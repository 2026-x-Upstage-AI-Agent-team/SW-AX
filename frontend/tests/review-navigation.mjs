import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';

const baseURL = process.env.INTAKE_TEST_URL;
assert.ok(baseURL && ['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname), 'Set the local test API URL');
let browser, page, request;

before(async () => {
  browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.CHROME_EXECUTABLE });
  const context = await browser.newContext({ baseURL });
  page = await context.newPage();
  request = context.request;
  const session = await (await request.get('/api/auth/session')).json();
  const login = await request.post('/login', {
    form: { username: process.env.INTAKE_TEST_LOGIN_A, password: process.env.INTAKE_TEST_PASSWORD_A },
    headers: { Accept: 'application/json', 'X-CSRF-TOKEN': session.csrf_token },
  });
  assert.equal(login.status(), 204);
});
after(async () => browser?.close());

test('각 근거의 PDF와 누락된 서류의 확정 목록을 연다', async () => {
  const events = await (await request.get('/api/events')).json();
  const event = process.env.INTAKE_TEST_EVENT
    ? events.find((e) => e.id === process.env.INTAKE_TEST_EVENT)
    : events.find((e) => e.name === '공식 오류 사례 검증');
  assert.ok(event, 'Run tests.test_operations_cases on the test DB first');
  const dashboard = await (await request.get('/api/dashboard?event=' + event.id)).json();
  const preview = page.getByRole('region', { name: '원문 미리보기' });
  const checklist = page.getByRole('complementary', { name: '검토 체크리스트' });
  async function openTeam(set) {
    const team = dashboard.teams.find((t) => t.email === set + '@award.test');
    assert.ok(team?.current, set);
    const detail = await (await request.get('/api/operations/submissions/' + team.current)).json();
    await page.goto('/#/teams/' + detail.id);
    await page.getByRole('heading', { name: detail.team_name, exact: true }).waitFor();
    return detail;
  }
  async function assertPreview(file, ref) {
    const iframe = preview.locator('iframe');
    const url = file.url + '#page=' + ref.page;
    await page.waitForFunction((src) => document.querySelector('#review-preview iframe')?.getAttribute('src') === src, url);
    await iframe.waitFor();
    assert.equal(await iframe.getAttribute('title'), file.name);
    assert.equal(await iframe.getAttribute('src'), url);
    if (ref.row) await preview.getByText(file.name + ' · ' + ref.page + '쪽 · ' + ref.row + '행').waitFor();
    const pdf = await request.get(file.url);
    assert.equal(pdf.status(), 200);
    assert.equal((await pdf.body()).subarray(0, 5).toString(), '%PDF-');
  }
  for (const [set, label] of [['set03', '대표 계좌·예금주 일치'], ['set05', '동의서 2부 접수'], ['set10', '동의서 명단에 없음']]) {
    const detail = await openTeam(set);
    const check = detail.result.checks.find((c) => c.label.includes(label));
    assert.ok(check && check.refs.length >= 2, label);
    const buttons = checklist.getByRole('listitem').filter({ has: page.getByText(check.label, { exact: true }) }).getByRole('button');
    assert.equal(await buttons.count(), check.refs.length);
    for (const [i, ref] of check.refs.entries()) {
      await buttons.nth(i).click();
      await assertPreview(detail.files.find((f) => f.id === ref.id), ref);
    }
  }
  const detail = await openTeam('set04');
  const missing = checklist.getByRole('listitem').filter({ hasText: '동의서 0부 접수' });
  await missing.getByRole('button', { name: '확정 파일 목록 보기' }).click();
  const files = preview.getByRole('region', { name: '확정 파일 목록' });
  await files.getByRole('heading', { name: `제출 v${detail.version} 확정 파일 목록 · 2개` }).waitFor();
  assert.deepEqual(await files.getByRole('button').allTextContents(), detail.files.map((f) => f.name));
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'review-preview');
  await files.getByRole('button').last().click();
  const last = detail.files.at(-1);
  await assertPreview(last, { page: last.page || 1 });
});
