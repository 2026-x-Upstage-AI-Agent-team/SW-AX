import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, '../public/rhwp');
const cache = resolve(here, '../../var/rhwp-editor-build');
const name = 'rhwp-chrome-0.9.0.zip';
const digest = 'db24306cc91e7fdf876f393ca3f2235f97546fc6413f6074223362b69d96820f';
const source = 'https://github.com/edwardkim/rhwp/releases/download/v0.9.0/' + name;
const archive = resolve(cache, name);
let bytes;
try {
  bytes = await readFile(archive);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (!bytes || createHash('sha256').update(bytes).digest('hex') !== digest) {
  const response = await fetch(source);
  if (!response.ok) throw new Error('rhwp Studio 다운로드 실패 (HTTP ' + response.status + ')');
  bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('rhwp Studio 배포본의 SHA-256이 다릅니다.');
  await mkdir(cache, { recursive: true });
  const temporary = archive + '.' + randomUUID();
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, archive);
  } finally {
    await rm(temporary, { force: true });
  }
}

// The upstream release packages the full Studio and its offline fonts. Only ship the web assets.
const entries = unzipSync(bytes, { filter: ({ name }) =>
  /^(assets|fonts|images|icons)\//.test(name) || ['wasm/rhwp.js', 'viewer.html', 'print.html', 'theme-init.js', 'locale-init.js', 'favicon.ico', 'THIRD_PARTY_LICENSES.md'].includes(name),
});
const policy = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data: blob:; img-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; form-action 'none'; base-uri 'self'";
for (const [entry, contents] of Object.entries(entries)) {
  if (entry.endsWith('/')) continue;
  if (entry === 'wasm/rhwp.js') continue;
  let data = contents;
  if (/\.(html|js|css)$/.test(entry)) {
    let body = Buffer.from(contents).toString('utf8');
    // Vite's extension build uses root-relative URLs; mount these under our own /rhwp/ path.
    body = body.replace(/(["'`(])\/(assets|fonts|images|icons)\//g, '$1/rhwp/$2/');
    if (entry.endsWith('.html')) {
      body = body.replace(/(src|href)="\/(theme-init\.js|locale-init\.js|favicon\.ico)"/g, '$1="/rhwp/$2"')
        .replace(/<script src="\/dev-tools-inject\.js"><\/script>/g, '')
        .replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="' + policy + '">');
    }
    if (entry === 'viewer.html') {
      body = body.replace('</head>', '<link rel="stylesheet" href="./host.css"><script src="./host.js"></script></head>');
    }
    data = Buffer.from(body);
  }
  const target = resolve(output, entry);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
}
for (const part of ['host.js', 'host.css']) {
  await writeFile(resolve(output, part), await readFile(resolve(here, 'rhwp-' + part)));
}
// The release's standalone bindings use the same WASM binary as Studio.
const wasmAsset = Object.keys(entries).find(name => /^assets\/rhwp_bg-[\w-]+\.wasm$/.test(name));
if (!wasmAsset) throw new Error('rhwp 미리보기 렌더러를 찾을 수 없습니다.');
await writeFile(resolve(output, 'rhwp.js'), Buffer.from(entries['wasm/rhwp.js']).toString('utf8').replace("'rhwp_bg.wasm'", JSON.stringify('./' + wasmAsset)));
await writeFile(resolve(output, 'preview.js'), await readFile(resolve(here, 'rhwp-preview.js')));
const preview = await readFile(resolve(here, 'rhwp-preview.html'), 'utf8');
await writeFile(resolve(output, 'preview.html'), preview.replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="' + policy + '">'));
await writeFile(resolve(output, 'LICENSE'), await readFile(resolve(here, '../node_modules/@rhwp/editor/LICENSE')));
