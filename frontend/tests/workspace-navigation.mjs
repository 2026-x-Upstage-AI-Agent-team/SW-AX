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

test('업무 순서 네 메뉴와 팀장 안내 메일을 현재 워크스페이스에서 열 수 있다', async t => {
  const page = await pageFor(t);
  await page.goto(root + '/review');
  const rail = page.getByRole('complementary', { name: '작업 공간' });
  await page.getByRole('heading', { name: '팀별 결과 확인', exact: true }).waitFor();
  if (process.env.SWAX_NAV_SCREENSHOTS) await page.screenshot({ path: process.env.SWAX_NAV_SCREENSHOTS + '/workspace-navigation-desktop.png', fullPage: true });
  assert.match(await rail.locator('[aria-current=page]').innerText(), /팀별 결과 확인/);
  const workflow = rail.getByRole('list', { name: '업무 순서', exact: true });
  assert.deepEqual(await workflow.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('aria-label'))),
    ['서류 올리기', '검토 진행', '팀별 결과 확인', '지급 보고서']);
  await workflow.getByRole('link', { name: '서류 올리기', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: '서류 올리기', exact: true }).waitFor();
  await workflow.getByRole('link', { name: '검토 진행', exact: true }).click();
  await page.waitForURL('**/workspaces/nav-test/intake/batches');
  assert.equal(await rail.locator('[aria-current=page]').count(), 1);
  assert.match(await rail.locator('[aria-current=page]').innerText(), /검토 진행/);
  await page.getByRole('heading', { name: '검토 진행', exact: true }).waitFor();
  await page.getByRole('main').getByRole('link', { name: '팀 배정 확인', exact: true }).click();
  await page.waitForURL('**/workspaces/nav-test/assign');
  await page.getByRole('heading', { name: '팀 배정 확인', exact: true }).waitFor();
  await workflow.getByRole('link', { name: '지급 보고서', exact: true }).click();
  await page.getByRole('heading', { name: '지급 보고서', exact: true }).waitFor();
  await rail.getByRole('link', { name: '팀장 안내 메일', exact: true }).click();
  await page.getByRole('heading', { name: '팀장 안내 메일', exact: true }).waitFor();
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
  assert.equal(await list.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)');
  assert.equal(await current.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(236, 253, 245)');
  if (process.env.SWAX_NAV_SCREENSHOTS) await page.screenshot({ path: process.env.SWAX_NAV_SCREENSHOTS + '/workspace-picker-desktop.png' });
  await page.getByRole('heading', { name: '팀별 결과 확인', exact: true }).click();
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

test('워크스페이스 목록과 검색은 동작 줄이기 설정을 반영한다', async t => {
  const page = await pageFor(t);
  for (const reducedMotion of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion });
    await page.goto(root + '/review');
    const assertMotion = async (target, label) => {
      const animated = await target.evaluate(element => {
        const style = getComputedStyle(element);
        return [style.animationDuration, style.transitionDuration].some(durations =>
          durations.split(',').some(duration => parseFloat(duration) > 0)
        );
      });
      assert.equal(animated, reducedMotion === 'no-preference', label);
    };

    const rail = page.getByRole('complementary', { name: '작업 공간' });
    const picker = rail.getByRole('button', { name: '워크스페이스 선택', exact: true });
    const workspaces = rail.getByRole('list', { name: '전환할 워크스페이스' });
    await picker.press('ArrowDown');
    await workspaces.getByRole('button', { name: event.name, exact: true }).waitFor();
    await assertMotion(workspaces, '워크스페이스 목록');
    await page.keyboard.press('Escape');
    await workspaces.waitFor({ state: 'hidden' });
    assert.equal(await picker.evaluate(element => element === document.activeElement), true);

    await page.getByRole('button', { name: '현재 워크스페이스 검색', exact: true }).click();
    const search = page.getByRole('dialog', { name: '현재 워크스페이스 검색' });
    await assertMotion(search, '워크스페이스 검색창');
    const input = search.getByRole('searchbox');
    await input.fill('가온');
    const result = search.getByRole('region', { name: '팀 검색 결과' });
    await assertMotion(result, '팀 검색 결과');
    assert.match(await result.getByRole('link').getAttribute('href'), /\/teams\/submission-1$/);
    assert.equal(await input.evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Escape');
    await search.waitFor({ state: 'hidden' });
  }
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

test('접힌 사이드바를 기억하고 시작 가이드에서 다시 펼친다', async t => {
  const page = await pageFor(t);
  await page.goto(root + '/review');
  await page.getByRole('button', { name: '사이드바 접기', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: '사이드바 펼치기', exact: true }).waitFor();
  const rail = page.getByRole('complementary', { name: '작업 공간' });
  await rail.getByRole('button', { name: '사이드바 펼치기', exact: true }).click();
  await rail.getByRole('link', { name: '서류 올리기', exact: true }).waitFor();
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
  await page.getByRole('heading', { name: '한 팀의 서류를 올려 보세요.' }).waitFor();
  await help.waitFor({ state: 'hidden' });
  assert.equal(await rail.getByRole('link', { name: '서류 올리기', exact: true }).isVisible(), true);
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
  await menu.getByRole('link', { name: '팀장 안내 메일', exact: true }).click();
  await page.getByRole('heading', { name: '팀장 안내 메일', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});

test('팀장 안내의 메일 목록과 초안 검토는 정렬되고 좁은 화면에서는 쌓인다', async t => {
  const page = await pageFor(t);
  await page.goto(root + '/mail');
  const tabs = page.getByRole('group', { name: '메일 보기', exact: true });
  const list = page.getByRole('region', { name: '메일 목록', exact: true });
  const draft = page.getByRole('region', { name: '초안 검토', exact: true });
  const checkDesktop = async () => {
    const [controls, left, right] = await Promise.all([tabs.boundingBox(), list.boundingBox(), draft.boundingBox()]);
    assert.ok(controls && left && right);
    assert.ok(controls.y + controls.height <= left.y);
    assert.ok(left.x + left.width < right.x);
    assert.ok(Math.abs(left.y - right.y) < 1);
    assert.ok(Math.abs(left.height - right.height) < 1);
  };

  await list.getByText('승인을 기다리는 메일이 없습니다.').waitFor();
  await checkDesktop();
  await tabs.getByRole('button', { name: '전체 메일 0', exact: true }).click();
  await list.getByText('아직 만들어진 메일이 없습니다.').waitFor();
  await checkDesktop();

  await page.setViewportSize({ width: 320, height: 1000 });
  const [upper, lower] = await Promise.all([list.boundingBox(), draft.boundingBox()]);
  assert.ok(upper && lower);
  assert.ok(upper.y + upper.height < lower.y);
  assert.ok(Math.abs(upper.x - lower.x) < 1);
  assert.ok(Math.abs(upper.width - lower.width) < 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});

test('확인할 일 배지는 현황의 같은 목록으로 이동하고 계정 메뉴는 프로필에 붙는다', async t => {
  const page = await pageFor(t);
  await page.goto(root + '/review');
  await page.getByRole('link', { name: '확인할 일 1건', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.id === 'queue-heading');
  assert.equal(new URL(page.url()).hash, '#/categories/awards/workspaces/nav-test/?focus=tasks');
  const trigger = page.getByRole('button', { name: '계정 메뉴', exact: true });
  const account = page.getByRole('group', { name: '계정 메뉴', exact: true });
  await trigger.click();
  await account.getByText('staff-nav', { exact: true }).waitFor();
  const [buttonBox, panelBox] = await Promise.all([trigger.boundingBox(), account.boundingBox()]);
  assert.ok(buttonBox && panelBox);
  assert.ok(panelBox.y >= buttonBox.y + buttonBox.height && panelBox.y - buttonBox.y - buttonBox.height < 16);
  assert.ok(Math.abs(panelBox.x + panelBox.width - buttonBox.x - buttonBox.width) < 1);
  assert.equal(await account.getByRole('link', { name: '로그아웃' }).getAttribute('href'), '/logout');
  await page.keyboard.press('Tab');
  assert.ok(await account.getByRole('link', { name: '업무 선택' }).evaluate(link => link === document.activeElement));
  await page.keyboard.press('Escape');
  await account.waitFor({ state: 'hidden' });
  assert.ok(await trigger.evaluate(button => button === document.activeElement));
  await trigger.click();
  await page.getByRole('heading', { name: '업무 현황', exact: true }).click();
  await account.waitFor({ state: 'hidden' });
  await trigger.click();
  await page.keyboard.press('Control+k');
  const search = page.getByRole('dialog', { name: '현재 워크스페이스 검색' });
  await search.waitFor();
  await account.waitFor({ state: 'hidden' });
  await page.keyboard.press('Escape');
  await search.waitFor({ state: 'hidden' });

  await page.setViewportSize({ width: 320, height: 1000 });
  await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '작업 메뉴' });
  await drawer.getByRole('button', { name: '계정 메뉴' }).click();
  await drawer.getByRole('group', { name: '계정 메뉴' }).getByRole('link', { name: '업무 선택' }).waitFor();
  await page.keyboard.press('Escape');
  await account.waitFor({ state: 'hidden' });
  assert.ok(await drawer.isVisible());
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
    return { radius: style.borderTopLeftRadius, thickness: parseFloat(style.paddingTop), colors: style.backgroundImage };
  });
  assert.equal(ringStyle.radius, '50%');
  assert.ok(ringStyle.thickness > 0, 'The chart ring must stay visible after the shared style reset.');
  assert.match(ringStyle.colors, /rgb\(6, 95, 70\)/);
  const rail = page.getByRole('complementary', { name: '작업 공간' });
  assert.equal(await rail.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
  assert.equal(await rail.locator('.brand-mark path[d="M15.6 27L21.5 32.9L34 19.5"]').evaluate(node => getComputedStyle(node).stroke), 'rgb(5, 150, 105)');
  assert.equal(await rail.getByRole('link', { name: '업무 현황', exact: true }).evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(15, 23, 42)');
  assert.equal(await page.getByRole('link', { name: '한 팀의 서류 올리기', exact: true }).evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(4, 120, 87)');
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

test('마지막 첨부 묶음을 삭제하면 업무 현황과 팀별 검토 집계에서 빠진다', async t => {
  const page = await pageFor(t);
  const registered = { ...team, current: null, submission: null };
  const emptyTeam = { ...registered, id: 'empty-team', name: '빈 팀', has_documents: false };
  let deleted = false;
  await page.route('**/api/dashboard?*', route => route.fulfill({ json: {
    ...dashboard,
    teams: [{ ...registered, has_documents: !deleted }, emptyTeam],
    batches: deleted ? [] : [batch],
  } }));
  await page.route('**/api/intake-batches?*', route => route.fulfill({ json: deleted ? [] : [{
    batch_id: batch.id, status: 'received', created_at: '2026-11-12T00:00:00Z', team_name: team.name, file_count: 1,
  }] }));
  await page.route('**/api/intake-batches/batch-1/deletion-preview', route => route.fulfill({
    json: { team_count: 0, batch_count: 1, file_count: 1, reviews: [], reports: [], token: 'test' },
  }));
  await page.route('**/api/intake-batches/batch-1', route => {
    assert.equal(route.request().method(), 'DELETE');
    deleted = true;
    return route.fulfill({ status: 204 });
  });

  await page.goto(root);
  const rail = page.getByRole('complementary', { name: '작업 공간' });
  const uploaded = page.locator('dl').filter({ hasText: '서류를 올린 팀' });
  await uploaded.getByText('1팀', { exact: true }).waitFor();
  await page.getByRole('link', { name: '팀 배정 확인 1팀 보기' }).waitFor();
  await rail.getByRole('link', { name: '검토 진행', exact: true }).click();
  await page.getByRole('button', { name: /묶음 삭제$/ }).click();
  await page.getByRole('button', { name: '묶음 삭제하기' }).click();
  await page.getByText('아직 올린 서류가 없습니다.').waitFor();

  await rail.getByRole('link', { name: '업무 현황', exact: true }).click();
  await uploaded.getByText('원본 0개', { exact: true }).waitFor();
  await uploaded.getByText('0팀', { exact: true }).waitFor();
  assert.match(await page.locator('.ring-center').innerText(), /^0\s+첨부한 팀$/);
  await page.getByRole('link', { name: '팀 배정 확인 0팀 보기' }).click();
  await page.getByRole('heading', { name: '아직 검토할 팀이 없습니다.' }).waitFor();
});

test('검토 검색과 필터는 원문을 열었다 돌아와도 유지된다', async t => {
  const page = await pageFor(t);
  await page.goto(root + '/review?filter=all');
  await page.getByRole('searchbox', { name: '팀명 또는 대표자 검색' }).fill('가온');
  await page.getByRole('link', { name: '가온팀 원문 대조', exact: true }).click();
  await page.getByRole('heading', { name: '미확인', exact: true }).waitFor();
  await page.getByRole('link', { name: '← 팀별 결과 확인', exact: true }).click();
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
  await page.getByRole('link', { name: '안내팀 안내 메일 검토', exact: true }).waitFor();
  assert.match(await page.getByRole('link', { name: '안내팀 안내 메일 검토' }).getAttribute('href'), /\/mail\?mail=draft-mail$/);
  assert.match(await page.getByRole('link', { name: '보완팀 보완 서류 올리기' }).getAttribute('href'), /\/intake\?base=sent$/);
  for (const width of [1024, 736, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  if (process.env.SWAX_NAV_SCREENSHOTS) await page.screenshot({ path: process.env.SWAX_NAV_SCREENSHOTS + '/workspace-review-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '승인 완료 1' }).click();
  assert.match(await page.getByRole('link', { name: '승인팀 지급 정보 입력' }).getAttribute('href'), /\/report$/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});

test('보완이 필요한 팀 상세에서 그 팀의 안내 메일을 바로 연다', async t => {
  const page = await pageFor(t);
  const matching = { id: 'gaon-mail', submission: submission.id, kind: '팀장 보완 요청', state: 'draft', name: team.name, created: 1, sent_to: null };
  const other = { ...matching, id: 'other-mail', submission: 'other-submission', name: '다른 팀' };
  let hasDraft = true;
  await page.route('**/api/dashboard?*', route => route.fulfill({ json: {
    ...dashboard, mail: hasDraft ? [other, matching] : [other],
  } }));
  await page.route('**/api/operations/submissions/submission-1', route => route.fulfill({ json: {
    ...submission, decision: '보완 필요', mail: hasDraft ? [matching] : [],
  } }));
  await page.route('**/api/mail/gaon-mail', route => route.fulfill({ json: {
    ...matching, subject: '가온팀 보완 요청', body: '보완 서류를 확인해 주세요.', recipient: 'leader@example.test', revision: 1, can_approve: true,
  } }));
  const writes = [];
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.method()); });
  const detail = root + '/teams/submission-1';
  const link = page.getByRole('main').getByRole('link', { name: '안내 메일 검토', exact: true });
  await page.goto(detail);
  await link.click();
  await page.waitForURL('**/mail?mail=gaon-mail');
  const subject = page.getByRole('textbox', { name: '제목', exact: true });
  await subject.waitFor();
  assert.equal(await subject.inputValue(), '가온팀 보완 요청');

  hasDraft = false;
  await page.goto(detail);
  await page.reload();
  await link.click();
  await page.waitForURL('**/mail?supplement=submission-1');
  const list = page.getByRole('region', { name: '메일 목록', exact: true });
  await list.waitFor();
  assert.equal(await list.getByText('다른 팀', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '승인 후 발송', exact: true }).count(), 0);
  assert.deepEqual(writes, []);
});
