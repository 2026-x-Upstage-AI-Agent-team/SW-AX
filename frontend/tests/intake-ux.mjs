import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const event = { id: 'test', name: '시험 대회' };
const team = { id: 'team', name: '시험 팀' };
const name = '01._(팀별)_SW수혜학생신청_및_시상금지급확인서_최종.hwpx';
const file = { id: 'original', name, kind: '01', state: 'unassigned', candidates: [], excluded: [], url: '', size: 100, pages: 0 };
const batch = { id: 'batch', state: 'review', created: 1, revision: 4, pending: 1, files: [file] };
const dashboard = { event: event.id, events: [event], teams: [team], batches: [batch], mail: [], reports: [] };
const batchPath = '/api/operations/batches/batch';
const statusPath = '/api/operations/worker-status';
const status = { state: 'running', online: ['prepare', 'studio', 'mail', 'report', 'printer'], checked_at: '2026-11-09T10:00:00Z', printer_last_seen: '2026-11-09T10:00:00Z' };
const responses = { '/api/events': [event], '/api/events/test/teams': [team], '/api/dashboard': dashboard, [batchPath]: batch, [statusPath]: status };
const versionsPath = '/api/files/original/versions';
responses[versionsPath] = { name, versions: [] };
let browser, server, baseURL, receiveUpload;

before(async () => {
  server = await preview({
    configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), logLevel: 'silent',
    preview: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'test-upload-receipt',
      configurePreviewServer(app) {
        app.middlewares.use((req, res, next) => {
          if (receiveUpload && req.method === 'POST' && req.url === '/api/intake-batches') {
            const chunks = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => receiveUpload(res, Buffer.concat(chunks)));
          } else next();
        });
      },
    }],
  });
  baseURL = 'http://127.0.0.1:' + server.httpServer.address().port;
  browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.CHROME_EXECUTABLE });
});
after(async () => { await browser?.close(); await server?.close(); });

async function newPage(t, width = 1440) {
  const context = await browser.newContext({ baseURL, viewport: { width, height: 850 }, locale: 'ko-KR', reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  t.after(() => context.close());
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/intake-batches' && route.request().method() === 'POST') return route.continue();
    return path in responses ? route.fulfill({ json: responses[path] }) : route.fulfill({ status: 404, json: {} });
  });
  return page;
}

test('좁은 화면에서 파일을 열고 목록으로 돌아오면 키보드 포커스도 돌아온다', async t => {
  const page = await newPage(t, 375);
  await page.goto('/#/assign');
  const queue = page.getByRole('region', { name: '확인할 파일 1' });
  const row = queue.getByRole('button', { name: new RegExp('SW수혜학생신청') });
  await row.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.id === 'detail-h');
  assert.equal(await queue.isVisible(), false);
  assert.equal(await page.getByRole('link', { name: '원본 받기' }).getAttribute('href'), '/api/intake-batches/batch/files/original/original');
  await page.goBack();
  await page.waitForFunction(() => document.activeElement?.id === 'assignment-file-original');
  await page.goForward();
  await page.getByRole('button', { name: '파일 목록으로' }).click();
  await row.waitFor();
  assert.equal(new URL(page.url()).hash, '#/assign');
  await page.goto('/#/assign?file=original');
  await page.getByRole('button', { name: '파일 목록으로' }).click();
  await row.waitFor();
  await page.goto('/#/assign?file=missing');
  await page.getByRole('alert').filter({ hasText: '현재 대회의 최근 접수 목록에 없습니다' }).waitFor();
  assert.equal(await page.locator('#detail-h').count(), 0);
});

test('판독 대기 원본은 확인할 파일에 있고 배정되면 처리된 목록으로 이동한다', async t => {
  const page = await newPage(t);
  await page.clock.install();
  const states = ['waiting', 'read', 'unassigned', 'error', 'assigned', 'outside'];
  const files = states.map(state => ({ ...file, id: state, name: state + '.hwpx', state }));
  const preparing = { ...batch, state: 'preparing', count: files.length, pending: 4, files };
  await page.route('**/api/dashboard?*', route => route.fulfill({ json: { ...dashboard, batches: [preparing] } }));
  await page.route('**' + batchPath, route => route.fulfill({ json: preparing }));
  await page.goto('/#/assign');
  const queue = page.getByRole('region', { name: /^확인할 파일/ });
  await queue.getByRole('heading', { name: '확인할 파일 4', exact: true }).waitFor();
  const lists = queue.getByRole('list');
  const rowIds = list => list.getByRole('button').evaluateAll(buttons => buttons.map(button => button.id));
  assert.deepEqual(await rowIds(lists.first()), states.slice(0, 4).map(state => 'assignment-file-' + state));
  assert.ok(await page.getByRole('radio', { name: '팀에 배정' }).isDisabled());
  await queue.getByRole('button', { name: '배정·처리된 파일 2 보기' }).click();
  assert.deepEqual(await rowIds(lists.nth(1)), ['assignment-file-assigned', 'assignment-file-outside']);
  files[0].state = 'assigned';
  preparing.pending--;
  await page.clock.fastForward(3001);
  await queue.getByRole('heading', { name: '확인할 파일 3', exact: true }).waitFor();
  await queue.getByRole('button', { name: '배정·처리된 파일 3 접기' }).waitFor();
  assert.deepEqual(await rowIds(lists.first()), states.slice(1, 4).map(state => 'assignment-file-' + state));
  assert.deepEqual(await rowIds(lists.nth(1)), ['assignment-file-waiting', 'assignment-file-assigned', 'assignment-file-outside']);
});

test('팀별 판정 필터는 대기·조치 필요·성공을 구분하고 새 판정이 도착하면 개수를 갱신한다', async t => {
  const page = await newPage(t, 375);
  await page.clock.install();
  function row(id, state, verdict = null, decision = null, held = false) {
    return { id, name: id, current: state ? id : null, held, submission: state ? { id, state, verdict, decision, version: 1, created: 1 } : null };
  }
  const teams = [
    row('접수팀', 'queued'), row('재판정팀', 'running', '성공'), row('요청팀', 'creating'), row('검토팀', 'polling'),
    row('확인팀', 'done', '담당자확인', '승인'), row('재제출팀', 'done', '재제출요청'), row('오류팀', 'failed'),
    row('배정확인팀', 'queued', null, null, true), row('미제출팀', null),
    row('승인전팀', 'done', '성공'), row('승인팀', 'done', '성공', '승인'),
  ];
  await page.route('**/api/dashboard?*', route => route.fulfill({ json: { ...dashboard, teams, batches: [] } }));
  await page.route('**/api/operations/submissions/*', route => route.fulfill({ json: { id: route.request().url().split('/').pop(), history: [] } }));
  await page.goto('/#/');
  const filters = page.getByRole('group', { name: '판정 필터' });
  const table = page.getByRole('region', { name: '팀별 판정 표' });
  const names = () => table.locator('tbody .team-identity').evaluateAll(cells => cells.map(cell => cell.firstElementChild.textContent));
  async function select(label) {
    const button = filters.getByRole('button', { name: label, exact: true });
    await button.click();
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
  }
  await select('전체 11');
  assert.equal((await names()).length, 11);
  await select('처리 대기 4');
  assert.deepEqual(await names(), ['접수팀', '재판정팀', '요청팀', '검토팀']);
  await select('조치 필요 5');
  assert.deepEqual(await names(), ['확인팀', '재제출팀', '오류팀', '배정확인팀', '미제출팀']);
  await select('정리됨 2');
  assert.deepEqual(await names(), ['승인전팀', '승인팀']);
  teams[0] = row('접수팀', 'done', '성공');
  await page.clock.fastForward(3001);
  await filters.getByRole('button', { name: '정리됨 3', pressed: true }).waitFor();
  assert.deepEqual(await names(), ['접수팀', '승인전팀', '승인팀']);
  await select('처리 대기 3');
  assert.deepEqual(await names(), ['재판정팀', '요청팀', '검토팀']);
  await page.setViewportSize({ width: 320, height: 740 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
});

test('판정 사유는 문제만 요약하고 검토 상세에서 원본 근거로 이동한다', async t => {
  const page = await newPage(t);
  const ref = id => ({ id, page: 1 });
  const documents = { '01': [ref('app')], '02': [ref('consent-a'), ref('consent-b')], '03': [ref('identity')], '?': [] };
  const raw = '계좌번호 123456789012가 일치합니다.【†1】 신분증 issued_date 누락, Sub-doc 2 동의서 명단 확인.';
  const report = '| 문서 | 대상자 | 항목 | 관측 상태 | 적용 기준 | 결과 | 근거 |\n|---|---|---|---|---|---|---|\n| 신분증 | 대표 | issued_date | 빈 값 | 필수 | 실패 | 미기재 |';
  const base = { version: 1, state: 'done', email: '', note: '', count: 4, history: [], audit: [], mail: [], fields: { members: [], recipient: {} } };
  const detail = { ...base, id: 'multiple', current: 'multiple', team: 'multiple', team_name: '중복팀', verdict: '재제출요청',
    files: Object.entries(documents).flatMap(([kind, refs]) => refs.map(r => ({ ...file, ...r, name: r.id + '.hwp', kind, url: '/pdf/' + r.id }))),
    result: { verdict: '재제출요청', reason: raw, staff_report: report, documents, issues: ['duplicate', 'consent'], checks: [
      { label: '동의서 2부 접수', passed: false, refs: documents['02'] },
      { label: '신청 명단과 동의서 작성자 일치', passed: false, refs: documents['02'] },
      { label: raw, passed: false, refs: documents['03'] },
      { label: '대표 서명', passed: true, refs: documents['01'] },
    ] } };
  const success = { ...detail, id: 'success', current: 'success', team_name: '정상팀', verdict: '성공',
    result: { ...detail.result, verdict: '성공', documents: { ...documents, '02': [ref('consent-a')] }, checks: [], issues: [] } };
  const missing = { ...detail, id: 'missing', current: 'missing', team_name: '누락팀',
    result: { ...detail.result, documents: { ...documents, '02': [], '03': [] }, issues: ['consent', 'account'], checks: [
      { label: '과제명', passed: false, refs: [] }, { label: '통장 계좌 신뢰도', passed: false, refs: [] },
    ] } };
  const manual = { ...detail, id: 'manual', current: 'manual', team_name: '대조팀', verdict: '담당자확인',
    result: { ...success.result, verdict: '담당자확인', staff_report: '', issues: ['affiliation'],
      checks: [{ label: '신청서·동의서 소속 표기 일치', passed: false, refs: documents['01'] }] } };
  const historic = { ...manual, id: 'historic', current: 'historic', team_name: '과거팀',
    result: { ...manual.result, documents: { '01': [], '02': [], '03': [], '?': [] }, checks: [], issues: [] } };
  const unknown = { ...manual, id: 'unknown', current: 'unknown', team_name: '추가검사팀',
    result: { ...manual.result, checks: [...manual.result.checks, { label: '내부검사_123456789012', passed: null, refs: documents['03'] }] } };
  const submissions = [detail, success, missing, manual, historic, unknown];
  const teams = submissions.map(s => ({ id: s.id, current: s.id, name: s.team_name, submission: s }));
  await page.route('**/api/dashboard?*', route => route.fulfill({ json: { ...dashboard, teams, batches: [] } }));
  for (const s of submissions) {
    await page.route('**/api/operations/submissions/' + s.id, route => route.fulfill({ json: s }));
  }
  await page.goto('/#/');
  const table = page.getByRole('region', { name: '팀별 판정 표' });
  const reason = name => table.getByRole('row').filter({ hasText: name }).locator('.team-reason');
  await reason('중복팀').filter({ hasText: /신분증 발급일/ }).waitFor();
  assert.match(await reason('중복팀').innerText(), /동의서 중복.*신분증 발급일 미기재.*외 1건/);
  assert.match(await reason('정상팀').innerText(), /보완 사항 없음/);
  assert.equal(await reason('누락팀').innerText(), '개인정보 동의서 미제출 · 신분증·통장 사본 미제출');
  assert.match(await reason('대조팀').innerText(), /소속 표기 대조/);
  assert.equal(await reason('과거팀').innerText(), '제출 서류 원본 확인');
  assert.equal(await reason('추가검사팀').innerText(), '신청서·동의서 소속 표기 대조 · 제출 서류 원본 확인');
  const privateText = /123456789012|issued_date|Sub-doc|【†/;
  assert.doesNotMatch(await page.locator('main').innerText(), privateText);
  await table.getByRole('link', { name: '중복팀 검토 열기', exact: true }).click();
  const checks = page.getByRole('complementary', { name: '검토 체크리스트' });
  await checks.getByText('신분증 발급일 미기재', { exact: true }).waitFor();
  const explanation = page.getByRole('region', { name: 'Upstage 검토 설명' });
  await explanation.getByText(/신분증 발급일 누락/).waitFor();
  assert.match(await explanation.innerText(), /API 추출값 없음/);
  assert.doesNotMatch(await explanation.innerText(), privateText);
  assert.doesNotMatch(await checks.textContent(), privateText);
  assert.equal(await checks.getByText('대표 서명', { exact: true }).isVisible(), false);
  await checks.getByText('통과한 항목 3개', { exact: true }).click();
  assert.equal(await checks.getByText('대표 서명', { exact: true }).isVisible(), true);
  await checks.getByRole('listitem').filter({ hasText: '신분증 발급일 미기재' }).getByRole('button').click();
  assert.equal(await page.getByRole('region', { name: '원문 미리보기' }).getByRole('tab', { name: /03 신분증·통장 사본/, selected: true }).count(), 1);
  const payout = page.locator('details').filter({ has: page.getByText('명단·지급 정보 대조', { exact: true }) });
  assert.equal(await payout.getByText('은행·계좌', { exact: true }).isVisible(), false);
  await payout.locator('summary').first().click();
  assert.equal(await payout.getByText('은행·계좌', { exact: true }).isVisible(), true);
});

test('미리보기 설명은 Upstage 응답만 사용하고 근거 없는 누락을 만들지 않는다', async t => {
  const page = await newPage(t);
  const reason = '개인정보동의서가 현재 입력에서 확인되지 않아 동의 표시와 서명을 확인할 수 없습니다.【†1】';
  const documents = { '01': [{ id: 'original', page: 1 }], '02': [], '03': [], '?': [] };
  const result = { team_name: 'API 근거팀', verdict: '재제출요청', reason, staff_report: '', documents, checks: [], issues: [], members: [], recipient: {},
    extracted: { 'Information Extract - 지급확인서': [{ representative_student_id: '', representative_signed: false, members: [] }] } };
  const base = { version: 3, state: 'done', team: 'team', team_name: 'API 근거팀', count: 1, files: [{ ...file, state: 'assigned' }],
    email: '', note: '', revision: 0, history: [], audit: [], mail: [], fields: { members: [], recipient: { account_number: '' } },
    verdict: '재제출요청', result };
  const report = '| 문서·대상자 또는 행 | 항목 | 관측값 | 상태 |\n|---|---|---|---|\n'
    + '| 신분증 | issued_date | ""【†2】 | 확정오류【†3】 |\n'
    + '| 신청서 팀원 | members.student_id | 실제공란 | 확정오류 |\n'
    + '| 신청서 | representative_student_id | "" | 통과 |';
  const cases = {
    source: base,
    report: { ...base, result: { ...result, staff_report: report } },
    legacy: { ...base, result: { ...result, reason: '', staff_report: '' } },
    success: { ...base, verdict: '성공', result: { ...result, verdict: '성공' } },
  };
  for (const [id, detail] of Object.entries(cases)) {
    await page.route('**/api/operations/submissions/' + id, route => route.fulfill({ json: { ...detail, id, current: id } }));
  }
  const explanation = page.getByRole('region', { name: 'Upstage 검토 설명' });
  await page.goto('/#/teams/source');
  await explanation.getByText(reason.replace('【†1】', ''), { exact: true }).waitFor();
  await explanation.getByText('Upstage 판정 근거 · 제출 v3', { exact: true }).waitFor();
  assert.doesNotMatch(await explanation.innerText(), /학번|계좌|미기재|API 추출값 없음/);
  const preview = page.getByRole('region', { name: '원문 미리보기' });
  assert.equal(await preview.getByRole('region', { name: 'Upstage 검토 설명' }).count(), 1);
  await page.getByRole('tab', { name: '확정 파일 목록', exact: true }).click();
  assert.equal(await explanation.count(), 1);
  await page.goto('/#/teams/report');
  await explanation.getByText('신분증·통장 사본 · 신분증 발급일 — API 추출값 없음', { exact: true }).waitFor();
  await explanation.getByText('지급확인서 · 팀원 학번 — API 추출값 없음', { exact: true }).waitFor();
  assert.equal(await explanation.getByText(/대표 학번/).count(), 0);
  await page.setViewportSize({ width: 320, height: 740 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  if (process.env.INTAKE_EXPLANATION_SCREENSHOT) await page.screenshot({ path: process.env.INTAKE_EXPLANATION_SCREENSHOT, fullPage: true });
  await page.goto('/#/teams/legacy');
  await explanation.getByText('이 제출본의 Upstage 응답에 상세 판정 설명이 없습니다.', { exact: true }).waitFor();
  assert.doesNotMatch(await explanation.innerText(), /미제출|미기재|추출값 없음/);
  await page.goto('/#/teams/success');
  await page.getByRole('heading', { name: 'API 근거팀', exact: true }).waitFor();
  assert.equal(await explanation.count(), 0);
});

test('추출값 충돌과 이름 없는 학생을 보존하고 담당자 수정 시 다른 값을 유지한다', async t => {
  const page = await newPage(t);
  const members = [{ role: '대표', name: '', student_id: '00202601', major: '가상학과', school: '가상대학교' }];
  const recipient = { bank_name: '담당자 확인은행', account_number: '001-0002', account_holder: '가상대표', rrn_display: '020101 - XXXXXXX' };
  const extracted = { 'Information Extract - 신분증정보': [
    { bank_name: '가상은행A', account_number: '001-0002' }, { bank_name: '가상은행B', account_number: '003-0004' },
  ] };
  const warning = '신분증정보의 추출값이 응답마다 다릅니다. 초안과 추출 원본값을 대조해 주세요.';
  const s = { id: 'transfer', current: 'transfer', team: 'team', team_name: team.name, state: 'done', version: 1,
    verdict: '성공', decision: null, revision: 2, email: '', note: '', held: false, files: [], history: [], audit: [], mail: [],
    fields: { members, recipient, award_type: '대상', support_amount: '1000' },
    result: { verdict: '성공', reason: '가상 증빙 확인', documents: { '01': [], '02': [], '03': [], '?': [] }, checks: [], issues: [],
      extracted, extraction_warnings: [warning], staff_report: '' } };
  await page.route('**/api/operations/submissions/transfer', route => route.fulfill({ json: s }));
  await page.route('**/api/submissions/transfer/review', route => route.fulfill({ json: { saved: true } }));
  await page.goto('/#/teams/transfer');
  await page.getByRole('heading', { name: '미확인', exact: true }).waitFor();
  await page.getByText(warning, { exact: true }).waitFor();
  const card = page.locator('details').filter({ has: page.getByText('명단·지급 정보 대조', { exact: true }) });
  const row = card.getByRole('row').filter({ hasText: '00202601' });
  assert.match(await row.innerText(), /미확인.*00202601.*가상학과/);
  assert.equal(await card.getByText('담당자 확인은행 001-0002', { exact: true }).isVisible(), true);
  await card.getByText('Upstage 추출 원본값', { exact: true }).click();
  assert.match(await card.locator('pre').innerText(), /가상은행B/);
  assert.match(await card.locator('pre').innerText(), /003-0004/);
  await card.getByText('원본 대조값 수정', { exact: true }).click();
  await card.getByLabel('은행', { exact: true }).fill('수정은행');
  const sent = page.waitForRequest('**/api/submissions/transfer/review');
  await card.getByRole('button', { name: '대조값 저장', exact: true }).click();
  const body = (await sent).postDataJSON();
  assert.deepEqual(body.members, members);
  assert.deepEqual(body.recipient, { ...recipient, bank_name: '수정은행' });
  assert.equal('award_type' in body, false);
  assert.equal('support_amount' in body, false);
});

test('보고서의 빈 추출값은 미확인으로 표시하고 등록 대표명으로 채우지 않는다', async t => {
  const page = await newPage(t);
  const draft = { team: 'API 팀명', rep: '등록 대표명', submission: 'api-team', version: 1, revision: 0,
    pending: [], missing_payouts: [], award_type: '대상', support_amount: '100',
    members: [{ role: '팀원', name: '추출 팀원', student_id: '', school: ' ', major: '' }],
    recipient: { bank_name: '', account_number: '', account_holder: '', gross_amount: '100', tax_amount: '0', net_amount: '100' } };
  await page.route('**/api/events/test/draft', route => route.fulfill({ json: { teams: [draft, { ...draft, team: '', submission: 'missing-team', members: [] }] } }));
  await page.goto('/#/report');
  const tables = page.getByRole('table');
  await tables.nth(1).getByRole('row').nth(1).waitFor();
  assert.match(await tables.nth(0).innerText(), /추출 팀원.*미확인.*미확인.*미확인.*API 팀명/s);
  const repCells = await tables.nth(1).getByRole('row').nth(1).getByRole('cell').allTextContents();
  assert.equal(repCells[1], '미확인');
  assert.deepEqual(repCells.slice(2, 8), Array(6).fill('미확인'));
  assert.equal(await page.getByText('등록 대표명', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('checkbox', { name: 'API 팀명 편철에 포함', exact: true }).count(), 1);
  assert.equal(await page.getByRole('checkbox', { name: '미확인 편철에 포함', exact: true }).count(), 1);
});

test('새 Agent의 긴 근거는 검토 상세에 보존하고 현황판에는 짧은 사유만 표시한다', async t => {
  const page = await newPage(t);
  const findings = [
    { 문서유형: '개인정보동의서', 대상자: '문서 전체', 검사항목: '필수 제출 유형 및 후속 필수검사', 문제유형: '처리 정책 확인',
      근거: '개인정보동의서의 존재와 처리 상태가 확인되지 않습니다.【†1】 동의서 기준의 필수값·동의·서명·명단 대조를 완료할 수 없습니다.[+1] 접수 원본과 분류·추출 상태를 확인해야 합니다.[†2]' },
    { 문서유형: '지급확인서', 대상자: '대표', 검사항목: '하단 신청인 서명', 문제유형: '판독 확인', 근거: '서명 영역 일부가 잘려 있어 확인이 필요합니다.[+3]' },
    { 문서유형: '신분증·통장 사본', 대상자: '대표', 검사항목: '은행명', 문제유형: '판독 확인', 근거: '통장 하단 은행명을 확인해야 합니다.【†4】' },
  ];
  const reason = '개인정보동의서의 존재·처리 상태와 서명·은행명의 판독 확인이 필요합니다.[+5]';
  const label = finding => ['문서유형', '대상자', '검사항목', '문제유형'].map(key => finding[key]).join(' · ') + ': ' + finding.근거;
  const detail = { id: 'agent-summary', current: 'agent-summary', team: 'summary-team', team_name: '새 응답팀', state: 'done', version: 1,
    count: 0, verdict: '담당자확인', decision: null, revision: 0, email: '', note: '', held: false,
    files: [], history: [], audit: [], mail: [], fields: { members: [], recipient: {} },
    result: { team_name: '새 응답팀', verdict: '담당자확인', reason, documents: { '01': [], '02': [], '03': [], '?': [] },
      members: [], recipient: {}, checks: findings.map(finding => ({ label: label(finding), passed: null, refs: [] })), issues: [], staff_report: '',
      agent_decision: { 최종판정: '담당자확인', 판정근거: reason, 확정오류: [], 확인필요: findings } } };
  const longTitle = '담당자가 원문과 추출 결과를 확인해야 하는 매우 긴 검사 항목 '.repeat(5);
  const longDetail = { ...detail, id: 'long-title', current: 'long-title', team_name: '긴 항목팀',
    result: { ...detail.result, team_name: '긴 항목팀', agent_decision: { ...detail.result.agent_decision,
      확인필요: [{ ...findings[0], 검사항목: longTitle }] } } };
  const teams = [detail, longDetail].map(s => ({ id: s.id, current: s.id, name: s.team_name, submission: s }));
  await page.route('**/api/dashboard?*', route => route.fulfill({ json: { ...dashboard, teams, batches: [] } }));
  for (const s of [detail, longDetail]) await page.route('**/api/operations/submissions/' + s.id, route => route.fulfill({ json: s }));
  await page.goto('/#/');
  const table = page.getByRole('region', { name: '팀별 판정 표' });
  const summary = table.getByRole('row').filter({ hasText: '새 응답팀' }).locator('.team-reason');
  await summary.filter({ hasText: /필수 제출 유형/ }).waitFor();
  assert.match(await summary.innerText(), /개인정보동의서.*필수 제출 유형.*하단 신청인 서명.*외 1건/);
  assert.ok((await summary.innerText()).length <= 140);
  assert.doesNotMatch(await summary.innerText(), /동의서 기준|완료할 수 없습니다|문서 전체/);
  const bounded = table.getByRole('row').filter({ hasText: '긴 항목팀' }).locator('.team-reason');
  await bounded.filter({ hasText: /…/ }).waitFor();
  assert.ok((await bounded.innerText()).length <= 64);
  const markers = /【[^】]*】|\[(?:\+|[†‡])\d+\]/;
  assert.doesNotMatch(await page.locator('main').innerText(), markers);
  await table.getByRole('link', { name: '새 응답팀 검토 열기', exact: true }).click();
  const checks = page.getByRole('complementary', { name: '검토 체크리스트' });
  await checks.getByText(/동의서 기준의 필수값·동의·서명·명단 대조를 완료할 수 없습니다/).waitFor();
  assert.match(await checks.innerText(), /접수 원본과 분류·추출 상태를 확인해야 합니다/);
  assert.match(await checks.innerText(), /통장 하단 은행명을 확인해야 합니다/);
  const explanation = page.getByRole('region', { name: 'Upstage 검토 설명' });
  assert.match(await explanation.innerText(), /개인정보동의서의 존재·처리 상태와 서명·은행명의 판독 확인이 필요합니다/);
  assert.doesNotMatch(await page.locator('main').innerText(), markers);
  await page.setViewportSize({ width: 320, height: 740 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
});

test('새 Agent의 보완필요 판정과 확정오류를 그대로 표시하고 승인을 제한한다', async t => {
  const page = await newPage(t);
  const label = '개인정보동의서 · 가상학생 · 제3자 제공 동의 · 누락: 동의 칸 공란';
  const reason = '확정오류 1건으로 보완이 필요하다.';
  const detail = { id: 'agent4', current: 'agent4', team: 'team', team_name: team.name, state: 'done', version: 1,
    count: 0, verdict: '보완필요', decision: null, revision: 0, email: '', note: '', held: false,
    files: [], history: [], audit: [], mail: [], fields: { members: [], recipient: {} },
    result: { team_name: 'Agent4 팀', verdict: '보완필요', reason, documents: { '01': [], '02': [], '03': [], '?': [] },
      members: [], recipient: {}, checks: [{ label, passed: false, refs: [] }], issues: ['consent'], staff_report: '',
      agent_decision: { 최종판정: '보완필요', 판정근거: reason,
        확정오류: [{ 문서유형: '개인정보동의서', 대상자: '가상학생', 검사항목: '제3자 제공 동의', 문제유형: '누락', 근거: '동의 칸 공란' }], 확인필요: [] } } };
  await page.route('**/api/operations/submissions/agent4', route => route.fulfill({ json: detail }));
  await page.goto('/#/teams/agent4');
  await page.getByRole('heading', { name: 'Agent4 팀', exact: true }).waitFor();
  assert.equal(await page.getByText('보완필요', { exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('radio', { name: '승인', exact: true }).isDisabled(), true);
  const checklist = page.getByRole('complementary', { name: '검토 체크리스트' });
  await checklist.getByText(label, { exact: true }).waitFor();
  assert.doesNotMatch(await checklist.innerText(), /미제출/);
});

test('팀별 판정 행의 검토 열기는 현재 제출본을 열고 제출본 없는 팀에는 링크를 표시하지 않는다', async t => {
  const page = await newPage(t);
  const submission = { id: 'submission-v2', version: 2, state: 'done', verdict: '재제출요청', decision: null, count: 1 };
  const teams = [
    { id: 'first-team', name: '3팀', rep: '첫 대표', current: submission.id, submission },
    { id: 'second-team', name: '3팀', rep: '다른 대표', current: null, submission: null, held: true },
  ];
  const detail = { ...submission, team: teams[0].id, team_name: teams[0].name, rep: teams[0].rep, current: submission.id,
    email: '', note: '', result: null, files: [file], history: [], mail: [], audit: [], fields: { members: [], recipient: {} } };
  await page.route('**/api/dashboard?*', route => route.fulfill({ json: { ...dashboard, teams, batches: [] } }));
  await page.route('**/api/operations/submissions/' + submission.id, route => route.fulfill({ json: detail }));
  await page.goto('/#/');
  const table = page.getByRole('region', { name: '팀별 판정 표' });
  const row = table.getByRole('row').filter({ hasText: '첫 대표' });
  const open = row.getByRole('link', { name: '3팀 (첫 대표) 검토 열기', exact: true });
  const missing = table.getByRole('row').filter({ hasText: '다른 대표' });
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 850 });
    await open.waitFor();
    const href = await open.getAttribute('href');
    assert.equal(href, '#/teams/submission-v2');
    assert.equal(await row.getByRole('link', { name: '3팀', exact: true }).getAttribute('href'), href);
    assert.equal(await missing.getByRole('link').count(), 0);
    assert.equal(await missing.getByRole('cell').last().innerText(), '제출본 없음');
    const bounds = await table.boundingBox(), link = await open.boundingBox();
    assert.ok(link.x >= bounds.x && link.x + link.width <= bounds.x + bounds.width + 1);
    if (width === 1440) { await open.focus(); await open.press('Enter'); }
    else await open.click();
    await page.waitForURL('**/#/teams/submission-v2');
    await page.getByRole('heading', { name: '미확인', exact: true }).waitFor();
    await page.getByRole('region', { name: '원문 미리보기' }).waitFor();
    await page.goBack();
  }
  await page.getByRole('button', { name: '정리됨 0' }).click();
  const empty = table.getByRole('cell', { name: '이 필터에 해당하는 팀이 없습니다.' });
  assert.equal(await empty.getAttribute('colspan'), '7');
});

test('사이드바 실행 버튼은 한 번만 요청하고 모바일 메뉴와 같은 실행 상태를 표시한다', async t => {
  const page = await newPage(t);
  await page.clock.install();
  let result = { state: 'stopped' };
  let reads = 0, starts = 0, finish;
  await page.route('**' + statusPath, route => {
    reads++;
    return result ? route.fulfill({ json: result }) : route.fulfill({ status: 503, json: {} });
  });
  await page.route('**/api/operations/worker-start', async route => {
    assert.equal(route.request().method(), 'POST');
    starts++;
    await new Promise(resolve => { finish = resolve; });
    result = { state: 'running' };
    return route.fulfill({ json: result });
  });
  await page.goto('/#/assign');
  const rail = page.getByRole('complementary', { name: '작업 공간' });
  const state = rail.getByRole('status');
  await state.filter({ hasText: '워커 실행 필요' }).waitFor();
  assert.equal(reads, 1);
  assert.equal(await page.getByRole('main').locator('.rail-worker, .worker-status').count(), 0);
  const sent = page.waitForRequest('**/api/operations/worker-start');
  await rail.getByRole('button', { name: '실행하기' }).click();
  await sent;
  await state.filter({ hasText: '워커 시작 중…' }).waitFor();
  assert.equal(await rail.getByRole('button', { name: '실행하기' }).count(), 0);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: '메뉴 열기' }).click();
  const menu = page.getByRole('dialog', { name: '작업 메뉴' });
  await menu.getByRole('status').filter({ hasText: '시작 중' }).waitFor();
  finish();
  await menu.getByRole('status').filter({ hasText: '실행 중' }).waitFor();
  assert.equal(starts, 1);
  await menu.getByRole('link', { name: '이메일 발송' }).click();
  await page.getByRole('button', { name: '메뉴 열기' }).click();
  await menu.getByRole('status').filter({ hasText: '실행 중' }).waitFor();
  result = null;
  await page.clock.fastForward(15001);
  await menu.getByRole('status').filter({ hasText: '확인 불가' }).waitFor();
  assert.equal(await menu.getByRole('button', { name: '실행하기' }).count(), 0);
  result = { state: 'stopped' };
  await menu.getByRole('button', { name: '다시 확인' }).click();
  await menu.getByRole('button', { name: '실행하기' }).waitFor();
});

test('워커 실행 실패 원인을 표시하고 같은 화면에서 다시 시도할 수 있다', async t => {
  const page = await newPage(t);
  let result = { state: 'stopped' };
  await page.route('**' + statusPath, route => route.fulfill({ json: result }));
  await page.route('**/api/operations/worker-start', route => {
    result = { state: 'running' };
    return route.fulfill({ json: result });
  });
  await page.route('**/api/operations/worker-start', route => route.fulfill({ status: 503, json: { detail: '워커 설치 경로를 확인하세요.' } }), { times: 1 });
  await page.goto('/#/');
  const rail = page.getByRole('complementary', { name: '작업 공간' });
  const start = rail.getByRole('button', { name: '실행하기' });
  await start.click();
  await rail.getByRole('alert').filter({ hasText: '워커 설치 경로를 확인하세요.' }).waitFor();
  await start.click();
  await rail.getByRole('status').filter({ hasText: '실행 중' }).waitFor();
  assert.equal(await rail.getByRole('alert').count(), 0);
});

test('다른 탭에서 저장한 HWPX가 미리보기와 확대 화면에 반영되고 접수 원본으로 전환할 수 있다', async t => {
  const page = await newPage(t);
  const { default: init, HwpDocument } = await import('../dist/rhwp/rhwp.js');
  const assets = new URL('../dist/rhwp/assets/', import.meta.url);
  const wasm = (await readdir(assets)).find(n => /^rhwp_bg-.*\.wasm$/.test(n));
  await init({ module_or_path: await readFile(new URL(wasm, assets)) });
  const doc = HwpDocument.createEmpty();
  doc.createBlankDocument();
  doc.insertText(0, 0, 0, '접수 원본');
  const source = Buffer.from(doc.exportHwpx());
  doc.free();
  let saved;
  const history = { name, versions: [] };
  await page.route('**' + versionsPath, route => route.fulfill({ json: history }));
  await page.route('**' + versionsPath + '/1/content', route => route.fulfill({ contentType: 'application/octet-stream', body: saved }));
  await page.goto('/#/assign?file=original');
  const reason = page.getByRole('textbox', { name: /근거/ });
  await reason.fill('배정 확인 중');
  await page.getByText('접수 원본', { exact: true }).waitFor();
  const editor = await page.context().newPage();
  await editor.route('**' + versionsPath + '/0/content', route => route.fulfill({ contentType: 'application/octet-stream', body: source }));
  await editor.route('**' + versionsPath, async route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: history });
    const form = await new Response(request.postDataBuffer(), { headers: { 'Content-Type': request.headers()['content-type'] } }).formData();
    saved = Buffer.from(await form.get('document').arrayBuffer());
    const version = { version: 1, editor: 'test', saved_at: new Date().toISOString() };
    history.versions.push(version);
    return route.fulfill({ json: version });
  });
  await editor.goto('/#/files/original/edit');
  const canvas = editor.frameLocator('iframe').locator('#scroll-content canvas').first();
  await editor.waitForFunction(() => document.querySelector('select[aria-label="문서 버전"]')?.disabled === false);
  const box = await canvas.boundingBox();
  await editor.mouse.click(box.x + box.width / 2, box.y + 100);
  await editor.keyboard.press('Control+Home');
  await editor.keyboard.type('SAVEDCOPY');
  await editor.getByRole('button', { name: '새 버전으로 저장' }).click();
  await editor.getByText('수정본 v1을 저장했습니다.').waitFor();
  assert.ok(strFromU8(unzipSync(saved)['Contents/section0.xml']).includes('SAVEDCOPY'));
  const choice = page.getByRole('combobox', { name: '미리보기 버전' });
  await choice.waitFor();
  assert.equal(await choice.locator('option:checked').innerText(), '최신 수정본 v1');
  const sheet = page.frameLocator('iframe').getByRole('img', { name: '수정본 v1 · 1쪽' });
  await sheet.waitFor();
  const shown = await sheet.evaluate(async img => {
    const svg = new DOMParser().parseFromString(await (await fetch(img.src)).text(), 'image/svg+xml');
    return [...svg.querySelectorAll('text')].map(t => t.textContent.trim()).join('');
  });
  assert.ok(shown.includes('SAVEDCOPY'), '렌더링한 첫 쪽의 텍스트: ' + shown.slice(0,120));
  assert.equal(await page.getByRole('link', { name: '수정본 내려받기' }).getAttribute('href'), versionsPath + '/1/content');
  const src = await page.locator('iframe').getAttribute('src');
  await page.getByRole('button', { name: '크게 보기' }).click();
  const dialog = page.getByRole('dialog');
  assert.equal(await dialog.locator('iframe').getAttribute('src'), src);
  assert.equal(await dialog.getByRole('link').getAttribute('href'), src);
  await dialog.getByRole('button', { name: '닫기' }).click();
  await choice.selectOption('0');
  await page.getByRole('link', { name: '원본 받기' }).waitFor();
  assert.equal(await reason.inputValue(), '배정 확인 중');
  await page.reload();
  await sheet.waitFor();
  const ref = { id: file.id, page: 2 };
  const previewPath = '/api/files/original/preview';
  const submission = { id: 'review', current: 'review', team_name: team.name, team: team.id, version: 1, state: 'done',
    count: 1, verdict: '담당자확인', email: '', note: '', files: [{ ...file, url: previewPath }], history: [], mail: [], audit: [],
    fields: { members: [], recipient: {} }, result: { issues: [], documents: { '01': [ref] },
      checks: [{ label: '제출 시점 확인', passed: null, refs: [ref] }] } };
  await page.route('**/api/operations/submissions/review', route => route.fulfill({ json: submission }));
  await page.route('**' + previewPath, route => route.fulfill({ contentType: 'text/html', body: '판정에 사용한 원본' }));
  await page.goto('/#/teams/review?file=original');
  await sheet.waitFor();
  await page.getByRole('complementary', { name: '검토 체크리스트' }).getByRole('button', { name: /지급확인서.*2쪽/ }).click();
  assert.equal(await choice.inputValue(), '0');
  assert.equal(await page.getByTitle(name, { exact: true }).getAttribute('src'), previewPath + '#page=2');
});

test('큰 문서 미리보기를 닫으면 원래 파일과 작성 중인 배정 근거가 유지된다', async t => {
  const page = await newPage(t);
  const previewPath = '/api/files/original/preview';
  await page.route('**' + batchPath, route => route.fulfill({ json: { ...batch, files: [{ ...file, url: previewPath, page: 2, pages: 3 }] } }));
  await page.route('**' + previewPath, route => route.fulfill({ contentType: 'text/html', body: '<p>시험 문서</p>' }));
  await page.setViewportSize({ width: 1920, height: 960 });
  await page.goto('/#/assign?file=original');
  const inline = page.getByTitle(name, { exact: true });
  await inline.waitFor();
  const box = await inline.boundingBox();
  assert.ok(box.width > 1050 && box.height >= 700);
  const reason = page.getByRole('textbox', { name: /근거/ });
  await reason.fill('원본을 대조하는 중');
  const enlarge = page.getByRole('button', { name: '크게 보기' });
  for (const width of [1920, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 960 });
    await enlarge.click();
    const dialog = page.getByRole('dialog', { name: name + ' 크게 보기' });
    const enlarged = dialog.locator('iframe');
    assert.equal(await enlarged.getAttribute('src'), previewPath + '#page=2');
    assert.equal(await dialog.getByRole('link', { name: '새 탭에서 열기' }).getAttribute('href'), previewPath + '#page=2');
    assert.ok((await enlarged.boundingBox()).width >= width * .94);
    if (width === 375) await dialog.getByRole('button', { name: '닫기' }).click();
    else await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.ok(await enlarge.evaluate(el => el === document.activeElement));
    assert.equal(await reason.inputValue(), '원본을 대조하는 중');
    assert.equal(await inline.getAttribute('src'), previewPath + '#page=2');
  }
});

test('작업 공간 너비에 맞춰 배정 목록과 원본을 배치하고 확대해도 가로로 넘치지 않는다', async t => {
  const page = await newPage(t);
  await page.goto('/#/assign');
  await page.getByRole('heading', { name }).waitFor();
  for (const [width, height, split] of [[320, 740, false], [375, 812, false], [768, 1024, false], [844, 390, false], [1024, 768, false], [1440, 900, true]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.locator('#detail-h').isVisible(), split, width + 'px');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.emulateMedia({ forcedColors: 'active' });
  await page.getByRole('button', { name: /SW수혜학생신청/ }).click();
  const choices = page.getByRole('radiogroup').getByRole('radio');
  await choices.first().focus();
  await page.keyboard.press('ArrowRight');
  assert.ok(await choices.nth(1).isChecked());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
});

test('조회 실패를 빈 접수로 표시하지 않고 다시 조회하며 배정 입력 오류를 해당 필드에 알린다', async t => {
  const page = await newPage(t);
  await page.route('**' + batchPath, route => route.fulfill({ status: 503, json: { detail: '파일 조회 실패' } }), { times: 1 });
  await page.goto('/#/assign');
  await page.getByRole('alert').filter({ hasText: '파일 조회 실패' }).waitFor();
  assert.equal(await page.getByText('접수된 원본이 없습니다.', { exact: false }).count(), 0);
  await page.getByRole('button', { name: '다시 조회' }).click();
  await page.getByRole('heading', { name }).waitFor();
  assert.equal(await page.getByRole('region', { name: '확인할 파일 1' }).isVisible(), true);
  const assign = page.getByRole('button', { name: '팀에 배정', exact: true });
  await assign.click();
  const select = page.getByRole('combobox', { name: '배정할 팀' });
  assert.equal(await select.getAttribute('aria-invalid'), 'true');
  assert.ok(await select.evaluate(el => el === document.activeElement));
  await select.selectOption('team');
  const reason = page.getByRole('textbox', { name: /근거/ });
  await reason.fill('  ');
  await page.getByRole('button', { name: '시험 팀에 배정' }).click();
  assert.ok(await reason.evaluate(el => el === document.activeElement));
  await reason.fill('원본 확인');
  assert.equal(await reason.getAttribute('aria-invalid'), 'false');
  const savePath = '**/files/original/assignment';
  await page.route(savePath, route => route.fulfill({ json: { saved: true } }));
  const sent = page.waitForRequest(savePath);
  await page.getByRole('button', { name: '시험 팀에 배정' }).click();
  assert.deepEqual((await sent).postDataJSON(), { action: 'assign', team: 'team', reason: '원본 확인', revision: 4, exclude: [] });
  await page.getByRole('status').filter({ hasText: '배정을 기록했습니다' }).waitFor();
});

test('업로드 오류를 파일 선택기에 연결하고 전송이 끝나면 서버 저장 대기를 표시한다', { timeout: 25000 }, async t => {
  const page = await newPage(t, 375);
  await page.goto('/#/intake');
  const picker = page.locator('input[type=file]');
  const sample = { name, mimeType: 'application/octet-stream', buffer: Buffer.from('test-file') };
  await picker.setInputFiles(sample);
  await picker.setInputFiles({ ...sample, name: '잘못된형식.pdf' });
  const error = page.getByRole('alert');
  await error.waitFor();
  const choose = page.getByRole('button', { name: '제출 원본 파일 선택' });
  assert.ok((await choose.getAttribute('aria-describedby')).split(' ').includes(await error.getAttribute('id')));
  assert.equal(await page.getByText(name, { exact: true }).count(), 1);
  const received = new Promise(resolve => { receiveUpload = resolve; });
  await page.getByRole('button', { name: '문서 업로드하기' }).click();
  const response = await received;
  try {
    await page.getByRole('progressbar', { name: '원본 저장 확인' }).waitFor();
    assert.ok(await page.getByRole('button', { name: '업로드 중…' }).isDisabled());
  } finally {
    receiveUpload = undefined;
    response.writeHead(202, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ batch_id: 'batch' }));
  }
  await page.waitForURL('**/#/intake/batches/batch');
});

test('새 팀 묶음이 기본이며 같은 접수 상세에 임시명과 판독된 팀명을 표시한다', async t => {
  const page = await newPage(t);
  let realName = false;
  await page.route('**/api/intake-batches/numbered', route => route.fulfill({ json: {
    batch: { batch_id:'numbered', event_id:event.id, target_team_id:'team', status:'received', created_at:'2026-11-09T09:00:00Z', intake_number:1,
      team_name: realName ? '가상검토팀01' : '접수 1팀', team_rep:'', file_count:1, total_bytes:4 },
    files:[], teams:[{team:'team',state:'confirmed',version:1,submission_id:'submission',
      review_job:{review_job_id:'job',state:realName ? 'done' : 'running'}}],
  } }));
  await page.goto('/#/intake');
  assert.equal(await page.getByLabel('접수 출처').inputValue(), 'bundle');
  await page.locator('input[type=file]').setInputFiles({ name:'증빙.hwp', mimeType:'application/octet-stream', buffer:Buffer.from('test') });
  const posted = new Promise(resolve => {
    receiveUpload = (res, bytes) => {
      receiveUpload = undefined;
      res.writeHead(202, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({batch_id:'numbered'}));
      resolve(bytes.toString());
    };
  });
  t.after(() => { receiveUpload = undefined; });
  await page.getByRole('button', {name:'문서 업로드하기'}).click();
  const body = await posted;
  assert.match(body, /name="mode"\r\n\r\nbundle/);
  assert.doesNotMatch(body, /name="target"/);
  await page.waitForURL('**/#/intake/batches/numbered');
  await page.locator('dd').filter({hasText:/^접수 1팀$/}).waitFor();
  realName = true;
  await page.getByText('접수 1팀 · 가상검토팀01', {exact:true}).first().waitFor();
  assert.equal(await page.getByText('접수 1팀 · 가상검토팀01', {exact:true}).count(), 2);
  assert.equal(new URL(page.url()).hash, '#/intake/batches/numbered');
});
