import type { ReactNode } from 'react';
import { Page } from './Layout';
import { PageHeader } from './ui';
import IntakeTabs from './IntakeTabs';

/** Keep the heading and tabs stationary across all document attachment views. */
export default function IntakeLayout({ children, replacement = false }: { children: ReactNode; replacement?: boolean }) {
  return <Page tone="gray" width="review">
    <PageHeader
      title={replacement ? '보완 서류 첨부' : '파일 첨부'}
      lead={replacement
        ? '교체할 원본에 저장한 수정본을 적용하거나 새로 받은 파일을 추가하세요. 첨부하면 같은 팀의 새 제출 버전으로 검토합니다.'
        : '한 팀의 서류를 함께 첨부하고, 팀별 파일 정리와 첨부 내역에서 진행 상태를 확인하세요.'}
    />
    {!replacement && <IntakeTabs />}
    {children}
  </Page>;
}
