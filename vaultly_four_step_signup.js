'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = './fubs_banking.db';

const db = new DatabaseSync(DB_FILE);

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL,
    dob TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    account_number TEXT NOT NULL UNIQUE,
    balance INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    description TEXT NOT NULL,
    reference TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

const sessions = new Map();

function hashSecret(secret, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(secret), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifySecret(secret, storedHash) {
  try {
    const [salt, originalHash] = storedHash.split(':');

    if (!salt || !originalHash) return false;

    const actualHash = crypto.scryptSync(String(secret), salt, 64);
    const expectedHash = Buffer.from(originalHash, 'hex');

    return actualHash.length === expectedHash.length &&
      crypto.timingSafeEqual(actualHash, expectedHash);
  } catch {
    return false;
  }
}

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

function makeReference() {
  return 'FUB' + crypto.randomBytes(8).toString('hex').toUpperCase();
}

function makeAccountNumber() {
  return String(1000000000 + crypto.randomInt(0, 9000000000));
}

function nairaToKobo(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Enter a valid amount greater than zero.');
  }

  if (amount > 100000000) {
    throw new Error('The amount exceeds the demo transaction limit.');
  }

  return Math.round(amount * 100);
}

function formatNaira(kobo) {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(kobo / 100);
}

function getUserById(id) {
  return db.prepare(`
    SELECT
      users.id,
      users.full_name,
      users.email,
      users.phone,
      users.dob,
      users.created_at,
      accounts.account_number,
      accounts.balance
    FROM users
    JOIN accounts ON accounts.user_id = users.id
    WHERE users.id = ?
  `).get(id);
}

function publicUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    fullName: user.full_name,
    email: user.email,
    phone: user.phone,
    dateOfBirth: user.dob,
    accountNumber: user.account_number,
    balance: user.balance / 100,
    balanceFormatted: formatNaira(user.balance),
    createdAt: user.created_at
  };
}

function getAuthenticatedUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  if (!token) return null;

  const userId = sessions.get(token);

  if (!userId) return null;

  const user = getUserById(userId);

  if (!user) {
    sessions.delete(token);
    return null;
  }

  return { user, token };
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });

  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    req.on('data', chunk => {
      size += chunk.length;

      if (size > 100000) {
        reject(new Error('Request is too large.'));
        req.destroy();
        return;
      }

      body += chunk;
    });

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON request.'));
      }
    });

    req.on('error', reject);
  });
}

function ageFrom(dateOfBirth) {
  if (!dateOfBirth) return 0;

  const birthDate = new Date(dateOfBirth + 'T00:00:00');

  if (Number.isNaN(birthDate.getTime())) return 0;

  const today = new Date();

  let age = today.getFullYear() - birthDate.getFullYear();

  if (
    today.getMonth() < birthDate.getMonth() ||
    (
      today.getMonth() === birthDate.getMonth() &&
      today.getDate() < birthDate.getDate()
    )
  ) {
    age--;
  }

  return age;
}

const html = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fubs Online Banking</title>
<style>
:root {
  color-scheme: dark;
  --bg: #07111f;
  --panel: #101d30;
  --panel2: #172740;
  --text: #f4f7ff;
  --muted: #9aabc4;
  --blue: #3185ff;
  --border: #293b55;
  --danger: #ff7474;
  --success: #52d6a0;
}
body.light {
  color-scheme: light;
  --bg: #f2f6fc;
  --panel: #ffffff;
  --panel2: #edf3fb;
  --text: #14243c;
  --muted: #64748b;
  --blue: #1264dc;
  --border: #d5dfed;
  --danger: #c62828;
  --success: #087c52;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: Arial, Helvetica, sans-serif;
  min-height: 100vh;
}
button, input { font: inherit; }
button { cursor: pointer; }
button:disabled { opacity: .55; cursor: not-allowed; }
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 15px;
  padding: 20px 5%;
  border-bottom: 1px solid var(--border);
}
.brand { font-size: 22px; font-weight: 800; }
.brand span { color: var(--blue); }
.wrap { max-width: 1050px; margin: 35px auto; padding: 0 18px; }
.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 25px;
  margin-bottom: 20px;
}
h1, h2, h3 { margin-top: 0; }
p { line-height: 1.6; }
.muted { color: var(--muted); }
label {
  display: block;
  margin: 15px 0 7px;
  font-size: 14px;
  font-weight: 600;
}
input {
  display: block;
  width: 100%;
  padding: 13px;
  color: var(--text);
  background: var(--panel2);
  border: 1px solid var(--border);
  border-radius: 9px;
  outline: none;
}
input:focus { border-color: var(--blue); }
button {
  border: 0;
  border-radius: 9px;
  padding: 12px 17px;
  font-weight: 700;
}
.primary { background: var(--blue); color: white; }
.secondary {
  color: var(--text);
  background: var(--panel2);
  border: 1px solid var(--border);
}
.danger { background: var(--danger); color: white; }
.actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.balance {
  background: linear-gradient(135deg, #0758bd, #3185ff);
  color: white;
  border-radius: 15px;
  padding: 24px;
}
.balance .amount { font-size: clamp(25px, 5vw, 38px); font-weight: 800; margin: 15px 0; }
.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid var(--border);
  padding: 14px 0;
  overflow-wrap: anywhere;
}
.row:last-child { border-bottom: 0; }
.hidden { display: none !important; }
.message { margin-top: 14px; line-height: 1.5; }
.error { color: var(--danger); }
.success { color: var(--success); }
.small { font-size: 13px; }
footer { text-align: center; color: var(--muted); padding: 20px; }
@media (max-width: 650px) {
  header { padding: 16px; }
  .wrap { margin-top: 20px; }
  .panel { padding: 18px; }
  .grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<header>
  <div class="brand">FUBS <span>ONLINE BANKING</span></div>
  <button id="themeButton" class="secondary">Switch theme</button>
</header>

<main class="wrap">
  <section id="authPanel" class="panel">
    <h1 id="authTitle">Welcome back</h1>
    <p class="muted">Sign in to your Fubs demo account or create a new one.</p>

    <div class="actions">
      <button id="showLogin" class="primary">Login</button>
      <button id="showRegister" class="secondary">Create account</button>
    </div>

    <form id="loginForm">
      <label for="loginEmail">Email address</label>
      <input id="loginEmail" type="email" autocomplete="email" required>

      <label for="loginPassword">Password</label>
      <input id="loginPassword" type="password" autocomplete="current-password" required>

      <div class="actions">
        <button class="primary" type="submit">Login securely</button>
      </div>
    </form>

    <form id="registerForm" class="hidden">
      <h3>Step 1 — Personal information</h3>
      <label for="fullName">Full name</label>
      <input id="fullName" maxlength="100" autocomplete="name" required>

      <label for="dob">Date of birth</label>
      <input id="dob" type="date" required>

      <h3>Step 2 — Contact information</h3>
      <label for="email">Email address</label>
      <input id="email" type="email" maxlength="254" autocomplete="email" required>

      <label for="phone">Phone number</label>
      <input id="phone" type="tel" maxlength="20" autocomplete="tel" required>

      <h3>Step 3 — Secure your account</h3>
      <label for="password">Create password (at least 8 characters)</label>
      <input id="password" type="password" minlength="8" autocomplete="new-password" required>

      <label for="pin">Create a 4-digit demo PIN</label>
      <input id="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required>

      <h3>Step 4 — Confirm</h3>
      <p class="muted small">
        This is a learning demo. Do not enter your real banking PIN, NIN,
        card details, or other sensitive financial information.
      </p>
      <label>
        <input id="terms" type="checkbox" required style="display:inline;width:auto">
        I understand that this is a demo banking application.
      </label>

      <div class="actions">
        <button class="primary" type="submit">Create demo account</button>
      </div>
    </form>

    <div id="authMessage" class="message" role="status"></div>
  </section>

  <section id="dashboard" class="hidden">
    <div class="panel">
      <h1>Dashboard</h1>
      <p class="muted">Welcome, <strong id="userName"></strong></p>
      <div class="balance">
        <div>Available demo balance</div>
        <div id="balance" class="amount">₦0.00</div>
        <div>Account number: <strong id="accountNumber"></strong></div>
      </div>
      <div class="actions">
        <button id="refreshButton" class="secondary">Refresh account</button>
        <button id="logoutButton" class="secondary">Logout</button>
      </div>
      <div id="dashboardMessage" class="message" role="status"></div>
    </div>

    <div class="grid">
      <section class="panel">
        <h2>Internal transfer</h2>
        <p class="muted small">Transfer demo funds to another registered Fubs account.</p>
        <form id="transferForm">
          <label for="recipient">Recipient account number</label>
          <input id="recipient" inputmode="numeric" maxlength="10" required>

          <label for="amount">Amount (₦)</label>
          <input id="amount" type="number" min="1" max="100000000" step="0.01" placeholder="1,000.00" required>

          <label for="transferPin">Your demo PIN</label>
          <input id="transferPin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required>

          <div class="actions">
            <button class="primary" type="submit">Transfer funds</button>
          </div>
        </form>
        <div id="transferMessage" class="message" role="status"></div>
      </section>

      <section class="panel">
        <h2>Account information</h2>
        <div class="row"><span class="muted">Full name</span><strong id="profileName"></strong></div>
        <div class="row"><span class="muted">Email</span><strong id="profileEmail"></strong></div>
        <div class="row"><span class="muted">Phone</span><strong id="profilePhone"></strong></div>
        <div class="row"><span class="muted">Date of birth</span><strong id="profileDob"></strong></div>
        <p class="muted small">No real bank account or external payment network is connected.</p>
      </section>
    </div>

    <section class="panel">
      <h2>Transaction history</h2>
      <div id="transactions" class="muted">Loading transactions...</div>
    </section>
  </section>
</main>

<footer>Fubs Online Banking · Educational demo only</footer>

<script>
'use strict';

const $ = id => document.getElementById(id);

const state = {
  token: sessionStorage.getItem('fubs_token') || '',
  user: null
};

function formatNaira(amount) {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
}

function setMessage(id, message, isError = false) {
  const element = $(id);
  element.textContent = message;
  element.className = 'message ' + (isError ? 'error' : 'success');
}

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  if (state.token) {
    headers.Authorization = 'Bearer ' + state.token;
  }

  const response = await fetch(path, {
    ...options,
    headers
  });

  let result;

  try {
    result = await response.json();
  } catch {
    throw new Error('The server returned an invalid response.');
  }

  if (response.status === 401 && state.token) {
    logout(false);
  }

  if (!response.ok) {
    throw new Error(result.error || 'Request failed.');
  }

  // Fix: unwrap the backend response for the frontend.
  return Object.prototype.hasOwnProperty.call(result, 'data')
    ? result.data
    : result;
}

function showLogin() {
  $('authTitle').textContent = 'Welcome back';
  $('loginForm').classList.remove('hidden');
  $('registerForm').classList.add('hidden');
  $('authMessage').textContent = '';
}

function showRegister() {
  $('authTitle').textContent = 'Create your account';
  $('loginForm').classList.add('hidden');
  $('registerForm').classList.remove('hidden');
  $('authMessage').textContent = '';
}

function showDashboard() {
  $('authPanel').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
}

function showAuth() {
  $('dashboard').classList.add('hidden');
  $('authPanel').classList.remove('hidden');
  showLogin();
}

function logout(showMessage = true) {
  state.token = '';
  state.user = null;
  sessionStorage.removeItem('fubs_token');
  showAuth();

  if (showMessage) {
    setMessage('authMessage', 'You have logged out.');
  }
}

async function loadDashboard() {
  const [user, transactions] = await Promise.all([
    api('/api/me'),
    api('/api/transactions')
  ]);

  state.user = user;

  $('userName').textContent = user.fullName;
  $('balance').textContent = user.balanceFormatted;
  $('accountNumber').textContent = user.accountNumber;

  $('profileName').textContent = user.fullName;
  $('profileEmail').textContent = user.email;
  $('profilePhone').textContent = user.phone;
  $('profileDob').textContent = user.dateOfBirth;

  const list = $('transactions');
  list.replaceChildren();

  if (!transactions.length) {
    list.textContent = 'No transactions yet.';
    return;
  }

  for (const tx of transactions) {
    const row = document.createElement('div');
    row.className = 'row';

    const left = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = tx.type;
    const description = document.createElement('div');
    description.className = 'muted small';
    description.textContent = tx.description;

    const date = document.createElement('div');
    date.className = 'muted small';
    date.textContent = new Date(tx.createdAt.replace(' ', 'T') + 'Z').toLocaleString();

    left.append(title, description, date);

    const right = document.createElement('strong');
    const sign = tx.type === 'TRANSFER_OUT' ? '-' : '+';
    right.textContent = sign + formatNaira(tx.amount);

    row.append(left, right);
    list.appendChild(row);
  }
}

$('showLogin').addEventListener('click', showLogin);
$('showRegister').addEventListener('click', showRegister);

$('themeButton').addEventListener('click', () => {
  document.body.classList.toggle('light');
});

$('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  setMessage('authMessage', 'Signing in...');

  try {
    const result = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        email: $('loginEmail').value.trim(),
        password: $('loginPassword').value
      })
    });

    state.token = result.token;
    sessionStorage.setItem('fubs_token', state.token);

    showDashboard();
    await loadDashboard();
    setMessage('dashboardMessage', 'Login successful.');
  } catch (error) {
    setMessage('authMessage', error.message, true);
  }
});

$('registerForm').addEventListener('submit', async event => {
  event.preventDefault();
  setMessage('authMessage', 'Creating your demo account...');

  const dob = $('dob').value;

  // Fix: ageFrom is defined inside the browser frontend.
  function ageFrom(dateOfBirth) {
    if (!dateOfBirth) return 0;

    const birthDate = new Date(dateOfBirth + 'T00:00:00');

    if (Number.isNaN(birthDate.getTime())) return 0;

    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();

    if (
      today.getMonth() < birthDate.getMonth() ||
      (
        today.getMonth() === birthDate.getMonth() &&
        today.getDate() < birthDate.getDate()
      )
    ) {
      age--;
    }

    return age;
  }

  if (ageFrom(dob) < 18) {
    setMessage('authMessage', 'This demo registration is for adults aged 18 or older.', true);
    return;
  }

  try {
    const result = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({
        fullName: $('fullName').value.trim(),
        dob,
        email: $('email').value.trim(),
        phone: $('phone').value.trim(),
        password: $('password').value,
        pin: $('pin').value,
        termsAccepted: $('terms').checked
      })
    });

    state.token = result.token;
    sessionStorage.setItem('fubs_token', state.token);

    showDashboard();
    await loadDashboard();
    setMessage('dashboardMessage', 'Your demo account was created successfully.');
    $('registerForm').reset();
  } catch (error) {
    setMessage('authMessage', error.message, true);
  }
});

$('transferForm').addEventListener('submit', async event => {
  event.preventDefault();
  setMessage('transferMessage', 'Processing demo transfer...');

  try {
    const result = await api('/api/transfer', {
      method: 'POST',
      body: JSON.stringify({
        recipientAccount: $('recipient').value.trim(),
        amount: $('amount').value,
        pin: $('transferPin').value
      })
    });

    setMessage('transferMessage', result.message);
    $('transferForm').reset();
    await loadDashboard();
  } catch (error) {
    setMessage('transferMessage', error.message, true);
  }
});

$('refreshButton').addEventListener('click', async () => {
  try {
    await loadDashboard();
    setMessage('dashboardMessage', 'Account information refreshed.');
  } catch (error) {
    setMessage('dashboardMessage', error.message, true);
  }
});

$('logoutButton').addEventListener('click', () => logout());

(async function start() {
  if (!state.token) {
    showAuth();
    return;
  }

  try {
    showDashboard();
    await loadDashboard();
  } catch {
    logout(false);
  }
})();
</script>
</body>
</html>`;

async function handleApi(req, res, pathname) {
  let body = {};

  if (req.method === 'POST') {
    body = await readJson(req);
  }

  if (req.method === 'POST' && pathname === '/api/register') {
    const fullName = String(body.fullName || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const phone = String(body.phone || '').trim();
    const dob = String(body.dob || '');
    const password = String(body.password || '');
    const pin = String(body.pin || '');

    if (fullName.length < 2 || fullName.length > 100) {
      return sendJson(res, 400, { error: 'Enter a valid full name.' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return sendJson(res, 400, { error: 'Enter a valid email address.' });
    }

    if (phone.length < 7 || phone.length > 20) {
      return sendJson(res, 400, { error: 'Enter a valid phone number.' });
    }

    if (ageFrom(dob) < 18) {
      return sendJson(res, 400, {
        error: 'Registration for this demo is limited to adults aged 18 or older.'
      });
    }

    if (password.length < 8 || password.length > 200) {
      return sendJson(res, 400, {
        error: 'Your password must contain at least 8 characters.'
      });
    }

    if (!/^\d{4}$/.test(pin)) {
      return sendJson(res, 400, { error: 'Your demo PIN must be 4 digits.' });
    }

    if (body.termsAccepted !== true) {
      return sendJson(res, 400, { error: 'Please confirm the demo terms.' });
    }

    const existing = db.prepare(
      'SELECT id FROM users WHERE email = ?'
    ).get(email);

    if (existing) {
      return sendJson(res, 409, { error: 'An account with this email already exists.' });
    }

    let userId;

    const createAccount = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO users (full_name, email, phone, dob, password_hash, pin_hash)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        fullName,
        email,
        phone,
        dob,
        hashSecret(password),
        hashSecret(pin)
      );

      userId = Number(result.lastInsertRowid);

      let accountNumber;

      do {
        accountNumber = makeAccountNumber();
      } while (
        db.prepare('SELECT id FROM accounts WHERE account_number = ?')
          .get(accountNumber)
      );

      db.prepare(`
        INSERT INTO accounts (user_id, account_number, balance)
        VALUES (?, ?, 0)
      `).run(userId, accountNumber);
    });

    try {
      createAccount();
    } catch (error) {
      console.error('Registration error:', error.message);
      return sendJson(res, 500, { error: 'Could not create your account. Please try again.' });
    }

    const token = makeToken();
    sessions.set(token, userId);

    return sendJson(res, 201, {
      data: {
        token,
        user: publicUser(getUserById(userId))
      }
    });
  }

  if (req.method === 'POST' && pathname === '/api/login') {
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    const user = db.prepare(`
      SELECT id, password_hash
      FROM users
      WHERE email = ?
    `).get(email);

    if (!user || !verifySecret(password, user.password_hash)) {
      return sendJson(res, 401, { error: 'Invalid email or password.' });
    }

    const token = makeToken();
    sessions.set(token, user.id);

    return sendJson(res, 200, {
      data: {
        token,
        user: publicUser(getUserById(user.id))
      }
    });
  }

  const auth = getAuthenticatedUser(req);

  if (!auth) {
    return sendJson(res, 401, { error: 'Please log in to continue.' });
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    sessions.delete(auth.token);
    return sendJson(res, 200, { data: { message: 'Logged out.' } });
  }

  if (req.method === 'GET' && pathname === '/api/me') {
    return sendJson(res, 200, { data: publicUser(auth.user) });
  }

  if (req.method === 'GET' && pathname === '/api/transactions') {
    const transactions = db.prepare(`
      SELECT type, amount, description, reference, created_at
      FROM transactions
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 100
    `).all(auth.user.id).map(tx => ({
      type: tx.type,
      amount: tx.amount / 100,
      description: tx.description,
      reference: tx.reference,
      createdAt: tx.created_at
    }));

    return sendJson(res, 200, { data: transactions });
  }

  if (req.method === 'POST' && pathname === '/api/transfer') {
    const recipientAccount = String(body.recipientAccount || '').trim();
    const pin = String(body.pin || '');

    let amount;

    try {
      amount = nairaToKobo(body.amount);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }

    if (!/^\d{10}$/.test(recipientAccount)) {
      return sendJson(res, 400, { error: 'Enter a valid 10-digit recipient account number.' });
    }

    if (!/^\d{4}$/.test(pin)) {
      return sendJson(res, 400, { error: 'Enter your 4-digit demo PIN.' });
    }

    const fullUser = db.prepare(
      'SELECT pin_hash FROM users WHERE id = ?'
    ).get(auth.user.id);

    if (!verifySecret(pin, fullUser.pin_hash)) {
      return sendJson(res, 401, { error: 'Incorrect demo PIN.' });
    }

    const recipient = db.prepare(`
      SELECT accounts.user_id, accounts.account_number, users.full_name
      FROM accounts
      JOIN users ON users.id = accounts.user_id
      WHERE accounts.account_number = ?
    `).get(recipientAccount);

    if (!recipient) {
      return sendJson(res, 404, { error: 'Recipient account was not found.' });
    }

    if (recipient.user_id === auth.user.id) {
      return sendJson(res, 400, { error: 'You cannot transfer to your own account.' });
    }

    try {
      const transfer = db.transaction(() => {
        const senderAccount = db.prepare(
          'SELECT balance FROM accounts WHERE user_id = ?'
        ).get(auth.user.id);

        if (!senderAccount || senderAccount.balance < amount) {
          throw new Error('Insufficient demo funds.');
        }

        db.prepare(`
          UPDATE accounts
          SET balance = balance - ?
          WHERE user_id = ?
        `).run(amount, auth.user.id);

        db.prepare(`
          UPDATE accounts
          SET balance = balance + ?
          WHERE user_id = ?
        `).run(amount, recipient.user_id);

        const reference = makeReference();

        db.prepare(`
          INSERT INTO transactions (user_id, type, amount, description, reference)
          VALUES (?, 'TRANSFER_OUT', ?, ?, ?)
        `).run(
          auth.user.id,
          amount,
          'Transfer to ' + recipient.full_name + ' (' + recipient.account_number + ')',
          reference
        );

        db.prepare(`
          INSERT INTO transactions (user_id, type, amount, description, reference)
          VALUES (?, 'TRANSFER_IN', ?, ?, ?)
        `).run(
          recipient.user_id,
          amount,
          'Transfer received from ' + auth.user.full_name,
          reference + '-IN'
        );

        return reference;
      });

      const reference = transfer();

      return sendJson(res, 200, {
        data: {
          message: 'Demo transfer successful. Reference: ' + reference
        }
      });
    } catch (error) {
      return sendJson(res, 400, {
        error: error.message || 'The demo transfer could not be completed.'
      });
    }
  }

  return sendJson(res, 404, { error: 'API endpoint not found.' });
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, 'http://localhost');
    const pathname = requestUrl.pathname;

    if (pathname.startsWith('/api/')) {
      return await handleApi(req, res, pathname);
    }

    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"
      });

      return res.end(html);
    }

    return sendJson(res, 404, { error: 'Page not found.' });
  } catch (error) {
    console.error('Server error:', error.message);

    if (!res.headersSent) {
      return sendJson(res, 500, { error: 'An unexpected server error occurred.' });
    }

    res.end();
  }
});
  server.listen(PORT, '0.0.0.0', () => {
  console.log('Fubs Online Banking demo is running.');
  console.log('Open http://localhost:' + PORT);
  console.log('Press Ctrl+C to stop the server.');
});