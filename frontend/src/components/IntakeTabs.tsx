import { NavLink } from 'react-router';
import { useEvent } from '../context/EventContext';

/** 문서 업로드 화면의 세 갈래: 접수하기 · 팀 배정 확인 · 접수 내역 */
export default function IntakeTabs() {
  const { dashboard } = useEvent();
  const pending = dashboard?.batches.reduce((n, b) => n + (b.pending ?? 0), 0) ?? 0;
  const tabs: Array<[string, string, boolean]> = [
    ['/intake', '접수하기', true],
    ['/assign', '팀 배정 확인', false],
    ['/intake/batches', '접수 내역', false],
  ];
  return (
    <nav aria-label="문서 업로드" className="segments self-start">
      {tabs.map(([to, label, end]) => (
        <NavLink key={to} to={to} end={end} className="segment">
          {label}
          {to === '/assign' && pending > 0 && <span className="nav-count">{pending}<span className="sr-only">개 확인 필요</span></span>}
        </NavLink>
      ))}
    </nav>
  );
}
