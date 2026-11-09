import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const event = { id: 'test', name: '시험 대회' };
const team = { id: 'team', name: '시험 팀' };
const name = '01._(팀별)_SW수혜학생신청_및_시상금지급확인서_최종.hwpx';
const file = { id: 'original', name, kind: '01', state: 'unassigned', candidates: [], excluded: [], url: '', size: 100, pages: 0 };
const batch = { id: 'batch', state: 'review', created: 1, revision: 4, pending: 1, files: [file] };
const dashboard = { event: event.id, events: [event], teams: [team], batches: [batch], mail: [], reports: [] };
const batchPath = '/api/operations/batches/batch';
const responses = { '/api/events': [event], '/api/events/test/teams': [team], '/api/dashboard': dashboard, [batchPath]: batch };
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
  const page = await browser.newPage({ baseURL, viewport: { width, height: 850 }, locale: 'ko-KR', reducedMotion: 'reduce' });
  page.setDefaultTimeout(8000);
  t.after(() => page.close());
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
    await page.getByRole('heading', { name: '3팀', exact: true }).waitFor();
    await page.getByRole('region', { name: '원문 미리보기' }).waitFor();
    await page.goBack();
  }
  await page.getByRole('button', { name: '정리됨 0' }).click();
  const empty = table.getByRole('cell', { name: '이 필터에 해당하는 팀이 없습니다.' });
  assert.equal(await empty.getAttribute('colspan'), '7');
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
  await page.getByRole('button', { name: '원본 접수하기' }).click();
  const response = await received;
  try {
    await page.getByRole('progressbar', { name: '원본 저장 확인' }).waitFor();
    assert.ok(await page.getByRole('button', { name: '접수 중…' }).isDisabled());
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
  await page.getByRole('button', {name:'원본 접수하기'}).click();
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
