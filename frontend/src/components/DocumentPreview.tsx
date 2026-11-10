import { useEffect, useState, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useAsync } from '../api/client';
import { getEditHistory, versionChannel, versionName, versionUrl } from '../api/documentVersions';
import { filePreviewUrl, type FileInfo } from '../api/service';
import { buttonStyles, PdfFrame } from './ui';

type Props = {
  file: Pick<FileInfo, 'id' | 'name' | 'url'>; page?: number; original?: boolean;
  height?: number | string; emptyMessage?: string; children?: ReactNode; openLink?: boolean; beforePreview?: ReactNode;
};

export default function DocumentPreview({ file, page, original = false, height, emptyMessage, children, openLink, beforePreview }: Props) {
  const [refresh, setRefresh] = useState(0);
  const [choice, setChoice] = useState<number | 'latest'>(original ? 0 : 'latest');
  const { data, error } = useAsync(() => getEditHistory(file.id), [file.id, refresh]);
  useEffect(() => {
    const reload = () => setRefresh(n => n + 1);
    const visible = () => { if (document.visibilityState === 'visible') reload(); };
    window.addEventListener('focus', reload);
    window.addEventListener('pageshow', reload);
    document.addEventListener('visibilitychange', visible);
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(versionChannel);
    if (channel) channel.onmessage = event => { if (event.data === file.id) reload(); };
    return () => {
      window.removeEventListener('focus', reload);
      window.removeEventListener('pageshow', reload);
      document.removeEventListener('visibilitychange', visible);
      channel?.close();
    };
  }, [file.id]);
  if (!data && !error && !original) return <p role="status" className="text-sm text-muted">저장한 버전 확인 중…</p>;
  const versions = data?.versions ?? [];
  const version = choice === 'latest' ? versions[0]?.version ?? 0 : choice;
  const name = file.name || data?.name || '첨부 문서';
  const title = version ? `${name} · 수정본 v${version}` : name;
  const url = version ? '/rhwp/preview.html?' + new URLSearchParams({ file: file.id, version: String(version), page: String(page || 1) }) : filePreviewUrl(file, page);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {versions.length ? <label className="flex items-center gap-2 font-semibold">미리보기 버전
          <select className="rounded-lg border border-line-2 bg-white p-2" value={choice} onChange={e => setChoice(e.target.value === 'latest' ? 'latest' : Number(e.target.value))}>
            <option value="latest">최신 수정본 v{versions[0].version}</option>
            {versions.slice(1).map(v => <option key={v.version} value={v.version}>수정본 v{v.version}</option>)}
            <option value="0">첨부한 파일</option>
          </select>
        </label> : <span className="font-semibold">첨부한 파일</span>}
        {version > 0 && <a className={buttonStyles.text} href={versionUrl(file.id, version)} download={versionName(name, version)}>수정본 내려받기</a>}
        {openLink && url && <a className={buttonStyles.text} href={url} target="_blank" rel="noreferrer">새 창으로 열기</a>}
      </div>
      {error && <p className="text-sm text-alert-strong" role="alert">수정본 목록을 확인하지 못했습니다. <button type="button" className="underline" onClick={() => setRefresh(n => n + 1)}>다시 조회</button></p>}
      {version > 0 && <p className="text-sm text-muted">이 수정본을 보완 서류로 첨부하면 새 제출 버전으로 판정합니다.</p>}
      {beforePreview}
      <PdfFrame url={url} title={title} height={height} emptyMessage={emptyMessage}>{children}</PdfFrame>
    </div>
  );
}

/** The single-PC service embeds the same preview next to its assignment and review forms. */
export function EmbeddedDocumentPreview() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const page = Number(params.get('page')) || 1;
  const original = params.get('source') === 'original';
  const url = params.get('pdf') === '1' ? '/api/files/' + encodeURIComponent(id) + '/preview' : '';
  return <DocumentPreview key={`${id}-${page}-${original}`} file={{ id, name: '', url }} page={page} original={original} height="calc(100dvh - 7rem)" />;
}
