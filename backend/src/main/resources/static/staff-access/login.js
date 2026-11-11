const form = document.getElementById('staff-login');
const password = document.getElementById('password');
const visibility = document.getElementById('password-visibility');

// HashRouter의 목적지는 서버로 전송되지 않으므로 폼 리디렉션에도 같은 프래그먼트를 남긴다.
form.addEventListener('submit', () => {
  const action = new URL(form.action);
  // 로그인 후에는 업무 카테고리 선택부터 시작한다.
  action.hash = '/';
  form.action = action.href;
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
  logoutNotice.addEventListener('close', () => document.getElementById('username').focus());
  const url = new URL(location.href);
  url.searchParams.delete('logout');
  history.replaceState(history.state, '', url);
}
