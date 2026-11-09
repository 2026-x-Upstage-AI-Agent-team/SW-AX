import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright-core';

// tests/test_intake_deletion.py supplies newly created fixtures from its isolated database.
test('삭제 범위 재확인과 세 화면의 삭제', { skip: !process.env.DELETION_FIXTURE }, async t => {
  const baseURL = new URL(process.env.INTAKE_TEST_URL);
  assert.equal(baseURL.hostname, '127.0.0.1');
  assert.ok(baseURL.port && baseURL.port !== '18765');
  const { event, batches: [first, second], reports, single } = JSON.parse(process.env.DELETION_FIXTURE);
  const browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.CHROME_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage({ baseURL: baseURL.origin, viewport: { width: 1366, height: 800 } });
  page.setDefaultTimeout(10000);
  await page.goto('/login');
  await page.getByLabel('아이디', { exact: true }).fill(process.env.INTAKE_TEST_LOGIN_A);
  await page.getByLabel('비밀번호', { exact: true }).fill(process.env.INTAKE_TEST_PASSWORD_A);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/');
  const events = await (await page.request.get('/api/events')).json();
  const name = events.find(e => e.id === event)?.name;
  assert.match(name, /^삭제 검증 [0-9a-f]{32}$/);
  const deletes = [];
  page.on('request', req => { if (req.method() === 'DELETE') deletes.push(req); });
  const dialog = page.getByRole('dialog');
  async function remove(kind, status, path) {
    const reply = page.waitForResponse(r => r.request().method() === 'DELETE' && new URL(r.url()).pathname === path);
    await dialog.getByRole('button', { name: kind + ' 삭제하기' }).click();
    assert.equal((await reply).status(), status);
    assert.match(deletes.at(-1).headers()['if-match'], /^"[a-f0-9]{64}"$/);
  }
  const screen = async path => page.goto('/#' + path);
  const route = path => path.replace('/api/intake-batches/', '/intake/batches/');
  const get = async path => (await page.request.get(path)).json();
  await screen('/manage');
  await page.getByLabel('대회 선택').filter({ visible: true }).selectOption(event);
  const eventButton = page.getByRole('button', { name: name + ' 대회 삭제', exact: true });
  await eventButton.click();
  await dialog.getByText('팀별 판정 2건', { exact: true }).waitFor();
  await dialog.getByText('지급내역서 2건', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: '취소' }).evaluate(e => e === document.activeElement), true);
  await dialog.getByRole('button', { name: '취소' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(deletes.length, 0);

  await eventButton.click();
  await dialog.getByText(/등록 팀 3개/).waitFor();
  const { csrf_token } = await get('/api/auth/session');
  const changed = await page.request.post('/api/events/' + event + '/teams', { headers: { 'X-CSRF-TOKEN': csrf_token }, data: { name: '추가 접수 팀' } });
  assert.ok(changed.ok());
  await remove('대회', 412, '/api/events/' + event);
  await dialog.getByText(/최신 목록을 다시 확인/).waitFor();
  assert.equal(await dialog.getByRole('button', { name: '대회 삭제하기' }).isDisabled(), true);
  await dialog.getByRole('button', { name: '삭제 목록 다시 조회' }).click();
  await dialog.getByText(/등록 팀 4개/).waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  for (const report of reports) assert.equal((await page.request.get(report + '/pdf')).status(), 200);

  await screen(route(first));
  const file = (await get(first)).files[0];
  const filePath = first + '/files/' + file.item_id;
  await page.getByRole('button', { name: file.name + ' 원본 삭제', exact: true }).click();
  await dialog.getByText('팀별 판정 1건', { exact: true }).waitFor();
  await dialog.getByText(/접수 1팀.*제출본 v1.*담당자확인.*담당자 승인/).waitFor();
  await dialog.getByText('지급내역서 v1 · 보고서 확정').waitFor();
  assert.equal(await dialog.getByText(/지급내역서 v2/).count(), 0);
  await remove('원본', 204, filePath);
  await page.getByRole('button', { name: file.name + ' 원본 삭제', exact: true }).waitFor({ state: 'detached' });
  assert.equal((await page.request.get(reports[0] + '/pdf')).status(), 404);
  assert.equal((await page.request.get(reports[1] + '/pdf')).status(), 200);

  await screen('/intake/batches');
  const short = second.split('/').at(-1).slice(0, 8);
  await page.getByRole('button', { name: '접수 ' + short + ' 묶음 삭제' }).click();
  await dialog.getByText('지급내역서 v2 · 보고서 확정').waitFor();
  await dialog.getByText(/접수 2팀.*제출본 v1/).waitFor();
  await remove('묶음', 204, second);
  await page.getByRole('link', { name: short, exact: true }).waitFor({ state: 'detached' });

  await screen(route(single));
  await page.setViewportSize({ width: 360, height: 640 });
  await page.getByRole('button', { name: /원본 삭제$/ }).click();
  await dialog.getByText('함께 삭제할 판정이 없습니다.').waitFor();
  await dialog.getByText('함께 삭제할 보고서가 없습니다.').waitFor();
  await dialog.getByText(/마지막 원본이므로/).waitFor();
  assert.ok(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth && e.getBoundingClientRect().width <= innerWidth));
  await remove('원본', 204, single + '/files/' + (await get(single)).files[0].item_id);
  await page.waitForURL('**/#/intake/batches');
  await page.getByText('마지막 원본과 접수 묶음을 삭제했습니다.').waitFor();
  await screen('/manage');
  await eventButton.click();
  await dialog.getByText(/등록 팀 4개.*접수 묶음 1건.*원본 2개/).waitFor();
  await remove('대회', 204, '/api/events/' + event);
  await page.getByText(name + ' 대회를 삭제했습니다.', { exact: true }).waitFor();
});
