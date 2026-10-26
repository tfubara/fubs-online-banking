'use strict';

const $ = id => document.getElementById(id);

function showMessage(id, text, isError = false) {
  const element = $(id);
  element.textContent = text;
  element.className = isError ? 'message error' : 'message';
}

async function adminApi(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  let data = {};

  try {
    data = await response.json();
  } catch {}

  if (!response.ok) {
    throw new Error(data.error || 'The request could not be completed.');
  }

  return data;
}

function showLogin() {
  $('admin-login-panel').classList.remove('hidden');
  $('admin-dashboard').classList.add('hidden');
  $('admin-password').value = '';
}

function showDashboard(email) {
  $('admin-login-panel').classList.add('hidden');
  $('admin-dashboard').classList.remove('hidden');
  $('admin-identity').textContent = email;
}

function createTextElement(tag, text, className = '') {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function applicationCard(application) {
  const card = document.createElement('article');
  card.className = 'panel application-card';

  const heading = document.createElement('h3');
  heading.textContent = application.fullName;
  card.append(heading);

  const details = document.createElement('div');
  details.className = 'application-details';

  const fields = [
    ['Application ID', application.id],
    ['Email', application.email],
    ['Phone', application.phone],
    ['Date of birth', application.dateOfBirth],
    ['Gender', application.gender || 'Not provided'],
    ['Country', application.country],
    ['State / region', application.stateRegion],
    ['City', application.city],
    ['Occupation', application.occupation || 'Not provided'],
    ['Employment', application.employmentStatus || 'Not provided'],
    ['Account number', application.accountNumber],
    ['Account status', application.accountStatus],
    ['Bank account status', application.bankAccountStatus],
    ['Email verified', application.emailVerified ? 'Yes' : 'No'],
    ['Phone verified', application.phoneVerified ? 'Yes' : 'No'],
    ['Face verification', application.faceVerificationStatus],
    ['Submitted', new Date(application.createdAt).toLocaleString()]
  ];

  for (const [label, value] of fields) {
    const row = document.createElement('div');
    row.className = 'detail';

    row.append(
      createTextElement('span', label),
      createTextElement('strong', String(value ?? 'Not provided'))
    );

    details.append(row);
  }

  card.append(details);

  const notesLabel = createTextElement('label', 'Review notes (optional)');
  const notes = document.createElement('textarea');
  notes.maxLength = 500;
  notes.rows = 3;
  notes.setAttribute(
    'aria-label',
    `Review notes for ${application.fullName}`
  );
  notes.placeholder = 'Record the reason for your decision.';

  card.append(notesLabel, notes);

  const actions = document.createElement('div');
  actions.className = 'actions';

  const approve = createTextElement('button', 'Approve', 'primary');
  approve.type = 'button';

  const reject = createTextElement('button', 'Reject', 'secondary');
  reject.type = 'button';

  approve.addEventListener('click', () => {
    decideApplication(application, 'approve', notes, approve, reject);
  });

  reject.addEventListener('click', () => {
    decideApplication(application, 'reject', notes, approve, reject);
  });

  actions.append(approve, reject);
  card.append(actions);

  return card;
}

async function loadApplications() {
  const list = $('application-list');
  list.replaceChildren(
    createTextElement('p', 'Loading applications…', 'muted')
  );

  try {
    const data = await adminApi('/api/admin/applications');

    list.replaceChildren();

    const applications = data.applications || [];
    $('application-count').lastElementChild.textContent =
      String(applications.length);

    if (applications.length === 0) {
      list.append(
        createTextElement(
          'p',
          'There are no applications awaiting review.',
          'muted'
        )
      );
      return;
    }

    for (const application of applications) {
      list.append(applicationCard(application));
    }

    showMessage('admin-dashboard-message', '');
  } catch (error) {
    list.replaceChildren(
      createTextElement('p', error.message, 'error')
    );

    if (/sign-in|required|unauthorized/i.test(error.message)) {
      showLogin();
    }
  }
}

async function decideApplication(application, action, notes, approve, reject) {
  const actionText = action === 'approve' ? 'approve' : 'reject';

  if (!window.confirm(
    `Are you sure you want to ${actionText} the application for ${application.fullName}?`
  )) {
    return;
  }

  approve.disabled = true;
  reject.disabled = true;

  try {
    const result = await adminApi(
      `/api/admin/applications/${encodeURIComponent(application.id)}/decision`,
      {
        method: 'POST',
        body: JSON.stringify({
          action,
          notes: notes.value.trim()
        })
      }
    );

    showMessage('admin-dashboard-message', result.message);
    await loadApplications();
  } catch (error) {
    showMessage('admin-dashboard-message', error.message, true);
    approve.disabled = false;
    reject.disabled = false;
  }
}

$('admin-login-form').addEventListener('submit', async event => {
  event.preventDefault();

  const button = $('admin-login-button');
  button.disabled = true;

  try {
    const data = await adminApi('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({
        email: $('admin-email').value.trim(),
        password: $('admin-password').value
      })
    });

    $('admin-password').value = '';
    showMessage('admin-login-message', data.message);
    showDashboard(data.email);
    await loadApplications();
  } catch (error) {
    showMessage('admin-login-message', error.message, true);
  } finally {
    button.disabled = false;
  }
});

$('refresh-applications').addEventListener('click', loadApplications);

$('admin-logout').addEventListener('click', async () => {
  try {
    await adminApi('/api/admin/logout', {
      method: 'POST',
      body: '{}'
    });

    showLogin();
    showMessage('admin-login-message', 'You have signed out.');
  } catch (error) {
    showMessage('admin-dashboard-message', error.message, true);
  }
});

(async function initializeAdmin() {
  try {
    const data = await adminApi('/api/admin/me');
    showDashboard(data.email);
    await loadApplications();
  } catch {
    showLogin();
  }
})();
