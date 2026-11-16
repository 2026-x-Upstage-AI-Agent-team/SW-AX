import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const event = { id: 'mail-reason-test', name: '보완 초안 시험', category_id: 'awards' };
const mail = { id: 'mail-5', submission: 'sub-5', kind: '보완 요청', state: 'draft', name: '가상검토팀05', version: 1, created: 1 };
const reason = 'AI가 확정한 보완 항목이 없어 초안을 생성하지 못했습니다. 담당자 검토에서 보완 사유를 확정하거나 본문을 직접 작성해 주세요.';
let server, browser, baseURL;
before(async () => {
  server = await preview({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), logLevel: 'silent', preview: { host: '127.0.0.1', port: 0 } });
  baseURL = 'http://127.0.0.1:' + server.httpServer.address().port;
  browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.CHROME_EXECUTABLE });
});
after(async () => { await browser?.close(); await server?.close(); });

async function setup(t, body = '', width = 1440) {
  const context = await browser.newContext({ baseURL, viewport: { width, height: 1000 }, locale: 'ko-KR', reducedMotion: 'reduce' });
  await context.addInitScript(() => localStorage.setItem('swax.workspace-tour.v1.intake.mail-reason-test', 'done'));
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  let view = { ...mail, subject: '[시상금 서류 보완 요청] 가상검토팀05', body, generation_reason: body ? '' : reason,
    revision: 0, recipient: 'leader@example.test', sender_address: 'staff@example.test', can_approve: true };
  const calls = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { assert.deepEqual(errors, []); await context.close(); });
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path === '/api/mail/mail-5/draft') {
      calls.push({ path, body: req.postDataJSON() });
      view = { ...view, ...req.postDataJSON(), revision: 1, generation_reason: '' };
      return route.fulfill({ json: view });
    }
    if (path.endsWith('/approve')) throw new Error('This test must never approve mail');
    const data = {
      '/api/events': [event], '/api/events/mail-reason-test/teams': [],
      '/api/dashboard': { event: event.id, events: [event], teams: [], batches: [], reports: [], mail: [mail], smtp: true, mail_ready: true },
      '/api/mail/mail-5': view, '/api/auth/session': { login: 'staff-fixture' },
      '/api/operations/worker-status': { state: 'running' },
    }[path];
    return route.fulfill({ status: data ? 200 : 404, json: data ?? {} });
  });
  await page.goto('/#/categories/awards/workspaces/mail-reason-test/mail');
  await page.getByRole('heading', { name: '초안 검토', exact: true }).waitFor();
  await page.getByRole('textbox', { name: '본문', exact: true }).waitFor();
  return { page, calls };
}

test('본문이 없으면 생성하지 못한 이유와 검토 화면 진입점을 표시한다', async t => {
  const { page } = await setup(t);
  await page.getByText(reason, { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '본문', exact: true }).inputValue(), '');
  assert.equal(await page.getByRole('link', { name: '보완 사유 확인' }).getAttribute('href'), '#/categories/awards/workspaces/mail-reason-test/teams/sub-5');
  assert.equal(await page.getByRole('button', { name: '승인 후 발송' }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '초안 저장' }).isDisabled(), true);
});

test('직접 작성한 본문에는 생성 불가 이유를 넣지 않고 편집 내용을 저장한다', async t => {
  const { page, calls } = await setup(t);
  const text = '담당자 확인 결과 동의서가 없습니다. 동의서를 제출해 주세요.';
  await page.getByRole('textbox', { name: '본문', exact: true }).fill(text);
  assert.equal(await page.getByText(reason, { exact: true }).count(), 0);
  await page.getByRole('button', { name: '초안 저장' }).click();
  await page.getByText('초안을 저장했습니다.', { exact: true }).waitFor();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.body, text);
  assert.equal(Object.hasOwn(calls[0].body, 'generation_reason'), false);
  assert.equal(await page.getByRole('textbox', { name: '본문', exact: true }).inputValue(), text);
});

test('담당자 확정 사유로 생성된 본문은 그대로 편집할 수 있다', async t => {
  const text = '가상검토팀05 팀장님,\n\n보완할 사항\n- 동의서 없음\n\n보완한 서류를 재제출해 주세요.';
  const { page } = await setup(t, text);
  assert.equal(await page.getByRole('textbox', { name: '본문', exact: true }).inputValue(), text);
  assert.equal(await page.getByRole('link', { name: '보완 사유 확인' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '승인 후 발송' }).isEnabled(), true);
});

test('320px 화면에서도 생성 불가 이유와 직접 작성란이 표시된다', async t => {
  const { page } = await setup(t, '', 320);
  await page.getByText(reason, { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.MAIL_REASON_SCREENSHOTS) await page.screenshot({ path: process.env.MAIL_REASON_SCREENSHOTS + '/empty-draft-320.png', fullPage: true });
});
