'use strict';

const $ = id => document.getElementById(id);

let step = 1;
let stream = null;
let captured = false;
let selectedRecipient = null;
let currentUser = null;

const money = (minor, currency = 'NGN') => {
  try {
    const value = BigInt(String(minor ?? 0));
    const whole = value / 100n;
    const kobo = String(value % 100n).padStart(2, '0');
    const formatted = new Intl.NumberFormat('en-NG').format(whole);

    return currency.trim() === 'NGN'
      ? `₦${formatted}.${kobo}`
      : `${currency.trim()} ${formatted}.${kobo}`;
  } catch {
    return 'Amount unavailable';
  }
};

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });

  let data = {};

  try {
    data = await response.json();
  } catch {}

  if (!response.ok) {
    const fields = data.fields
      ?.map(item => `${item.field}: ${item.message}`)
      .join('\n');

    throw new Error(
      [data.error || 'Request failed.', fields]
        .filter(Boolean)
        .join('\n')
    );
  }

  return data;
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
  }

  stream = null;

  if ($('video')) {
    $('video').srcObject = null;
  }
}

function message(text, error = false) {
  $('message').textContent = text;
  $('message').className = 'message' + (error ? ' error' : '');
}

function loginView() {
  stopCamera();

  $('heading').textContent = 'Welcome to Fubs';
  $('login-form').classList.remove('hidden');
  $('register-form').classList.add('hidden');

  message('');
}

function registerView() {
  $('heading').textContent = 'Create your account';
  $('login-form').classList.add('hidden');
  $('register-form').classList.remove('hidden');

  setStep(1);
  message('');
}

function setStep(number) {
  step = number;

  document.querySelectorAll('.reg-step').forEach(section => {
    section.classList.toggle(
      'hidden',
      Number(section.dataset.step) !== number
    );
  });

  $('step-label').textContent = `Step ${number} of 4`;
  $('progress-fill').style.width = `${number * 25}%`;

  $('back').classList.toggle('hidden', number === 1);
  $('next').classList.toggle('hidden', number === 4);
  $('submit').classList.toggle('hidden', number !== 4);

  if (number === 4) {
    summary();
  }
}

function ageFrom(value) {
  if (!value) return 0;

  const date = new Date(value + 'T00:00:00');

  if (Number.isNaN(date.getTime())) return 0;

  const today = new Date();

  let age = today.getFullYear() - date.getFullYear();

  if (
    today.getMonth() < date.getMonth() ||
    (
      today.getMonth() === date.getMonth() &&
      today.getDate() < date.getDate()
    )
  ) {
    age--;
  }

  return age;
}

function validate() {
  const section = document.querySelector(
    `.reg-step[data-step="${step}"]`
  );

  for (const input of section.querySelectorAll('input,select')) {
    if (input.required && !input.checkValidity()) {
      input.reportValidity();
      return false;
    }
  }

  if (step === 1 && ageFrom($('dob').value) < 18) {
    message(
      'Registration is currently limited to adults aged 18 or older.',
      true
    );
    return false;
  }

  if (step === 3) {
    if ($('password').value !== $('confirmPassword').value) {
      message('Passwords do not match.', true);
      return false;
    }

    if ($('pin').value !== $('confirmPin').value) {
      message('Transaction PINs do not match.', true);
      return false;
    }

    if ($('password').value === $('pin').value) {
      message('Password and PIN must be different.', true);
      return false;
    }
  }

  return true;
}

function summary() {
  const name = [
    $('firstName').value,
    $('middleName').value,
    $('lastName').value
  ].filter(Boolean).join(' ');

  $('summary').textContent =
    `Name: ${name}\n` +
    `Email: ${$('email').value}\n` +
    `Phone: ${$('phone').value}\n` +
    `Selfie captured: ${captured ? 'Yes (not uploaded or verified)' : 'No'}`;
}

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    message(
      'Camera requires a supported browser and HTTPS or localhost.',
      true
    );
    return;
  }

  try {
    stopCamera();

    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user' },
      audio: false
    });

    $('video').srcObject = stream;
    $('video').classList.remove('hidden');
    $('preview').classList.add('hidden');
    $('camera-placeholder').classList.add('hidden');
    $('capture').disabled = false;
    $('camera-status').textContent = 'Camera is active.';
  } catch {
    message(
      'Camera permission was denied or the camera is unavailable.',
      true
    );
  }
}

function capture() {
  const video = $('video');

  if (!stream || !video.videoWidth) {
    $('camera-status').textContent =
      'Open the camera and wait for the preview.';
    return;
  }

  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 900 / video.videoWidth);

  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);

  canvas.getContext('2d').drawImage(
    video,
    0,
    0,
    canvas.width,
    canvas.height
  );

  $('preview').src = canvas.toDataURL('image/jpeg', 0.88);
  $('preview').classList.remove('hidden');
  video.classList.add('hidden');
  $('retake').classList.remove('hidden');
  $('capture').disabled = true;

  captured = true;
  stopCamera();

  $('camera-status').textContent =
    'Selfie captured locally. It has not been uploaded or verified.';

  summary();
}

function retake() {
  captured = false;

  $('preview').classList.add('hidden');
  $('retake').classList.add('hidden');

  openCamera();
}

/* ---------------------------------------------------------
   DASHBOARD UI
--------------------------------------------------------- */

function createDashboardTools() {
  let section = $('banking-tools');

  if (section) return;

  section = document.createElement('section');
  section.id = 'banking-tools';
  section.className = 'panel';

  section.innerHTML = `
    <div class="eyebrow">DEMO BANKING SERVICES</div>
    <h2>Account balance</h2>
    <p id="balance-display" aria-live="polite">Loading balance...</p>
    <p id="banking-status" class="notice" role="status">
      Loading account information...
    </p>

    <hr>

    <h2>Transfer to a Fubs account</h2>
    <p class="muted">
      Internal demo transfers only. Both accounts must be active.
    </p>

    <form id="recipient-lookup-form">
      <label for="recipient-account">Recipient account number</label>
      <input
        id="recipient-account"
        inputmode="numeric"
        autocomplete="off"
        pattern="[0-9]{10}"
        maxlength="10"
        required
        placeholder="Enter 10-digit account number"
      >
      <button type="submit" class="secondary">
        Find recipient
      </button>
    </form>

    <p id="recipient-result" class="notice" aria-live="polite">
      No recipient selected.
    </p>

    <form id="transfer-form">
      <label for="transfer-amount">Amount (NGN)</label>
      <input
        id="transfer-amount"
        type="number"
        min="0.01"
        max="100000000"
        step="0.01"
        required
        placeholder="e.g. 1500.00"
      >

      <label for="transfer-pin">Six-digit transaction PIN</label>
      <input
        id="transfer-pin"
        type="password"
        inputmode="numeric"
        pattern="[0-9]{6}"
        minlength="6"
        maxlength="6"
        autocomplete="off"
        required
      >

      <button id="transfer-submit" type="submit" class="primary">
        Submit demo transfer
      </button>
    </form>

    <p id="transfer-result" role="status" aria-live="polite"></p>

    <hr>

    <h2>Saved beneficiaries</h2>

    <form id="beneficiary-form">
      <label for="beneficiary-account">Fubs account number</label>
      <input
        id="beneficiary-account"
        inputmode="numeric"
        pattern="[0-9]{10}"
        maxlength="10"
        required
        placeholder="10-digit account number"
      >
      <button type="submit" class="secondary">
        Save beneficiary
      </button>
    </form>

    <p id="beneficiary-result" role="status" aria-live="polite"></p>
    <div id="beneficiaries-list">Loading beneficiaries...</div>

    <hr>

    <div class="actions">
      <button id="refresh-banking" type="button" class="secondary">
        Refresh account and transactions
      </button>
    </div>
  `;

  const dashboard = $('dashboard');
  const columns = dashboard.querySelector('.twocol');

  if (columns) {
    dashboard.insertBefore(section, columns);
  } else {
    dashboard.append(section);
  }

  $('recipient-lookup-form').addEventListener(
    'submit',
    lookupRecipient
  );

  $('transfer-form').addEventListener(
    'submit',
    submitTransfer
  );

  $('beneficiary-form').addEventListener(
    'submit',
    addBeneficiary
  );

  $('refresh-banking').addEventListener('click', refreshBanking);

  $('beneficiaries-list').addEventListener('click', async event => {
    const button = event.target.closest('[data-delete-beneficiary]');

    if (!button) return;

    const id = button.dataset.deleteBeneficiary;

    button.disabled = true;

    try {
      await api(`/api/beneficiaries/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      });

      $('beneficiary-result').textContent = 'Beneficiary removed.';
      await loadBeneficiaries();
    } catch (error) {
      $('beneficiary-result').textContent = error.message;
      button.disabled = false;
    }
  });
}

function dashboard(user) {
  stopCamera();

  currentUser = user;
  selectedRecipient = null;

  $('auth').classList.add('hidden');
  $('dashboard').classList.remove('hidden');

  $('dash-name').textContent = user.fullName;
  $('account-status').textContent =
    (user.accountStatus || 'unknown').replaceAll('_', ' ');

  $('face-status').textContent =
    (user.faceVerificationStatus || 'unknown').replaceAll('_', ' ');

  $('account-number').textContent = user.accountNumber || 'Pending';

  $('profile').replaceChildren();

  for (const [label, value] of [
    ['Full name', user.fullName],
    ['Email', user.email],
    ['Phone', user.phone],
    ['Date of birth', user.dateOfBirth],
    ['Email verified', user.emailVerified ? 'Yes' : 'Not verified'],
    ['Phone verified', user.phoneVerified ? 'Yes' : 'Not verified']
  ]) {
    const detail = document.createElement('div');
    detail.className = 'detail';

    const span = document.createElement('span');
    span.textContent = label;

    const strong = document.createElement('strong');
    strong.textContent = value || 'Not provided';

    detail.append(span, strong);
    $('profile').append(detail);
  }

  createDashboardTools();
  refreshBanking();
}

async function loadAccount() {
  const display = $('balance-value');
  const status = $('banking-status');

  display.textContent = 'Loading...';

  try {
    const data = await api('/api/account');

    display.textContent = money(
      data.balanceMinor,
      data.currency || 'NGN'
    );

    status.textContent =
      `Account ${data.accountNumber} · Status: ${data.status}`;
  } catch (error) {
    display.textContent = 'Balance unavailable';
    status.textContent = error.message;
  }
}

/* ---------------------------------------------------------
   ACCOUNT LOOKUP
--------------------------------------------------------- */

async function lookupRecipient(event) {
  event.preventDefault();

  const accountNumber = $('recipient-account').value.trim();
  const result = $('recipient-result');

  selectedRecipient = null;
  result.textContent = 'Looking up recipient...';

  try {
    const data = await api(
      `/api/account/lookup/${encodeURIComponent(accountNumber)}`
    );

    selectedRecipient = {
      accountNumber: data.accountNumber,
      accountName: data.accountName
    };

    result.textContent =
      `Recipient: ${data.accountName} · ${data.accountNumber}`;

    $('beneficiary-account').value = data.accountNumber;
  } catch (error) {
    result.textContent = error.message;
  }
}

/* ---------------------------------------------------------
   SUBMIT INTERNAL DEMO TRANSFER
--------------------------------------------------------- */

async function submitTransfer(event) {
  event.preventDefault();

  const result = $('transfer-result');
  const button = $('transfer-submit');

  const amount = $('transfer-amount').value.trim();
  const transactionPin = $('transfer-pin').value;

  if (!selectedRecipient) {
    result.textContent =
      'Look up and confirm the recipient before transferring.';
    return;
  }

  if (
    $('recipient-account').value.trim() !==
    selectedRecipient.accountNumber
  ) {
    selectedRecipient = null;
    result.textContent =
      'Recipient account changed. Please look it up again.';
    return;
  }

  if (!amount || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    result.textContent = 'Enter a valid transfer amount.';
    return;
  }

  if (!/^\d{6}$/.test(transactionPin)) {
    result.textContent = 'Enter your six-digit transaction PIN.';
    return;
  }

  const confirmed = window.confirm(
    `Confirm this DEMO transfer?\n\n` +
    `Recipient: ${selectedRecipient.accountName}\n` +
    `Account: ${selectedRecipient.accountNumber}\n` +
    `Amount: ${money(
      Math.round(Number(amount) * 100),
      'NGN'
    )}\n\n` +
    `This is an internal demo transaction, not a real bank transfer.`
  );

  if (!confirmed) return;

  button.disabled = true;
  result.textContent = 'Processing demo transfer...';

  try {
    const data = await api('/api/transfers', {
      method: 'POST',
      body: JSON.stringify({
        recipientAccountNumber: selectedRecipient.accountNumber,
        amount,
        transactionPin,
        idempotencyKey: crypto.randomUUID()
      })
    });

    result.textContent =
      `${data.message} Reference: ${data.reference}. ` +
      `Remaining demo balance: ${money(
        data.remainingBalanceMinor,
        data.currency || 'NGN'
      )}`;

    $('transfer-form').reset();
    $('recipient-lookup-form').reset();

    selectedRecipient = null;
    $('recipient-result').textContent = 'No recipient selected.';

    await refreshBanking();
  } catch (error) {
    result.textContent = error.message;
  } finally {
    $('transfer-pin').value = '';
    button.disabled = false;
  }
}

/* ---------------------------------------------------------
   TRANSACTION HISTORY
--------------------------------------------------------- */

async function loadTransactions() {
  const container = $('transactions');

  try {
    const data = await api('/api/transactions');

    container.replaceChildren();

    if (!data.transactions?.length) {
      container.textContent = 'No transactions recorded.';
      return;
    }

    for (const transaction of data.transactions) {
      const item = document.createElement('div');
      item.className = 'detail';

      const information = document.createElement('div');

      const title = document.createElement('strong');
      title.textContent =
        `${transaction.type} · ${transaction.status}`;

      const description = document.createElement('p');
      description.textContent = transaction.description || '';

      const reference = document.createElement('small');
      reference.textContent =
        `Reference: ${transaction.reference}`;

      const date = document.createElement('small');
      date.textContent = transaction.createdAt
        ? new Date(transaction.createdAt).toLocaleString()
        : '';

      information.append(title, description, reference, date);

      const amount = document.createElement('strong');
      amount.textContent = money(
        transaction.amountMinor,
        transaction.currency || 'NGN'
      );

      item.append(information, amount);
      container.append(item);
    }
  } catch (error) {
    container.textContent = error.message;
  }
}

/* ---------------------------------------------------------
   BENEFICIARIES
--------------------------------------------------------- */

async function loadBeneficiaries() {
  const container = $('beneficiaries-list');

  try {
    const data = await api('/api/beneficiaries');

    container.replaceChildren();

    if (!data.beneficiaries?.length) {
      container.textContent = 'No saved beneficiaries.';
      return;
    }

    for (const beneficiary of data.beneficiaries) {
      const item = document.createElement('div');
      item.className = 'detail';

      const information = document.createElement('div');

      const name = document.createElement('strong');
      name.textContent = beneficiary.recipientName;

      const account = document.createElement('p');
      account.textContent =
        `${beneficiary.bankName} · ${beneficiary.accountNumber}`;

      const actions = document.createElement('div');
      actions.className = 'actions';

      const transferButton = document.createElement('button');
      transferButton.type = 'button';
      transferButton.className = 'secondary';
      transferButton.textContent = 'Use recipient';

      transferButton.addEventListener('click', () => {
        $('recipient-account').value = beneficiary.accountNumber;

        $('recipient-account').scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        });

        $('recipient-account').focus();

        $('recipient-result').textContent =
          'Recipient selected. Click Find recipient to verify the current account status.';

        selectedRecipient = null;
      });

      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'secondary';
      deleteButton.textContent = 'Remove';
      deleteButton.dataset.deleteBeneficiary = beneficiary.id;

      actions.append(transferButton, deleteButton);
      information.append(name, account, actions);
      item.append(information);
      container.append(item);
    }
  } catch (error) {
    container.textContent = error.message;
  }
}

async function addBeneficiary(event) {
  event.preventDefault();

  const result = $('beneficiary-result');
  const accountNumber = $('beneficiary-account').value.trim();

  try {
    const data = await api('/api/beneficiaries', {
      method: 'POST',
      body: JSON.stringify({
        accountNumber,
        bankName: 'Fubs Online Banking'
      })
    });
	
    result.textContent = data.message;
    $('beneficiary-form').reset();

    await loadBeneficiaries();
  } catch (error) {
    result.textContent = error.message;
  }
}

/* ---------------------------------------------------------
   REFRESH DASHBOARD DATA
--------------------------------------------------------- */

async function refreshBanking() {
  await Promise.all([
    loadAccount(),
    loadTransactions(),
    loadBeneficiaries()
  ]);
}

/* ---------------------------------------------------------
   LOGIN, REGISTRATION, AND LOGOUT
--------------------------------------------------------- */

$('login-tab').onclick = loginView;
$('register-tab').onclick = registerView;

$('theme').onclick = () => {
  document.body.classList.toggle('light');

  localStorage.setItem(
    'fubs-theme',
    document.body.classList.contains('light') ? 'light' : 'dark'
  );
};

if (localStorage.getItem('fubs-theme') === 'light') {
  document.body.classList.add('light');
}

$('next').onclick = () => {
  if (validate()) {
    message('');
    setStep(Math.min(4, step + 1));
  }
};

$('back').onclick = () => {
  if (step === 4) stopCamera();

  setStep(Math.max(1, step - 1));
  message('');
};

$('open-camera').onclick = openCamera;
$('capture').onclick = capture;
$('retake').onclick = retake;

$('register-form').onsubmit = async event => {
  event.preventDefault();

  if (step !== 4 || !validate()) return;

  if (!captured) {
    message('Capture a selfie to complete this demo step.', true);
    return;
  }

  const button = $('submit');
  button.disabled = true;

  try {
    const data = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        firstName: $('firstName').value.trim(),
        middleName: $('middleName').value.trim(),
        lastName: $('lastName').value.trim(),
        dateOfBirth: $('dob').value,
        gender: $('gender').value,
        country: $('country').value.trim(),
        stateRegion: $('stateRegion').value.trim(),
        city: $('city').value.trim(),
        residentialAddress: $('address').value.trim(),
        postalCode: $('postal').value.trim(),
        occupation: $('occupation').value.trim(),
        employmentStatus: $('employment').value,
        email: $('email').value.trim(),
        phone: $('phone').value.trim(),
        password: $('password').value,
        transactionPin: $('pin').value,
        termsAccepted: $('terms').checked
      })
    });

    message(data.message);
    dashboard(data.user);
  } catch (error) {
    message(error.message, true);
  } finally {
    button.disabled = false;
  }
};

$('login-form').onsubmit = async event => {
  event.preventDefault();

  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: $('login-email').value.trim(),
        password: $('login-password').value
      })
    });

    message(data.message);
    dashboard(data.user);
  } catch (error) {
    message(error.message, true);
  }
};

$('logout').onclick = async () => {
  try {
    await api('/api/auth/logout', {
      method: 'POST',
      body: '{}'
    });
  } catch {}

  currentUser = null;
  selectedRecipient = null;

  $('dashboard').classList.add('hidden');
  $('auth').classList.remove('hidden');

  loginView();
};

window.addEventListener('beforeunload', stopCamera);

(async () => {
  try {
    const data = await api('/api/me');
    dashboard(data.user);
  } catch {
    loginView();
  }
})();
// Handle dashboard buttons and clearly identify demo-only services.
document.querySelectorAll('[data-notice]').forEach(button => {
  button.addEventListener('click', () => {
    alert(button.dataset.notice);
  });
});

// Open the transfer section when a transfer shortcut is clicked.
document.querySelectorAll('[data-target]').forEach(button => {
  button.addEventListener('click', () => {
    const target = document.getElementById(button.dataset.target);

    if (target) {
      target.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    }
  });
});

// Show or hide the account balance.
const balanceToggle = document.getElementById('toggle-balance');

if (balanceToggle) {
  balanceToggle.addEventListener('click', () => {
    const balance = document.getElementById('balance-value');

    if (balance) {
      const hidden = balance.dataset.hidden === 'true';

      if (!hidden) {
        balance.dataset.original = balance.textContent;
        balance.textContent = '₦••••••';
        balance.dataset.hidden = 'true';
      } else {
        balance.textContent = balance.dataset.original || '₦0.00';
        balance.dataset.hidden = 'false';
      }
    }
  });
}
// Add simulated demo funds to the signed-in user's account.
const addDemoMoneyButton = document.getElementById('add-demo-money');

if (addDemoMoneyButton) {
  addDemoMoneyButton.addEventListener('click', async () => {
    if (document.getElementById('demo-deposit-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'demo-deposit-overlay';
    overlay.style.cssText = `
      position:fixed; inset:0; z-index:9999;
      background:rgba(0,0,0,.75); display:flex;
      align-items:center; justify-content:center; padding:20px;
    `;

    overlay.innerHTML = `
      <form id="demo-deposit-form" style="
        width:100%; max-width:420px; background:#111b19;
        color:white; padding:26px; border-radius:18px;
        border:1px solid #176b58;
      ">
        <h2 style="margin:0 0 8px">Add Demo Money</h2>
        <p style="color:#a9c5bc; margin-bottom:20px">
          Simulated funds only. Maximum ₦100 billion.
        </p>
        <label for="demo-deposit-amount">Amount in naira</label>
        <div style="
          display:flex; align-items:center; gap:8px;
          margin-top:8px; padding:12px;
          border:1px solid #176b58; border-radius:10px;
        ">
          <span>₦</span>
          <input id="demo-deposit-amount" type="text"
            inputmode="decimal" autocomplete="off"
            placeholder="0.00" required
            style="width:100%; min-width:0; border:0; outline:0;
              background:transparent; color:white; font-size:20px">
        </div>
        <p id="demo-deposit-error" role="alert"
          style="color:#ff9d9d; min-height:20px"></p>
        <div style="display:flex; gap:10px; margin-top:16px">
          <button type="button" id="demo-deposit-cancel"
            style="flex:1;padding:12px;border-radius:9px;cursor:pointer">
            Cancel
          </button>
          <button type="submit" id="demo-deposit-submit"
            style="flex:1;padding:12px;border:0;border-radius:9px;
              background:#00b894;color:#06130f;font-weight:bold;cursor:pointer">
            Add Money
          </button>
        </div>
      </form>
    `;

    document.body.appendChild(overlay);

    const form = overlay.querySelector('#demo-deposit-form');
    const input = overlay.querySelector('#demo-deposit-amount');
    const errorBox = overlay.querySelector('#demo-deposit-error');
    const submitButton = overlay.querySelector('#demo-deposit-submit');
    const cancelButton = overlay.querySelector('#demo-deposit-cancel');

    const closeDialog = () => overlay.remove();

    cancelButton.addEventListener('click', closeDialog);

    overlay.addEventListener('click', event => {
      if (event.target === overlay) closeDialog();
    });

    input.addEventListener('input', () => {
      let raw = input.value.replace(/,/g, '').replace(/[^\d.]/g, '');
      const dot = raw.indexOf('.');

      if (dot !== -1) {
        raw = raw.slice(0, dot + 1) +
          raw.slice(dot + 1).replace(/\./g, '').slice(0, 2);
      }

      let [whole = '', decimal] = raw.split('.');
      whole = whole.replace(/^0+(?=\d)/, '');

      if (whole.length > 12) whole = whole.slice(0, 12);

      const formattedWhole = whole
        ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
        : '';

      input.value = decimal !== undefined
        ? `${formattedWhole}.${decimal}`
        : formattedWhole;
    });

    input.focus();

    form.addEventListener('submit', async event => {
      event.preventDefault();

      const amount = input.value.replace(/,/g, '');

      if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(amount)) {
        errorBox.textContent = 'Enter a valid amount with up to two decimal places.';
        return;
      }

      const [naira = '0', kobo = ''] = amount.split('.');
      const minor = BigInt(naira) * 100n + BigInt(kobo.padEnd(2, '0'));

      if (minor <= 0n || minor > 10000000000000n) {
        errorBox.textContent = 'Amount must be between ₦0.01 and ₦100,000,000,000.00.';
        return;
      }

      submitButton.disabled = true;
      submitButton.textContent = 'Adding...';
      errorBox.textContent = '';

      try {
        const data = await api('/api/demo-deposits', {
          method: 'POST',
          body: JSON.stringify({ amountNaira: amount })
        });

        closeDialog();
        alert(data.message);

        await refreshBanking();
      } catch (error) {
        errorBox.textContent = error.message || 'Could not add demo money.';
      } finally {
        if (submitButton.isConnected) {
          submitButton.disabled = false;
          submitButton.textContent = 'Add Money';
        }
      }
    });
  });
}

