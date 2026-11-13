import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const event = { id: 'gmail-test', name: 'Gmail 연결 시험', category_id: 'awards' };
const path = '/#/categories/awards/workspaces/gmail-test/gmail';
let server, browser, baseURL;
before(async () => {
  server = await preview({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), logLevel: 'silent', preview: { host: '127.0.0.1', port: 0 } });
  baseURL = 'http://127.0.0.1:' + server.httpServer.address().port;
  browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.CHROME_EXECUTABLE });
});
after(async () => { await browser?.close(); await server?.close(); });

async function setup(t, initial, width = 1440) {
  const context = await browser.newContext({ baseURL, viewport: { width, height: 1000 }, locale: 'ko-KR', reducedMotion: 'reduce' });
  await context.addInitScript(() => localStorage.setItem('swax.workspace-tour.v1.intake.gmail-test', 'done'));
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const errors = [], changes = [];
  let account = initial;
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { assert.deepEqual(errors, []); await context.close(); });
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url());
    const status = { ...account, redirect_uri: baseURL + '/api/settings/gmail/callback' };
    if (url.pathname === '/api/settings/gmail' && req.method() === 'GET') return route.fulfill({ json: status });
    if (url.pathname === '/api/settings/gmail/connect') {
      const body = req.postDataJSON(); changes.push({ path: url.pathname, body });
      if (body.app_password === 'aaaaaaaaaaaaaaaa') return route.fulfill({ status: 422, json: { detail: 'Google에서 인증을 거절했습니다.' } });
      account = { gmail_account: body.address, gmail_oauth_connected: false, mail_ready: true };
      return route.fulfill({ json: { address: body.address, connected: true } });
    }
    if (url.pathname === '/api/settings/gmail/disconnect') {
      changes.push({ path: url.pathname, body: req.postData() });
      account = { ...account, gmail_oauth_connected: false, mail_ready: false };
      return route.fulfill({ json: account });
    }
    if (url.pathname === '/api/settings/gmail/oauth/start') {
      changes.push({ path: url.pathname, body: req.postDataJSON() });
      return route.fulfill({ json: { url: baseURL + '/test-consent' } });
    }
    const data = {
      '/api/events': [event], '/api/events/gmail-test/teams': [],
      '/api/dashboard': { event: event.id, events: [event], teams: [], batches: [], reports: [], mail: [], smtp: true, ...account },
      '/api/auth/session': { login: 'gmail-fixture-a' }, '/api/operations/worker-status': { state: 'running' },
    }[url.pathname];
    return route.fulfill({ status: data ? 200 : 404, json: data ?? {} });
  });
  await page.route('**/test-consent', route => route.fulfill({ contentType: 'text/html', body: '<h1>Consent test double</h1>' }));
  await page.goto(path);
  await page.getByRole('heading', { name: '내 발신 계정' }).waitFor();
  return { page, changes };
}

test('발신 주소가 없어도 Google 계정 선택을 시작할 수 있다', async t => {
  const { page, changes } = await setup(t, { gmail_account: '', gmail_oauth_connected: false, mail_ready: false });
  assert.equal(await page.getByText('GMAIL_ADDRESS', { exact: false }).count(), 0);
  await page.getByRole('button', { name: 'Google 계정 연결', exact: true }).click();
  await page.waitForURL('**/test-consent');
  assert.deepEqual(changes, [{ path: '/api/settings/gmail/oauth/start', body: {} }]);
});

test('연결 중에도 다른 계정을 선택할 수 있다', async t => {
  const { page } = await setup(t, { gmail_account: 'original@example.org', gmail_oauth_connected: true, mail_ready: true });
  await page.getByText('original@example.org', { exact: true }).waitFor();
  await page.getByRole('button', { name: '다른 Google 계정으로 변경' }).click();
  await page.waitForURL('**/test-consent');
});

test('앱 비밀번호 인증이 실패하면 기존 연결을 유지하고 성공한 주소로 변경한다', async t => {
  const { page, changes } = await setup(t, { gmail_account: 'original@example.org', gmail_oauth_connected: true, mail_ready: true });
  await page.getByText('앱 비밀번호로 연결', { exact: true }).click();
  await page.getByLabel('Google 계정 이메일', { exact: true }).fill('changed@example.org');
  await page.getByLabel('Google이 발급한 16자리 코드', { exact: true }).fill('aaaaaaaaaaaaaaaa');
  await page.getByRole('button', { name: '인증하고 연결' }).click();
  await page.getByText('Google에서 인증을 거절했습니다.', { exact: true }).waitFor();
  assert.equal(await page.getByText('original@example.org', { exact: true }).count(), 1);
  await page.getByLabel('Google 계정 이메일', { exact: true }).fill('changed@example.org');
  await page.getByLabel('Google이 발급한 16자리 코드', { exact: true }).fill('bbbbbbbbbbbbbbbb');
  await page.getByRole('button', { name: '인증하고 연결' }).click();
  await page.getByText('changed@example.org', { exact: true }).waitFor();
  assert.deepEqual(changes.at(-1).body, { address: 'changed@example.org', app_password: 'bbbbbbbbbbbbbbbb' });
  assert.equal(await page.getByLabel('Google이 발급한 16자리 코드', { exact: true }).inputValue(), '');
});

for (const oauth of [true, false]) test(`${oauth ? 'Google' : '앱 비밀번호'} 연결 해제와 모바일 화면`, async t => {
  const { page, changes } = await setup(t, { gmail_account: 'mine@example.org', gmail_oauth_connected: oauth, mail_ready: true }, 320);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.SWAX_GMAIL_SCREENSHOTS) await page.screenshot({ path: process.env.SWAX_GMAIL_SCREENSHOTS + `/gmail-${oauth ? 'oauth' : 'password'}-320.png`, fullPage: true });
  await page.getByRole('button', { name: '연결 해제', exact: true }).click();
  await page.getByText('다시 연결 필요', { exact: true }).waitFor();
  assert.equal(changes.at(-1).path, '/api/settings/gmail/disconnect');
  assert.equal(await page.getByRole('button', { name: '연결 해제', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Google 계정 연결', exact: true }).count(), 1);
});
