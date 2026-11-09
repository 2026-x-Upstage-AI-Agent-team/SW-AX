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

const conflictId = process.env.INTAKE_TEST_CONFLICT_BATCH;
const printId = process.env.INTAKE_TEST_PRINT_REPORT;
const queueEvent = process.env.INTAKE_TEST_QUEUE_EVENT;
const historyId = process.env.INTAKE_TEST_RETRY_SUBMISSION;
const recipientId = process.env.INTAKE_TEST_RECIPIENT_SUBMISSION;
const delayedId = process.env.INTAKE_TEST_DELAYED_SUBMISSION;
if (queueEvent) {
  test('처리 대기 중인 팀의 최초 원본 접수 시각을 표시한다', async () => {
    const dashboard = await (await request.get('/api/dashboard?event=' + queueEvent)).json();
    const waiting = dashboard.teams.map((t) => t.submission).filter((s) => s?.state === 'queued');
    const first = Math.min(...waiting.map((s) => s.received));
    assert.ok(first < Math.min(...waiting.map((s) => s.created)) - 3500);
    await page.addInitScript((id) => localStorage.setItem('swax.event.intake', id), queueEvent);
    await page.goto('/#/');
    const value = await page.evaluate((t) => new Date(t * 1000).toLocaleString('ko-KR'), first);
    await page.getByText('대기 ' + waiting.length + '팀 · 최초 접수 ' + value, { exact: true }).waitFor();
  });
} else if (conflictId) {
  test('충돌 접수의 원본과 최신 보완 경로를 열고 담당자 대조를 마친다', async () => {
    const { batch } = await (await request.get('/api/intake-batches/' + conflictId)).json();
    await page.addInitScript((id) => localStorage.setItem('swax.event.intake', id), batch.event_id);
    await page.goto('/#/intake/batches/' + conflictId);
    await page.getByText('보완본 담당자 확인', { exact: true }).waitFor();
    assert.ok(await page.locator('a[download]').count());
    await page.getByRole('link', { name: '최신 제출본에서 보완 접수' }).click();
    await page.getByRole('heading', { name: /Nextify 보완본 \(v2/ }).waitFor();
    assert.ok(page.url().endsWith('base=' + batch.current_submission));
    await page.goBack();
    await page.getByRole('button', { name: '이 접수의 대조 완료' }).click();
    await page.getByText('보완본 확인 완료', { exact: true }).waitFor();
    await page.goto('/#/teams/' + process.env.INTAKE_TEST_REASON_SUBMISSION);
    const row = page.getByRole('listitem').filter({ hasText: '01 지급확인서 1쪽 첫째 행에 학번이 없습니다.' }).first();
    await row.getByRole('button', { name: '01 지급확인서 · 1쪽 · 1행' }).click();
    const mail = page.getByRole('listitem').filter({ hasText: '보완 요청' }).filter({ hasText: 'leader@award.test' });
    await mail.getByText(/예약 .* · 발송 /).waitFor();
  });
} else if (printId) {
  test('실패한 보고서에서 같은 HWPX로 재출력을 요청한다', async () => {
    const report = await (await request.get('/api/reports/' + printId)).json();
    await page.addInitScript((id) => localStorage.setItem('swax.event.intake', id), report.event);
    await page.goto('/#/report');
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/' + printId + '/retry-print')),
      page.getByRole('button', { name: '같은 HWPX로 PDF 다시 출력' }).click(),
    ]);
    assert.equal(response.status(), 202);
    assert.deepEqual(await response.json(), { id: printId, version: report.version });
    await page.getByText('전용 PC 출력 대기', { exact: true }).first().waitFor();
  });
} else if (delayedId) {
  test('지연된 판정의 마지막 조회 시각과 총 시도 횟수를 확인하고 처리를 재개한다', async () => {
    const detail = await (await request.get('/api/operations/submissions/' + delayedId)).json();
    assert.equal(detail.job, 'job_found');
    assert.equal(detail.state, 'paused');
    assert.equal(detail.attempts, 4);
    assert.equal(detail.polling_delayed, true);
    assert.ok(detail.last_polled_at);
    await page.goto('/#/teams/' + delayedId);
    const time = page.getByText(/^마지막 조회 시각/).locator('time');
    await time.waitFor();
    const expected = new Date(detail.last_polled_at * 1000).toISOString();
    assert.equal(await time.getAttribute('datetime'), expected);
    const localTime = await page.evaluate((iso) => new Date(iso).toLocaleString('ko-KR', {
      dateStyle: 'medium', timeStyle: 'medium',
    }), expected);
    assert.equal(await time.textContent(), localTime);
    const total = page.getByText('총 4회 시도 (최초 1회, 재시도 3회)', { exact: true });
    const history = page.getByRole('listitem');
    const limit = history.filter({ hasText: '4번째 시도' }).filter({ hasText: 'HTTP 429' });
    await total.waitFor();
    await history.filter({ hasText: '2번째 시도' }).filter({ hasText: 'HTTP 503' }).waitFor();
    await limit.waitFor();
    const [resumed] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/submissions/' + delayedId + '/retry')),
      page.getByRole('button', { name: '처리 재개' }).click(),
    ]);
    assert.equal(resumed.status(), 200);
    await total.waitFor({ state: 'hidden' });
    await page.getByText('처리 지연', { exact: true }).waitFor();
    assert.equal(await time.getAttribute('datetime'), expected);
    await limit.waitFor();
  });
} else if (recipientId) {
  test('신청서와 다른 등록 주소를 현재 제출본에서 확인한다', async () => {
    const path = '/api/operations/submissions/' + recipientId;
    const before = await (await request.get(path)).json();
    assert.match(before.email, /@award\.test$/);
    assert.equal(before.email_needs_confirmation, true);
    assert.ok(before.application_emails.length);
    assert.ok(before.mail.some((m) => m.state === 'recipient_check'));
    await page.goto('/#/teams/' + recipientId);
    await page.getByText('신청서 대표 이메일 · ' + before.application_emails.join(', '), { exact: true }).waitFor();
    const confirm = page.getByRole('button', { name: '이 제출본의 수신 주소 확인' });
    const [saved] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith('/teams/' + before.team + '/email')),
      confirm.click(),
    ]);
    assert.equal(saved.status(), 200);
    assert.deepEqual(saved.request().postDataJSON(), { email: before.email, submission: recipientId });
    const after = await (await request.get(path)).json();
    assert.equal(after.email_needs_confirmation, false);
    assert.equal(after.mail.filter((m) => m.kind === '보완 요청').length, 1);
  });
} else if (historyId) {
  test('처리가 끝난 제출본의 과거 재시도에서도 429와 503을 구분한다', async () => {
    await page.goto('/#/teams/' + historyId);
    for (const reason of ['HTTP 429 · RATE_LIMITED', 'HTTP 503 · SERVICE_UNAVAILABLE']) {
      await page.getByRole('listitem').filter({ hasText: reason }).first().waitFor();
    }
  });
} else {
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
}
