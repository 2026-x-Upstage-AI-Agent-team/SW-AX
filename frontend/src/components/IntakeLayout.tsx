import type { ReactNode } from 'react';
import { Page } from './Layout';
import { PageHeader } from './ui';
import IntakeTabs from './IntakeTabs';
import { teamAssignmentMenu, workflowLabels } from './workspaceMenu';

const intakeCopy = {
  upload: { title: workflowLabels.upload, lead: '한 팀의 서류를 함께 올리면 AI가 검토를 시작합니다.' },
  progress: { title: workflowLabels.progress, lead: '올린 서류의 처리 상태를 확인하고, 검토가 끝나면 팀별 결과를 확인하세요.' },
  assignment: { title: teamAssignmentMenu.label, lead: '어느 팀의 서류인지 확인이 필요한 파일을 배정하세요.' },
  replacement: { title: '보완 서류 올리기', lead: '저장한 수정본을 적용하거나 새로 받은 서류를 올리면 같은 팀의 새 제출본으로 검토합니다.' },
} as const;

export default function IntakeLayout({ children, view = 'upload' }: { children: ReactNode; view?: keyof typeof intakeCopy }) {
  return <Page tone="gray" width="review">
    <PageHeader {...intakeCopy[view]} />
    {view !== 'replacement' && <IntakeTabs />}
    {children}
  </Page>;
}
