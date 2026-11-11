import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, useParams } from 'react-router';
import { ArrowLeft, ArrowRight, BookOpen, X } from 'lucide-react';
import { backend } from '../api/backend';
import { workspacePath } from '../api/workspaces';
import { buttonStyles } from './ui';
import { workflowLabels } from './workspaceMenu';

type TourControl = {
  active: boolean;
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
  { phase: 1, path: '/', target: 'nav-upload', title: '한 팀의 서류를 올려 보세요.',
    text: `왼쪽 메뉴의 ‘${workflowLabels.upload}’를 누르세요. 한 팀씩 올리면 서류가 같은 팀으로 묶여요.`, hint: '파일 없이도 ‘다음 안내’로 사용 순서를 둘러볼 수 있어요.' },
  { phase: 1, path: '/intake', target: 'file-picker', title: '한 팀의 서류를 함께 선택하세요.',
    text: `‘${workflowLabels.choose}’을 눌러 신청서(01), 개인정보 동의서(02), 대표 증빙(03)을 함께 선택하세요. 파일을 끌어 놓아도 돼요.`, hint: 'HWP·HWPX 파일을 올릴 수 있어요. 00 지급내역서는 제외해 주세요.' },
  { phase: 1, path: '/intake', target: 'upload-submit', title: '선택한 서류를 올려 보세요.',
    text: `목록을 확인한 뒤 ‘${workflowLabels.submit}’를 누르세요. 서류를 저장하고 검토를 시작해요.`, hint: '파일을 고르지 않았다면 ‘다음 단계’로 진행 화면을 먼저 살펴볼 수 있어요.' },
  { phase: 2, path: '/intake/batches', target: 'upload-history', title: '서류가 어디까지 검토됐는지 확인하세요.',
    text: `‘${workflowLabels.progress}’에서 올린 서류의 상태를 확인하세요. 올린 직후에는 ‘${workflowLabels.progressAction}’로 해당 묶음의 상세를 열 수 있어요.`, hint: `검토가 끝나면 ‘${workflowLabels.review}’ 버튼이 나타나요. 소속 팀 확인이 필요한 파일은 ‘팀 배정 확인’에 표시돼요.` },
  { phase: 3, path: '/review', target: 'nav-review', title: '팀별 검토 결과를 확인하세요.',
    text: `‘${workflowLabels.review}’에서 팀을 고르세요. 원문을 확인하고 ‘서류 승인’ 또는 ‘보완 필요’를 선택한 뒤 ‘${workflowLabels.saveReview}’을 누르세요.`, hint: `보완이 필요한 팀은 상세 화면의 ‘${workflowLabels.mailAction}’에서 팀장에게 보낼 내용을 확인할 수 있어요.` },
  { phase: 4, path: '/report', target: 'nav-report', title: '지급 보고서를 만들어 보세요.',
    text: `‘${workflowLabels.report}’에서 승인한 팀의 지급 정보를 입력하고 ‘${workflowLabels.reportAction}’를 누르세요. 미리보기를 확인한 뒤 확정하면 HWPX·PDF를 내려받을 수 있어요.`, hint: '사용 순서를 모두 살펴봤어요. 첫 팀의 서류를 올려 보세요.' },
] as const;
const phaseCount = steps.at(-1)!.phase;

type Rect = { top: number; left: number; width: number; height: number };
type Placement = {
  name: string; rect: Rect | null; lastRect: Rect | null; target: HTMLElement | null;
  width: number; height: number; pending: boolean; busy: boolean;
};

function visibleTarget(name: string) {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`)).find(element => {
    if (element.closest('[inert]')) return false;
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
      if (stored !== null && /^[0-6]$/.test(stored)) {
        // The previous guide had a separate mail step before the report.
        const index = Number(stored) === 6 ? steps.length - 1 : Number(stored);
        const expected = workspacePath(workspaceId, steps[index].path, categoryId);
        if (pathname.replace(/\/$/, '') === expected.replace(/\/$/, '')
          || (index === 3 && pathname.startsWith(expected + '/'))
          || (index === 4 && pathname.startsWith(workspacePath(workspaceId, '/teams/', categoryId)))) return index;
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
    if (step === 3 && (pathname === workspacePath(workspaceId, '/review', categoryId)
      || pathname.startsWith(workspacePath(workspaceId, '/teams/', categoryId)))) setStep(4);
    if ((step === 1 || step === 2) && pathname.replace(/\/$/, '') === root.replace(/\/$/, '')) setStep(0);
  }, [step, pathname, workspaceId, categoryId, root]);

  function start() {
    const upload = document.querySelector<HTMLElement>('[data-tour="upload-form"]');
    if (upload?.dataset.tourPending === 'true' || upload?.dataset.tourBusy === 'true') {
      closeMenu();
      setStep(1);
    } else move(0);
  }

  return <TourContext.Provider value={{ active: step !== null, start, menuDialog, menuOpen, openMenu, closeMenu }}>
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
  const location = useLocation();
  const card = useRef<HTMLDivElement>(null);
  const [cardHeight, setCardHeight] = useState(290);
  const [placement, setPlacement] = useState<Placement>({
    name: '', rect: null, lastRect: null, target: null,
    width: document.documentElement.clientWidth, height: window.innerHeight, pending: false, busy: false,
  });
  const mobileNav = item.target.startsWith('nav-') && !window.matchMedia('(min-width: 60rem)').matches;
  const needsMenu = mobileNav && !menuOpen;
  const targetName = needsMenu ? 'menu-open' : item.target;
  const receipt = item.phase === 2 && Boolean(location.state?.uploaded);
  const matchesTarget = placement.name === targetName || (receipt && placement.name === 'upload-receipt');
  const target = matchesTarget && placement.rect ? placement.target : null;
  const displayedTarget = target ? placement.name : targetName;

  useLayoutEffect(() => {
    let frame = 0;
    let checked: HTMLElement | null = null;
    const measure = () => {
      const receiptAction = receipt ? visibleTarget('upload-receipt') : null;
      const name = receiptAction ? 'upload-receipt' : targetName;
      const target = receiptAction ?? visibleTarget(targetName);
      const upload = document.querySelector<HTMLElement>('[data-tour="upload-form"]');
      const width = document.documentElement.clientWidth;
      const height = window.innerHeight;
      let bounds = target?.getBoundingClientRect();
      if (target && bounds && checked !== target) {
        checked = target;
        const body = target.closest('.workspace-body');
        const topEdge = body
          ? Math.max(body.querySelector('.workspace-toolbar')?.getBoundingClientRect().bottom ?? 0,
            document.querySelector('.mobile-bar')?.getBoundingClientRect().bottom ?? 0)
          : 0;
        if (bounds.top < topEdge || bounds.bottom > height) {
          target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
          bounds = target.getBoundingClientRect();
        }
      }
      const rect = bounds && bounds.right > 4 && bounds.left < width - 4 && bounds.bottom > 4 && bounds.top < height - 4
        ? { top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height } : null;
      const pending = upload?.dataset.tourPending === 'true';
      const busy = upload?.dataset.tourBusy === 'true';
      setPlacement(current => current.name === name && current.target === target && current.width === width && current.height === height
        && current.pending === pending && current.busy === busy && JSON.stringify(current.rect) === JSON.stringify(rect)
        ? current : { name, rect, lastRect: rect ?? current.lastRect, target, width, height, pending, busy });
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const onResize = () => { checked = null; schedule(); };
    measure();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', schedule, true);
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'inert', 'data-tour-pending', 'data-tour-busy'] });
    const resize = new ResizeObserver(onResize);
    resize.observe(document.body);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', onResize); window.removeEventListener('scroll', schedule, true); observer.disconnect(); resize.disconnect(); };
  }, [targetName, menuOpen, receipt]);

  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    const copy = element.querySelector<HTMLElement>('.tour-copy');
    if (copy) copy.scrollTop = 0;
    const measureCard = () => {
      setCardHeight(Math.ceil(element.scrollHeight + Math.max(0, (copy?.scrollHeight ?? 0) - (copy?.clientHeight ?? 0)) + 2));
    };
    measureCard();
    const resize = new ResizeObserver(measureCard);
    resize.observe(element);
    return () => resize.disconnect();
  }, [step, menuOpen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(card.current?.querySelectorAll<HTMLElement>('button:not(:disabled), .tour-copy[tabindex]') ?? []);
      if (target?.matches('a[href], button:not(:disabled), select:not(:disabled)')) controls.unshift(target);
      if (!controls.length) return;
      const current = controls.indexOf(document.activeElement as HTMLElement);
      const next = (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
      event.preventDefault();
      controls[next].focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [finish, target]);

  const { width, height, pending, busy } = placement;
  const gap = 12;
  const clampEdge = (value: number, size: number) => Math.max(4, Math.min(value, size - 4));
  const paddedRect = (rect: Rect) => ({
    left: clampEdge(rect.left - 6, width), top: clampEdge(rect.top - 6, height),
    right: clampEdge(rect.left + rect.width + 6, width), bottom: clampEdge(rect.top + rect.height + 6, height),
  });
  const hole = target && placement.rect ? paddedRect(placement.rect) : null;
  // Preserve the card's anchor while a route is loading its next target.
  const anchor = hole ?? (placement.lastRect ? paddedRect(placement.lastRect) : null);
  const cardWidth = Math.min(360, width - 24);
  let left = (width - cardWidth) / 2;
  let top = Math.max(gap, (height - cardHeight) / 2);
  let maxCardHeight = height - gap * 2;
  let side = 'center';
  if (anchor) {
    const centerX = (anchor.left + anchor.right) / 2;
    const centerY = (anchor.top + anchor.bottom) / 2;
    if (width - anchor.right >= cardWidth + gap * 2) {
      left = anchor.right + gap;
      top = centerY - Math.min(cardHeight, maxCardHeight) / 2;
      side = 'right';
    }
    else if (anchor.left >= cardWidth + gap * 2) {
      left = anchor.left - cardWidth - gap;
      top = centerY - Math.min(cardHeight, maxCardHeight) / 2;
      side = 'left';
    }
    else {
      // Above/below bubbles follow the target horizontally, including right-aligned buttons.
      left = centerX - cardWidth / 2;
      const above = anchor.top - gap * 2;
      const below = height - anchor.bottom - gap * 2;
      side = above >= cardHeight || (below < cardHeight && above > below) ? 'above' : 'below';
      maxCardHeight = Math.max(196, side === 'above' ? above : below);
      top = side === 'above' ? anchor.top - Math.min(cardHeight, maxCardHeight) - gap : anchor.bottom + gap;
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

  const content = <div className="workspace-tour" data-tour-step={item.phase} data-tour-target={displayedTarget}>
    {hole ? <>
      <div className="tour-shade" style={{ inset: `0 0 ${height - hole.top}px 0` }} />
      <div className="tour-shade" style={{ top: hole.bottom, bottom: 0, left: 0, right: 0 }} />
      <div className="tour-shade" style={{ top: hole.top, height: hole.bottom - hole.top, left: 0, width: hole.left }} />
      <div className="tour-shade" style={{ top: hole.top, height: hole.bottom - hole.top, left: hole.right, right: 0 }} />
      <div key={displayedTarget} className="tour-spotlight" data-target={displayedTarget} style={{ top: hole.top, left: hole.left, width: hole.right - hole.left, height: hole.bottom - hole.top }} />
    </> : <div className="tour-shade" style={{ inset: 0 }} />}
    {hole && <div key={displayedTarget} className="tour-arrow" aria-hidden="true" style={side === 'right' || side === 'left'
      ? { left: side === 'right' ? left - 6 : left + cardWidth - 6, top: Math.max(top + 24, Math.min(hole.top + (hole.bottom - hole.top) / 2 - 6, top + Math.min(cardHeight, maxCardHeight) - 24)) }
      : { left: Math.max(left + 24, Math.min(hole.left + (hole.right - hole.left) / 2 - 6, left + cardWidth - 24)), top: side === 'above' ? top + Math.min(cardHeight, maxCardHeight) - 6 : top - 6 }} />}
    <div ref={card} className="tour-card" role="dialog" aria-label="워크스페이스 시작 가이드" aria-describedby="tour-description" tabIndex={-1}
      data-side={side} style={{ top, left, width: cardWidth, maxHeight: maxCardHeight }}>
      <div className="tour-topline"><span><BookOpen size={14} aria-hidden="true" />시작 가이드 · {item.phase} / {phaseCount}</span>
        <button type="button" onClick={finish} className="tour-exit">가이드 종료<X size={14} aria-hidden="true" /></button></div>
      <div className="tour-progress" aria-hidden="true">{Array.from({ length: phaseCount }, (_, index) => <span key={index} className={index < item.phase ? 'is-visited' : ''} />)}</div>
      <div className="tour-copy" role="region" aria-label="현재 단계 안내" tabIndex={0}>
        <div key={step + ':' + targetName} className="tour-copy-content">
          <h2>{needsMenu ? '오른쪽 위 메뉴를 열어 주세요.' : item.title}</h2>
          <p id="tour-description">{needsMenu ? '작업 메뉴를 열면 다음에 눌러야 할 버튼을 강조해 드릴게요.' : item.text}</p>
          <p className="tour-hint">{guard ? '선택한 파일이 있어요. 첨부를 마친 뒤 계속하거나 가이드를 종료하고 작업을 이어가세요.' : item.hint}</p>
        </div>
      </div>
      <footer>
        <button type="button" className={buttonStyles.text} onClick={() => move(step - 1)} disabled={step === 0 || previousBlocked}><ArrowLeft size={15} aria-hidden="true" />이전</button>
        <button type="button" className={buttonStyles.primary} onClick={next} disabled={nextBlocked}>
          {needsMenu ? '메뉴 열기' : step === steps.length - 1 ? '서류 올리기 시작' : steps[step + 1].phase === item.phase ? '다음 안내' : '다음 단계'}<ArrowRight size={15} aria-hidden="true" />
        </button>
      </footer>
    </div>
  </div>;
  return createPortal(content, menuOpen && menuDialog.current ? menuDialog.current : document.body);
}
