const form = document.getElementById('staff-login');
const username = document.getElementById('username');
const password = document.getElementById('password');
const visibility = document.getElementById('password-visibility');
const errorMessage = document.getElementById('login-error');
const submit = form.querySelector('button[type="submit"]');
const submitLabel = document.getElementById('login-submit-label');
const testAccount = document.getElementById('test-account-fill');
const testAccountStatus = document.getElementById('test-account-status');
const credentialManager = window.PasswordCredential && navigator.credentials;
const fields = [username, password];
let saveTestAccount = false;

function clearError() {
  errorMessage.textContent = '';
  for (const field of fields) {
    field.removeAttribute('aria-invalid');
    field.removeAttribute('aria-describedby');
  }
}

function showError(message, invalidFields = []) {
  errorMessage.textContent = message;
  for (const field of invalidFields) {
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute('aria-describedby', errorMessage.id);
  }
}

for (const field of fields) {
  field.addEventListener('input', () => {
    if (field.getAttribute('aria-describedby') === errorMessage.id) clearError();
  });
}

form.noValidate = true;
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (submit.disabled) return;
  clearError();

  if (!username.value.trim()) {
    showError('아이디를 입력해 주세요.', [username]);
    username.focus();
    return;
  }
  if (!password.value) {
    showError('비밀번호를 입력해 주세요.', [password]);
    password.focus();
    return;
  }

  const values = new FormData(form);
  submit.disabled = true;
  submitLabel.textContent = '로그인 중…';
  let response;
  try {
    response = await fetch(form.action, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams(values),
    });
  } catch {
    // Network failures use the same feedback slot.
  }

  if (response?.status === 204) {
    if (saveTestAccount) {
      try {
        await credentialManager.store(new window.PasswordCredential({
          id: values.get('username'),
          password: values.get('password'),
        }));
      } catch {
        // Browser settings can prevent saving a password.
      }
    }
    location.replace(new URL('./#/', form.action));
    return;
  }

  submit.disabled = false;
  submitLabel.textContent = '로그인';
  if (response?.status === 401) {
    if (username.value !== values.get('username') || password.value !== values.get('password')) return;
    password.value = '';
    showError('아이디 또는 비밀번호를 확인해 주세요.', [password]);
    username.setAttribute('aria-describedby', errorMessage.id);
    password.focus();
    return;
  }

  showError('잠시 후 다시 시도해 주세요.');
});

visibility.hidden = false;
function setPasswordVisibility(reveal) {
  password.type = reveal ? 'text' : 'password';
  visibility.textContent = reveal ? '숨기기' : '보기';
  visibility.setAttribute('aria-label', reveal ? '비밀번호 숨기기' : '비밀번호 보기');
}
visibility.addEventListener('click', () => setPasswordVisibility(password.type === 'password'));

function fillTestAccount(login, secret, message) {
  saveTestAccount = false;
  setPasswordVisibility(false);
  username.value = login;
  password.value = secret;
  clearError();
  testAccountStatus.textContent = message;
  submit.focus();
}

async function getLocalTestAccount() {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) return null;
  try {
    const response = await fetch('/__swax-local-test-account', {
      method: 'POST',
      mode: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) return null;
    const account = await response.json();
    return typeof account?.login === 'string' && typeof account.password === 'string' ? account : null;
  } catch {
    return null;
  }
}

testAccount.hidden = false;
testAccount.addEventListener('click', async () => {
  if (submit.disabled) return;
  testAccountStatus.textContent = '';
  testAccount.disabled = true;
  try {
    const localAccount = await getLocalTestAccount();
    if (submit.disabled) return;
    if (localAccount) {
      fillTestAccount(localAccount.login, localAccount.password, '로컬 테스트 계정을 채웠습니다.');
      return;
    }
    if (credentialManager) {
      const credential = await credentialManager.get({ password: true, mediation: 'optional' });
      if (submit.disabled) return;
      if (credential?.type === 'password') {
        fillTestAccount(credential.id, credential.password, '이 주소에 저장된 계정을 채웠습니다.');
        return;
      }
      saveTestAccount = true;
      testAccountStatus.textContent = '처음에는 테스트 계정으로 로그인하고 브라우저에서 비밀번호를 저장하세요.';
      username.focus();
      return;
    }
  } catch {
    // Browser autofill remains available through the form fields.
  } finally {
    testAccount.disabled = false;
  }
  testAccountStatus.textContent = '아이디 입력칸에서 브라우저에 저장된 계정을 선택하세요.';
  username.focus();
});

const logoutNotice = document.getElementById('logout-notice');
if (logoutNotice) {
  logoutNotice.showModal();
  logoutNotice.addEventListener('close', () => username.focus());
  const url = new URL(location.href);
  url.searchParams.delete('logout');
  history.replaceState(history.state, '', url);
}
