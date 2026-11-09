import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';
import { chromium } from 'playwright-core';

const baseURL = process.env.INTAKE_TEST_URL;
const fixture = fileURLToPath(new URL('../../test case/upstage_data', import.meta.url));
async function originals() {
  const chosen = /^set01_(A_신청서\.hwp|C_사본\.hwpx)$/i;
  try {
    const archive = await readFile(fixture + '.zip');
    return Object.entries(unzipSync(archive, { filter: ({ name }) => basename(dirname(name)) === 'set01' && chosen.test(basename(name)) }));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const entries = await readdir(fixture, { recursive: true, withFileTypes: true });
  const files = entries.filter(f => f.isFile() && basename(f.parentPath) === 'set01' && chosen.test(f.name));
  return Promise.all(files.map(async f => [f.name, await readFile(join(f.parentPath, f.name))]));
}

test('가상 HWP·HWPX를 로컬 편집기에서 수정하고 새 버전으로 다시 연다', async () => {
  assert.ok(baseURL && ['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname), '시험용 로컬 서버를 지정하세요.');
  const browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.CHROME_EXECUTABLE });
  try {
    const context = await browser.newContext({ baseURL, locale: 'ko-KR', viewport: { width: 1440, height: 980 } });
    const api = context.request;
    const csrf = async () => (await (await api.get('/api/auth/session')).json()).csrf_token;
    const login = await api.post('/login', {
      form: { username: process.env.INTAKE_TEST_LOGIN_A, password: process.env.INTAKE_TEST_PASSWORD_A },
      headers: { Accept: 'application/json', 'X-CSRF-TOKEN': await csrf() },
    });
    assert.equal(login.status(), 204);
    const headers = { 'X-CSRF-TOKEN': await csrf() };
    const event = await api.post('/api/events', { headers, data: { name: '편집 검증 ' + crypto.randomUUID() } });
    assert.ok(event.ok());
    const eventId = (await event.json()).id;
    const official = await originals();
    assert.equal(official.length, 2);
    const external = new Set();
    context.on('request', req => {
      if (/^https?:/.test(req.url()) && new URL(req.url()).origin !== new URL(baseURL).origin) external.add(new URL(req.url()).origin);
    });
    for (const [path, raw] of official) {
      const name = path.endsWith('.hwpx') ? '03_대표증빙.hwpx' : '01_지급확인서.hwp';
      const source = Buffer.from(raw);
      const receipt = await api.post('/api/intake-batches', {
        headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
        multipart: { event: eventId, manifest: JSON.stringify([{ name, size: source.length }]),
          files: { name, mimeType: 'application/octet-stream', buffer: source } },
      });
      assert.equal(receipt.status(), 202);
      const batch = await (await api.get(receipt.headers().location)).json();
      const id = batch.files[0].item_id;
      const versions = '/api/files/' + id + '/versions';
      const page = await context.newPage();
      const ready = () => page.waitForFunction(() => document.querySelector('select[aria-label="문서 버전"]')?.disabled === false);
      await page.goto('/#/files/' + id + '/edit');
      await page.getByText(name, { exact: true }).waitFor();
      await ready();
      const canvas = page.frameLocator('iframe').locator('#scroll-content canvas').first();
      await canvas.waitFor();
      const box = await canvas.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + 100);
      await page.keyboard.press('Control+Home');
      await page.keyboard.type('WEBEDIT', { delay: 30 });
      if (name.endsWith('.hwp')) await page.keyboard.press('Control+s');
      else await page.getByRole('button', { name: '새 버전으로 저장' }).click();
      const outcome = page.getByText('수정본 v1을 저장했습니다.', { exact: true }).or(page.getByRole('alert'));
      await outcome.waitFor();
      assert.equal(await outcome.innerText(), '수정본 v1을 저장했습니다.', name + ' 저장 결과');
      await page.reload();
      await ready();
      assert.equal(await page.getByRole('combobox', { name: '문서 버전' }).inputValue(), '1');
      assert.deepEqual(await (await api.get(versions + '/0/content')).body(), source);
      const saved = unzipSync(await (await api.get(versions + '/1/content')).body());
      assert.match(strFromU8(saved['Contents/section0.xml']), /WEBEDIT/);
      if (name.endsWith('.hwpx')) {
        const images = unzipSync(raw, { filter: ({ name: part }) => part.startsWith('BinData/') });
        for (const [part, bytes] of Object.entries(images)) assert.deepEqual(saved[part], bytes);
      }
      await page.close();
    }
    assert.equal(external.size, 0, '편집기가 외부 주소를 요청했습니다.');
  } finally { await browser.close(); }
});
