import { NavLink } from './workspaceNavigation';
import { useEvent } from '../context/EventContext';

/** 파일 첨부 화면의 세 갈래: 파일 첨부하기 · 팀별 파일 정리 · 첨부 내역 */
export default function IntakeTabs() {
  const { dashboard } = useEvent();
  const pending = dashboard?.batches.reduce((n, b) => n + (b.pending ?? 0), 0) ?? 0;
  const tabs: Array<[string, string, boolean]> = [
    ['/intake', '파일 첨부', true],
    ['/assign', '팀별 파일 정리', false],
    ['/intake/batches', '첨부 내역', false],
  ];
  return (
    <nav aria-label="파일 첨부" className="segments self-start">
      {tabs.map(([to, label, end]) => (
        <NavLink key={to} to={to} end={end} className="segment" data-tour={to === '/intake/batches' ? 'upload-history' : undefined}>
          {label}
          {to === '/assign' && pending > 0 && <span className="nav-count">{pending}<span className="sr-only">개 확인 필요</span></span>}
        </NavLink>
      ))}
    </nav>
  );
}
