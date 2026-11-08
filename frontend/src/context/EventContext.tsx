import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useApi } from '../api/client';
import { paths, type AwardEvent, type AwardTeam } from '../api/intake';

type EventState = {
  events?: AwardEvent[];
  eventsError?: string;
  event?: AwardEvent;
  selectEvent: (id: string) => void;
  teams?: AwardTeam[];
  teamsError?: string;
  /** 대회·팀·접수 목록을 다시 조회한다. */
  refresh: () => void;
  revision: number;
};

const EventContext = createContext<EventState | null>(null);
const STORAGE_KEY = 'swax.event';

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function EventProvider({ children }: { children: ReactNode }) {
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState(readStored);
  const events = useApi<AwardEvent[]>(paths.events, revision);
  const event = events.data?.find((e) => e.id === selected) ?? events.data?.[0];
  const teams = useApi<AwardTeam[]>(event ? paths.teams(event.id) : null, revision);

  useEffect(() => {
    if (!event) return;
    try {
      localStorage.setItem(STORAGE_KEY, event.id);
    } catch {
      /* 저장소를 쓸 수 없어도 화면은 동작한다 */
    }
  }, [event]);

  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  const value = useMemo<EventState>(
    () => ({
      events: events.data,
      eventsError: events.error,
      event,
      selectEvent: setSelected,
      teams: teams.data,
      teamsError: teams.error,
      refresh,
      revision,
    }),
    [events.data, events.error, event, teams.data, teams.error, refresh, revision],
  );
  return <EventContext.Provider value={value}>{children}</EventContext.Provider>;
}

export function useEvent() {
  const ctx = useContext(EventContext);
  if (!ctx) throw new Error('useEvent must be used inside EventProvider');
  return ctx;
}
