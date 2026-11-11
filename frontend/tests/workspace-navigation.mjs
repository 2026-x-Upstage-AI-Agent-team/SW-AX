import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const root = '/#/categories/awards/workspaces/nav-test';
const event = { id: 'nav-test', name: '2026 SW 경진대회', category_id: 'awards' };
const submission = { id: 'submission-1', team: 'team-1', team_name: '가온팀', current: 'submission-1', version: 1, state: 'done', verdict: '담당자확인', decision: null, count: 1, created: 1, revision: 1, fields: { members: [], recipient: {}, award_type: '', support_amount: '' }, result: null, history: [], mail: [], audit: [], files: [] };
const team = { id: 'team-1', name: '가온팀', rep: '', email: 'leader@example.test', current: submission.id, held: false, submission };
const file = { id: 'file-1', name: '01_가온팀_신청서.hwpx', state: 'read', kind: '01', size: 100, pages: 1, candidates: [], excluded: [] };
const batch = { id: 'batch-1', event: event.id, state: 'review', revision: 1, created: 1, pending: 0, files: [file], teams: [], count: 1 };
const dashboard = { event: event.id, events: [event], teams: [team], batches: [batch], mail: [], reports: [], smtp: false, connected: true, config: '51', overview: { date: '', place: '' } };
let server, browser, baseURL;

before(async () => {
  server = await preview({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), logLevel: 'silent', preview: { host: '127.0.0.1', port: 0 } });
  baseURL = 'http://127.0.0.1:' + server.httpServer.address().port;
  browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.CHROME_EXECUTABLE });
});
after(async () => { await browser?.close(); await server?.close(); });

async function pageFor(t, width = 1440, tour = false) {
  const context = await browser.newContext({ baseURL, viewport: { width, height: 1000 }, locale: 'ko-KR', reducedMotion: 'reduce', hasTouch: width < 600 });
  if (!tour) await context.addInitScript(() => localStorage.setItem('swax.workspace-tour.v1.intake.nav-test', 'done'));
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { assert.deepEqual(errors, []); await context.close(); });
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const data = {
      '/api/events': [event], '/api/events/nav-test/teams': [team], '/api/dashboard': dashboard,
      '/api/operations/submissions/submission-1': submission, '/api/operations/batches/batch-1': batch,
      '/api/operations/worker-status': { state: 'running' }, '/api/auth/session': { login: 'staff-nav' },
    }[path];
    return data ? route.fulfill({ json: data }) : route.fulfill({ status: 404, json: {} });
  });
  return page;
}

test('서류 관리 하위 메뉴와 독립된 팀별 검토는 현재 워크스페이스에서 이동한다', async t => {
  const page = await pageFor(t);
  await page.goto(root + '/review');
  const rail = page.getByRole('complementary', { name: '작업 공간' });
  await page.getByRole('heading', { name: '팀별 검토', exact: true }).waitFor();
  if (process.env.SWAX_NAV_SCREENSHOTS) await page.screenshot({ path: process.env.SWAX_NAV_SCREENSHOTS + '/workspace-navigation-desktop.png', fullPage: true });
  assert.match(await rail.locator('[aria-current=page]').innerText(), /팀별 검토/);
  await rail.getByRole('button', { name: '서류 관리', exact: true }).click();
  assert.equal(await rail.getByRole('link', { name: '파일 첨부', exact: true }).isVisible(), true);
  await rail.getByRole('link', { name: '파일 첨부', exact: true }).click();
  await page.getByRole('heading', { name: '파일 첨부', exact: true }).waitFor();
  await rail.getByRole('link', { name: '첨부 내역', exact: true }).click();
  await page.waitForURL('**/workspaces/nav-test/intake/batches');
  assert.equal(await rail.locator('[aria-current=page]').count(), 1);
  assert.equal(await rail.locator('[aria-current=page]').innerText(), '첨부 내역');
  await page.getByRole('heading', { name: '파일 첨부', exact: true }).waitFor();
});

test('워크스페이스 검색은 팀과 원본 파일을 찾아 해당 제출본과 첨부 내역으로 연결한다', async t => {
  const page = await pageFor(t);
  await page.goto(root + '/review');
  await page.getByRole('button', { name: '현재 워크스페이스 검색' }).click();
  const dialog = page.getByRole('dialog', { name: '현재 워크스페이스 검색' });
  const input = dialog.getByRole('searchbox');
  await input.fill('가온');
  const teamResult = dialog.getByRole('region', { name: '팀 검색 결과' }).getByRole('link');
  assert.equal(await teamResult.getAttribute('href'), '#/categories/awards/workspaces/nav-test/teams/submission-1');
  await input.fill('신청서');
  const fileResult = dialog.getByRole('region', { name: '파일 검색 결과' }).getByRole('link');
  await fileResult.waitFor();
  assert.equal(await fileResult.getAttribute('href'), '#/categories/awards/workspaces/nav-test/intake/batches/batch-1');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await dialog.isVisible(), false);
  assert.equal(await page.getByRole('button', { name: '현재 워크스페이스 검색' }).evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Control+k');
  await dialog.waitFor();
  await input.fill('존재하지않는자료');
  await dialog.getByText('일치하는 팀·파일·메뉴가 없습니다.').waitFor();
});

test('워크스페이스 선택 목록은 현재 공간을 표시하고 키보드와 모바일 메뉴에서 전환한다', async t => {
  const page = await pageFor(t);
  await page.addInitScript(() => localStorage.setItem('swax.workspace-tour.v1.intake.nav-other', 'done'));
  const other = { ...event, id: 'nav-other', name: '2026 웨이브' };
  await page.route('**/api/events', route => route.fulfill({ json: [event, other] }));
  await page.route('**/api/events/nav-other/teams', route => route.fulfill({ json: [] }));
  await page.route('**/api/dashboard?*', route => {
    const switched = new URL(route.request().url()).searchParams.get('event') === other.id;
    return route.fulfill({ json: switched ? { ...dashboard, event: other.id, events: [event, other], teams: [], batches: [] } : dashboard });
  });
  await page.goto(root + '/review');
  const picker = page.getByRole('button', { name: '워크스페이스 선택' });
  const list = page.getByRole('list', { name: '전환할 워크스페이스' });
  await picker.press('ArrowDown');
  await list.waitFor();
  const current = list.getByRole('button', { name: event.name });
  assert.equal(await current.getAttribute('aria-current'), 'true');
  assert.equal(await list.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(30, 41, 59)');
  if (process.env.SWAX_NAV_SCREENSHOTS) await page.screenshot({ path: process.env.SWAX_NAV_SCREENSHOTS + '/workspace-picker-desktop.png' });
  await page.getByRole('heading', { name: '팀별 검토', exact: true }).click();
  await list.waitFor({ state: 'hidden' });
  await picker.press('ArrowDown');
  await current.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForURL('**/workspaces/nav-other');
  await picker.getByText(other.name, { exact: true }).waitFor();

  await page.setViewportSize({ width: 320, height: 800 });
  await page.getByRole('button', { name: '메뉴 열기' }).click();
  const menu = page.getByRole('dialog', { name: '작업 메뉴' });
  await picker.click();
  await list.waitFor();
  if (process.env.SWAX_NAV_SCREENSHOTS) await page.screenshot({ path: process.env.SWAX_NAV_SCREENSHOTS + '/workspace-picker-mobile.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.keyboard.press('Escape');
  await list.waitFor({ state: 'hidden' });
  assert.equal(await menu.isVisible(), true);
  assert.equal(await picker.evaluate(element => element === document.activeElement), true);
  await picker.click();
  await list.getByRole('button', { name: event.name }).click();
  await page.waitForURL('**/workspaces/nav-test');
  await menu.waitFor({ state: 'hidden' });
});

test('파일 검색 실패를 빈 결과로 숨기지 않고 다시 조회한다', async t => {
  const page = await pageFor(t);
  let fail = true;
  await page.route('**/api/operations/batches/batch-1', route => fail ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: batch }));
  await page.goto(root + '/review');
  await page.getByRole('button', { name: '현재 워크스페이스 검색' }).click();
  const dialog = page.getByRole('dialog', { name: '현재 워크스페이스 검색' });
  await dialog.getByRole('alert').waitFor();
  fail = false;
  await dialog.getByRole('button', { name: '다시 시도' }).click();
  await dialog.getByRole('searchbox').fill('신청서');
  await dialog.getByRole('region', { name: '파일 검색 결과' }).getByRole('link').waitFor();
});

test('접힌 사이드바를 기억하고 하위 메뉴와 시작 가이드에서 다시 펼친다', async t => {
  const page = await pageFor(t);
  await page.goto(root + '/review');
  await page.getByRole('button', { name: '사이드바 접기', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: '사이드바 펼치기', exact: true }).waitFor();
  const rail = page.getByRole('complementary', { name: '작업 공간' });
  await rail.getByRole('button', { name: '서류 관리', exact: true }).click();
  await rail.getByRole('link', { name: '파일 첨부', exact: true }).waitFor();
  await page.getByRole('button', { name: '사이드바 접기', exact: true }).click();
  const helpButton = page.getByRole('button', { name: '도움말 열기', exact: true });
  const help = page.getByRole('group', { name: '도움말', exact: true });
  await helpButton.click();
  await help.waitFor();
  const contact = help.getByRole('link', { name: /개발자에게 문의하기/ });
  assert.equal(await contact.getAttribute('href'), 'https://github.com/2026-x-Upstage-AI-Agent-team/SW-AX/issues');
  assert.equal(await contact.getAttribute('target'), '_blank');
  if (process.env.SWAX_NAV_SCREENSHOTS) await page.screenshot({ path: process.env.SWAX_NAV_SCREENSHOTS + '/workspace-help.png' });
  await page.keyboard.press('Escape');
  await help.waitFor({ state: 'hidden' });
  await helpButton.click();
  await help.getByRole('button', { name: '시작 가이드', exact: true }).click();
  await page.getByRole('heading', { name: '먼저, 파일 첨부를 눌러 주세요.' }).waitFor();
  await help.waitFor({ state: 'hidden' });
  assert.equal(await rail.getByRole('link', { name: '파일 첨부', exact: true }).isVisible(), true);
  await page.keyboard.press('Escape');
});

test('320px 모바일 메뉴에서 설정·Gmail·팀장 안내로 이동하며 가로 넘침이 없다', async t => {
  const page = await pageFor(t, 320);
  await page.goto(root + '/review');
  await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
  const menu = page.getByRole('dialog', { name: '작업 메뉴' });
  if (process.env.SWAX_NAV_SCREENSHOTS) await page.screenshot({ path: process.env.SWAX_NAV_SCREENSHOTS + '/workspace-navigation-mobile.png', fullPage: true });
  await menu.getByRole('link', { name: 'Gmail 연결', exact: true }).click();
  await page.getByRole('heading', { name: 'Gmail 연결', exact: true }).waitFor();
  assert.equal(await menu.isVisible(), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
  await menu.getByRole('link', { name: '팀장 안내', exact: true }).click();
  await page.getByRole('heading', { name: '팀장 안내', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});

test('확인할 일 배지는 현황의 같은 목록으로 이동하고 계정에는 실제 로그인명을 표시한다', async t => {
  const page = await pageFor(t);
  await page.goto(root + '/review');
  await page.getByRole('link', { name: '확인할 일 1건', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.id === 'queue-heading');
  assert.equal(new URL(page.url()).hash, '#/categories/awards/workspaces/nav-test/?focus=tasks');
  await page.getByRole('button', { name: '계정 메뉴', exact: true }).click();
  await page.getByRole('dialog', { name: '계정 메뉴', exact: true }).getByText('staff-nav', { exact: true }).waitFor();
});

test('업무 현황은 판정 분포와 진행 요약을 보여주고 검토 작업으로 연결한다', async t => {
  const page = await pageFor(t);
  const teams = [team,
    { ...team, id: 'ai-success', name: '통과팀', current: 'success', submission: { ...submission, id: 'success', verdict: '성공', decision: null } },
    { ...team, id: 'approved', name: '승인팀', current: 'approved', submission: { ...submission, id: 'approved', verdict: '담당자확인', decision: '승인' } },
  ];
  await page.route('**/api/dashboard?*', route => route.fulfill({ json: { ...dashboard, teams } }));
  await page.goto(root);
  await page.getByRole('heading', { name: 'AI 판정 분포' }).waitFor();
  const ring = page.locator('.verdict-ring');
  const ringStyle = await ring.evaluate(node => {
    const style = getComputedStyle(node);
    return { radius: style.borderTopLeftRadius, thickness: parseFloat(style.paddingTop) };
  });
  assert.equal(ringStyle.radius, '50%');
  assert.ok(ringStyle.thickness > 0, 'The chart ring must stay visible after the shared style reset.');
  assert.ok(await page.locator('.workspace-rail').evaluate(node => parseFloat(getComputedStyle(node).paddingInlineStart) > 0));
  if (process.env.SWAX_NAV_SCREENSHOTS) await page.screenshot({ path: process.env.SWAX_NAV_SCREENSHOTS + '/workspace-dashboard.png', fullPage: true });
  assert.equal(await page.getByRole('group', { name: '검토 작업 필터' }).count(), 0);
  assert.equal(await page.getByRole('region', { name: '팀별 판정 표' }).count(), 0);
  await page.getByRole('region', { name: '업무 진행 요약' }).getByRole('link', { name: '승인 완료 1팀 보기' }).waitFor();
  await page.getByRole('region', { name: '업무 진행 요약' }).getByRole('link', { name: '검토 대기 2팀 보기' }).click();
  await page.waitForURL('**/review?filter=review');
  const queue = page.getByRole('region', { name: '검토 대상 팀' });
  assert.equal(await queue.getByRole('article').count(), 2);
  await queue.getByRole('link', { name: '통과팀 승인 검토', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'AI 판정 분포' }).count(), 0);
});

test('검토 검색과 필터는 원문을 열었다 돌아와도 유지된다', async t => {
  const page = await pageFor(t);
  await page.goto(root + '/review?filter=all');
  await page.getByRole('searchbox', { name: '팀명 또는 대표자 검색' }).fill('가온');
  await page.getByRole('link', { name: '가온팀 원문 대조', exact: true }).click();
  await page.getByRole('heading', { name: '미확인', exact: true }).waitFor();
  await page.getByRole('link', { name: '← 팀별 검토', exact: true }).click();
  await page.getByRole('searchbox', { name: '팀명 또는 대표자 검색' }).waitFor();
  assert.equal(await page.getByRole('searchbox', { name: '팀명 또는 대표자 검색' }).inputValue(), '가온');
  assert.equal(await page.getByRole('button', { name: '전체 1', pressed: true }).count(), 1);
  await page.waitForFunction(() => document.activeElement?.id === 'review-team-team-1');
});

test('보완 진행 팀은 메일 승인과 보완 첨부를, 승인 팀은 지급 정보 입력을 안내한다', async t => {
  const page = await pageFor(t, 320);
  const teams = [
    { ...team, id: 'draft', name: '안내팀', current: 'draft', submission: { ...submission, id: 'draft', verdict: '재제출요청' } },
    { ...team, id: 'sent', name: '보완팀', current: 'sent', submission: { ...submission, id: 'sent', verdict: '재제출요청' } },
    { ...team, id: 'approved', name: '승인팀', current: 'approved', submission: { ...submission, id: 'approved', verdict: '담당자확인', decision: '승인' } },
  ];
  const mail = [{ id: 'draft-mail', submission: 'draft', kind: '팀장 보완 요청', state: 'draft' }, { id: 'sent-mail', submission: 'sent', kind: '팀장 보완 요청', state: 'sent' }];
  await page.route('**/api/dashboard?*', route => route.fulfill({ json: { ...dashboard, teams, mail } }));
  await page.goto(root + '/review?filter=supplement');
  await page.getByRole('link', { name: '안내팀 보완 안내 검토', exact: true }).waitFor();
  assert.match(await page.getByRole('link', { name: '안내팀 보완 안내 검토' }).getAttribute('href'), /\/mail\?mail=draft-mail$/);
  assert.match(await page.getByRole('link', { name: '보완팀 보완 서류 첨부' }).getAttribute('href'), /\/intake\?base=sent$/);
  for (const width of [1024, 736, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  if (process.env.SWAX_NAV_SCREENSHOTS) await page.screenshot({ path: process.env.SWAX_NAV_SCREENSHOTS + '/workspace-review-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '승인 완료 1' }).click();
  assert.match(await page.getByRole('link', { name: '승인팀 지급 정보 입력' }).getAttribute('href'), /\/report$/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});
