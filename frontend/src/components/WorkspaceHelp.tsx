import { useId, useRef } from 'react';
import { ArrowUpRight, BookOpen, MessageSquare } from 'lucide-react';

const developerIssues = 'https://github.com/2026-x-Upstage-AI-Agent-team/SW-AX/issues';

export default function WorkspaceHelp({ onStartGuide }: { onStartGuide: () => void }) {
  const panelId = useId();
  const panel = useRef<HTMLDivElement>(null);

  return <>
    <button type="button" className="workspace-help-button" popoverTarget={panelId}
      aria-label="도움말 열기" title="도움말">
      <span aria-hidden="true">?</span>
    </button>
    <div id={panelId} ref={panel} popover="auto" className="surface workspace-help-panel"
      role="group" aria-label="도움말">
      <button type="button" className="nav-item w-full" onClick={() => {
        panel.current?.hidePopover();
        onStartGuide();
      }}>
        <BookOpen size={19} aria-hidden="true" />시작 가이드
      </button>
      <a href={developerIssues} target="_blank" rel="noopener noreferrer"
        className="nav-item" onClick={() => panel.current?.hidePopover()}>
        <MessageSquare size={19} aria-hidden="true" />
        <span>개발자에게 문의하기<small className="block text-xs text-muted">공개 GitHub Issues · 새 탭</small></span>
        <ArrowUpRight size={16} className="ml-auto" aria-hidden="true" />
      </a>
    </div>
  </>;
}
