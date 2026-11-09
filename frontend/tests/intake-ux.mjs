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
            req.on('end', () => receiveUpload(res));
            req.resume();
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
