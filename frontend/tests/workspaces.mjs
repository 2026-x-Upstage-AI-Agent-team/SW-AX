import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright-core';

const baseURL = process.env.INTAKE_TEST_URL;
assert.ok(baseURL && ['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname), 'Set INTAKE_TEST_URL to a local test instance.');

test('로그인 예시 카드와 진행 단계가 함께 바뀌고 재생을 멈출 수 있다', { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.CHROME_EXECUTABLE });
  const options = { baseURL, viewport: { width: 1280, height: 850 }, reducedMotion: 'no-preference' };
  const assertStage = async (page, index) => {
    const stage = page.locator('.preview-stage');
    assert.equal(await stage.getAttribute('data-preview-stage'), String(index));
    assert.deepEqual(await stage.locator('[data-preview-card][aria-hidden="false"]').evaluateAll(cards =>
      cards.map(card => card.dataset.previewCard)), [String(index)]);
    assert.deepEqual(await stage.locator('[data-preview-step][aria-current="step"]').evaluateAll(steps =>
      steps.map(step => step.dataset.previewStep)), [String(index)]);
  };
  try {
    const page = await browser.newPage(options);
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
    await page.goto('/login');
    await page.evaluate(async () => { await document.fonts.ready; });
    const toggle = page.locator('[data-preview-toggle]');
    const cards = page.locator('.preview-cards');
    const cardBox = await cards.boundingBox();
    const line = page.locator('.preview-steps');
    assert.ok(cardBox);
    assert.equal(await line.evaluate(node => getComputedStyle(node, '::after').transitionProperty), 'scale');
    assert.equal(await toggle.isVisible(), true);
    await assertStage(page, 0);
    await page.clock.runFor(3000);
    await assertStage(page, 1);

    assert.equal((await toggle.textContent()).trim(), '일시정지');
    await toggle.press('Enter');
    assert.equal((await toggle.textContent()).trim(), '재생');
    await page.clock.runFor(9000);
    await assertStage(page, 1);
    await toggle.press('Enter');

    await page.clock.runFor(3000);
    await assertStage(page, 2);
    await page.clock.runFor(3000);
    await assertStage(page, 3);
    assert.deepEqual(await cards.boundingBox(), cardBox);
    await page.clock.runFor(2000);
    await assertStage(page, 3);
    await page.clock.runFor(2200);
    await assertStage(page, 0);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await page.clock.runFor(10000);
    await assertStage(page, 1);
    assert.equal(await toggle.isVisible(), false);

    const staticPage = await browser.newPage({ ...options, javaScriptEnabled: false });
    await staticPage.goto('/login');
    await assertStage(staticPage, 1);
    assert.equal(await staticPage.locator('[data-preview-toggle]').isVisible(), false);
  } finally { await browser.close(); }
});

test('로그인은 이전 작업 주소나 실패 이력과 관계없이 카테고리 선택에서 시작한다', { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.CHROME_EXECUTABLE });
  try {
    for (const [previous, width] of [['/intake', 1280], ['/categories/awards/workspaces/old-workspace/intake', 320]]) {
      const context = await browser.newContext({ baseURL, viewport: { width, height: 850 } });
      const page = await context.newPage();
      await page.goto('/login#' + previous);
      await page.evaluate(async () => { await document.fonts.ready; });
      const formBox = await page.locator('#staff-login').boundingBox();
      const preview = page.locator('.login-preview');
      const previewBox = await preview.isVisible() ? await preview.boundingBox() : null;
      assert.ok(formBox && formBox.x >= 0 && formBox.x + formBox.width <= width);
      assert.equal(await page.evaluate(() => {
        const { scrollWidth, clientWidth } = document.documentElement;
        return scrollWidth - clientWidth;
      }), 0);
      if (width === 1280) {
        assert.ok(previewBox && formBox.x + formBox.width <= previewBox.x);
        assert.ok(previewBox.y <= formBox.y && previewBox.y + previewBox.height >= formBox.y + formBox.height);
      } else if (previewBox) {
        assert.ok(previewBox.y >= formBox.y + formBox.height);
      }
      const username = page.getByLabel('아이디', { exact: true });
      const password = page.getByLabel('비밀번호', { exact: true });
      const submit = page.getByRole('button', { name: '로그인', exact: true });
      const error = page.getByRole('alert');
      const inputBoxes = () => Promise.all([username.boundingBox(), password.boundingBox()]);
      const borderColor = input => input.evaluate(field => getComputedStyle(field).borderTopColor);
      const errorColor = 'rgb(180, 35, 24)';
      const before = await inputBoxes();
      let attempts = 0;
      page.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/login') attempts++;
      });
      await submit.click();
      await page.getByText('아이디를 입력해 주세요.', { exact: true }).waitFor();
      assert.equal(await username.evaluate(input => input === document.activeElement), true);
      assert.equal(await borderColor(username), errorColor);
      assert.notEqual(await borderColor(password), errorColor);
      const attemptedUsername = width === 1280 ? process.env.INTAKE_TEST_LOGIN_A : 'missing-ui-test-user';
      await username.fill(attemptedUsername);
      await submit.click();
      await page.getByText('비밀번호를 입력해 주세요.', { exact: true }).waitFor();
      assert.equal(await password.evaluate(input => input === document.activeElement), true);
      assert.equal(await borderColor(password), errorColor);
      assert.notEqual(await borderColor(username), errorColor);
      assert.equal(attempts, 0);
      assert.deepEqual(await inputBoxes(), before);
      await password.fill('incorrect-test-password');
      await submit.click();
      await page.getByText('아이디 또는 비밀번호를 확인해 주세요.', { exact: true }).waitFor();
      assert.equal(attempts, 1);
      assert.equal(await error.evaluate(message => getComputedStyle(message).color), errorColor);
      assert.notEqual(await borderColor(username), errorColor);
      assert.equal(await borderColor(password), errorColor);
      assert.deepEqual(await inputBoxes(), before, 'Invalid credentials must not move either input.');
      const errorBox = await error.boundingBox();
      assert.ok(errorBox.y >= before[0].y + before[0].height && errorBox.y + errorBox.height <= before[1].y);
      assert.equal(await username.getAttribute('aria-describedby'), 'login-error');
      assert.equal(new URL(page.url()).hash, '#' + previous);
      assert.equal(await username.inputValue(), attemptedUsername);
      assert.equal(await password.inputValue(), '');
      await username.fill(process.env.INTAKE_TEST_LOGIN_A);
      await password.fill(process.env.INTAKE_TEST_PASSWORD_A);
      assert.equal(await error.textContent(), '');
      assert.notEqual(await borderColor(username), errorColor);
      assert.notEqual(await borderColor(password), errorColor);
      await submit.click();
      await page.waitForURL(baseURL + '/#/');
      await page.getByRole('heading', { name: '문서 업무', exact: true }).waitFor();
      assert.equal(await page.getByRole('navigation', { name: '주 메뉴' }).count(), 0);
      await page.getByRole('link', { name: '로그아웃', exact: true }).click();
      await page.getByRole('button', { name: '로그아웃', exact: true }).click();
      const notice = page.getByRole('dialog', { name: '로그아웃했습니다.' });
      await notice.waitFor();
      assert.deepEqual(await inputBoxes(), before, 'The logout notice must not move either input.');
      await notice.getByRole('button', { name: '확인', exact: true }).click();
      await notice.waitFor({ state: 'hidden' });
      assert.equal(await username.evaluate(input => input === document.activeElement), true);
      await context.close();
    }
    // The server must clear the inherited hash even when the login script does not run.
    const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto('/login#/intake');
    await page.getByLabel('아이디', { exact: true }).fill(process.env.INTAKE_TEST_LOGIN_A);
    await page.getByLabel('비밀번호', { exact: true }).fill(process.env.INTAKE_TEST_PASSWORD_A);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await page.waitForURL(baseURL + '/#/');
    await context.close();
  } finally { await browser.close(); }
});

test('카테고리에서 생성한 워크스페이스가 첨부·새로고침·다른 탭에서도 유지된다', { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.CHROME_EXECUTABLE });
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
  const request = context.request;
  const created = [];
  let headers;
  try {
    const session = await (await request.get('/api/auth/session')).json();
    const login = await request.post('/login', {
      form: { username: process.env.INTAKE_TEST_LOGIN_A, password: process.env.INTAKE_TEST_PASSWORD_A },
      headers: { Accept: 'application/json', 'X-CSRF-TOKEN': session.csrf_token },
    });
    assert.equal(login.status(), 204);
    headers = { 'X-CSRF-TOKEN': (await (await request.get('/api/auth/session')).json()).csrf_token };
    const categories = await (await request.get('/api/categories')).json();
    assert.deepEqual(categories.filter(category => category.enabled).map(category => category.id), ['awards']);
    const preparing = categories.filter(category => !category.enabled);
    assert.equal(preparing.length, 5);
    assert.ok(preparing.some(category => category.id === 'result-reports'));
    for (const category of preparing) {
      const blocked = await request.post('/api/events', { headers, data: { name: 'blocked-category-test', category_id: category.id } });
      assert.equal(blocked.status(), 422, category.id);
      assert.deepEqual(await (await request.get('/api/events?category=' + category.id)).json(), []);
    }
    const invalid = await request.post('/api/events', { headers, data: { name: 'invalid-category', category_id: 'missing' } });
    assert.equal(invalid.status(), 422);
    assert.deepEqual(await (await request.get('/api/events?category=missing')).json(), []);

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/#/');
    await page.getByRole('heading', { name: '문서 업무', exact: true }).waitFor();
    assert.equal(await page.getByRole('navigation', { name: '주 메뉴' }).count(), 0);
    const disabledCards = page.locator('.category-card-disabled');
    await disabledCards.first().waitFor();
    assert.equal(await disabledCards.count(), preparing.length);
    assert.equal(await disabledCards.getByRole('link').count(), 0);
    assert.equal(await disabledCards.getByRole('button').count(), 0);
    for (const card of await disabledCards.all()) assert.equal(await card.getAttribute('aria-disabled'), 'true');
    for (const category of preparing) {
      await page.goto('/#/categories/' + category.id + '/workspaces');
      await page.getByRole('heading', { name: '준비 중인 업무입니다.' }).waitFor();
      assert.equal(await page.getByRole('button', { name: '워크스페이스 만들기' }).count(), 0);
    }
    await page.goto('/#/');
    await page.getByRole('link', { name: /시상금 서류 검토/ }).click();
    await page.getByRole('heading', { name: '워크스페이스', exact: true }).waitFor();
    const name = '워크스페이스 흐름 시험 ' + crypto.randomUUID();
    await page.getByLabel('대회명', { exact: true }).fill(name);
    const [createdResponse] = await Promise.all([
      page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/events'),
      page.getByRole('button', { name: '워크스페이스 만들기', exact: true }).click(),
    ]);
    assert.equal(createdResponse.status(), 200);
    const workspace = await createdResponse.json();
    created.push(workspace.id);
    assert.equal(workspace.category_id, 'awards');
    const root = '/categories/awards/workspaces/' + workspace.id;
    await page.waitForURL('**/#' + root);
    await page.getByRole('heading', { name: '업무 현황', exact: true }).waitFor();
    const guide = page.getByRole('dialog', { name: '워크스페이스 시작 가이드', exact: true });
    await guide.getByRole('heading', { name: '한 팀의 서류를 올려 보세요.', exact: true }).waitFor();
    await page.locator('.workspace-rail').getByRole('link', { name: '서류 올리기', exact: true }).click();
    await page.waitForURL('**/#' + root + '/intake');
    await page.getByRole('heading', { level: 1, name: '서류 올리기', exact: true }).waitFor();
    await guide.getByRole('heading', { name: '한 팀의 서류를 함께 선택하세요.' }).waitFor();
    await guide.getByRole('button', { name: '가이드 종료' }).click();
    assert.equal(await page.getByLabel('서류를 올릴 팀').inputValue(), 'bundle');
    assert.equal(await page.getByRole('button', { name: '선택한 서류 올리기', exact: true }).isDisabled(), true);
    await page.reload();
    await page.getByRole('heading', { level: 1, name: '서류 올리기', exact: true }).waitFor();
    const picker = page.getByRole('button', { name: '워크스페이스 선택', exact: true });
    await picker.getByText(name, { exact: true }).waitFor();

    const otherResponse = await request.post('/api/events', { headers, data: { name: name + ' 두 번째', category_id: 'awards' } });
    assert.equal(otherResponse.status(), 200);
    const other = await otherResponse.json();
    created.push(other.id);
    const otherPage = await context.newPage();
    await otherPage.goto('/#/categories/awards/workspaces/' + other.id);
    await otherPage.getByRole('heading', { name: '업무 현황', exact: true }).waitFor();
    // This changes the remembered workspace, but must never change the first tab's target.
    await page.reload();
    await page.getByRole('heading', { level: 1, name: '서류 올리기', exact: true }).waitFor();
    await picker.getByText(name, { exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, '#' + root + '/intake');
    await page.getByRole('link', { name: '워크스페이스 목록', exact: true }).click();
    await page.getByRole('heading', { name, exact: true }).waitFor();

    await page.setViewportSize({ width: 320, height: 800 });
    for (const path of ['/', '/categories/awards/workspaces', root + '/intake']) {
      await page.goto('/#' + path);
      await page.getByRole('heading', { level: 1 }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, path + ' must fit at 320px');
    }
    await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
    await page.getByRole('dialog', { name: '작업 메뉴' }).getByRole('link', { name: '워크스페이스 목록', exact: true }).click();
    await page.getByRole('heading', { name: '워크스페이스', exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog', { name: '작업 메뉴' }).count(), 0);

    await page.goto('/#/categories/awards/workspaces/00000000-0000-0000-0000-000000000000/intake');
    await page.getByRole('heading', { name: '워크스페이스를 열 수 없습니다.' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '선택한 서류 올리기' }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    // Only remove empty workspaces created by this test, using the normal deletion preview token.
    for (const id of created.reverse()) {
      const path = '/api/events/' + id;
      const preview = await request.get(path + '/deletion-preview');
      if (preview.ok()) {
        const impact = await preview.json();
        assert.equal(impact.file_count, 0);
        const result = await request.delete(path, { headers: { ...headers, 'If-Match': '"' + impact.token + '"' } });
        assert.ok(result.ok(), 'remove test workspace');
      }
    }
    await browser.close();
  }
});
