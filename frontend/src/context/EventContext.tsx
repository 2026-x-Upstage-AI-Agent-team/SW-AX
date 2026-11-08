import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { backend, reviewLive } from '../api/backend';
import { useApi, useAsync, usePolling } from '../api/client';
import { paths, type AwardEvent, type AwardTeam } from '../api/intake';
import { busyStates } from '../api/labels';
import { getDashboard, type Dashboard } from '../api/service';

type EventState = {
  events?: AwardEvent[];
  eventsError?: string;
  event?: AwardEvent;
  selectEvent: (id: string) => void;
  teams?: AwardTeam[];
  teamsError?: string;
  /** 검토 서비스 현황(연결 전이면 예시 데이터) */
  dashboard?: Dashboard;
  dashboardError?: string;
  /** 대회·팀·접수·현황을 다시 조회한다. */
  refresh: () => void;
  revision: number;
};

const EventContext = createContext<EventState | null>(null);
const STORAGE_KEY = 'swax.event.' + backend;
const SERVICE_DEFAULT_EVENT = 'wave';

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function isBusy(d?: Dashboard) {
  if (!d) return false;
  return (
    d.batches.some((b) => b.state === 'preparing') ||
    d.teams.some((t) => t.submission && busyStates.has(t.submission.state)) ||
    d.reports.some((r) => r.state === 'queued' || r.state === 'building') ||
    d.mail.some((m) => m.state === 'waiting' || m.state === 'sending')
  );
}

export function EventProvider({ children }: { children: ReactNode }) {
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState(readStored);
  const refresh = useCallback(() => setRevision((v) => v + 1), []);

  // Spring Boot 접수 API
  const springEvents = useApi<AwardEvent[]>(backend === 'intake' ? paths.events : null, revision);
  const springEvent = springEvents.data?.find((e) => e.id === selected) ?? springEvents.data?.[0];
  const springTeams = useApi<AwardTeam[]>(backend === 'intake' && springEvent ? paths.teams(springEvent.id) : null, revision);

  // 검토 서비스 현황 (연결 전에는 예시 데이터)
  const dashEvent = reviewLive ? selected || SERVICE_DEFAULT_EVENT : SERVICE_DEFAULT_EVENT;
  const dash = useAsync(() => getDashboard(dashEvent), [dashEvent, revision]);

  useEffect(() => {
    // 저장해 둔 대회가 사라졌으면 기본 대회로 돌아간다.
    if (reviewLive && dash.error && !dash.data && selected && selected !== SERVICE_DEFAULT_EVENT) setSelected(SERVICE_DEFAULT_EVENT);
  }, [dash.error, dash.data, selected]);

  usePolling(reviewLive && isBusy(dash.data), refresh);

  const events = reviewLive ? dash.data?.events : springEvents.data;
  const event = reviewLive ? dash.data?.events.find((e) => e.id === dash.data?.event) : springEvent;
  const serviceTeams = useMemo(() => dash.data?.teams.map(({ id, name, rep }) => ({ id, name, rep })), [dash.data]);
  const teams = reviewLive ? serviceTeams : springTeams.data;

  useEffect(() => {
    if (!event) return;
    try {
      localStorage.setItem(STORAGE_KEY, event.id);
    } catch {
      /* 저장소를 쓸 수 없어도 화면은 동작한다 */
    }
  }, [event]);

  const value = useMemo<EventState>(
    () => ({
      events,
      eventsError: reviewLive ? dash.error : springEvents.error,
      event,
      selectEvent: setSelected,
      teams,
      teamsError: reviewLive ? dash.error : springTeams.error,
      dashboard: dash.data,
      dashboardError: dash.error,
      refresh,
      revision,
    }),
    [events, event, teams, dash.data, dash.error, springEvents.error, springTeams.error, refresh, revision],
  );
  return <EventContext.Provider value={value}>{children}</EventContext.Provider>;
}

export function useEvent() {
  const ctx = useContext(EventContext);
  if (!ctx) throw new Error('useEvent must be used inside EventProvider');
  return ctx;
}
