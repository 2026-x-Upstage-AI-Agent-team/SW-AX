const form = document.getElementById('staff-login');
const username = document.getElementById('username');
const password = document.getElementById('password');
const visibility = document.getElementById('password-visibility');
const errorMessage = document.getElementById('login-error');
const submit = form.querySelector('button[type="submit"]');
const fields = [username, password];

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
    if (field.getAttribute('aria-invalid') === 'true') clearError();
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
  submit.textContent = '로그인 중…';
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
    location.replace(new URL('./#/', form.action));
    return;
  }

  submit.disabled = false;
  submit.textContent = '로그인';
  if (response?.status === 401) {
    if (username.value !== values.get('username') || password.value !== values.get('password')) return;
    password.value = '';
    showError('아이디 또는 비밀번호를 확인해 주세요.', fields);
    password.focus();
    return;
  }

  showError('잠시 후 다시 시도해 주세요.');
});

visibility.hidden = false;
visibility.addEventListener('click', () => {
  const reveal = password.type === 'password';
  password.type = reveal ? 'text' : 'password';
  visibility.textContent = reveal ? '숨기기' : '보기';
  visibility.setAttribute('aria-label', reveal ? '비밀번호 숨기기' : '비밀번호 보기');
});

const logoutNotice = document.getElementById('logout-notice');
if (logoutNotice) {
  logoutNotice.showModal();
  logoutNotice.addEventListener('close', () => username.focus());
  const url = new URL(location.href);
  url.searchParams.delete('logout');
  history.replaceState(history.state, '', url);
}
