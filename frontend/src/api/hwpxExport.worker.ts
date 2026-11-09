import { unzipSync, zipSync, type Zippable } from 'fflate';

// rhwp 0.9 can append padding after a DEFLATE stream in image entries.
// Repack the unchanged parts for Hangul and Java ZIP readers, keeping mimetype first and stored.
self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  try {
    let count = 0;
    let expanded = 0;
    const parts = unzipSync(new Uint8Array(event.data), { filter(entry) {
      expanded += entry.originalSize;
      if (++count > 10000 || expanded > 384 * 1024 ** 2) throw new Error('HWPX의 압축 해제 크기 또는 항목 수가 저장 한도를 초과했습니다.');
      return true;
    } });
    if (!parts.mimetype) throw new Error('내보낸 문서에 HWPX 형식 정보가 없습니다.');
    const entries: Zippable = { mimetype: [parts.mimetype, { level: 0 }] };
    for (const [name, bytes] of Object.entries(parts)) {
      if (name !== 'mimetype') entries[name] = bytes;
    }
    const output = zipSync(entries, { mtime: new Date(1980, 0, 1) });
    self.postMessage({ bytes: output.buffer }, { transfer: [output.buffer] });
  } catch (error) {
    self.postMessage({ error: (error as Error).message });
  }
};
