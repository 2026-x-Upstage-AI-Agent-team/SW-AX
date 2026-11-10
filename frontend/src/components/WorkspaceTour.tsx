import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, useParams } from 'react-router';
import { ArrowLeft, ArrowRight, BookOpen, X } from 'lucide-react';
import { backend } from '../api/backend';
import { workspacePath } from '../api/workspaces';
import { buttonStyles } from './ui';

type TourControl = {
  start: () => void;
  menuDialog: RefObject<HTMLDialogElement | null>;
  menuOpen: boolean;
  openMenu: () => void;
  closeMenu: () => void;
};
const TourContext = createContext<TourControl | null>(null);
export function useWorkspaceTour() {
  const value = useContext(TourContext);
  if (!value) throw new Error('WorkspaceTourProvider is required');
  return value;
}

const steps = [
  { path: '/', target: 'nav-upload', title: '먼저, 파일 첨부를 눌러 주세요.',
    text: '여기에서 한 팀의 서류를 함께 올릴 수 있어요. 강조된 메뉴를 누르면 다음 안내로 이어져요.', hint: '파일 없이도 ‘다음 단계’로 사용 순서를 둘러볼 수 있어요.' },
  { path: '/intake', target: 'file-picker', title: '한 팀의 서류를 함께 선택하세요.',
    text: '이 영역을 눌러 신청서(01), 개인정보 동의서(02), 대표 증빙(03)을 선택하세요. 파일을 끌어 놓아도 돼요.', hint: 'HWP·HWPX를 지원해요. 00 지급내역서는 첨부하지 않아요.' },
  { path: '/intake', target: 'upload-submit', title: '선택한 파일을 확인하고 첨부하세요.',
    text: '목록을 확인한 뒤 ‘파일 첨부하기’를 누르면 서류 판독과 자동 검토가 시작돼요. 다음 팀도 같은 순서로 올리면 돼요.', hint: '아직 파일을 고르지 않았다면 ‘다음 단계’로 나머지 화면을 둘러보세요.' },
  { path: '/intake/batches', target: 'upload-history', title: '첨부한 서류의 처리 상태를 확인하세요.',
    text: '‘첨부 내역’에서 첨부번호를 누르면 판독·검토 진행 상태를 볼 수 있어요. 소속 팀을 확인할 파일이 있으면 ‘팀별 파일 정리’를 이용하세요.', hint: '판독 중에는 같은 서류를 다시 첨부하지 않아도 돼요.' },
  { path: '/', target: 'nav-dashboard', title: '검토가 끝나면 결과를 확인하세요.',
    text: '‘업무 현황’의 팀별 판정에서 ‘검토 열기’를 누르세요. 원문과 근거를 대조한 뒤 승인 또는 보완 필요를 선택하고 ‘결론 기록’을 눌러요.', hint: '보완이 필요하면 해당 팀의 검토 화면에서 보완 서류를 첨부할 수 있어요.' },
  { path: '/mail', target: 'nav-mail', title: '필요한 팀장 안내를 확인하세요.',
    text: '목록에서 메일을 선택해 오른쪽에서 수신자와 내용을 확인하세요. 수정했다면 ‘초안 저장’을 누르고, 준비가 되면 ‘승인 후 발송’으로 안내해요.', hint: '안내가 필요한 경우 진행해요. 실제 Gmail 발송은 ‘Gmail 연결’이 필요해요.' },
  { path: '/report', target: 'nav-report', title: '마지막으로 보고서를 만들어요.',
    text: '승인한 팀의 지급 정보를 저장하고 ‘미리보기 생성’을 누르세요. 내용을 확인해 ‘이 버전으로 확정’하면 HWPX·PDF를 내려받을 수 있어요.', hint: '사용 순서를 모두 살펴봤어요. 이제 첫 팀의 파일 첨부부터 시작해 보세요.' },
];

type Rect = { top: number; left: number; width: number; height: number };
type Placement = { rect: Rect | null; target: HTMLElement | null; width: number; height: number; pending: boolean; busy: boolean };

function visibleTarget(name: string) {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`)).find(element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0;
  }) ?? null;
}

export function WorkspaceTourProvider({ children }: { children: ReactNode }) {
  const { workspaceId = '', categoryId = 'awards' } = useParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const root = workspacePath(workspaceId, '/', categoryId);
  const storageKey = `swax.workspace-tour.v1.${backend}.${workspaceId}`;
  const observedPath = useRef(pathname);
  const [step, setStep] = useState<number | null>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored === 'done') return null;
      if (stored !== null && /^\d+$/.test(stored) && Number(stored) < steps.length) {
        const index = Number(stored);
        const expected = workspacePath(workspaceId, steps[index].path, categoryId);
        if (pathname.replace(/\/$/, '') === expected.replace(/\/$/, '')
          || (index === 3 && pathname.startsWith(expected + '/'))) return index;
      }
    } catch { /* A tour can also run without browser storage. */ }
    return pathname.replace(/\/$/, '') === root.replace(/\/$/, '') ? 0 : null;
  });
  const menuDialog = useRef<HTMLDialogElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const openMenu = useCallback(() => {
    if (menuDialog.current && !menuDialog.current.open) menuDialog.current.showModal();
    setMenuOpen(true);
  }, []);
  const closeMenu = useCallback(() => {
    menuDialog.current?.close();
    setMenuOpen(false);
  }, []);
  const move = useCallback((index: number) => {
    closeMenu();
    setStep(index);
    const next = workspacePath(workspaceId, steps[index].path, categoryId);
    if (next !== pathname) navigate(next);
  }, [categoryId, workspaceId, pathname, navigate, closeMenu]);
  const finish = useCallback(() => {
    setStep(null);
    closeMenu();
    try { localStorage.setItem(storageKey, 'done'); } catch { /* Optional preference. */ }
    requestAnimationFrame(() => document.getElementById('workspace-content')?.focus({ preventScroll: true }));
  }, [storageKey, closeMenu]);

  useEffect(() => {
    if (step !== null) {
      try { localStorage.setItem(storageKey, String(step)); } catch { /* Optional progress. */ }
    }
  }, [step, storageKey]);
  useEffect(() => {
    // Step controls can render before React Router commits the destination.
    // Only actual route changes should advance the tour after a target click.
    if (observedPath.current === pathname) return;
    observedPath.current = pathname;
    if (step === 0 && pathname === workspacePath(workspaceId, '/intake', categoryId)) setStep(1);
    if ((step === 1 || step === 2) && pathname.startsWith(workspacePath(workspaceId, '/intake/batches/', categoryId))) setStep(3);
    if ((step === 1 || step === 2) && pathname.replace(/\/$/, '') === root.replace(/\/$/, '')) setStep(0);
  }, [step, pathname, workspaceId, categoryId, root]);

  function start() {
    const upload = document.querySelector<HTMLElement>('[data-tour="upload-form"]');
    if (upload?.dataset.tourPending === 'true' || upload?.dataset.tourBusy === 'true') {
      closeMenu();
      setStep(1);
    } else move(0);
  }

  return <TourContext.Provider value={{ start, menuDialog, menuOpen, openMenu, closeMenu }}>
    {children}
    {step !== null && <TourOverlay key={storageKey} step={step} move={move} finish={finish} menuOpen={menuOpen} menuDialog={menuDialog} openMenu={openMenu}
      complete={() => { finish(); navigate(workspacePath(workspaceId, '/intake', categoryId)); }} />}
  </TourContext.Provider>;
}

function TourOverlay({ step, move, finish, menuOpen, menuDialog, openMenu, complete }: {
  step: number; move: (index: number) => void; finish: () => void; menuOpen: boolean;
  menuDialog: RefObject<HTMLDialogElement | null>; openMenu: () => void; complete: () => void;
}) {
  const item = steps[step];
  const card = useRef<HTMLDivElement>(null);
  const [cardHeight, setCardHeight] = useState(290);
  const [placement, setPlacement] = useState<Placement>({ rect: null, target: null, width: window.innerWidth, height: window.innerHeight, pending: false, busy: false });
  const mobileNav = item.target.startsWith('nav-') && !window.matchMedia('(min-width: 60rem)').matches;
  const needsMenu = mobileNav && !menuOpen;
  const targetName = needsMenu ? 'menu-open' : item.target;

  useLayoutEffect(() => {
    let frame = 0;
    let scrolled: HTMLElement | null = null;
    const measure = () => {
      const target = visibleTarget(targetName);
      const upload = document.querySelector<HTMLElement>('[data-tour="upload-form"]');
      if (target && scrolled !== target) {
        scrolled = target;
        target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      }
      const bounds = target?.getBoundingClientRect();
      const rect = bounds ? { top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height } : null;
      const next = { rect, target, width: window.innerWidth, height: window.innerHeight, pending: upload?.dataset.tourPending === 'true', busy: upload?.dataset.tourBusy === 'true' };
      setPlacement(current => current.target === next.target && current.width === next.width && current.height === next.height
        && current.pending === next.pending && current.busy === next.busy && JSON.stringify(current.rect) === JSON.stringify(rect) ? current : next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    measure();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'data-tour-pending', 'data-tour-busy'] });
    const resize = new ResizeObserver(schedule);
    resize.observe(document.body);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); observer.disconnect(); resize.disconnect(); };
  }, [targetName, menuOpen]);

  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    const resize = new ResizeObserver(() => {
      const copy = element.querySelector<HTMLElement>('.tour-copy');
      setCardHeight(Math.ceil(element.scrollHeight + Math.max(0, (copy?.scrollHeight ?? 0) - (copy?.clientHeight ?? 0)) + 2));
    });
    resize.observe(element);
    return () => resize.disconnect();
  }, [step, menuOpen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(card.current?.querySelectorAll<HTMLElement>('button:not(:disabled), .tour-copy[tabindex]') ?? []);
      const target = placement.target;
      if (target?.matches('a[href], button:not(:disabled), select:not(:disabled)')) controls.unshift(target);
      if (!controls.length) return;
      const current = controls.indexOf(document.activeElement as HTMLElement);
      const next = (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
      event.preventDefault();
      controls[next].focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [finish, placement.target]);

  const { rect, width, height, pending, busy } = placement;
  const gap = 12;
  const hole = rect ? {
    left: Math.max(4, rect.left - 6), top: Math.max(4, rect.top - 6),
    right: Math.min(width - 4, rect.left + rect.width + 6), bottom: Math.min(height - 4, rect.top + rect.height + 6),
  } : null;
  const cardWidth = Math.min(360, width - 24);
  let left = (width - cardWidth) / 2;
  let top = Math.max(gap, (height - cardHeight) / 2);
  let maxCardHeight = height - gap * 2;
  let side = 'center';
  if (hole) {
    if (width - hole.right >= cardWidth + gap * 2) { left = hole.right + gap; top = hole.top; side = 'right'; }
    else {
      const above = hole.top - gap * 2;
      const below = height - hole.bottom - gap * 2;
      side = above >= cardHeight || (below < cardHeight && above > below) ? 'above' : 'below';
      maxCardHeight = Math.max(196, side === 'above' ? above : below);
      top = side === 'above' ? hole.top - Math.min(cardHeight, maxCardHeight) - gap : hole.bottom + gap;
    }
    left = Math.max(gap, Math.min(left, width - cardWidth - gap));
    top = Math.max(gap, Math.min(top, height - Math.min(cardHeight, maxCardHeight) - gap));
  }
  const guard = pending && (step === 1 || step === 2);
  const previousBlocked = busy || (pending && step === 1);
  const nextBlocked = busy || (pending && step === 2);

  function next() {
    if (needsMenu) { openMenu(); return; }
    if (step === steps.length - 1) { complete(); return; }
    move(step + 1);
  }

  const content = <div className="workspace-tour" data-tour-step={step + 1}>
    {hole ? <>
      <div className="tour-shade" style={{ inset: `0 0 ${height - hole.top}px 0` }} />
      <div className="tour-shade" style={{ top: hole.bottom, bottom: 0, left: 0, right: 0 }} />
      <div className="tour-shade" style={{ top: hole.top, height: hole.bottom - hole.top, left: 0, width: hole.left }} />
      <div className="tour-shade" style={{ top: hole.top, height: hole.bottom - hole.top, left: hole.right, right: 0 }} />
      <div className="tour-spotlight" data-target={targetName} style={{ top: hole.top, left: hole.left, width: hole.right - hole.left, height: hole.bottom - hole.top }} />
    </> : <div className="tour-shade" style={{ inset: 0 }} />}
    {hole && <div className="tour-arrow" aria-hidden="true" style={side === 'right'
      ? { left: left - 6, top: Math.max(top + 24, Math.min(hole.top + (hole.bottom - hole.top) / 2 - 6, top + Math.min(cardHeight, maxCardHeight) - 24)) }
      : { left: Math.max(left + 24, Math.min(hole.left + (hole.right - hole.left) / 2 - 6, left + cardWidth - 24)), top: side === 'above' ? top + Math.min(cardHeight, maxCardHeight) - 6 : top - 6 }} />}
    <div ref={card} className="tour-card" role="dialog" aria-label="워크스페이스 시작 가이드" aria-describedby="tour-description" tabIndex={-1}
      data-side={side} style={{ top, left, width: cardWidth, maxHeight: maxCardHeight }}>
      <div className="tour-topline"><span><BookOpen size={14} aria-hidden="true" />시작 가이드 · {step + 1} / {steps.length}</span>
        <button type="button" onClick={finish} className="tour-exit">가이드 종료<X size={14} aria-hidden="true" /></button></div>
      <div className="tour-progress" aria-hidden="true">{steps.map((_, index) => <span key={index} className={index <= step ? 'is-visited' : ''} />)}</div>
      <div className="tour-copy" role="region" aria-label="현재 단계 안내" tabIndex={0}>
        <h2>{needsMenu ? '오른쪽 위 메뉴를 열어 주세요.' : item.title}</h2>
        <p id="tour-description">{needsMenu ? '작업 메뉴를 열면 다음에 눌러야 할 버튼을 강조해 드릴게요.' : item.text}</p>
        <p className="tour-hint">{guard ? '선택한 파일이 있어요. 첨부를 마친 뒤 계속하거나 가이드를 종료하고 작업을 이어가세요.' : item.hint}</p>
      </div>
      <footer>
        <button type="button" className={buttonStyles.text} onClick={() => move(step - 1)} disabled={step === 0 || previousBlocked}><ArrowLeft size={15} aria-hidden="true" />이전</button>
        <button type="button" className={buttonStyles.primary} onClick={next} disabled={nextBlocked}>
          {needsMenu ? '메뉴 열기' : step === steps.length - 1 ? '파일 첨부 시작하기' : '다음 단계'}<ArrowRight size={15} aria-hidden="true" />
        </button>
      </footer>
    </div>
  </div>;
  return createPortal(content, menuOpen && menuDialog.current ? menuDialog.current : document.body);
}

export default function WorkspaceGuideStart() {
  const { start } = useWorkspaceTour();
  return <button type="button" onClick={start} className={buttonStyles.text}><BookOpen size={16} aria-hidden="true" />시작 가이드</button>;
}
