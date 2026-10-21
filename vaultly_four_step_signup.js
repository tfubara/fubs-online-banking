'use strict';

/*
  FUBS ONLINE BANKING
  Demo banking application: backend + frontend in one file.
  Requires Node.js 22.5 or newer.

  Run:
  node --no-warnings vaultly_four_step_signup.js

  Open:
  http://localhost:3000

  IMPORTANT:
  This is a demonstration application, not a real bank.
*/

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

/* ================= DATABASE ================= */

fs.mkdirSync(path.join(__dirname, 'data'), {
  recursive: true
});

const db = new DatabaseSync(
  path.join(__dirname, 'data', 'bank-v2.db')
);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  first_name TEXT NOT NULL,
  middle_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL,
  dob TEXT NOT NULL,
  gender TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT 'Nigeria',
  occupation TEXT NOT NULL DEFAULT '',
  source_of_funds TEXT NOT NULL DEFAULT '',
  account_purpose TEXT NOT NULL DEFAULT '',
  next_of_kin TEXT NOT NULL DEFAULT '',
  next_of_kin_phone TEXT NOT NULL DEFAULT '',
  face_capture_completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  account_number TEXT NOT NULL UNIQUE,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  savings INTEGER NOT NULL DEFAULT 0 CHECK (savings >= 0)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  direction TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  counterparty TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tx_user
ON transactions(user_id, id DESC);
`);

/* ================= TRANSACTION SAFETY ================= */

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');

  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/* ================= CONFIGURATION ================= */

const PORT = process.env.PORT || 3000;

const SECRET =
  process.env.JWT_SECRET ||
  crypto.randomBytes(32).toString('hex');

if (!process.env.JWT_SECRET) {
  console.warn(
    'Warning: JWT_SECRET is not configured. Sessions may reset after restart.'
  );
}

const DEMO_TOPUP = process.env.DEMO_TOPUP !== 'false';

const MAX_TX_NAIRA = 5_000_000;

/* ================= ERROR HANDLING ================= */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ================= SECURITY HELPERS ================= */

const b64 = (value) =>
  Buffer.from(value).toString('base64url');

const hmac = (value, key = SECRET) =>
  crypto
    .createHmac('sha256', key)
    .update(value)
    .digest('base64url');

function signToken(userId) {
  const payload = b64(
    JSON.stringify({
      uid: userId,
      exp: Date.now() + 7 * 86400000
    })
  );

  return `${payload}.${hmac(payload)}`;
}

function verifyToken(token) {
  try {
    const [payload, signature] = String(token || '').split('.');

    if (!payload || !signature) {
      return null;
    }

    const expected = hmac(payload);

    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);

    if (
      actualBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      return null;
    }

    const data = JSON.parse(
      Buffer.from(payload, 'base64url').toString()
    );

    if (data.exp <= Date.now()) {
      return null;
    }

    return data.uid;
  } catch {
    return null;
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);

  const hash = crypto.scryptSync(
    password,
    salt,
    64
  );

  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function checkPassword(password, stored) {
  try {
    const [salt, savedHash] = stored.split(':');

    const calculatedHash = crypto.scryptSync(
      password,
      Buffer.from(salt, 'hex'),
      64
    );

    const savedBuffer = Buffer.from(savedHash, 'hex');

    return (
      calculatedHash.length === savedBuffer.length &&
      crypto.timingSafeEqual(calculatedHash, savedBuffer)
    );
  } catch {
    return false;
  }
}

function referenceNumber() {
  return (
    'TX' +
    Date.now().toString(36).toUpperCase() +
    crypto.randomBytes(3).toString('hex').toUpperCase()
  );
}

/* ================= PHONE VALIDATION ================= */

function normalizePhone(phone) {
  let value = String(phone || '').replace(/[\s-]/g, '');

  if (value.startsWith('+234')) {
    value = '0' + value.slice(4);
  } else if (
    value.startsWith('234') &&
    value.length === 13
  ) {
    value = '0' + value.slice(3);
  }

  return /^0[789][01]\d{8}$/.test(value)
    ? value
    : null;
}

/* ================= AGE CALCULATION ================= */

function calculateAge(dob) {
  const birthDate = new Date(dob);
  const today = new Date();

  let age = today.getFullYear() - birthDate.getFullYear();

  const birthdayHasNotOccurred =
    today.getMonth() < birthDate.getMonth() ||
    (
      today.getMonth() === birthDate.getMonth() &&
      today.getDate() < birthDate.getDate()
    );

  if (birthdayHasNotOccurred) {
    age--;
  }

  return age;
}

/* ================= MONEY FORMATTING ================= */

// Store amounts in integer kobo to avoid floating-point money errors.

function formatMoney(kobo) {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(kobo) / 100);
}

function toKobo(value) {
  const raw = String(value ?? '')
    .trim()
    .replace(/,/g, '');

  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) {
    throw new HttpError(
      400,
      'Enter a valid amount, using no more than two decimal places.'
    );
  }

  const [whole, fraction = ''] = raw.split('.');

  const naira = Number(whole);

  if (
    !Number.isSafeInteger(naira) ||
    naira <= 0
  ) {
    throw new HttpError(
      400,
      'Enter an amount greater than zero.'
    );
  }

  if (
    naira > MAX_TX_NAIRA ||
    (
      naira === MAX_TX_NAIRA &&
      Number(fraction) > 0
    )
  ) {
    throw new HttpError(
      400,
      `Maximum demo transaction is ₦${MAX_TX_NAIRA.toLocaleString('en-NG')}.00`
    );
  }

  return (
    naira * 100 +
    Number((fraction + '00').slice(0, 2))
  );
}

/* ================= ACCOUNT NUMBERS ================= */

function newAccountNumber() {
  for (;;) {
    const number =
      '30' +
      String(crypto.randomInt(0, 100000000))
        .padStart(8, '0');

    const exists = db.prepare(
      'SELECT 1 FROM accounts WHERE account_number = ?'
    ).get(number);

    if (!exists) {
      return number;
    }
  }
}

/* ================= CUSTOMER PROFILE ================= */

function getProfile(userId) {
  const user = db.prepare(`
    SELECT
      u.*,
      a.account_number,
      a.balance,
      a.savings
    FROM users u
    JOIN accounts a ON a.user_id = u.id
    WHERE u.id = ?
  `).get(userId);

  if (!user) {
    return null;
  }

  return {
    id: user.id,

    fullName: [
      user.first_name,
      user.middle_name,
      user.last_name
    ].filter(Boolean).join(' '),

    firstName: user.first_name,
    middleName: user.middle_name,
    lastName: user.last_name,

    dob: user.dob,
    age: calculateAge(user.dob),
    gender: user.gender,

    phone: user.phone,
    email: user.email,

    address: user.address,
    city: user.city,
    state: user.state,
    country: user.country,

    occupation: user.occupation,
    sourceOfFunds: user.source_of_funds,
    accountPurpose: user.account_purpose,

    nextOfKin: user.next_of_kin,
    nextOfKinPhone: user.next_of_kin_phone,

    faceCaptureCompleted:
      Boolean(user.face_capture_completed),

    accountNumber: user.account_number,

    // Amounts are returned in kobo.
    balance: user.balance,
    savings: user.savings,

    formattedBalance: formatMoney(user.balance),
    formattedSavings: formatMoney(user.savings)
  };
}

/* ================= RATE LIMITING ================= */

const requestHits = new Map();

function limitRequests(key, maximum, duration) {
  const now = Date.now();

  const recent = (
    requestHits.get(key) || []
  ).filter((time) => now - time < duration);

  recent.push(now);
  requestHits.set(key, recent);

  if (recent.length > maximum) {
    throw new HttpError(
      429,
      'Too many attempts. Please wait and try again.'
    );
  }
}

setInterval(() => {
  const now = Date.now();

  for (const [key, times] of requestHits) {
    if (!times.some((time) => now - time < 3600000)) {
      requestHits.delete(key);
    }
  }
}, 600000).unref();

/* ================= API ROUTES ================= */

const routes = {};

function route(method, url, requiresAuth, handler) {
  routes[`${method} ${url}`] = {
    requiresAuth,
    handler
  };
}

/* ================= REGISTRATION ================= */

route(
  'POST',
  '/api/auth/register',
  false,
  async ({ body, ip }) => {
    limitRequests('register:' + ip, 10, 3600000);

    const firstName = String(body.firstName || '').trim();
    const middleName = String(body.middleName || '').trim();
    const lastName = String(body.lastName || '').trim();

    const dob = String(body.dob || '').trim();
    const gender = String(body.gender || '').trim();

    const phone = normalizePhone(body.phone);

    const email = String(body.email || '')
      .trim()
      .toLowerCase();

    const password = String(body.password || '');
    const pin = String(body.pin || '');

    const address = String(body.address || '').trim();
    const city = String(body.city || '').trim();
    const state = String(body.state || '').trim();

    const country = String(body.country || 'Nigeria').trim();

    const occupation = String(body.occupation || '').trim();

    const sourceOfFunds =
      String(body.sourceOfFunds || '').trim();

    const accountPurpose =
      String(body.accountPurpose || '').trim();

    const nextOfKin =
      String(body.nextOfKin || '').trim();

    const nextOfKinPhone =
      normalizePhone(body.nextOfKinPhone);

    if (!firstName || !lastName || !dob || !gender) {
      throw new HttpError(
        400,
        'Complete all required personal information.'
      );
    }

    if (!phone) {
      throw new HttpError(
        400,
        'Enter a valid Nigerian phone number.'
      );
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new HttpError(
        400,
        'Enter a valid email address.'
      );
    }

    if (
      !address ||
      !city ||
      !state ||
      !country ||
      !occupation ||
      !sourceOfFunds ||
      !accountPurpose ||
      !nextOfKin ||
      !nextOfKinPhone
    ) {
      throw new HttpError(
        400,
        'Complete all required contact and profile fields.'
      );
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
      throw new HttpError(
        400,
        'Transaction PIN must contain 4 to 6 digits.'
      );
    }

    if (body.faceCaptureCompleted !== true) {
      throw new HttpError(
        400,
        'Complete the camera selfie step before creating the demo account.'
      );
    }

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(dob) ||
      Number.isNaN(Date.parse(dob)) ||
      calculateAge(dob) < 18
    ) {
      throw new HttpError(
        403,
        'You must be at least 18 years old to open this demo account.'
      );
    }

    const duplicate = db.prepare(`
      SELECT 1
      FROM users
      WHERE phone = ? OR email = ?
    `).get(phone, email);

    if (duplicate) {
      throw new HttpError(
        409,
        'An account already exists with this phone number or email.'
      );
    }

    const userId = tx(() => {
      const result = db.prepare(`
        INSERT INTO users (
          phone,
          email,
          password_hash,
          pin_hash,
          first_name,
          middle_name,
          last_name,
          dob,
          gender,
          address,
          city,
          state,
          country,
          occupation,
          source_of_funds,
          account_purpose,
          next_of_kin,
          next_of_kin_phone,
          face_capture_completed
        )
        VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
        )
      `).run(
        phone,
        email,
        hashPassword(password),
        hashPassword(pin),
        firstName,
        middleName,
        lastName,
        dob,
        gender,
        address,
        city,
        state,
        country,
        occupation,
        sourceOfFunds,
        accountPurpose,
        nextOfKin,
        nextOfKinPhone
      );

      db.prepare(`
        INSERT INTO accounts (
          user_id,
          account_number
        )
        VALUES (?, ?)
      `).run(
        result.lastInsertRowid,
        newAccountNumber()
      );

      return Number(result.lastInsertRowid);
    });

    return {
      status: 201,
      data: {
        token: signToken(userId),
        user: getProfile(userId)
      }
    };
  }
);

/* ================= LOGIN ================= */

route(
  'POST',
  '/api/auth/login',
  false,
  async ({ body, ip }) => {
    limitRequests('login:' + ip, 15, 15 * 60000);

    const identifier = String(body.identifier || '')
      .trim()
      .toLowerCase();

    const user = db.prepare(`
      SELECT *
      FROM users
      WHERE email = ? OR phone = ?
    `).get(
      identifier,
      normalizePhone(identifier) || '__none__'
    );

    if (
      !user ||
      !checkPassword(
        String(body.password || ''),
        user.password_hash
      )
    ) {
      throw new HttpError(
        401,
        'Incorrect login details.'
      );
    }

    return {
      data: {
        token: signToken(user.id),
        user: getProfile(user.id)
      }
    };
  }
);

/* ================= CURRENT CUSTOMER ================= */

route(
  'GET',
  '/api/me',
  true,
  ({ userId }) => ({
    data: getProfile(userId)
  })
);

/* ================= TRANSACTION HISTORY ================= */

route(
  'GET',
  '/api/transactions',
  true,
  ({ userId, query }) => {
    const requestedLimit = Number(query.get('limit')) || 50;

    const limit = Math.min(
      Math.max(requestedLimit, 1),
      200
    );

    const transactions = db.prepare(`
      SELECT
        id,
        type,
        direction,
        amount,
        balance_after,
        counterparty,
        description,
        reference,
        created_at
      FROM transactions
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(userId, limit);

    return {
      data: transactions.map((item) => ({
        ...item,
        formattedAmount: formatMoney(item.amount),
        formattedBalance: formatMoney(item.balance_after)
      }))
    };
  }
);

/* ================= ACCOUNT NUMBER LOOKUP ================= */

// Searches the database for the recipient's account number.
// Only returns the account name and account number.

route(
  'GET',
  '/api/lookup',
  true,
  ({ query }) => {
    const accountNumber = String(
      query.get('account') || ''
    ).trim();

    if (!/^\d{10}$/.test(accountNumber)) {
      throw new HttpError(
        400,
        'Enter a valid 10-digit account number.'
      );
    }

    const recipient = db.prepare(`
      SELECT
        a.account_number,
        u.first_name,
        u.middle_name,
        u.last_name
      FROM accounts a
      JOIN users u ON u.id = a.user_id
      WHERE a.account_number = ?
    `).get(accountNumber);

    if (!recipient) {
      throw new HttpError(
        404,
        'Account not found. Check the account number.'
      );
    }

    return {
      data: {
        accountNumber: recipient.account_number,
        name: [
          recipient.first_name,
          recipient.middle_name,
          recipient.last_name
        ].filter(Boolean).join(' '),
        bankName: 'Fubs Online Banking'
      }
    };
  }
);

/* ================= DEMO DEPOSIT ================= */

// This simulates funding a demo account.
// It does not charge a card or receive real money.

route(
  'POST',
  '/api/topup',
  true,
  ({ userId, body }) => {
    if (!DEMO_TOPUP) {
      throw new HttpError(
        501,
        'Real funding requires an authorised payment gateway.'
      );
    }

    const amount = toKobo(body.amount);
    const reference = referenceNumber();

    tx(() => {
      const account = db.prepare(`
        SELECT balance
        FROM accounts
        WHERE user_id = ?
      `).get(userId);

      if (!account) {
        throw new HttpError(
          404,
          'Account not found.'
        );
      }

      db.prepare(`
        UPDATE accounts
        SET balance = balance + ?
        WHERE user_id = ?
      `).run(amount, userId);

      const updated = db.prepare(`
        SELECT balance
        FROM accounts
        WHERE user_id = ?
      `).get(userId);

      db.prepare(`
        INSERT INTO transactions (
          user_id,
          type,
          direction,
          amount,
          balance_after,
          counterparty,
          description,
          reference
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        'deposit',
        'credit',
        amount,
        updated.balance,
        'Demo funding',
        'Simulated account funding',
        reference
      );
    });

    return {
      data: getProfile(userId),
      message: 'Demo funding completed.',
      reference
    };
  }
);

/* ================= INTERNAL TRANSFERS ================= */

// Transfers money between two registered demo accounts.
// Both account updates and transaction records are committed
// together so that a failed transfer does not partially complete.

route(
  'POST',
  '/api/transfer',
  true,
  ({ userId, body }) => {
    limitRequests(
      'transfer:' + userId,
      20,
      60000
    );

    const accountNumber = String(
      body.accountNumber || ''
    ).trim();

    const amount = toKobo(body.amount);

    const note = String(
      body.note || ''
    ).trim().slice(0, 100);

    const pin = String(body.pin || '');

    if (!/^\d{10}$/.test(accountNumber)) {
      throw new HttpError(
        400,
        'Enter a valid 10-digit recipient account number.'
      );
    }

    if (!/^\d{4,6}$/.test(pin)) {
      throw new HttpError(
        400,
        'Enter your transaction PIN.'
      );
    }

    const senderUser = db.prepare(`
      SELECT id, pin_hash
      FROM users
      WHERE id = ?
    `).get(userId);

    if (
      !senderUser ||
      !checkPassword(pin, senderUser.pin_hash)
    ) {
      throw new HttpError(
        401,
        'Incorrect transaction PIN.'
      );
    }

    const reference = referenceNumber();

    tx(() => {
      const senderAccount = db.prepare(`
        SELECT *
        FROM accounts
        WHERE user_id = ?
      `).get(userId);

      const recipient = db.prepare(`
        SELECT
          a.user_id,
          a.account_number,
          a.balance,
          u.first_name,
          u.middle_name,
          u.last_name
        FROM accounts a
        JOIN users u ON u.id = a.user_id
        WHERE a.account_number = ?
      `).get(accountNumber);

      if (!senderAccount) {
        throw new HttpError(
          404,
          'Your account could not be found.'
        );
      }

      if (!recipient) {
        throw new HttpError(
          404,
          'Recipient account not found.'
        );
      }

      if (recipient.user_id === userId) {
        throw new HttpError(
          400,
          'You cannot transfer money to your own account.'
        );
      }

      if (senderAccount.balance < amount) {
        throw new HttpError(
          400,
          'Insufficient available balance.'
        );
      }

      const recipientName = [
        recipient.first_name,
        recipient.middle_name,
        recipient.last_name
      ].filter(Boolean).join(' ');

      const senderName = db.prepare(`
        SELECT first_name, last_name
        FROM users
        WHERE id = ?
      `).get(userId);

      const senderAccountName =
        `${senderName.first_name} ${senderName.last_name}`;

      // Debit the sender.
      db.prepare(`
        UPDATE accounts
        SET balance = balance - ?
        WHERE user_id = ?
      `).run(amount, userId);

      // Credit the recipient.
      db.prepare(`
        UPDATE accounts
        SET balance = balance + ?
        WHERE user_id = ?
      `).run(amount, recipient.user_id);

      const senderBalance = db.prepare(`
        SELECT balance
        FROM accounts
        WHERE user_id = ?
      `).get(userId).balance;

      const recipientBalance = db.prepare(`
        SELECT balance
        FROM accounts
        WHERE user_id = ?
      `).get(recipient.user_id).balance;

      // Record the sender's debit.
      db.prepare(`
        INSERT INTO transactions (
          user_id,
          type,
          direction,
          amount,
          balance_after,
          counterparty,
          description,
          reference
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        'transfer',
        'debit',
        amount,
        senderBalance,
        recipientName,
        note || 'Transfer to ' + recipientName,
        reference
      );

      // Record the recipient's credit.
      db.prepare(`
        INSERT INTO transactions (
          user_id,
          type,
          direction,
          amount,
          balance_after,
          counterparty,
          description,
          reference
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        recipient.user_id,
        'transfer',
        'credit',
        amount,
        recipientBalance,
        senderAccountName,
        note || 'Transfer from ' + senderAccountName,
        reference
      );
    });

    return {
      data: getProfile(userId),
      message: 'Transfer successful.',
      reference,
      amount: amount,
      formattedAmount: formatMoney(amount)
    };
  }
);

/* ================= SAVINGS ================= */

// Moves money between the main balance and the savings balance.
// This is an internal demo feature, not an interest-bearing deposit.

route(
  'POST',
  '/api/save',
  true,
  ({ userId, body }) => {
    const amount = toKobo(body.amount);

    const direction = String(
      body.direction || ''
    ).toLowerCase();

    if (!['save', 'withdraw'].includes(direction)) {
      throw new HttpError(
        400,
        'Choose whether to save or withdraw.'
      );
    }

    const reference = referenceNumber();

    tx(() => {
      const account = db.prepare(`
        SELECT balance, savings
        FROM accounts
        WHERE user_id = ?
      `).get(userId);

      if (!account) {
        throw new HttpError(
          404,
          'Account not found.'
        );
      }

      let newBalance;
      let newSavings;

      if (direction === 'save') {
        if (account.balance < amount) {
          throw new HttpError(
            400,
            'Insufficient balance to save this amount.'
          );
        }

        newBalance = account.balance - amount;
        newSavings = account.savings + amount;
      } else {
        if (account.savings < amount) {
          throw new HttpError(
            400,
            'Insufficient savings balance.'
          );
        }

        newBalance = account.balance + amount;
        newSavings = account.savings - amount;
      }

      db.prepare(`
        UPDATE accounts
        SET balance = ?, savings = ?
        WHERE user_id = ?
      `).run(
        newBalance,
        newSavings,
        userId
      );

      db.prepare(`
        INSERT INTO transactions (
          user_id,
          type,
          direction,
          amount,
          balance_after,
          counterparty,
          description,
          reference
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        direction === 'save' ? 'savings' : 'savings_withdrawal',
        direction === 'save' ? 'debit' : 'credit',
        amount,
        newBalance,
        'Fubs Savings',
        direction === 'save'
          ? 'Transfer to demo savings'
          : 'Withdrawal from demo savings',
        reference
      );
    });

    return {
      data: getProfile(userId),
      message: direction === 'save'
        ? 'Savings transfer completed.'
        : 'Savings withdrawal completed.',
      reference,
      formattedAmount: formatMoney(amount)
    };
  }
);

/* ================= DEMO BILL PAYMENTS ================= */

// Simulates a bill payment in the demo database.
// It does not contact a real electricity, internet or TV provider.

route(
  'POST',
  '/api/bills',
  true,
  ({ userId, body }) => {
    const amount = toKobo(body.amount);

    const category = String(
      body.category || ''
    ).trim().slice(0, 40);

    const provider = String(
      body.provider || ''
    ).trim().slice(0, 60);

    const target = String(
      body.target || ''
    ).trim().slice(0, 100);

    if (!category || !provider || !target) {
      throw new HttpError(
        400,
        'Enter the bill category, provider and customer reference.'
      );
    }

    const reference = referenceNumber();

    tx(() => {
      const account = db.prepare(`
        SELECT balance
        FROM accounts
        WHERE user_id = ?
      `).get(userId);

      if (!account) {
        throw new HttpError(
          404,
          'Account not found.'
        );
      }

      if (account.balance < amount) {
        throw new HttpError(
          400,
          'Insufficient balance for this payment.'
        );
      }

      db.prepare(`
        UPDATE accounts
        SET balance = balance - ?
        WHERE user_id = ?
      `).run(amount, userId);

      const updated = db.prepare(`
        SELECT balance
        FROM accounts
        WHERE user_id = ?
      `).get(userId);

      db.prepare(`
        INSERT INTO transactions (
          user_id,
          type,
          direction,
          amount,
          balance_after,
          counterparty,
          description,
          reference
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        'bill',
        'debit',
        amount,
        updated.balance,
        provider,
        `${category}: ${target}`,
        reference
      );
    });

    return {
      data: getProfile(userId),
      message: 'Demo bill payment completed.',
      reference,
      formattedAmount: formatMoney(amount)
    };
  }
);
/* ================= HTTP SERVER AND SECURITY ================= */

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self';"
    });

    res.end(JSON.stringify(data));
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        let rawBody = "";
        let size = 0;
        const maxSize = 1024 * 1024;

        req.on("data", chunk => {
            size += chunk.length;

            if (size > maxSize) {
                reject(new HttpError(413, "Request is too large."));
                req.destroy();
                return;
            }

            rawBody += chunk.toString("utf8");
        });

        req.on("end", () => {
            if (!rawBody.trim()) {
                resolve({});
                return;
            }

            try {
                resolve(JSON.parse(rawBody));
            } catch {
                reject(new HttpError(400, "Invalid JSON request."));
            }
        });

        req.on("error", reject);
    });
}

function getBearerToken(req) {
    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
        return null;
    }

    return authorization.slice(7).trim();
}

function sendHtml(res, html) {
    res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self';"
    });

    res.end(html);
}

const server = http.createServer(async (req, res) => {
    try {
        const requestUrl = new URL(
            req.url,
            `http://${req.headers.host || "localhost"}`
        );

        const pathname = requestUrl.pathname;
        const method = req.method.toUpperCase();

        // Handle browser preflight requests.
        if (method === "OPTIONS") {
            res.writeHead(204, {
                "Allow": "GET, POST, OPTIONS",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
                "Access-Control-Max-Age": "600",
                "X-Content-Type-Options": "nosniff"
            });

            res.end();
            return;
        }

        // Serve the frontend added in Part 4.
        if (
            method === "GET" &&
            (pathname === "/" || pathname === "/index.html")
        ) {
            sendHtml(res, FRONTEND_HTML);
            return;
        }

        // All other requests must match a registered API route.
        if (!pathname.startsWith("/api/")) {
            sendJson(res, 404, {
                success: false,
                message: "Page not found."
            });
            return;
        }

        const routeKey = `${method} ${pathname}`;
        const selectedRoute = routes[routeKey];

        if (!selectedRoute) {
            sendJson(res, 404, {
                success: false,
                message: "API endpoint not found."
            });
            return;
        }

        // Read request data.
        let body = {};

        if (method === "POST" || method === "PUT" || method === "PATCH") {
            const contentType = req.headers["content-type"] || "";

            if (!contentType.toLowerCase().includes("application/json")) {
                sendJson(res, 415, {
                    success: false,
                    message: "Content-Type must be application/json."
                });
                return;
            }

            body = await readRequestBody(req);
        }

        // Authenticate requests that require a logged-in user.
        let userId = null;

        if (selectedRoute.requiresAuth) {
            const token = getBearerToken(req);

            if (!token) {
                sendJson(res, 401, {
                    success: false,
                    message: "Please log in to continue."
                });
                return;
            }

            userId = verifyToken(token);

            if (!userId) {
                sendJson(res, 401, {
                    success: false,
                    message: "Your session is invalid or has expired. Please log in again."
                });
                return;
            }
        }

        // Execute the selected backend route.
        const result = await selectedRoute.handler({
            req,
            res,
            body,
            userId,
            query: Object.fromEntries(requestUrl.searchParams)
        });

        // A route can return its own response, for example after logging out.
        if (res.writableEnded) {
            return;
        }

        const statusCode =
            result && Number.isInteger(result.status)
                ? result.status
                : 200;

        const responseData =
            result && typeof result === "object"
                ? { ...result }
                : { data: result };

        delete responseData.status;

        sendJson(res, statusCode, responseData);

    } catch (error) {
        if (res.writableEnded || res.destroyed) {
            return;
        }

        const statusCode =
            Number.isInteger(error.statusCode)
                ? error.statusCode
                : Number.isInteger(error.status)
                    ? error.status
                    : 500;

        if (statusCode >= 500) {
            console.error("Server error:", error);
        }

        sendJson(res, statusCode, {
            success: false,
            message:
                statusCode >= 500
                    ? "A server error occurred. Please try again later."
                    : error.message || "The request could not be completed."
        });
    }
});

// Start the application.
server.listen(PORT, "127.0.0.1", () => {
    console.log("");
    console.log("========================================");
    console.log("       FUBS ONLINE BANKING");
    console.log("========================================");
    console.log(`Server running at http://127.0.0.1:${PORT}`);
    console.log("Database: SQLite");
    console.log("Mode: DEMO");
    console.log("");
    console.log("Press Ctrl + C to stop the server.");
});
/* ================= FUBS ONLINE BANKING FRONTEND ================= */

const FRONTEND_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Fubs Online Banking</title>

<style>
:root {
    --bg: #07111f;
    --panel: #0d1b2e;
    --panel2: #11233a;
    --blue: #1685ff;
    --blue2: #0066dd;
    --text: #f4f7fb;
    --muted: #9aabc0;
    --border: #263c56;
    --green: #20c997;
    --red: #ff6878;
}

* {
    box-sizing: border-box;
}

body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: Arial, Helvetica, sans-serif;
    min-height: 100vh;
}

button, input, select, textarea {
    font: inherit;
}

button {
    cursor: pointer;
}

button:disabled {
    opacity: .55;
    cursor: not-allowed;
}

.hidden {
    display: none !important;
}

.muted {
    color: var(--muted);
}

.small {
    font-size: 12px;
    line-height: 1.6;
}

.topbar {
    min-height: 76px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 15px;
    padding: 16px 5%;
    border-bottom: 1px solid var(--border);
    background: #081525;
}

.brand {
    display: flex;
    align-items: center;
    gap: 12px;
    font-weight: 800;
    font-size: 19px;
}

.brand-icon {
    display: grid;
    place-items: center;
    width: 43px;
    height: 43px;
    border-radius: 13px;
    background: var(--blue);
    color: white;
    font-size: 22px;
}

.brand span:last-child {
    color: var(--blue);
}

.container {
    width: min(1150px, 92%);
    margin: 30px auto;
}

.panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 17px;
    padding: 24px;
    margin-bottom: 20px;
}

h1, h2, h3, p {
    margin-top: 0;
}

h1 {
    font-size: clamp(26px, 4vw, 38px);
}

h2 {
    font-size: 21px;
}

h3 {
    font-size: 16px;
}

.subtitle {
    color: var(--muted);
    line-height: 1.7;
}

.grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
}

.grid-three {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
}

label {
    display: block;
    margin-bottom: 7px;
    font-size: 13px;
    font-weight: 700;
    color: #dce7f4;
}

input, select, textarea {
    width: 100%;
    padding: 13px 14px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: #071525;
    color: var(--text);
    outline: none;
}

input:focus, select:focus, textarea:focus {
    border-color: var(--blue);
    box-shadow: 0 0 0 3px #1685ff20;
}

.field {
    margin-bottom: 16px;
    min-width: 0;
}

.btn {
    border: 0;
    border-radius: 10px;
    padding: 13px 17px;
    font-weight: 700;
    transition: .2s;
}

.btn-primary {
    background: var(--blue);
    color: white;
}

.btn-primary:hover {
    background: var(--blue2);
}

.btn-secondary {
    background: var(--panel2);
    color: var(--text);
    border: 1px solid var(--border);
}

.btn-danger {
    background: #692735;
    color: white;
}

.btn-block {
    width: 100%;
}

.btn-row {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
}

.link-button {
    border: none;
    background: none;
    color: #5eaeff;
    cursor: pointer;
    padding: 5px;
    font-weight: 700;
}

.notice {
    padding: 13px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: #0a1727;
    color: var(--muted);
    line-height: 1.6;
    font-size: 13px;
    margin-bottom: 16px;
}

.message {
    padding: 13px;
    border-radius: 10px;
    margin-bottom: 16px;
    line-height: 1.5;
}

.message.success {
    color: #8af0cf;
    background: #0a302a;
    border: 1px solid #17614d;
}

.message.error {
    color: #ffb6bf;
    background: #35151c;
    border: 1px solid #71303b;
}

.message.info {
    color: #b8d9ff;
    background: #102b48;
    border: 1px solid #254e79;
}

.tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 24px;
    flex-wrap: wrap;
}

.tab {
    border: 1px solid var(--border);
    background: var(--panel2);
    color: var(--muted);
    border-radius: 9px;
    padding: 11px 14px;
}

.tab.active {
    color: white;
    background: var(--blue2);
    border-color: var(--blue);
}

.balance-panel {
    background: linear-gradient(135deg, #0759b5, #102c62);
    border: 1px solid #277de2;
    border-radius: 18px;
    padding: 25px;
    min-height: 190px;
    margin-bottom: 20px;
}

.balance-amount {
    font-size: clamp(28px, 5vw, 42px);
    font-weight: 800;
    margin: 18px 0;
    overflow-wrap: anywhere;
}

.account-number {
    letter-spacing: 2px;
    font-size: 18px;
    font-weight: 700;
}

.stat {
    background: var(--panel);
    border: 1px solid var(--border);
    padding: 19px;
    border-radius: 14px;
    min-width: 0;
}

.stat strong {
    display: block;
    font-size: 21px;
    margin-top: 10px;
    overflow-wrap: anywhere;
}

.action-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 20px;
}

.section {
    display: none;
}

.section.active {
    display: block;
}

.table-wrap {
    width: 100%;
    overflow-x: auto;
}

table {
    width: 100%;
    border-collapse: collapse;
    min-width: 560px;
}

th, td {
    padding: 14px 12px;
    border-bottom: 1px solid var(--border);
    text-align: left;
    font-size: 13px;
}

th {
    color: var(--muted);
}

.positive {
    color: var(--green);
}

.negative {
    color: var(--red);
}

footer {
    text-align: center;
    padding: 25px;
    color: var(--muted);
    font-size: 12px;
}

.camera-box {
    border: 1px dashed #45627f;
    padding: 15px;
    border-radius: 12px;
    margin-bottom: 16px;
}

#cameraVideo, #capturedImage {
    width: 100%;
    max-width: 400px;
    display: block;
    margin: 12px auto;
    border-radius: 10px;
    background: #03080f;
}

@media (max-width: 750px) {
    .grid-three {
        grid-template-columns: 1fr;
    }

    .grid, .action-grid {
        grid-template-columns: 1fr;
    }

    .panel {
        padding: 18px;
    }

    .topbar {
        padding: 14px 4%;
    }

    .container {
        margin-top: 20px;
    }
}
</style>
</head>

<body>

<header class="topbar">
    <div class="brand">
        <div class="brand-icon">F</div>
        <div>FUBS <span>ONLINE BANKING</span></div>
    </div>

    <div id="headerActions">
        <button class="btn btn-secondary" id="headerLogin"
                onclick="showAuth('login')">Login</button>
    </div>
</header>

<main class="container">

    <div id="globalMessage"></div>

    <!-- LOGIN AND REGISTRATION -->

    <section id="authView">

        <div class="panel" id="welcomePanel">
            <h1>Banking made simple.</h1>
            <p class="subtitle">
                Welcome to Fubs Online Banking. Manage your demo account,
                explore transactions and practise digital banking.
            </p>

            <div class="notice">
                DEMO APPLICATION: This website does not connect to real banks,
                verify identity documents, or send real money.
                Use fictional information only.
            </div>
        </div>

        <div class="panel">
            <div class="tabs">
                <button class="tab active" id="loginTab"
                        onclick="showAuth('login')">Login</button>

                <button class="tab" id="registerTab"
                        onclick="showAuth('register')">Create account</button>
            </div>

            <!-- LOGIN FORM -->

            <form id="loginForm">
                <h2>Welcome back</h2>
                <p class="subtitle">Log in to your demo account.</p>

                <div class="field">
                    <label for="loginIdentifier">Email or phone number</label>
                    <input id="loginIdentifier" required
                           autocomplete="username"
                           placeholder="Enter your email or phone">
                </div>

                <div class="field">
                    <label for="loginPassword">Password</label>
                    <input id="loginPassword" type="password" required
                           autocomplete="current-password"
                           placeholder="Enter your password">
                </div>

                <button class="btn btn-primary btn-block" type="submit">
                    Login securely
                </button>

                <p class="small muted" style="margin-top:15px">
                    New here?
                    <button type="button" class="link-button"
                            onclick="showAuth('register')">
                        Create a demo account
                    </button>
                </p>
            </form>

            <!-- REGISTRATION FORM -->

            <form id="registerForm" class="hidden">
                <h2>Create your demo account</h2>
                <p class="subtitle">
                    Complete the following details to create an account.
                </p>

                <div class="notice">
                    You must be at least 18 to use this demo registration flow.
                    Do not enter a real NIN, real bank PIN, or sensitive identity
                    information.
                </div>

                <h3>Step 1 — Personal information</h3>

                <div class="grid">
                    <div class="field">
                        <label for="firstName">First name</label>
                        <input id="firstName" required maxlength="60">
                    </div>

                    <div class="field">
                        <label for="middleName">Middle name (optional)</label>
                        <input id="middleName" maxlength="60">
                    </div>

                    <div class="field">
                        <label for="lastName">Last name</label>
                        <input id="lastName" required maxlength="60">
                    </div>

                    <div class="field">
                        <label for="dob">Date of birth</label>
                        <input id="dob" type="date" required>
                    </div>

                    <div class="field">
                        <label for="gender">Gender</label>
                        <select id="gender" required>
                            <option value="">Select</option>
                            <option value="Male">Male</option>
                            <option value="Female">Female</option>
                            <option value="Other">Other</option>
                            <option value="Prefer not to say">Prefer not to say</option>
                        </select>
                    </div>

                    <div class="field">
                        <label for="occupation">Occupation</label>
                        <input id="occupation" required maxlength="100">
                    </div>
                </div>

                <h3>Step 2 — Contact information</h3>

                <div class="grid">
                    <div class="field">
                        <label for="phone">Phone number</label>
                        <input id="phone" type="tel" required
                               autocomplete="tel"
                               placeholder="e.g. 08012345678">
                    </div>

                    <div class="field">
                        <label for="email">Email address</label>
                        <input id="email" type="email" required
                               autocomplete="email">
                    </div>

                    <div class="field">
                        <label for="address">Address</label>
                        <input id="address" required maxlength="200">
                    </div>

                    <div class="field">
                        <label for="city">City or town</label>
                        <input id="city" required maxlength="100">
                    </div>

                    <div class="field">
                        <label for="state">State</label>
                        <input id="state" required maxlength="100">
                    </div>

                    <div class="field">
                        <label for="country">Country</label>
                        <input id="country" value="Nigeria" required maxlength="100">
                    </div>
                </div>

                <h3>Step 3 — Account information</h3>

                <div class="grid">
                    <div class="field">
                        <label for="sourceOfFunds">Source of funds</label>
                        <select id="sourceOfFunds" required>
                            <option value="">Select source</option>
                            <option value="Salary">Salary</option>
                            <option value="Business">Business</option>
                            <option value="Personal savings">Personal savings</option>
                            <option value="Family support">Family support</option>
                            <option value="Other">Other</option>
                        </select>
                    </div>

                    <div class="field">
                        <label for="accountPurpose">Purpose of account</label>
                        <select id="accountPurpose" required>
                            <option value="">Select purpose</option>
                            <option value="Personal use">Personal use</option>
                            <option value="Savings">Savings</option>
                            <option value="Business use">Business use</option>
                            <option value="School expenses">School expenses</option>
                        </select>
                    </div>

                    <div class="field">
                        <label for="nextOfKin">Next of kin name</label>
                        <input id="nextOfKin" required maxlength="120">
                    </div>

                    <div class="field">
                        <label for="nextOfKinPhone">Next of kin phone</label>
                        <input id="nextOfKinPhone" type="tel" required>
                    </div>
                </div>

                <h3>Step 4 — Security</h3>

                <div class="grid">
                    <div class="field">
                        <label for="registerPassword">Create password</label>
                        <input id="registerPassword" type="password"
                               minlength="10" maxlength="128"
                               autocomplete="new-password" required>
                        <p class="small muted">
                            Use at least 10 characters for this demo.
                        </p>
                    </div>

                    <div class="field">
                        <label for="confirmPassword">Confirm password</label>
                        <input id="confirmPassword" type="password"
                               minlength="10" maxlength="128"
                               autocomplete="new-password" required>
                    </div>

                    <div class="field">
                        <label for="registerPin">Create transaction PIN</label>
                        <input id="registerPin" type="password"
                               inputmode="numeric" pattern="[0-9]{4}"
                               maxlength="4" required>
                        <p class="small muted">Use a fictional 4-digit PIN.</p>
                    </div>

                    <div class="field">
                        <label for="confirmPin">Confirm transaction PIN</label>
                        <input id="confirmPin" type="password"
                               inputmode="numeric" pattern="[0-9]{4}"
                               maxlength="4" required>
                    </div>
                </div>

                <div class="camera-box">
                    <h3>Optional camera demonstration</h3>
                    <p class="small muted">
                        Camera access is optional. This demo does not verify
                        your identity or perform genuine facial recognition.
                        The registration API only receives a completion flag;
                        it does not receive or verify a captured image.
                    </p>

                    <video id="cameraVideo" class="hidden"
                           autoplay playsinline></video>

                    <canvas id="cameraCanvas" class="hidden"></canvas>

                    <img id="capturedImage" class="hidden" alt="Camera preview">

                    <div class="btn-row">
                        <button type="button" class="btn btn-secondary"
                                id="startCameraButton">
                            Start camera
                        </button>

                        <button type="button" class="btn btn-secondary hidden"
                                id="captureButton">
                            Capture preview
                        </button>

                        <button type="button" class="btn btn-secondary hidden"
                                id="stopCameraButton">
                            Stop camera
                        </button>
                    </div>

                    <p id="cameraStatus" class="small muted">
                        Camera not started.
                    </p>
                </div>

                <label style="display:flex;gap:10px;align-items:flex-start;
                              line-height:1.6;margin-bottom:20px">
                    <input type="checkbox" id="terms" required
                           style="width:auto;margin-top:4px">
                    <span>
                        I understand this is a demonstration application and
                        I am using fictional information.
                    </span>
                </label>

                <button class="btn btn-primary btn-block" type="submit">
                    Create demo account
                </button>

                <p class="small muted" style="margin-top:15px">
                    Already registered?
                    <button type="button" class="link-button"
                            onclick="showAuth('login')">Login</button>
                </p>
            </form>
        </div>
    </section>

    <!-- DASHBOARD -->

    <section id="dashboardView" class="hidden">

        <div style="display:flex;justify-content:space-between;
                    align-items:center;gap:15px;flex-wrap:wrap;margin-bottom:20px">
            <div>
                <h1 id="welcomeTitle">Welcome</h1>
                <p class="subtitle">Your Fubs demo banking dashboard.</p>
            </div>

            <button class="btn btn-secondary" id="logoutButton">
                Logout
            </button>
        </div>

        <div class="balance-panel">
            <p class="muted">Available demo balance</p>
            <div class="balance-amount" id="balanceAmount">₦0.00</div>

            <p class="muted">Demo account number</p>
            <div class="account-number" id="accountNumber">----------</div>

            <p style="margin-top:15px">
                <span id="accountHolder">Account holder</span>
            </p>
        </div>

        <div class="grid-three" style="margin-bottom:25px">
            <div class="stat">
                <span class="muted small">Account status</span>
                <strong id="accountStatus">Demo</strong>
            </div>

            <div class="stat">
                <span class="muted small">Savings balance</span>
                <strong id="savingsAmount">₦0.00</strong>
            </div>

            <div class="stat">
                <span class="muted small">Transactions</span>
                <strong id="transactionCount">0</strong>
            </div>
        </div>

        <div class="notice">
            All balances and transactions displayed here belong to the local
            demo database. Deposits are simulated and transfers only work
            between accounts created in this same application.
        </div>

        <div class="tabs" id="dashboardTabs">
            <button class="tab active" data-section="overview">Overview</button>
            <button class="tab" data-section="transfer">Transfer</button>
            <button class="tab" data-section="topup">Demo deposit</button>
            <button class="tab" data-section="savings">Savings</button>
            <button class="tab" data-section="bills">Bill payments</button>
            <button class="tab" data-section="history">History</button>
            <button class="tab" data-section="profile">Profile</button>
        </div>

        <!-- OVERVIEW -->

        <section class="section active" id="section-overview">
            <div class="panel">
                <h2>Quick actions</h2>
                <div class="action-grid">
                    <button class="btn btn-primary"
                            onclick="showSection('transfer')">
                        Transfer money
                    </button>

                    <button class="btn btn-secondary"
                            onclick="showSection('topup')">
                        Add demo funds
                    </button>

                    <button class="btn btn-secondary"
                            onclick="showSection('savings')">
                        Manage savings
                    </button>

                    <button class="btn btn-secondary"
                            onclick="showSection('history')">
                        View transactions
                    </button>
                </div>
            </div>

            <div class="panel">
                <h2>Recent transactions</h2>
                <div id="recentTransactions">
                    <p class="muted">Loading transactions...</p>
                </div>
            </div>
        </section>

        <!-- TRANSFER -->

        <section class="section" id="section-transfer">
            <div class="panel">
                <h2>Transfer between demo accounts</h2>
                <p class="subtitle">
                    Send funds to another account registered in this application.
                </p>

                <div id="recipientMessage"></div>

                <form id="lookupForm">
                    <div class="field">
                        <label for="recipientAccount">Recipient account number</label>
                        <input id="recipientAccount" inputmode="numeric"
                               maxlength="10" pattern="[0-9]{10}" required
                               placeholder="Enter 10-digit account number">
                    </div>

                    <button class="btn btn-secondary" type="submit">
                        Find account
                    </button>
                </form>

                <div id="recipientDetails" class="notice hidden"
                     style="margin-top:16px"></div>

                <form id="transferForm" class="hidden"
                      style="margin-top:20px">
                    <div class="field">
                        <label for="transferAmount">Amount (NGN)</label>
                        <input id="transferAmount" type="text"
                               inputmode="decimal" required
                               placeholder="e.g. 5,000.00">
                    </div>

                    <div class="field">
                        <label for="transferDescription">Description (optional)</label>
                        <input id="transferDescription" maxlength="120"
                               placeholder="e.g. Payment">
                    </div>

                    <div class="field">
                        <label for="transferPin">Transaction PIN</label>
                        <input id="transferPin" type="password"
                               inputmode="numeric" pattern="[0-9]{4}"
                               maxlength="4" required>
                    </div>

                    <button class="btn btn-primary btn-block" type="submit">
                        Confirm demo transfer
                    </button>
                </form>
            </div>
        </section>

        <!-- DEMO DEPOSIT -->

        <section class="section" id="section-topup">
            <div class="panel">
                <h2>Add demo funds</h2>

                <div class="notice">
                    This feature creates simulated funds for testing.
                    It does not charge a card, contact a bank, or receive real money.
                </div>

                <form id="topupForm">
                    <div class="field">
                        <label for="topupAmount">Amount (NGN)</label>
                        <input id="topupAmount" type="text"
                               inputmode="decimal" required
                               placeholder="e.g. 10,000.00">
                    </div>

                    <button class="btn btn-primary btn-block" type="submit">
                        Add demo funds
                    </button>
                </form>
            </div>
        </section>

        <!-- SAVINGS -->

        <section class="section" id="section-savings">
            <div class="panel">
                <h2>Manage savings</h2>
                <p class="subtitle">
                    Move funds between your demo balance and demo savings.
                </p>

                <form id="savingsForm">
                    <div class="field">
                        <label for="savingsDirection">Action</label>
                        <select id="savingsDirection" required>
                            <option value="save">Move money into savings</option>
                            <option value="withdraw">Move money out of savings</option>
                        </select>
                    </div>

                    <div class="field">
                        <label for="savingsTransactionAmount">Amount (NGN)</label>
                        <input id="savingsTransactionAmount" type="text"
                               inputmode="decimal" required
                               placeholder="e.g. 2,500.00">
                    </div>

                    <button class="btn btn-primary btn-block" type="submit">
                        Confirm savings action
                    </button>
                </form>
            </div>
        </section>

        <!-- BILLS -->

        <section class="section" id="section-bills">
            <div class="panel">
                <h2>Demo bill payments</h2>

                <div class="notice">
                    Bill payments are simulated. No airtime, data, electricity
                    units, or real-world services will be purchased.
                </div>

                <form id="billsForm">
                    <div class="field">
                        <label for="billCategory">Bill category</label>
                        <select id="billCategory" required>
                            <option value="">Select category</option>
                            <option value="airtime">Airtime</option>
                            <option value="data">Data</option>
                            <option value="electricity">Electricity</option>
                            <option value="cable">Cable TV</option>
                        </select>
                    </div>

                    <div class="field">
                        <label for="billProvider">Provider</label>
                        <input id="billProvider" required maxlength="100"
                               placeholder="e.g. Demo Provider">
                    </div>

                    <div class="field">
                        <label for="billTarget">Phone number or customer reference</label>
                        <input id="billTarget" required maxlength="120">
                    </div>

                    <div class="field">
                        <label for="billAmount">Amount (NGN)</label>
                        <input id="billAmount" type="text"
                               inputmode="decimal" required
                               placeholder="e.g. 1,500.00">
                    </div>

                    <button class="btn btn-primary btn-block" type="submit">
                        Pay demo bill
                    </button>
                </form>
            </div>
        </section>

        <!-- HISTORY -->

        <section class="section" id="section-history">
            <div class="panel">
                <div style="display:flex;justify-content:space-between;
                            align-items:center;gap:10px;flex-wrap:wrap">
                    <h2>Transaction history</h2>
                    <button class="btn btn-secondary"
                            onclick="loadTransactions()">
                        Refresh
                    </button>
                </div>

                <div id="transactionHistory">
                    <p class="muted">Loading history...</p>
                </div>
            </div>
        </section>

        <!-- PROFILE -->

        <section class="section" id="section-profile">
            <div class="panel">
                <h2>Account profile</h2>
                <div id="profileDetails"></div>
            </div>
        </section>

    </section>

</main>

<footer>
    Fubs Online Banking · Demonstration application only · No real banking services
</footer>

<script>
(function () {
    'use strict';

    var token = sessionStorage.getItem('fubs_demo_token') || '';
    var currentUser = null;
    var currentRecipient = null;
    var cameraStream = null;

    var messageElement = document.getElementById('globalMessage');

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g,
            function (character) {
                return {
                    '&': '&amp;',
                    '<': '&lt;',
                    '>': '&gt;',
                    '"': '&quot;',
                    "'": '&#39;'
                }[character];
            });
    }

    function showMessage(message, type, target) {
        var element = target || messageElement;

        element.innerHTML =
            '<div class="message ' + escapeHtml(type || 'info') + '">' +
            escapeHtml(message) +
            '</div>';
    }

    function clearMessage(target) {
        (target || messageElement).innerHTML = '';
    }

    function unwrap(result) {
        if (result && result.data !== undefined) {
            return result.data;
        }

        return result;
    }

    async function api(url, options) {
        options = options || {};

        var headers = Object.assign({}, options.headers || {});

        if (options.body !== undefined) {
            headers['Content-Type'] = 'application/json';
        }

        if (token) {
            headers.Authorization = 'Bearer ' + token;
        }

        var response;

        try {
            response = await fetch(url, Object.assign({}, options, {
                headers: headers,
                cache: 'no-store'
            }));
        } catch (error) {
            throw new Error(
                'Could not connect to the server. Check that your app is running.'
            );
        }

        var result;

        try {
            result = await response.json();
        } catch (error) {
            throw new Error('The server returned an invalid response.');
        }

        if (!response.ok) {
            throw new Error(
                result.message || 'The request could not be completed.'
            );
        }

        return result;
    }

    function money(value) {
        var number = Number(value);

        if (!Number.isFinite(number)) {
            number = 0;
        }

        return new Intl.NumberFormat('en-NG', {
            style: 'currency',
            currency: 'NGN',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }).format(number);
    }

    function formatAmountInput(input) {
        var value = input.value.trim();

        if (!value) {
            return;
        }

        value = value.replace(/,/g, '');

        if (!/^\d+(\.\d{0,2})?$/.test(value)) {
            return;
        }

        var parts = value.split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');

        input.value = parts.join('.');
    }

    function getAmount(inputId) {
        var value = document.getElementById(inputId).value.trim();
        value = value.replace(/,/g, '');

        if (!/^\d+(\.\d{1,2})?$/.test(value)) {
            throw new Error('Enter a valid amount with no more than 2 decimal places.');
        }

        var amount = Number(value);

        if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error('The amount must be greater than zero.');
        }

        if (amount > 100000000) {
            throw new Error('The amount exceeds this demo limit.');
        }

        return amount.toFixed(2);
    }

    function showAuth(mode) {
        document.getElementById('authView').classList.remove('hidden');
        document.getElementById('dashboardView').classList.add('hidden');

        document.getElementById('loginForm').classList.toggle(
            'hidden', mode !== 'login'
        );

        document.getElementById('registerForm').classList.toggle(
            'hidden', mode !== 'register'
        );

        document.getElementById('loginTab').classList.toggle(
            'active', mode === 'login'
        );

        document.getElementById('registerTab').classList.toggle(
            'active', mode === 'register'
        );

        clearMessage();
    }

    function showDashboard() {
        document.getElementById('authView').classList.add('hidden');
        document.getElementById('dashboardView').classList.remove('hidden');

        document.getElementById('headerActions').innerHTML =
            '<span class="small muted">Demo account</span>';

        showSection('overview');
    }

    function showSection(name) {
        document.querySelectorAll('.section').forEach(function (section) {
            section.classList.remove('active');
        });

        document.querySelectorAll('#dashboardTabs .tab').forEach(function (tab) {
            tab.classList.toggle('active', tab.dataset.section === name);
        });

        var section = document.getElementById('section-' + name);

        if (section) {
            section.classList.add('active');
        }

        clearMessage();

        if (name === 'history') {
            loadTransactions();
        }

        if (name === 'overview') {
            loadTransactions();
        }

        if (name === 'profile') {
            renderProfile();
        }
    }

    function displayValue(object, keys) {
        for (var i = 0; i < keys.length; i++) {
            if (object && object[keys[i]] !== undefined &&
                object[keys[i]] !== null) {
                return object[keys[i]];
            }
        }

        return '';
    }

    function updateDashboard(profile) {
        currentUser = profile || {};

        var account = currentUser.account || currentUser;

        var firstName = displayValue(currentUser, ['firstName', 'first_name']);
        var lastName = displayValue(currentUser, ['lastName', 'last_name']);
        var fullName = displayValue(currentUser, [
            'name', 'fullName', 'full_name'
        ]);

        if (!fullName) {
            fullName = (firstName + ' ' + lastName).trim();
        }

        if (!fullName) {
            fullName = 'Demo customer';
        }

        var balanceKobo = displayValue(account, [
            'balanceKobo', 'balance_kobo'
        ]);

        var balanceNaira = displayValue(account, [
            'balance', 'balanceNaira', 'balance_naira'
        ]);

        var savingsKobo = displayValue(account, [
            'savingsKobo', 'savings_kobo'
        ]);

        var savingsNaira = displayValue(account, [
            'savings', 'savingsBalance', 'savings_balance'
        ]);

        var balance = balanceKobo !== ''
            ? Number(balanceKobo) / 100
            : Number(balanceNaira || 0);

        var savings = savingsKobo !== ''
            ? Number(savingsKobo) / 100
            : Number(savingsNaira || 0);

        var number = displayValue(account, [
            'accountNumber', 'account_number'
        ]) || displayValue(currentUser, [
            'accountNumber', 'account_number'
        ]);

        document.getElementById('welcomeTitle').textContent =
            'Welcome, ' + fullName;

        document.getElementById('accountHolder').textContent = fullName;
        document.getElementById('accountNumber').textContent =
            number || 'Not available';

        document.getElementById('balanceAmount').textContent = money(balance);
        document.getElementById('savingsAmount').textContent = money(savings);

        document.getElementById('accountStatus').textContent =
            displayValue(account, ['status']) || 'Demo active';
    }

    function renderProfile() {
        var profile = currentUser || {};

        var fields = [
            ['First name', ['firstName', 'first_name']],
            ['Middle name', ['middleName', 'middle_name']],
            ['Last name', ['lastName', 'last_name']],
            ['Email', ['email']],
            ['Phone', ['phone']],
            ['Date of birth', ['dob']],
            ['Gender', ['gender']],
            ['Address', ['address']],
            ['City', ['city']],
            ['State', ['state']],
            ['Country', ['country']],
            ['Occupation', ['occupation']],
            ['Account number', ['accountNumber', 'account_number']]
        ];

        var html = '<div class="grid">';

        fields.forEach(function (field) {
            var value = displayValue(profile, field[1]);

            if (value === '') {
                value = 'Not provided';
            }

            html += '<div class="stat"><span class="muted small">' +
                escapeHtml(field[0]) +
                '</span><p style="margin-top:10px;overflow-wrap:anywhere">' +
                escapeHtml(value) + '</p></div>';
        });

        html += '</div>';

        document.getElementById('profileDetails').innerHTML = html;
    }

    function renderTransactions(container, transactions) {
        if (!Array.isArray(transactions) || transactions.length === 0) {
            container.innerHTML =
                '<p class="muted">No transactions found yet.</p>';
            return;
        }

        var html = '<div class="table-wrap"><table>' +
            '<thead><tr><th>Date</th><th>Type</th><th>Description</th>' +
            '<th>Amount</th><th>Status</th></tr></thead><tbody>';

        transactions.forEach(function (item) {
            var date = displayValue(item, [
                'createdAt', 'created_at', 'date', 'timestamp'
            ]) || '—';

            var type = displayValue(item, [
                'type', 'transactionType', 'transaction_type'
            ]) || 'Transaction';

            var description = displayValue(item, [
                'description', 'narration', 'details'
            ]) || '—';

            var amountKobo = displayValue(item, [
                'amountKobo', 'amount_kobo'
            ]);

            var rawAmount = displayValue(item, ['amount']);

            var amount = amountKobo !== ''
                ? Number(amountKobo) / 100
                : Number(rawAmount || 0);

            var direction = String(displayValue(item, [
                'direction', 'transaction_type'
            ]) || type).toLowerCase();

            var negative = direction.indexOf('debit') >= 0 ||
                direction.indexOf('transfer out') >= 0 ||
                direction.indexOf('withdraw') >= 0 ||
                direction.indexOf('payment') >= 0;

            var amountText = (negative ? '-' : '+') + money(Math.abs(amount));

            var status = displayValue(item, ['status']) || 'Recorded';

            html += '<tr>' +
                '<td>' + escapeHtml(date) + '</td>' +
                '<td>' + escapeHtml(type) + '</td>' +
                '<td>' + escapeHtml(description) + '</td>' +
                '<td class="' + (negative ? 'negative' : 'positive') + '">' +
                    escapeHtml(amountText) + '</td>' +
                '<td>' + escapeHtml(status) + '</td>' +
                '</tr>';
        });

        html += '</tbody></table></div>';
        container.innerHTML = html;
    }

    async function loadTransactions() {
        try {
            var result = await api('/api/transactions');
            var data = unwrap(result);

            var transactions = Array.isArray(data)
                ? data
                : data.transactions || [];

            renderTransactions(
                document.getElementById('transactionHistory'),
                transactions
            );

            renderTransactions(
                document.getElementById('recentTransactions'),
                transactions.slice(0, 5)
            );

            document.getElementById('transactionCount').textContent =
                String(transactions.length);
        } catch (error) {
            document.getElementById('transactionHistory').textContent =
                error.message;

            document.getElementById('recentTransactions').textContent =
                error.message;
        }
    }

    async function refreshProfile() {
        var result = await api('/api/me');
        var profile = unwrap(result);

        updateDashboard(profile);
        renderProfile();
    }

    function logout() {
        token = '';
        currentUser = null;
        currentRecipient = null;

        sessionStorage.removeItem('fubs_demo_token');

        stopCamera();

        document.getElementById('headerActions').innerHTML =
            '<button class="btn btn-secondary" onclick="showAuth(\'login\')">' +
            'Login</button>';

        showAuth('login');
    }

    document.getElementById('loginForm').addEventListener(
        'submit', async function (event) {
            event.preventDefault();
            clearMessage();

            var button = this.querySelector('button[type="submit"]');
            button.disabled = true;

            try {
                var result = await api('/api/auth/login', {
                    method: 'POST',
                    body: JSON.stringify({
                        identifier: document.getElementById(
                            'loginIdentifier'
                        ).value.trim(),
                        password: document.getElementById(
                            'loginPassword'
                        ).value
                    })
                });

                var data = unwrap(result);
                var receivedToken = data.token ||
                    (data.data && data.data.token);

                if (!receivedToken) {
                    throw new Error(
                        'The login response did not contain a token. Check the backend response format.'
                    );
                }

                token = receivedToken;
                sessionStorage.setItem('fubs_demo_token', token);

                await refreshProfile();
                showDashboard();
                await loadTransactions();

                document.getElementById('loginPassword').value = '';

            } catch (error) {
                showMessage(error.message, 'error');
            } finally {
                button.disabled = false;
            }
        }
    );

    document.getElementById('registerForm').addEventListener(
        'submit', async function (event) {
            event.preventDefault();
            clearMessage();

            var password = document.getElementById('registerPassword').value;
            var confirmPassword = document.getElementById('confirmPassword').value;
            var pin = document.getElementById('registerPin').value;
            var confirmPin = document.getElementById('confirmPin').value;

            if (password !== confirmPassword) {
                showMessage('The passwords do not match.', 'error');
                return;
            }

            if (pin !== confirmPin) {
                showMessage('The transaction PINs do not match.', 'error');
                return;
            }

            if (!/^[0-9]{4}$/.test(pin)) {
                showMessage('Use a 4-digit demo transaction PIN.', 'error');
                return;
            }

            var button = this.querySelector('button[type="submit"]');
            button.disabled = true;

            try {
                var body = {
                    firstName: document.getElementById('firstName').value.trim(),
                    middleName: document.getElementById('middleName').value.trim(),
                    lastName: document.getElementById('lastName').value.trim(),
                    dob: document.getElementById('dob').value,
                    gender: document.getElementById('gender').value,
                    phone: document.getElementById('phone').value.trim(),
                    email: document.getElementById('email').value.trim(),
                    password: password,
                    pin: pin,
                    address: document.getElementById('address').value.trim(),
                    city: document.getElementById('city').value.trim(),
                    state: document.getElementById('state').value.trim(),
                    country: document.getElementById('country').value.trim(),
                    occupation: document.getElementById('occupation').value.trim(),
                    sourceOfFunds: document.getElementById('sourceOfFunds').value,
                    accountPurpose: document.getElementById('accountPurpose').value,
                    nextOfKin: document.getElementById('nextOfKin').value.trim(),
                    nextOfKinPhone: document.getElementById('nextOfKinPhone').value.trim(),

                    // Demo-only flag; this does not verify identity.
                    faceCaptureCompleted: true
                };

                var result = await api('/api/auth/register', {
                    method: 'POST',
                    body: JSON.stringify(body)
                });

                showMessage(
                    result.message ||
                    'Demo account created. You can now log in.',
                    'success'
                );

                this.reset();

                document.getElementById('country').value = 'Nigeria';

                showAuth('login');

                document.getElementById('loginIdentifier').value = body.email;
                document.getElementById('loginPassword').value = '';

                showMessage(
                    'Your demo account has been created. Log in using your email and password.',
                    'success'
                );

            } catch (error) {
                showMessage(error.message, 'error');
            } finally {
                button.disabled = false;
            }
        }
    );

    document.querySelectorAll(
        '#topupAmount, #transferAmount, #savingsTransactionAmount, #billAmount'
    ).forEach(function (input) {
        input.addEventListener('blur', function () {
            formatAmountInput(input);
        });
    });

    document.getElementById('lookupForm').addEventListener(
        'submit', async function (event) {
            event.preventDefault();

            var accountNumber = document.getElementById(
                'recipientAccount'
            ).value.trim();

            var message = document.getElementById('recipientMessage');
            var details = document.getElementById('recipientDetails');
            var transferForm = document.getElementById('transferForm');

            clearMessage(message);
            details.classList.add('hidden');
            transferForm.classList.add('hidden');
            currentRecipient = null;

            if (!/^[0-9]{10}$/.test(accountNumber)) {
                showMessage(
                    'Enter a valid 10-digit demo account number.',
                    'error',
                    message
                );
                return;
            }

            try {
                var result = await api(
                    '/api/lookup?accountNumber=' +
                    encodeURIComponent(accountNumber)
                );

                var recipient = unwrap(result);

                currentRecipient = recipient.account || recipient;

                var recipientName = displayValue(currentRecipient, [
                    'name', 'fullName', 'full_name'
                ]);

                if (!recipientName) {
                    recipientName =
                        (displayValue(currentRecipient, ['firstName', 'first_name']) +
                        ' ' +
                        displayValue(currentRecipient, ['lastName', 'last_name']))
                        .trim();
                }

                if (!recipientName) {
                    recipientName = 'Demo account holder';
                }

                details.innerHTML =
                    '<strong>Recipient found</strong><br>' +
                    'Name: ' + escapeHtml(recipientName) + '<br>' +
                    'Account number: ' +
                    escapeHtml(displayValue(currentRecipient, [
                        'accountNumber', 'account_number'
                    ]) || accountNumber) + '<br>' +
                    'Bank: ' +
                    escapeHtml(displayValue(currentRecipient, [
                        'bankName', 'bank_name'
                    ]) || 'Fubs Online Banking');

                details.classList.remove('hidden');
                transferForm.classList.remove('hidden');

            } catch (error) {
                showMessage(error.message, 'error', message);
            }
        }
    );

    document.getElementById('transferForm').addEventListener(
        'submit', async function (event) {
            event.preventDefault();

            if (!currentRecipient) {
                showMessage('Find a recipient first.', 'error');
                return;
            }

            try {
                var amount = getAmount('transferAmount');

                var accountNumber = displayValue(currentRecipient, [
                    'accountNumber', 'account_number'
                ]) || document.getElementById('recipientAccount').value.trim();

                var result = await api('/api/transfer', {
                    method: 'POST',
                    body: JSON.stringify({
                        accountNumber: accountNumber,
                        amount: amount,
                        description: document.getElementById(
                            'transferDescription'
                        ).value.trim(),
                        pin: document.getElementById('transferPin').value
                    })
                });

                showMessage(
                    result.message || 'Demo transfer completed.',
                    'success'
                );

                this.reset();
                await refreshProfile();
                await loadTransactions();

            } catch (error) {
                showMessage(error.message, 'error');
            }
        }
    );

    document.getElementById('topupForm').addEventListener(
        'submit', async function (event) {
            event.preventDefault();

            try {
                var amount = getAmount('topupAmount');

                var result = await api('/api/topup', {
                    method: 'POST',
                    body: JSON.stringify({
                        amount: amount
                    })
                });

                showMessage(
                    result.message || 'Demo funds added successfully.',
                    'success'
                );

                this.reset();
                await refreshProfile();
                await loadTransactions();

            } catch (error) {
                showMessage(error.message, 'error');
            }
        }
    );

    document.getElementById('savingsForm').addEventListener(
        'submit', async function (event) {
            event.preventDefault();

            try {
                var amount = getAmount('savingsTransactionAmount');

                var result = await api('/api/save', {
                    method: 'POST',
                    body: JSON.stringify({
                        direction: document.getElementById(
                            'savingsDirection'
                        ).value,
                        amount: amount
                    })
                });

                showMessage(
                    result.message || 'Demo savings updated.',
                    'success'
                );

                this.reset();
                await refreshProfile();
                await loadTransactions();

            } catch (error) {
                showMessage(error.message, 'error');
            }
        }
    );

    document.getElementById('billsForm').addEventListener(
        'submit', async function (event) {
            event.preventDefault();

            try {
                var amount = getAmount('billAmount');

                var result = await api('/api/bills', {
                    method: 'POST',
                    body: JSON.stringify({
                        category: document.getElementById('billCategory').value,
                        provider: document.getElementById('billProvider').value.trim(),
                        target: document.getElementById('billTarget').value.trim(),
                        amount: amount
                    })
                });

                showMessage(
                    result.message || 'Demo bill payment recorded.',
                    'success'
                );

                this.reset();
                await refreshProfile();
                await loadTransactions();

            } catch (error) {
                showMessage(error.message, 'error');
            }
        }
    );

    document.querySelectorAll('#dashboardTabs .tab').forEach(function (tab) {
        tab.addEventListener('click', function () {
            showSection(tab.dataset.section);
        });
    });

    document.getElementById('logoutButton').addEventListener(
        'click', logout
    );

    // Camera preview is optional and stays in the browser.
    document.getElementById('startCameraButton').addEventListener(
        'click', async function () {
            var status = document.getElementById('cameraStatus');

            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                status.textContent =
                    'Camera access is unavailable in this browser or context.';
                return;
            }

            try {
                cameraStream = await navigator.mediaDevices.getUserMedia({
                    video: true,
                    audio: false
                });

                var video = document.getElementById('cameraVideo');
                video.srcObject = cameraStream;
                video.classList.remove('hidden');

                document.getElementById('captureButton').classList.remove('hidden');
                document.getElementById('stopCameraButton').classList.remove('hidden');

                status.textContent =
                    'Camera started. The preview is not sent to the server.';

            } catch (error) {
                status.textContent =
                    'Camera permission was denied or the camera is unavailable.';
            }
        }
    );

    document.getElementById('captureButton').addEventListener(
        'click', function () {
            var video = document.getElementById('cameraVideo');
            var canvas = document.getElementById('cameraCanvas');
            var image = document.getElementById('capturedImage');
            var status = document.getElementById('cameraStatus');

            if (!video.videoWidth || !video.videoHeight) {
                status.textContent = 'Wait for the camera preview to load.';
                return;
            }

            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;

            var context = canvas.getContext('2d');
            context.drawImage(video, 0, 0, canvas.width, canvas.height);

            image.src = canvas.toDataURL('image/jpeg', 0.85);
            image.classList.remove('hidden');

            status.textContent =
                'Preview captured locally. This is not identity verification.';
        }
    );

    function stopCamera() {
        if (cameraStream) {
            cameraStream.getTracks().forEach(function (track) {
                track.stop();
            });

            cameraStream = null;
        }

        var video = document.getElementById('cameraVideo');

        if (video) {
            video.srcObject = null;
            video.classList.add('hidden');
        }

        var captureButton = document.getElementById('captureButton');
        var stopButton = document.getElementById('stopCameraButton');

        if (captureButton) {
            captureButton.classList.add('hidden');
        }

        if (stopButton) {
            stopButton.classList.add('hidden');
        }
    }

    document.getElementById('stopCameraButton').addEventListener(
        'click', function () {
            stopCamera();
            document.getElementById('cameraStatus').textContent =
                'Camera stopped.';
        }
    );

    // Make selected functions available to the HTML buttons.
    window.showAuth = showAuth;
    window.showSection = showSection;

    // Restore the dashboard when the current session has a valid token.
    async function startApp() {
        if (!token) {
            showAuth('login');
            return;
        }

        try {
            await refreshProfile();
            showDashboard();
            await loadTransactions();
        } catch (error) {
            sessionStorage.removeItem('fubs_demo_token');
            token = '';
            showAuth('login');
            showMessage(
                'Your session has expired. Please log in again.',
                'info'
            );
        }
    }

    startApp();
})();
</script>

</body>
</html>`;