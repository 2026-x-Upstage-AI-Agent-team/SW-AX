import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, FileText, Search, Users, X } from 'lucide-react';
import { getBatch, type FileInfo } from '../api/service';
import { receiptName } from '../api/intake';
import { useEvent } from '../context/EventContext';
import { Link } from './workspaceNavigation';
import { buttonStyles, inputStyle } from './ui';
import { documentMenu, primaryMenu } from './workspaceMenu';

type SearchFile = FileInfo & { batch: string };

export default function WorkspaceSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { dashboard } = useEvent();
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<SearchFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const batchIds = dashboard?.batches.map(batch => batch.id).join(',') ?? '';

  useEffect(() => {
    if (open) { setQuery(''); dialog.current?.showModal(); }
    else dialog.current?.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const ids = batchIds ? batchIds.split(',') : [];
    const found = new Map<string, SearchFile>();
    let next = 0;
    let errors = false;
    setFiles([]); setLoading(true); setFailed(false);
    // Limit simultaneous requests while searching every batch in this workspace.
    const worker = async () => {
      while (active && next < ids.length) {
        const id = ids[next++];
        try {
          const batch = await getBatch(id);
          for (const file of batch.files) if (!found.has(file.id)) found.set(file.id, { ...file, batch: id });
        } catch { errors = true; }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker)).then(() => {
      if (active) { setFiles([...found.values()]); setFailed(errors); setLoading(false); }
    });
    return () => { active = false; };
  }, [open, batchIds, retry]);

  const text = query.trim().toLocaleLowerCase();
  const matches = (value: string) => value.toLocaleLowerCase().includes(text);
  const teams = dashboard?.teams.filter(team => matches(`${receiptName(team.name, team.intake_number)} ${team.rep}`)) ?? [];
  const matchingFiles = useMemo(() => text ? files.filter(file => file.name.toLocaleLowerCase().includes(text)) : [], [files, text]);
  const pages = [...primaryMenu, ...documentMenu].filter(item => matches(item.label));

  return <dialog ref={dialog} className="deletion-dialog" aria-labelledby="workspace-search-title" onClose={onClose}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dialog.current?.close(); onClose(); } }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="flex items-center gap-3 border-b border-line p-4">
      <Search size={20} aria-hidden="true" />
      <label className="sr-only" id="workspace-search-title" htmlFor="workspace-search-query">현재 워크스페이스 검색</label>
      <input id="workspace-search-query" type="search" className={inputStyle + ' min-w-0 flex-1'} autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="팀명, 파일명 또는 메뉴 검색" autoComplete="off" />
      <button type="button" className="icon-button" aria-label="검색 닫기" onClick={onClose}><X size={18} aria-hidden="true" /></button>
    </div>
    <p className="px-5 pt-3 text-xs text-muted">{dashboard?.events.find(event => event.id === dashboard.event)?.name ?? '현재 워크스페이스'} 안에서 검색</p>
    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4" aria-live="polite" aria-busy={loading}>
      {!dashboard && <p className="py-3 text-sm text-muted">자료를 불러오고 있습니다. 잠시 후 다시 검색해 주세요.</p>}
      {teams.length > 0 && <section key={'teams:' + text} className="motion-results" aria-label="팀 검색 결과"><h2 className="text-sm font-bold">팀 <span>{teams.length}</span></h2>
        {teams.slice(0, 8).map(team => <Link key={team.id} to={team.current ? '/teams/' + team.current : '/review?filter=all&team=' + encodeURIComponent(team.id)} className="file-download mt-2" onClick={onClose}>
          <Users size={18} aria-hidden="true" /><span><strong>{receiptName(team.name, team.intake_number)}</strong><small>{team.current ? '팀별 검토 열기' : '아직 제출본 없음'}</small></span><ArrowUpRight size={16} aria-hidden="true" />
        </Link>)}
        {teams.length > 8 && <p className="py-3 text-sm text-muted">{teams.length}팀 중 8팀 표시 · 검색어를 더 입력해 주세요.</p>}
      </section>}
      {matchingFiles.length > 0 && <section key={'files:' + text} className="motion-results" aria-label="파일 검색 결과"><h2 className="text-sm font-bold">첨부 파일 <span>{matchingFiles.length}</span></h2>
        {matchingFiles.slice(0, 8).map(file => <Link key={file.id} to={'/intake/batches/' + file.batch} className="file-download mt-2" onClick={onClose}>
          <FileText size={18} aria-hidden="true" /><span><strong>{file.name}</strong><small>첨부 내역에서 원본 확인</small></span><ArrowUpRight size={16} aria-hidden="true" />
        </Link>)}
        {matchingFiles.length > 8 && <p className="py-3 text-sm text-muted">{matchingFiles.length}개 중 8개 표시 · 검색어를 더 입력해 주세요.</p>}
      </section>}
      {pages.length > 0 && <section key={'menus:' + text} className="motion-results" aria-label="메뉴 검색 결과"><h2 className="text-sm font-bold">바로가기</h2>{pages.map(item => <Link key={item.to} to={item.to} className="file-download mt-2" onClick={onClose}><ArrowUpRight size={18} aria-hidden="true" /><strong>{item.label}</strong></Link>)}</section>}
      {loading && <p className="py-3 text-sm text-muted" role="status">첨부 파일을 찾고 있습니다…</p>}
      {failed && <p className="py-3 text-sm text-muted" role="alert">일부 첨부 파일을 불러오지 못했습니다. <button type="button" className={buttonStyles.text} onClick={() => setRetry(value => value + 1)}>다시 시도</button></p>}
      {text && !loading && !failed && dashboard && !teams.length && !matchingFiles.length && !pages.length && <p className="motion-results py-3 text-sm text-muted">일치하는 팀·파일·메뉴가 없습니다.</p>}
    </div>
    <footer className="border-t border-line px-5 py-3 text-xs text-muted">Tab으로 이동 · Enter로 열기 · Esc로 닫기</footer>
  </dialog>;
}
