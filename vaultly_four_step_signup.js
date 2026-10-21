'use strict';
/*
  FUBS ONLINE BANKING: demo banking app in ONE file (back end + front end).
  Needs Node.js 22.5 or newer. No npm install. Demo banking app.
  Run: node --no-warnings vaultly_four_step_signup.js
  Then open http://localhost:3000
*/
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

/* ================= DATABASE ================= */

fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const db = new DatabaseSync(path.join(__dirname, 'data', 'bank-v2.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, pin_hash TEXT NOT NULL,
  first_name TEXT NOT NULL, middle_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL, dob TEXT NOT NULL, gender TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL, city TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT 'Nigeria', occupation TEXT NOT NULL DEFAULT '',
  source_of_funds TEXT NOT NULL DEFAULT '', account_purpose TEXT NOT NULL DEFAULT '',
  next_of_kin TEXT NOT NULL DEFAULT '', next_of_kin_phone TEXT NOT NULL DEFAULT '',
  face_capture_completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS accounts (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id),
  account_number TEXT NOT NULL UNIQUE,
  balance        INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  savings        INTEGER NOT NULL DEFAULT 0 CHECK (savings >= 0)
);
CREATE TABLE IF NOT EXISTS transactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  type          TEXT NOT NULL,
  direction     TEXT NOT NULL,
  amount        INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  counterparty  TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  reference     TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, id DESC);
`);

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/* ================= BACK END ================= */

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

if (!process.env.JWT_SECRET) {
  console.warn('! JWT_SECRET not set: using a random one (logins reset on restart).');
}

const DEMO_TOPUP = process.env.DEMO_TOPUP !== 'false';
const REQUIRE_PHONE_MATCH = process.env.REQUIRE_PHONE_MATCH !== 'false';
const MAX_TX_NAIRA = 5_000_000;

/* ---------- helpers ---------- */

class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

const b64 = (b) => Buffer.from(b).toString('base64url');
const hmac = (s, k = SECRET) =>
  crypto.createHmac('sha256', k).update(s).digest('base64url');

function signToken(uid) {
  const body = b64(JSON.stringify({
    uid,
    exp: Date.now() + 7 * 864e5
  }));
  return `${body}.${hmac(body)}`;
}

function verifyToken(t) {
  const [body, sig] = String(t || '').split('.');
  if (!body || !sig) return null;

  const good = hmac(body);

  if (
    sig.length !== good.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))
  ) {
    return null;
  }

  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return p.exp > Date.now() ? p.uid : null;
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}

function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const h = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}

const ref = () =>
  'TX' + Date.now().toString(36).toUpperCase() +
  crypto.randomBytes(3).toString('hex').toUpperCase();

function normPhone(p) {
  let s = String(p || '').replace(/[\s-]/g, '');

  if (s.startsWith('+234')) {
    s = '0' + s.slice(4);
  } else if (s.startsWith('234') && s.length === 13) {
    s = '0' + s.slice(3);
  }

  return /^0[789][01]\d{8}$/.test(s) ? s : null;
}

function ageFrom(dob) {
  const d = new Date(dob);
  const n = new Date();

  let a = n.getFullYear() - d.getFullYear();

  if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) {
    a--;
  }

  return a;
}

function toKobo(v) {
  const raw = String(v ?? '').trim().replace(/,/g, '');

  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) {
    throw new HttpError(400, 'Enter a valid amount (up to 2 decimal places).');
  }

  const [whole, fraction = ''] = raw.split('.');
  const naira = Number(whole);

  if (!Number.isSafeInteger(naira) || naira <= 0) {
    throw new HttpError(400, 'Enter an amount greater than zero.');
  }

  if (
    naira > MAX_TX_NAIRA ||
    (naira === MAX_TX_NAIRA && Number(fraction) > 0)
  ) {
    throw new HttpError(
      400,
      `Maximum per transaction is ₦${MAX_TX_NAIRA.toLocaleString('en-NG')}.00`
    );
  }

  return naira * 100 + Number((fraction + '00').slice(0, 2));
}

function profile(uid) {
  const u = db.prepare(`
    SELECT u.*, a.account_number, a.balance, a.savings
    FROM users u
    JOIN accounts a ON a.user_id = u.id
    WHERE u.id = ?
  `).get(uid);

  if (!u) return null;

  return {
    id: u.id,
    fullName: [u.first_name, u.middle_name, u.last_name].filter(Boolean).join(' '),
    firstName: u.first_name,
    dob: u.dob,
    age: ageFrom(u.dob),
    gender: u.gender,
    address: u.address,
    city: u.city,
    state: u.state,
    country: u.country,
    occupation: u.occupation,
    sourceOfFunds: u.source_of_funds,
    accountPurpose: u.account_purpose,
    nextOfKin: u.next_of_kin,
    nextOfKinPhone: u.next_of_kin_phone,
    faceCaptureCompleted: Boolean(u.face_capture_completed),
    phone: u.phone,
    email: u.email,
    accountNumber: u.account_number,
    balance: u.balance,
    savings: u.savings
  };
}

function newAccountNumber() {
  for (;;) {
    const n = '30' + String(crypto.randomInt(0, 1e8)).padStart(8, '0');

    if (!db.prepare('SELECT 1 FROM accounts WHERE account_number=?').get(n)) {
      return n;
    }
  }
}

/* in-memory rate limiter */

const hits = new Map();

function limit(key, n, ms) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < ms);

  arr.push(now);
  hits.set(key, arr);

  if (arr.length > n) {
    throw new HttpError(429, 'Too many attempts. Please wait and try again.');
  }
}

setInterval(() => {
  const now = Date.now();

  for (const [k, v] of hits) {
    if (!v.some((t) => now - t < 36e5)) {
      hits.delete(k);
    }
  }
}, 6e5).unref();

/* ---------- route handlers ---------- */

const routes = {};

const route = (method, p, auth, fn) => {
  routes[`${method} ${p}`] = { auth, fn };
};

route('POST', '/api/auth/register', false, async ({ body, ip }) => {
  limit('reg:' + ip, 10, 36e5);

  const firstName = String(body.firstName || '').trim();
  const middleName = String(body.middleName || '').trim();
  const lastName = String(body.lastName || '').trim();
  const dob = String(body.dob || '').trim();
  const gender = String(body.gender || '').trim();
  const phone = normPhone(body.phone);

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const pin = String(body.pin || '');

  const address = String(body.address || '').trim();
  const city = String(body.city || '').trim();
  const state = String(body.state || '').trim();
  const country = String(body.country || 'Nigeria').trim();
  const occupation = String(body.occupation || '').trim();

  const sourceOfFunds = String(body.sourceOfFunds || '').trim();
  const accountPurpose = String(body.accountPurpose || '').trim();

  const nextOfKin = String(body.nextOfKin || '').trim();
  const nextOfKinPhone = normPhone(body.nextOfKinPhone);

  if (!firstName || !lastName || !dob || !gender) {
    throw new HttpError(400, 'Complete all required personal information.');
  }

  if (!phone) {
    throw new HttpError(400, 'Enter a valid Nigerian phone number.');
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'Enter a valid email address.');
  }

  if (
    !address || !city || !state || !country ||
    !occupation || !sourceOfFunds || !accountPurpose ||
    !nextOfKin || !nextOfKinPhone
  ) {
    throw new HttpError(400, 'Complete all required contact and profile fields.');
  }

  if (
    password.length < 10 ||
    !/[A-Za-z]/.test(password) ||
    !/\d/.test(password)
  ) {
    throw new HttpError(
      400,
      'Password must be at least 10 characters and include letters and numbers.'
    );
  }

  if (!/^\d{4,6}$/.test(pin)) {
    throw new HttpError(400, 'Transaction PIN must contain 4 to 6 digits.');
  }

  if (body.faceCaptureCompleted !== true) {
    throw new HttpError(400, 'Complete the camera selfie step before creating the demo account.');
  }

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(dob) ||
    Number.isNaN(Date.parse(dob)) ||
    ageFrom(dob) < 18
  ) {
    throw new HttpError(403, 'You must be at least 18 years old to open this demo account.');
  }

  if (db.prepare('SELECT 1 FROM users WHERE phone=? OR email=?').get(phone, email)) {
    throw new HttpError(409, 'An account already exists with this phone number or email.');
  }

  const uid = tx(() => {
    const r = db.prepare(`
      INSERT INTO users (
        phone, email, password_hash, pin_hash,
        first_name, middle_name, last_name, dob, gender,
        address, city, state, country, occupation,
        source_of_funds, account_purpose, next_of_kin, next_of_kin_phone,
        face_capture_completed
      )
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
    `).run(
      phone, email, hashPassword(password), hashPassword(pin),
      firstName, middleName, lastName, dob, gender,
      address, city, state, country, occupation,
      sourceOfFunds, accountPurpose, nextOfKin, nextOfKinPhone
    );

    db.prepare(
      'INSERT INTO accounts (user_id, account_number) VALUES (?,?)'
    ).run(r.lastInsertRowid, newAccountNumber());

    return Number(r.lastInsertRowid);
  });

  return {
    status: 201,
    data: { token: signToken(uid), user: profile(uid) }
  };
});

route('POST', '/api/auth/login', false, async ({ body, ip }) => {
  limit('login:' + ip, 15, 15 * 6e4);

  const id = String(body.identifier || '').trim().toLowerCase();

  const u = db.prepare(
    'SELECT * FROM users WHERE email=? OR phone=?'
  ).get(id, normPhone(id) || '__none__');

  if (!u || !checkPassword(String(body.password || ''), u.password_hash)) {
    throw new HttpError(401, 'Incorrect login details');
  }

  return {
    data: { token: signToken(u.id), user: profile(u.id) }
  };
});

route('GET', '/api/me', true, ({ uid }) => ({
  data: profile(uid)
}));

route('GET', '/api/transactions', true, ({ uid, query }) => {
  const lim = Math.min(Number(query.get('limit')) || 50, 200);

  return {
    data: db.prepare(`
      SELECT id, type, direction, amount, balance_after,
             counterparty, description, reference, created_at
      FROM transactions
      WHERE user_id=?
      ORDER BY id DESC
      LIMIT ?
    `).all(uid, lim)
  };
});

/* Paystack Nigerian bank list and account-name resolution.
   Keep PAYSTACK_SECRET_KEY on the server, never in browser code. */

route('GET', '/api/banks', true, async () => {
  const key = process.env.PAYSTACK_SECRET_KEY;

  if (!key) {
    throw new HttpError(
      503,
      'Bank lookup is not configured yet. Add PAYSTACK_SECRET_KEY to your server environment.'
    );
  }

  const response = await fetch(
    'https://api.paystack.co/bank?country=nigeria&perPage=100',
    {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json'
      }
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.status || !Array.isArray(result.data)) {
    throw new HttpError(502, result.message || 'Could not retrieve the Nigerian bank list.');
  }

  return {
    data: result.data
      .filter(b => b.code && b.name)
      .map(b => ({ name: b.name, code: String(b.code) }))
  };
});

route('GET', '/api/resolve-account', true, async ({ query, uid }) => {
  limit('bankresolve:' + uid, 30, 60 * 1000);

  const key = process.env.PAYSTACK_SECRET_KEY;

  if (!key) {
    throw new HttpError(
      503,
      'Bank lookup is not configured yet. Add PAYSTACK_SECRET_KEY to your server environment.'
    );
  }

  const accountNumber = String(query.get('accountNumber') || '').trim();
  const bankCode = String(query.get('bankCode') || '').trim();

  if (!/^\d{10}$/.test(accountNumber)) {
    throw new HttpError(400, 'Account number must contain exactly 10 digits.');
  }

  if (!/^[A-Za-z0-9_-]{2,20}$/.test(bankCode)) {
    throw new HttpError(400, 'Select a valid bank.');
  }

  const url = new URL('https://api.paystack.co/bank/resolve');
  url.searchParams.set('account_number', accountNumber);
  url.searchParams.set('bank_code', bankCode);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json'
    }
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.status || !result.data?.account_name) {
    throw new HttpError(
      422,
      result.message || 'Paystack could not verify that account. Check the bank and account number.'
    );
  }

  return {
    data: {
      account: {
        accountNumber: String(result.data.account_number || accountNumber),
        accountName: String(result.data.account_name),
        bankCode
      }
    }
  };
});

route('GET', '/api/lookup', true, ({ uid, query }) => {
  limit('lookup:' + uid, 60, 60 * 1000);

  const acct = String(query.get('account') || '').trim();

  if (!/^\d{10}$/.test(acct)) {
    throw new HttpError(400, 'Account number must be 10 digits');
  }

  const r = db.prepare(`
    SELECT u.first_name, u.middle_name, u.last_name
    FROM accounts a
    JOIN users u ON u.id = a.user_id
    WHERE a.account_number=?
  `).get(acct);

  if (!r) {
    throw new HttpError(404, 'No Fubs demo account found with that number');
  }

  return {
    data: {
      name: [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' '),
      accountNumber: acct,
      bankName: 'Fubs Online Banking'
    }
  };
});

route('POST', '/api/topup', true, ({ uid, body }) => {
  if (!DEMO_TOPUP) {
    throw new HttpError(501, 'Funding requires a payment gateway integration');
  }

  const amt = toKobo(body.amount);

  tx(() => {
    db.prepare('UPDATE accounts SET balance=balance+? WHERE user_id=?').run(amt, uid);

    const bal = db.prepare(
      'SELECT balance FROM accounts WHERE user_id=?'
    ).get(uid).balance;

    db.prepare(`
      INSERT INTO transactions
      (user_id,type,direction,amount,balance_after,counterparty,description,reference)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      uid, 'topup', 'credit', amt, bal,
      'Wallet funding', 'Add money (demo)', ref()
    );
  });

  return { data: profile(uid) };
});

route('POST', '/api/transfer', true, ({ uid, body }) => {
  limit('xfer:' + uid, 30, 6e4);

  const amt = toKobo(body.amount);
  const to = String(body.accountNumber || '');
  const note = String(body.note || '').slice(0, 100);

  tx(() => {
    const me = db.prepare(
      'SELECT * FROM accounts WHERE user_id=?'
    ).get(uid);

    const dest = db.prepare(`
      SELECT a.*, u.first_name, u.last_name
      FROM accounts a
      JOIN users u ON u.id=a.user_id
      WHERE a.account_number=?
    `).get(to);

    if (!dest) {
      throw new HttpError(404, 'Recipient account not found');
    }

    if (dest.user_id === uid) {
      throw new HttpError(400, 'You cannot transfer to yourself');
    }

    if (me.balance < amt) {
      throw new HttpError(400, 'Insufficient balance');
    }

    const sender = db.prepare(
      'SELECT first_name,last_name FROM users WHERE id=?'
    ).get(uid);

    const r = ref();

    db.prepare(
      'UPDATE accounts SET balance=balance-? WHERE user_id=?'
    ).run(amt, uid);

    db.prepare(
      'UPDATE accounts SET balance=balance+? WHERE user_id=?'
    ).run(amt, dest.user_id);

    const insert = db.prepare(`
      INSERT INTO transactions
      (user_id,type,direction,amount,balance_after,counterparty,description,reference)
      VALUES (?,?,?,?,?,?,?,?)
    `);

    insert.run(
      uid, 'transfer', 'debit', amt, me.balance - amt,
      `${dest.first_name} ${dest.last_name}`, note || 'Transfer', r
    );

    insert.run(
      dest.user_id, 'transfer', 'credit', amt, dest.balance + amt,
      `${sender.first_name} ${sender.last_name}`, note || 'Transfer', r
    );
  });

  return { data: profile(uid) };
});

route('POST', '/api/save', true, ({ uid, body }) => {
  const amt = toKobo(body.amount);
  const out = body.direction === 'out';

  tx(() => {
    const a = db.prepare(
      'SELECT * FROM accounts WHERE user_id=?'
    ).get(uid);

    if (out ? a.savings < amt : a.balance < amt) {
      throw new HttpError(
        400,
        out ? 'Not enough in savings' : 'Insufficient balance'
      );
    }

    const bal = a.balance + (out ? amt : -amt);

    db.prepare(
      'UPDATE accounts SET balance=?, savings=savings+? WHERE user_id=?'
    ).run(bal, out ? -amt : amt, uid);

    db.prepare(`
      INSERT INTO transactions
      (user_id,type,direction,amount,balance_after,counterparty,description,reference)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      uid, 'save', out ? 'credit' : 'debit', amt, bal,
      'Savings',
      out ? 'Withdrawn from savings' : 'Moved to savings',
      ref()
    );
  });

  return { data: profile(uid) };
});

const BILLS = {
  airtime: 'Airtime',
  data: 'Data',
  tv: 'TV',
  electricity: 'Electricity'
};

route('POST', '/api/bills', true, ({ uid, body }) => {
  limit('bill:' + uid, 30, 6e4);

  const cat = String(body.category || '');

  if (!BILLS[cat]) {
    throw new HttpError(400, 'Unknown bill category');
  }

  const provider = String(body.provider || '').slice(0, 40);
  const target = String(body.target || '').replace(/[^\w-]/g, '').slice(0, 20);

  if (!provider || !target) {
    throw new HttpError(400, 'Provider and number are required');
  }

  const amt = toKobo(body.amount);

  // Demo only. Real bill payment needs an aggregator API.
  tx(() => {
    const a = db.prepare(
      'SELECT balance FROM accounts WHERE user_id=?'
    ).get(uid);

    if (a.balance < amt) {
      throw new HttpError(400, 'Insufficient balance');
    }

    db.prepare(
      'UPDATE accounts SET balance=balance-? WHERE user_id=?'
    ).run(amt, uid);

    db.prepare(`
      INSERT INTO transactions
      (user_id,type,direction,amount,balance_after,counterparty,description,reference)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      uid, 'bill', 'debit', amt, a.balance - amt,
      provider, `${BILLS[cat]} - ${target}`, ref()
    );
  });

  return { data: profile(uid) };
});

/* ================= FRONT END ================= */

const INDEX_HTML = String.raw`<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#05070d">
  <title>Fubs Online Banking</title>
  <link rel="stylesheet" href="/styles.css">
  <script src="/theme.js"></script>
</head>
<body>
  <div id="app" aria-live="polite"></div>
  <div id="sheet-root"></div>
  <div id="toast" role="status"></div>
  <script src="/app.js"></script>
</body>
</html>
`;

const STYLES_CSS = String.raw`:root, [data-theme="dark"] {
  --bg: #05070d; --surface: #0d1322; --surface-2: #141c33; --line: #1b2644;
  --text: #f2f5ff; --muted: #8b97b8; --blue: #2f6bff; --blue-2: #1746d6; --blue-soft: #12224d;
  --on-blue: #fff; --green: #2fd19b; --red: #ff6b7d; --shadow: 0 10px 30px rgba(0,0,0,.45);
  color-scheme: dark;
}
[data-theme="light"] {
  --bg: #ffffff; --surface: #f3f6ff; --surface-2: #e8eeff; --line: #dbe3fb;
  --text: #0b1430; --muted: #5d6b91; --blue: #2f6bff; --blue-2: #1746d6; --blue-soft: #dde7ff;
  --on-blue: #fff; --green: #0e9f6e; --red: #d93a50; --shadow: 0 10px 30px rgba(47,107,255,.15);
  color-scheme: light;
}
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body { margin: 0; background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
body { min-height: 100vh; }
button { font: inherit; color: inherit; cursor: pointer; border: 0; background: none; }
input, select { font: inherit; color: var(--text); }
.app { max-width: 480px; margin: 0 auto; min-height: 100vh; padding: 16px 16px 96px; }

/* header */
.top { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
.avatar { width: 44px; height: 44px; border-radius: 50%; background: linear-gradient(135deg, var(--blue), #7aa2ff); display: grid; place-items: center; font-weight: 700; color: #fff; }
.hi { font-size: 18px; font-weight: 700; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon-btn { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; color: var(--text); background: var(--surface); }
.icon-btn svg { width: 22px; height: 22px; }

/* balance card */
.balance { background: linear-gradient(135deg, var(--blue), var(--blue-2)); color: var(--on-blue); border-radius: 22px 22px 0 0; padding: 18px 18px 20px; position: relative; box-shadow: var(--shadow); }
.balance .row { display: flex; justify-content: space-between; align-items: flex-start; }
.balance .lbl { display: flex; align-items: center; gap: 8px; font-size: 15px; opacity: .95; }
.balance .lbl svg { width: 20px; height: 20px; }
.amount { font-size: 30px; font-weight: 800; margin: 14px 0 10px; letter-spacing: -.5px; }
.amount small { font-size: 20px; font-weight: 700; opacity: .85; }
.earn { font-size: 15px; opacity: .95; }
.pill { border: 1.5px solid rgba(255,255,255,.55); border-radius: 999px; padding: 9px 16px; font-weight: 600; color: #fff; }
.last { background: var(--surface); border: 1px solid var(--line); border-top: 0; border-radius: 0 0 22px 22px; padding: 14px 16px; display: flex; align-items: center; gap: 10px; font-size: 14px; margin-bottom: 14px; }
.last .txt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link { color: var(--muted); display: flex; align-items: center; gap: 4px; }

.strip { width: 100%; text-align: left; background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 14px 16px; display: flex; align-items: center; gap: 10px; margin-bottom: 14px; font-size: 15px; }
.strip .grow { flex: 1; }
.strip b { color: var(--blue); }

.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 20px; padding: 18px 10px; margin-bottom: 14px; }
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px 4px; }
.act { display: flex; flex-direction: column; align-items: center; gap: 8px; font-size: 14px; color: var(--muted); }
.act .ic { width: 62px; height: 62px; border-radius: 18px; background: var(--surface-2); display: grid; place-items: center; color: var(--blue); }
.act .ic svg { width: 30px; height: 30px; }
.grid4 .act .ic { width: 52px; height: 52px; border-radius: 50%; }
.grid4 .act .ic svg { width: 26px; height: 26px; }
.grid4 .act { font-size: 13px; }
.grid3 .act { color: var(--text); font-size: 15px; }

.promo { border-radius: 20px; padding: 18px; background: linear-gradient(135deg, var(--blue-soft), var(--surface)); border: 1px solid var(--line); margin-bottom: 14px; }
.promo h3 { margin: 0 0 12px; font-size: 18px; }
.promo .in { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px dashed var(--line); padding-top: 14px; }
.promo p { margin: 2px 0 0; color: var(--muted); font-size: 14px; }
.btn { background: var(--blue); color: #fff; border-radius: 999px; padding: 12px 28px; font-weight: 700; }
.btn.block { width: 100%; padding: 15px; border-radius: 14px; font-size: 16px; }
.btn.ghost { background: var(--surface-2); color: var(--text); }
.btn[disabled] { opacity: .6; cursor: progress; }

/* tabs */
.tabs { position: fixed; left: 0; right: 0; bottom: 0; background: var(--surface); border-top: 1px solid var(--line); padding-bottom: env(safe-area-inset-bottom); }
.tabs > div { max-width: 480px; margin: 0 auto; display: grid; grid-template-columns: repeat(4, 1fr); }
.tab { padding: 10px 0 12px; display: flex; flex-direction: column; align-items: center; gap: 4px; font-size: 13px; color: var(--muted); }
.tab svg { width: 26px; height: 26px; }
.tab.on { color: var(--blue); font-weight: 700; }

/* lists & pages */
h1.pg { font-size: 22px; margin: 4px 0 16px; }
.list { background: var(--surface); border: 1px solid var(--line); border-radius: 18px; overflow: hidden; margin-bottom: 14px; }
.item { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.item:last-child { border-bottom: 0; }
.item .ic { width: 40px; height: 40px; border-radius: 50%; background: var(--surface-2); color: var(--blue); display: grid; place-items: center; flex: none; }
.item .ic svg { width: 20px; height: 20px; }
.item .mid { flex: 1; min-width: 0; }
.item .mid b { display: block; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item .mid span { font-size: 12.5px; color: var(--muted); }
.cr { color: var(--green); font-weight: 700; }
.dr { color: var(--text); font-weight: 700; }
.kv { display: flex; justify-content: space-between; gap: 16px; padding: 13px 16px; border-bottom: 1px solid var(--line); font-size: 15px; }
.kv:last-child { border-bottom: 0; }
.kv span:first-child { color: var(--muted); }
.kv span:last-child { text-align: right; }
.badge { display: inline-flex; align-items: center; gap: 6px; background: var(--blue-soft); color: var(--blue); padding: 5px 10px; border-radius: 999px; font-size: 12.5px; font-weight: 700; }
.empty { text-align: center; color: var(--muted); padding: 28px 12px; }

/* auth */
.auth { max-width: 420px; margin: 0 auto; padding: 28px 18px 40px; min-height: 100vh; display: flex; flex-direction: column; justify-content: center; }
.logo { width: 56px; height: 56px; border-radius: 16px; background: linear-gradient(135deg, var(--blue), var(--blue-2)); display: grid; place-items: center; color: #fff; margin-bottom: 18px; }
.logo svg { width: 30px; height: 30px; }
.auth h1 { font-size: 28px; margin: 0 0 6px; }
.auth p.sub { color: var(--muted); margin: 0 0 22px; line-height: 1.45; }
.field { margin-bottom: 14px; }
.field label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
.field input { width: 100%; background: var(--surface); border: 1.5px solid var(--line); border-radius: 12px; padding: 14px; outline: 0; }
.field input:focus { border-color: var(--blue); }
.hint { font-size: 12.5px; color: var(--muted); margin-top: 5px; }
.err { background: rgba(255,107,125,.12); color: var(--red); border-radius: 10px; padding: 10px 12px; font-size: 14px; margin-bottom: 14px; }
.info { background: var(--blue-soft); color: var(--text); border-radius: 12px; padding: 12px 14px; font-size: 13.5px; line-height: 1.45; margin-bottom: 16px; }
.switch { text-align: center; margin-top: 18px; color: var(--muted); }
.switch button { color: var(--blue); font-weight: 700; }

/* bottom sheet */
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: flex-end; justify-content: center; z-index: 20; }
.sheet { background: var(--bg); width: 100%; max-width: 480px; max-height: 92vh; overflow: auto; border-radius: 24px 24px 0 0; padding: 18px 18px 28px; border: 1px solid var(--line); animation: up .2s ease-out; }
@keyframes up { from { transform: translateY(40px); opacity: 0; } }
.sheet h2 { margin: 0 0 4px; font-size: 20px; }
.sheet .x { float: right; }
.sheet .sub { color: var(--muted); font-size: 14px; margin: 0 0 16px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
.chip { padding: 9px 14px; border-radius: 999px; background: var(--surface); border: 1.5px solid var(--line); font-size: 14px; }
.chip.on { border-color: var(--blue); color: var(--blue); background: var(--blue-soft); font-weight: 700; }
.recipient { background: var(--blue-soft); color: var(--blue); font-weight: 700; padding: 10px 12px; border-radius: 10px; margin-bottom: 14px; font-size: 14px; }
#toast { position: fixed; left: 50%; bottom: 90px; transform: translateX(-50%) translateY(20px); background: var(--text); color: var(--bg); padding: 11px 18px; border-radius: 999px; font-size: 14px; opacity: 0; pointer-events: none; transition: .25s; z-index: 40; max-width: 90vw; }
#toast.show { opacity: 1; transform: translateX(-50%); }
`;

const THEME_JS = "try { document.documentElement.dataset.theme = localStorage.getItem('theme') || 'dark'; } catch (e) {}";

// The browser script is written as a normal function, then sent to the browser as text.
function clientApp() {
  /* ---------- tiny helpers ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));

  const store = {
    get(k) {
      try { return localStorage.getItem(k); } catch { return null; }
    },
    set(k, v) {
      try { localStorage.setItem(k, v); } catch {}
    },
    del(k) {
      try { localStorage.removeItem(k); } catch {}
    }
  };

  const fmt = (kobo) => (kobo / 100).toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  const naira = (kobo) => '₦' + fmt(kobo);

  const ico = (p) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;

  const I = {
    user: ico('<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>'),
    home: ico('<path d="m3 10 9-7 9 7"/><path d="M5 9v12h14V9"/><path d="M9 21v-7h6v7"/>'),
    send: ico('<path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4Z"/>'),
    clock: ico('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>'),
    wallet: ico('<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 9h18"/><path d="M16 14h2"/>'),
    plus: ico('<path d="M12 5v14M5 12h14"/>'),
    arrow: ico('<path d="M5 12h14M13 6l6 6-6 6"/>'),
    phone: ico('<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>'),
    wifi: ico('<path d="M2 8.8a15 15 0 0 1 20 0"/><path d="M5 12a10 10 0 0 1 14 0"/><path d="M8.5 15.5a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1"/>'),
    bolt: ico('<path d="m13 2-3 8h7l-6 12 1-9H5l8-11Z"/>'),
    sun: ico('<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41"/>'),
    moon: ico('<path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>'),
    shield: ico('<path d="M12 2 20 5v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5Z"/><path d="m8 12 3 3 5-6"/>'),
    usercheck: ico('<circle cx="9" cy="8" r="4"/><path d="M2 21c1-4 4-6 7-6"/><path d="m15 13 2 2 5-5"/>')
  };
    // Match the icons defined in Part 1 to the names used by the app.
  Object.assign(I, {
    bank: I.user,
    safe: I.shield,
    data: I.send,
    tv: I.clock,
    bolt: I.send,
    piggy: I.wallet,
    coins: I.plus,
    gift: I.usercheck,
    more: I.send,
    eye: I.user,
    eyeOff: I.shield,
    chev: I.send,
    star: I.usercheck,
    chart: I.clock,
    me: I.user,
    x: I.send,
    arrowUp: I.send,
    arrowDown: I.send,
    logo: I.shield
  });

  /* ---------- state & API ---------- */

  const S = {
    token: store.get('token'),
    user: null,
    txs: [],
    view: 'home',
    authMode: 'login',
    hide: store.get('hide') === '1',
    error: '',
    busy: false,
    regStep: 1,
    regData: {},
    faceCaptured: false
  };

  let faceStream = null;

  async function api(path, method = 'GET', body) {
    const res = await fetch(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(S.token ? { Authorization: 'Bearer ' + S.token } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

    const data = await res.json().catch(() => ({}));

    if (res.status === 401 && S.token) logout(true);
    if (!res.ok) throw new Error(data.error || 'Request failed');

    return data;
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');

    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function setTheme(next) {
    document.documentElement.dataset.theme = next;
    store.set('theme', next);

    const meta = $('meta[name=theme-color]');
    if (meta) meta.content = next === 'dark' ? '#05070d' : '#ffffff';
  }

  const toggleTheme = () => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    render();
  };

  function logout(silent) {
    store.del('token');
    S.token = null;
    S.user = null;
    S.authMode = 'login';
    closeSheet();
    render();

    if (!silent) toast('Logged out');
  }

  async function load() {
    if (!S.token) return render();

    try {
      S.user = await api('/api/me');
      S.txs = await api('/api/transactions');
    } catch {
      // The API helper handles expired login sessions.
    }

    render();
  }

  /* ---------- views ---------- */

  function themeBtn() {
    const dark = document.documentElement.dataset.theme === 'dark';

    return `<button class="icon-btn" data-act="theme" aria-label="Switch theme">
      ${dark ? I.usercheck : I.shield}
    </button>`;
  }

  function authView() {
    const reg = S.authMode === 'register';

    if (!reg) {
      return `<div class="auth">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div class="logo">${I.shield}</div>${themeBtn()}
        </div>
        <h1>Welcome back</h1>
        <p class="sub">Log in with your phone number or email address.</p>
        ${S.error ? `<div class="err">${esc(S.error)}</div>` : ''}
        <form id="auth-form" autocomplete="on" novalidate>
          <div class="field">
            <label for="identifier">Phone number or email</label>
            <input id="identifier" autocomplete="username" required>
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input id="password" type="password" autocomplete="current-password" required>
          </div>
          <button class="btn block" ${S.busy ? 'disabled' : ''}>
            ${S.busy ? 'Please wait…' : 'Log in'}
          </button>
        </form>
        <div class="switch">New here? <button data-act="switch">Create account</button></div>
      </div>`;
    }

    const d = S.regData || {};
    const step = S.regStep || 1;

    const field = (id, label, type = 'text', required = true) => {
      const value = esc(d[id] || '');

      if (id === 'gender') {
        return `<div class="field">
          <label for="gender">${label}</label>
          <select class="reg-input" id="gender" ${required ? 'required' : ''}>
            <option value="">Choose gender</option>
            ${['Female', 'Male', 'Other'].map(x =>
              `<option ${d.gender === x ? 'selected' : ''}>${x}</option>`
            ).join('')}
          </select>
        </div>`;
      }

      return `<div class="field">
        <label for="${id}">${label}</label>
        <input class="reg-input" id="${id}" type="${type}" value="${value}"
          ${type === 'password' ? 'autocomplete="new-password"' : ''}
          ${required ? 'required' : ''}
          ${['pin', 'confirmPin'].includes(id) ? 'inputmode="numeric" maxlength="6"' : ''}
          ${['phone', 'nextOfKinPhone'].includes(id) ? 'placeholder="08012345678"' : ''}>
      </div>`;
    };

    let content = '';

    if (step === 1) {
      content =
        field('firstName', 'First name') +
        field('middleName', 'Middle name (optional)', 'text', false) +
        field('lastName', 'Last name') +
        field('dob', 'Date of birth', 'date') +
        field('gender', 'Gender');
    }

    if (step === 2) {
      content =
        field('phone', 'Mobile phone number', 'tel') +
        field('email', 'Email address', 'email') +
        field('address', 'Residential address') +
        field('city', 'City / town') +
        field('state', 'State') +
        field('country', 'Country') +
        field('occupation', 'Occupation') +
        field('sourceOfFunds', 'Source of funds') +
        field('accountPurpose', 'Purpose of account') +
        field('nextOfKin', 'Next of kin full name') +
        field('nextOfKinPhone', 'Next of kin phone number', 'tel');
    }

    if (step === 3) {
      content =
        field('password', 'Create password', 'password') +
        field('confirmPassword', 'Confirm password', 'password') +
        field('pin', 'Transaction PIN (4–6 digits)', 'password') +
        field('confirmPin', 'Confirm transaction PIN', 'password') +
        `<div class="info">Use a unique password. This demo stores password and PIN hashes.</div>`;
    }

    if (step === 4) {
      content = `
        <div class="info">
          Allow camera access, position your face in the frame, and capture a selfie.
          This prototype does not perform real facial matching or identity verification.
        </div>
        <video id="face-video" autoplay playsinline
          style="display:none;width:100%;max-height:260px;object-fit:cover;border-radius:16px;background:#111;margin-bottom:12px">
        </video>
        <canvas id="face-canvas" style="display:none"></canvas>
        <div id="face-preview"
          style="min-height:150px;border:1px dashed var(--line);border-radius:16px;display:grid;place-items:center;margin-bottom:12px;color:var(--muted);overflow:hidden">
          ${S.faceCaptured ? 'Selfie captured ✓' : 'Camera preview will appear here'}
        </div>
        <div style="display:flex;gap:8px;margin-bottom:16px">
          <button type="button" class="btn ghost" data-act="camera-start">Open camera</button>
          <button type="button" class="btn ghost" data-act="camera-capture">Capture selfie</button>
        </div>
        <div class="field">
          <label><input id="terms" type="checkbox" ${d.terms ? 'checked' : ''}>
            I confirm these details are accurate and accept the demo terms.
          </label>
        </div>
        <div class="info">
          No NIN or BVN is requested. This creates a demo account, not a verified bank account.
        </div>`;
    }

    return `<div class="auth" style="max-width:520px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div class="logo">${I.shield}</div>${themeBtn()}
      </div>
      <h1>Create your account</h1>
      <p class="sub">Four simple steps. No NIN or BVN required for this demo.</p>
      <div style="display:flex;gap:6px;margin:0 0 20px">
        ${[1, 2, 3, 4].map(n =>
          `<div style="height:5px;flex:1;border-radius:8px;background:${n <= step ? 'var(--blue)' : 'var(--line)'}"></div>`
        ).join('')}
      </div>
      <p class="hint" style="margin-bottom:14px">
        Step ${step} of 4 · ${['Personal information', 'Contact & profile', 'Security setup', 'Face capture & review'][step - 1]}
      </p>
      ${S.error ? `<div class="err">${esc(S.error)}</div>` : ''}
      <form id="register-step-form" novalidate>
        ${content}
        <div style="display:flex;gap:10px;margin-top:18px">
          ${step > 1 ? '<button type="button" class="btn ghost" data-act="reg-back" style="flex:1">Back</button>' : ''}
          <button class="btn block" style="flex:2" ${S.busy ? 'disabled' : ''}>
            ${step === 4 ? 'Create demo account' : 'Continue'}
          </button>
        </div>
      </form>
      <div class="switch">Already have an account? <button data-act="switch">Log in</button></div>
    </div>`;
  }

  const TX_ICON = {
    topup: I.plus,
    transfer: I.shield,
    save: I.usercheck,
    bill: I.send
  };

  function txRow(t) {
    const cr = t.direction === 'credit';
    const when = new Date(t.created_at.replace(' ', 'T') + 'Z')
      .toLocaleString('en-NG', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      });

    return `<div class="item">
      <div class="ic">${TX_ICON[t.type] || I.plus}</div>
      <div class="mid">
        <b>${esc(t.counterparty || t.description)}</b>
        <span>${esc(t.description)} · ${when}</span>
      </div>
      <div class="${cr ? 'cr' : 'dr'}">${cr ? '+' : '-'}${naira(t.amount)}</div>
    </div>`;
  }

  const act = (a, icon, label, extra = '') =>
    `<button class="act" data-act="${a}" ${extra}><span class="ic">${icon}</span>${label}</button>`;

  function homeView() {
    const u = S.user;
    const last = S.txs[0];
    const today = new Date().toISOString().slice(0, 10);

    const spent = S.txs
      .filter(t => t.direction === 'debit' && t.created_at.startsWith(today))
      .reduce((s, t) => s + t.amount, 0);

    const [whole, dec] = fmt(u.balance).split('.');

    return `
      <div class="top">
        <div class="avatar">${esc(u.firstName[0])}</div>
        <div class="hi">Hi, ${esc(u.firstName.toUpperCase())}</div>
        ${themeBtn()}
      </div>
      <div class="balance">
        <div class="row">
          <div>
            <div class="lbl">${I.shield} Available
              <button data-act="hide" aria-label="Show or hide balance" style="color:inherit">
                ${S.hide ? I.user : I.shield}
              </button>
            </div>
            <div class="amount">${S.hide ? '₦ ••••••' : `₦${whole}<small>.${dec}</small>`}</div>
          </div>
          <button class="pill" data-act="topup">+ Add Money</button>
        </div>
        <div class="earn">Account ${esc(u.accountNumber)}</div>
      </div>
      <div class="last">
        ${last
          ? `<span class="cr">●</span><span class="txt">${esc(last.description)} ${last.direction === 'credit' ? '+' : '-'}${naira(last.amount)}</span>`
          : '<span class="txt">No transactions yet</span>'}
        <button class="link" data-act="history">Transactions ${I.send}</button>
      </div>
      <button class="strip" data-act="history">
        <span class="ic" style="color:var(--blue)">${I.plus}</span>
        <span class="grow">Today's Spending: <b>${S.hide ? '₦••••' : naira(spent)}</b></span>
        ${I.send}
      </button>
      <div class="panel"><div class="grid3">
        ${act('tovault', I.user, 'To Fubs Online Banking')}
        ${act('tobank', I.shield, 'To Bank')}
        ${act('save', I.usercheck, 'Save')}
      </div></div>
      <div class="panel"><div class="grid4">
        ${act('bill', I.send, 'Airtime', 'data-cat="airtime"')}
        ${act('bill', I.clock, 'Data', 'data-cat="data"')}
        ${act('bill', I.user, 'TV', 'data-cat="tv"')}
        ${act('bill', I.shield, 'Electricity', 'data-cat="electricity"')}
        ${act('go', I.wallet, 'Wealth', 'data-view="wealth"')}
        ${act('save', I.plus, 'Spend & Save')}
        ${act('go', I.usercheck, 'Invitation', 'data-view="rewards"')}
        ${act('more', I.send, 'More')}
      </div></div>
      <div class="promo">
        <h3>Plan Your Dream Goal!</h3>
        <div class="in">
          <div><b>Savings Target</b><p>Small savings today, big wins tomorrow.</p></div>
          <button class="btn" data-act="save">Go</button>
        </div>
      </div>`;
  }

  function wealthView() {
    const u = S.user;

    return `<h1 class="pg">Wealth</h1>
      <div class="balance" style="border-radius:22px;margin-bottom:14px">
        <div class="lbl">${I.shield} Savings balance</div>
        <div class="amount">${S.hide ? '₦ ••••••' : naira(u.savings)}</div>
        <div style="display:flex;gap:10px">
          <button class="pill" data-act="save">+ Save</button>
          <button class="pill" data-act="unsave">Withdraw</button>
        </div>
      </div>
      <div class="list">
        ${S.txs.filter(t => t.type === 'save').map(txRow).join('') || '<div class="empty">No savings activity yet.</div>'}
      </div>`;
  }

  function rewardsView() {
    return `<h1 class="pg">Rewards</h1>
      <div class="promo">
        <h3>Invite friends</h3>
        <div class="in">
          <div><b>Your account number</b><p>${esc(S.user.accountNumber)}</p></div>
          <button class="btn" data-act="copy">Copy</button>
        </div>
      </div>
      <div class="empty">Referral bonuses will appear here when a rewards programme is connected.</div>`;
  }

  function meView() {
    const u = S.user;
    const row = (k, v) => `<div class="kv"><span>${k}</span><span>${esc(v)}</span></div>`;
    const dark = document.documentElement.dataset.theme === 'dark';

    return `<h1 class="pg">Me</h1>
      <div style="margin-bottom:12px"><span class="badge">${I.shield} Demo profile</span></div>
      <div class="list">
        ${row('Full name', u.fullName)}
        ${row('Age', u.age + ' years')}
        ${row('Date of birth', u.dob)}
        ${row('Gender', u.gender)}
        ${row('Address', [u.address, u.city, u.state, u.country].filter(Boolean).join(', '))}
        ${row('Occupation', u.occupation)}
        ${row('Source of funds', u.sourceOfFunds)}
        ${row('Account purpose', u.accountPurpose)}
        ${row('Next of kin', u.nextOfKin)}
        ${row('Phone', u.phone)}
        ${row('Email', u.email)}
        ${row('Account number', u.accountNumber)}
      </div>
      <div class="list">
        <button class="item" style="width:100%;text-align:left" data-act="theme">
          <div class="ic">${dark ? I.usercheck : I.shield}</div>
          <div class="mid"><b>Theme</b><span>${dark ? 'Black & blue (tap for white & blue)' : 'White & blue (tap for black & blue)'}</span></div>
        </button>
      </div>
      <button class="btn ghost block" data-act="logout">Log out</button>`;
  }

  function historyView() {
    return `<h1 class="pg">Transactions</h1>
      <div class="list">
        ${S.txs.map(txRow).join('') || '<div class="empty">No transactions yet.</div>'}
      </div>`;
  }

  const TABS = [
    ['home', 'Home', I.home],
    ['rewards', 'Rewards', I.usercheck],
    ['wealth', 'Wealth', I.shield],
    ['me', 'Me', I.user]
  ];

  function render() {
    const root = $('#app');

    if (!S.token || !S.user) {
      root.innerHTML = authView();
      return;
    }

    const views = {
      home: homeView,
      wealth: wealthView,
      rewards: rewardsView,
      me: meView,
      history: historyView
    };

    const v = views[S.view] || homeView;

    root.innerHTML = `<div class="app">
      ${S.view === 'history' ? '<button class="link" data-act="go" data-view="home" style="margin-bottom:8px">← Back</button>' : ''}
      ${v()}
    </div>
    <nav class="tabs"><div>
      ${TABS.map(([k, label, icon]) =>
        `<button class="tab ${S.view === k ? 'on' : ''}" data-act="go" data-view="${k}">${icon}${label}</button>`
      ).join('')}
    </div></nav>`;
  }

  /* ---------- bottom sheets ---------- */

  function openSheet(html) {
    $('#sheet-root').innerHTML = `<div class="overlay" data-act="overlay">
      <div class="sheet" role="dialog" aria-modal="true">
        <button class="icon-btn x" data-act="close" aria-label="Close">${I.send}</button>
        ${html}
      </div>
    </div>`;

    const first = $('#sheet-root input');
    if (first) first.focus();
  }

  function closeSheet() {
    $('#sheet-root').innerHTML = '';
  }

  const errBox = () => '<div class="err" id="sheet-err" hidden></div>';

  function sheetErr(m) {
    const e = $('#sheet-err');
    if (!e) return;
    e.textContent = m;
    e.hidden = false;
  }

  const amountField = () => `<div class="field">
    <label for="amt">Amount (₦)</label>
    <input id="amt" type="text" inputmode="decimal" autocomplete="off"
      placeholder="0.00" maxlength="16" required>
    <small class="sub">Use commas for thousands and a dot for kobo, e.g. 12,500.50.</small>
  </div>`;

  function sheetTopup() {
    openSheet(`<h2>Add money</h2>
      <p class="sub">Demo mode: this credits your wallet instantly. Real funding needs a payment gateway integration.</p>
      ${errBox()}
      <form data-form="topup">${amountField()}<button class="btn block">Add money</button></form>`);
  }

  function sheetTransfer(external) {
    if (external) {
      openSheet(`<h2>Verify external bank account</h2>
        <p class="sub">Choose a Nigerian bank and enter the 10-digit account number. Paystack verifies account details only; this demo does not send money.</p>
        ${errBox()}
        <form data-form="transfer" data-external="true">
          <div class="field"><label for="bankCode">Recipient's bank</label>
            <select id="bankCode" required><option value="">Loading banks...</option></select>
          </div>
          <div class="field"><label for="acct">Account number</label>
            <input id="acct" inputmode="numeric" autocomplete="off" maxlength="10" pattern="[0-9]{10}" placeholder="10-digit account number" required>
          </div>
          <div id="recipient" aria-live="polite"></div>
          <button class="btn block">Verify account</button>
        </form>`);
      loadPaystackBanks();
      return;
    }

    openSheet(`<h2>To Fubs Online Banking</h2>
      <p class="sub">Send money within this Fubs demo to an existing 10-digit Fubs account.</p>
      ${errBox()}
      <form data-form="transfer">
        <div class="field"><label for="acct">Account number</label>
          <input id="acct" inputmode="numeric" maxlength="10" required>
        </div>
        <div id="recipient"></div>
        ${amountField()}
        <div class="field"><label for="note">Note (optional)</label><input id="note" maxlength="100"></div>
        <button class="btn block">Send demo transfer</button>
      </form>`);
  }

  async function loadPaystackBanks() {
    const select = $('#bankCode');
    if (!select) return;

    try {
      const banks = await api('/api/banks');

      if (!$('#bankCode')) return;

      select.innerHTML = '<option value="">Select a bank</option>';

      banks.sort((a, b) => a.name.localeCompare(b.name)).forEach(bank => {
        const option = document.createElement('option');
        option.value = bank.code;
        option.textContent = bank.name;
        select.appendChild(option);
      });
    } catch (err) {
      if ($('#bankCode')) select.innerHTML = '<option value="">Could not load banks</option>';
      sheetErr(err.message);
    }
  }

  function sheetSave(out) {
    openSheet(`<h2>${out ? 'Withdraw from savings' : 'Save money'}</h2>
      <p class="sub">Savings balance: ${naira(S.user.savings)} · Wallet: ${naira(S.user.balance)}</p>
      ${errBox()}
      <form data-form="save" data-dir="${out ? 'out' : 'in'}">
        ${amountField()}<button class="btn block">${out ? 'Withdraw' : 'Save'}</button>
      </form>`);
  }

  const PROVIDERS = {
    airtime: ['MTN', 'Airtel', 'Glo', '9mobile'],
    data: ['MTN', 'Airtel', 'Glo', '9mobile'],
    tv: ['DStv', 'GOtv', 'StarTimes'],
    electricity: ['IKEDC', 'EKEDC', 'AEDC', 'PHED']
  };

  function sheetBill(cat) {
    const label = {
      airtime: 'Airtime',
      data: 'Data',
      tv: 'TV',
      electricity: 'Electricity'
    }[cat];

    openSheet(`<h2>${label}</h2>
      <p class="sub">Demo mode: the payment is recorded but not sent to a provider.</p>
      ${errBox()}
      <form data-form="bill" data-cat="${cat}">
        <div class="chips" id="providers">
          ${PROVIDERS[cat].map((p, i) =>
            `<button type="button" class="chip ${i ? '' : 'on'}" data-act="pick" data-p="${p}">${p}</button>`
          ).join('')}
        </div>
        <div class="field">
          <label for="target">${cat === 'tv' ? 'Smartcard number' : cat === 'electricity' ? 'Meter number' : 'Phone number'}</label>
          <input id="target" inputmode="numeric" required>
        </div>
        ${amountField()}
        <button class="btn block">Pay</button>
      </form>`);

    $('#providers').dataset.value = PROVIDERS[cat][0];
  }

  function sheetMore() {
    openSheet(`<h2>More</h2><p class="sub">Choose a service</p>
      <div class="grid4" style="margin-top:8px">
        ${act('bill', I.send, 'Airtime', 'data-cat="airtime"')}
        ${act('bill', I.clock, 'Data', 'data-cat="data"')}
        ${act('bill', I.user, 'TV', 'data-cat="tv"')}
        ${act('bill', I.shield, 'Electricity', 'data-cat="electricity"')}
      </div>`);
  }

  /* ---------- selfie demo ---------- */

  function stopFaceCamera() {
    if (faceStream) {
      faceStream.getTracks().forEach(t => t.stop());
      faceStream = null;
    }
  }

  async function startFaceCamera() {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera access requires HTTPS or localhost and a supported browser.');
      }

      stopFaceCamera();

      faceStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false
      });

      const video = $('#face-video');

      if (!video) {
        stopFaceCamera();
        return;
      }

      video.srcObject = faceStream;
      video.style.display = 'block';
      toast('Camera ready. Position your face and capture.');
    } catch (err) {
      S.error = err.message || 'Could not open camera. Check browser permissions.';
      render();
    }
  }

  function captureFace() {
    const video = $('#face-video');
    const canvas = $('#face-canvas');
    const preview = $('#face-preview');

    if (!video || !canvas || !video.videoWidth) {
      toast('Open the camera first.');
      return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

    const img = document.createElement('img');
    img.src = canvas.toDataURL('image/jpeg', 0.82);
    img.alt = 'Captured signup selfie';
    img.style.cssText = 'display:block;width:100%;max-height:260px;object-fit:cover';

    preview.replaceChildren(img);
    S.faceCaptured = true;
    stopFaceCamera();

    toast('Selfie captured for this demo.');
  }

  function saveRegInputs() {
    document.querySelectorAll('#register-step-form .reg-input').forEach(el => {
      S.regData[el.id] = el.value;
    });

    const terms = $('#terms');
    if (terms) S.regData.terms = terms.checked;
  }

  function validateRegStep() {
    saveRegInputs();

    const d = S.regData;
    const required = {
      1: ['firstName', 'lastName', 'dob', 'gender'],
      2: [
        'phone', 'email', 'address', 'city', 'state', 'country',
        'occupation', 'sourceOfFunds', 'accountPurpose',
        'nextOfKin', 'nextOfKinPhone'
      ],
      3: ['password', 'confirmPassword', 'pin', 'confirmPin']
    };

    for (const key of (required[S.regStep] || [])) {
      if (!String(d[key] || '').trim()) {
        throw new Error('Please complete all required fields on this step.');
      }
    }

    if (S.regStep === 1 &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(d.dob) || ageFrom(d.dob) < 18)) {
      throw new Error('You must be at least 18 years old to create this demo account.');
    }

    if (S.regStep === 2 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) {
      throw new Error('Enter a valid email address.');
    }

    if (S.regStep === 3) {
      if (d.password.length < 10 || !/[A-Za-z]/.test(d.password) || !/\d/.test(d.password)) {
        throw new Error('Password must be at least 10 characters and include letters and numbers.');
      }

      if (d.password !== d.confirmPassword) {
        throw new Error('Passwords do not match.');
      }

      if (!/^\d{4,6}$/.test(d.pin)) {
        throw new Error('Transaction PIN must contain 4 to 6 digits.');
      }

      if (d.pin !== d.confirmPin) {
        throw new Error('Transaction PINs do not match.');
      }
    }
  }

  /* ---------- events ---------- */

  const $$ = (s) => [...document.querySelectorAll(s)];

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;

    const a = el.dataset.act;

    if (a === 'overlay') {
      if (e.target === el) closeSheet();
      return;
    }

    const go = (v) => {
      S.view = v;
      closeSheet();
      render();
      window.scrollTo(0, 0);
    };

    const actions = {
      theme: toggleTheme,
      close: closeSheet,
      go: () => go(el.dataset.view),
      history: () => go('history'),
      logout: () => logout(),
      hide: () => {
        S.hide = !S.hide;
        store.set('hide', S.hide ? '1' : '0');
        render();
      },
      switch: () => {
        S.authMode = S.authMode === 'login' ? 'register' : 'login';
        S.error = '';
        S.regStep = 1;
        S.regData = {};
        S.faceCaptured = false;
        stopFaceCamera();
        render();
      },
      'reg-back': () => {
        saveRegInputs();
        S.regStep = Math.max(1, S.regStep - 1);
        S.error = '';
        render();
      },
      'camera-start': startFaceCamera,
      'camera-capture': captureFace,
      topup: sheetTopup,
      tovault: () => sheetTransfer(false),
      tobank: () => sheetTransfer(true),
      save: () => sheetSave(false),
      unsave: () => sheetSave(true),
      more: sheetMore,
      bill: () => sheetBill(el.dataset.cat),
      pick: () => {
        $$('.chip').forEach(c => c.classList.remove('on'));
        el.classList.add('on');

        const providers = $('#providers');
        if (providers) providers.dataset.value = el.dataset.p;
      },
      copy: () => {
        navigator.clipboard?.writeText(S.user.accountNumber)
          .then(() => toast('Account number copied'))
          .catch(() => toast(S.user.accountNumber));
      }
    };

    if (actions[a]) actions[a]();
  });

  // Internal Fubs account lookup.
  document.addEventListener('input', async (e) => {
    if (e.target.id !== 'acct' || $('#bankCode')) return;

    const box = $('#recipient');
    const value = e.target.value.replace(/\D/g, '');

    if (value.length !== 10) {
      if (box) box.innerHTML = '';
      return;
    }

    try {
      const result = await api('/api/lookup?account=' + value);

      if (e.target.value.replace(/\D/g, '') === value && box) {
        box.innerHTML = `<div class="recipient">
          <strong>${esc(result.name)}</strong><br>
          ${esc(result.bankName)} · ${esc(result.accountNumber)}
        </div>`;
      }
    } catch (err) {
      if (box) box.innerHTML = `<div class="err">${esc(err.message)}</div>`;
    }
  });

  // Format naira amounts with thousands separators and two decimal places.
  document.addEventListener('focusin', (e) => {
    if (e.target.id === 'amt') {
      e.target.value = e.target.value.replace(/,/g, '');
    }
  });

  document.addEventListener('focusout', (e) => {
    if (e.target.id !== 'amt') return;

    const raw = e.target.value.trim().replace(/,/g, '');
    if (!/^\d+(?:\.\d{0,2})?$/.test(raw) || raw === '') return;

    const number = Number(raw);

    if (Number.isFinite(number)) {
      e.target.value = number.toLocaleString('en-NG', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });
    }
  });

  document.addEventListener('submit', async (e) => {
    e.preventDefault();

    const f = e.target;
    const btn = f.querySelector('button.btn');
    const val = (id) => (f.querySelector('#' + id)?.value || '').trim();

    if (btn) btn.disabled = true;

    try {
      if (f.id === 'auth-form') {
        S.busy = true;
        S.error = '';

        const result = await api('/api/auth/login', 'POST', {
          identifier: val('identifier'),
          password: f.querySelector('#password').value
        });

        S.token = result.token;
        store.set('token', result.token);
        S.user = result.user;
        S.view = 'home';
        S.busy = false;
        S.txs = await api('/api/transactions');

        render();
        toast(`Welcome back, ${result.user.firstName}`);
        return;
      }

      if (f.id === 'register-step-form') {
        S.error = '';

        try {
          validateRegStep();
        } catch (err) {
          S.error = err.message;
          render();
          return;
        }

        if (S.regStep < 4) {
          S.regStep++;
          render();
          return;
        }

        if (!S.faceCaptured) {
          throw new Error('Open the camera and capture a selfie first.');
        }

        if (!$('#terms')?.checked) {
          throw new Error('Please accept the demo terms to continue.');
        }

        S.regData.terms = true;
        S.busy = true;
        render();

        const d = S.regData;

        const payload = {
          firstName: d.firstName,
          middleName: d.middleName,
          lastName: d.lastName,
          dob: d.dob,
          gender: d.gender,
          phone: d.phone,
          email: d.email,
          address: d.address,
          city: d.city,
          state: d.state,
          country: d.country,
          occupation: d.occupation,
          sourceOfFunds: d.sourceOfFunds,
          accountPurpose: d.accountPurpose,
          nextOfKin: d.nextOfKin,
          nextOfKinPhone: d.nextOfKinPhone,
          password: d.password,
          pin: d.pin,
          faceCaptureCompleted: S.faceCaptured
        };

        const result = await api('/api/auth/register', 'POST', payload);

        stopFaceCamera();

        S.token = result.token;
        store.set('token', result.token);
        S.user = result.user;
        S.view = 'home';
        S.busy = false;
        S.regData = {};
        S.regStep = 1;
        S.faceCaptured = false;
        S.txs = await api('/api/transactions');

        render();
        toast(`Welcome, ${result.user.firstName}! Demo account created.`);
        return;
      }

      const kind = f.dataset.form;
      const amount = val('amt');

      if (kind === 'transfer' && f.dataset.external === 'true') {
        const bankCode = val('bankCode');
        const accountNumber = val('acct').replace(/\D/g, '');
        const box = $('#recipient');

        if (box) box.innerHTML = '';

        if (!bankCode) throw new Error('Please select the recipient bank.');

        if (!/^\d{10}$/.test(accountNumber)) {
          throw new Error('Enter a valid 10-digit account number.');
        }

        const result = await api(
          '/api/resolve-account?' +
          new URLSearchParams({ accountNumber, bankCode }).toString()
        );

        if (box) {
          box.innerHTML = `<div class="recipient">
            <strong>${esc(result.account.accountName)}</strong><br>
            ${esc(accountNumber)} · Verified by Paystack
          </div>
          <p class="sub">Account details verified. This demo has not sent money.</p>`;
        }

        toast('Account name verified');

        if (btn) btn.disabled = false;
        return;
      }

      const calls = {
        topup: () => api('/api/topup', 'POST', { amount }),
        transfer: () => api('/api/transfer', 'POST', {
          amount,
          accountNumber: val('acct'),
          note: val('note')
        }),
        save: () => api('/api/save', 'POST', {
          amount,
          direction: f.dataset.dir
        }),
        bill: () => api('/api/bills', 'POST', {
          amount,
          category: f.dataset.cat,
          provider: $('#providers')?.dataset.value || '',
          target: val('target')
        })
      };

      if (!calls[kind]) throw new Error('Unknown action.');

      S.user = await calls[kind]();
      S.txs = await api('/api/transactions');

      closeSheet();
      render();
      toast('Done ✓');
    } catch (err) {
      if (f.id === 'auth-form' || f.id === 'register-step-form') {
        S.error = err.message;
        S.busy = false;
        render();
      } else {
        sheetErr(err.message);
        if (btn) btn.disabled = false;
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheet();
  });

  load();
}

/* ================= WEB SERVER ================= */

const PAGES = {
  '/': ['text/html; charset=utf-8', INDEX_HTML],
  '/styles.css': ['text/css', STYLES_CSS],
  '/theme.js': ['text/javascript', THEME_JS],
  '/app.js': ['text/javascript', '(' + clientApp.toString() + ')();']
};

const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'"
};

const send = (res, status, data, headers = {}) => {
  const body =
    typeof data === 'string' || Buffer.isBuffer(data)
      ? data
      : JSON.stringify(data);

  res.writeHead(status, { ...SEC, ...headers });
  res.end(body);
};

const readBody = (req) => new Promise((resolve, reject) => {
  let s = '';

  req.on('data', (chunk) => {
    s += chunk;

    if (s.length > 1e5) {
      reject(new HttpError(413, 'Request body too large'));
      req.destroy();
    }
  });

  req.on('end', () => {
    try {
      resolve(s ? JSON.parse(s) : {});
    } catch {
      reject(new HttpError(400, 'Invalid JSON'));
    }
  });

  req.on('error', reject);
});

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  try {
    if (url.pathname.startsWith('/api/')) {
      const r = routes[`${req.method} ${url.pathname}`];

      if (!r) throw new HttpError(404, 'Not found');

      let uid = null;

      if (r.auth) {
        uid = verifyToken(
          (req.headers.authorization || '').replace(/^Bearer /, '')
        );

        if (!uid || !profile(uid)) {
          throw new HttpError(401, 'Please log in again');
        }
      }

      const body = req.method === 'POST' ? await readBody(req) : {};

      const out = await r.fn({
        uid,
        body,
        query: url.searchParams,
        ip: req.socket.remoteAddress
      });

      return send(
        res,
        out.status || 200,
        out.data,
        {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store'
        }
      );
    }

    const page = PAGES[url.pathname] || PAGES['/'];

    return send(res, 200, page[1], {
      'Content-Type': page[0]
    });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);

    return send(
      res,
      err.status || 500,
      {
        error: err instanceof HttpError
          ? err.message
          : 'Something went wrong'
      },
      { 'Content-Type': 'application/json' }
    );
  }
}).listen(PORT, () => {
  console.log(
    `Fubs Online Banking running on http://localhost:${PORT} (demo app, not a real bank)`
  );
});