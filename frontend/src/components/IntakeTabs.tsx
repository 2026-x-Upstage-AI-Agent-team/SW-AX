import { NavLink } from './workspaceNavigation';
import { teamAssignmentMenu, workflowLabels } from './workspaceMenu';
import { useEvent } from '../context/EventContext';

export default function IntakeTabs() {
  const { dashboard } = useEvent();
  const pending = dashboard?.batches.reduce((n, b) => n + (b.pending ?? 0), 0) ?? 0;
  const tabs: Array<[string, string, boolean]> = [
    ['/intake', workflowLabels.upload, true],
    ['/intake/batches', workflowLabels.progress, false],
    [teamAssignmentMenu.to, teamAssignmentMenu.label, false],
  ];
  return (
    <nav aria-label="서류 올리기와 검토 진행" className="segments self-start">
      {tabs.map(([to, label, end]) => (
        <NavLink key={to} to={to} end={end} className="segment" data-tour={to === '/intake/batches' ? 'upload-history' : undefined}>
          {label}
          {to === '/assign' && pending > 0 && <span className="nav-count">{pending}<span className="sr-only">개 확인 필요</span></span>}
        </NavLink>
      ))}
    </nav>
  );
}
