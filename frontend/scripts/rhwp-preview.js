import init, { HwpDocument } from './rhwp.js';

const params = new URLSearchParams(location.search);
const file = params.get('file') ?? '';
const version = Number(params.get('version'));
const status = document.querySelector('#status');
const sheet = document.querySelector('#sheet');
const nav = document.querySelector('nav');
const previous = document.querySelector('#previous');
const next = document.querySelector('#next');

async function openPreview() {
  if (!/^[\w-]+$/.test(file) || !Number.isSafeInteger(version) || version < 1) throw new Error('문서 버전을 확인하세요.');
  const response = await fetch('/api/files/' + encodeURIComponent(file) + '/versions/' + version + '/content', { cache: 'no-store' });
  if (!response.ok) throw new Error(response.status === 401 ? '담당자 로그인이 필요합니다.' : '저장한 수정본을 불러오지 못했습니다.');
  const [bytes] = await Promise.all([response.arrayBuffer(), init()]);
  const doc = new HwpDocument(new Uint8Array(bytes));
  const total = doc.pageCount();
  if (!total) throw new Error('표시할 문서 쪽이 없습니다.');
  let page = Math.min(total, Math.max(1, parseInt(params.get('page') ?? '', 10) || 1));
  function render() {
    const svg = doc.renderPageSvg(page - 1);
    const last = sheet.getAttribute('src');
    sheet.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    if (last) URL.revokeObjectURL(last);
    sheet.alt = '수정본 v' + version + ' · ' + page + '쪽';
    document.querySelector('#page').textContent = page + ' / ' + total + '쪽';
    previous.disabled = page === 1;
    next.disabled = page === total;
    window.scrollTo(0, 0);
  }
  previous.onclick = () => { page--; render(); };
  next.onclick = () => { page++; render(); };
  sheet.onload = () => { status.hidden = true; sheet.hidden = false; nav.hidden = total === 1; };
  sheet.onerror = () => { sheet.hidden = true; status.hidden = false; status.textContent = '수정한 쪽을 표시하지 못했습니다.'; };
  render();
}

openPreview().catch(error => { status.textContent = error.message || '수정본을 열지 못했습니다.'; });
