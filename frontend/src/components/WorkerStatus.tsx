import { useCallback, useEffect, useRef, useState } from 'react';
import { isDemoBackend } from '../api/backend';
import { api } from '../api/client';

const labels = { loading: '확인 중', stopped: '실행 필요', starting: '시작 중…', running: '실행 중', unknown: '확인 불가' };
type State = keyof typeof labels;
type WorkerReply = { state: 'stopped' | 'starting' | 'running'; managed?: boolean };
const statusPath = '/api/operations/worker-status';

function stateOf(reply: WorkerReply) {
  if (!['stopped', 'starting', 'running'].includes(reply.state)) throw new Error('워커 상태를 확인할 수 없습니다.');
  return reply.state;
}

export function useWorkerControl() {
  const [state, setState] = useState<State>('loading');
  const [message, setMessage] = useState('');
  const [managed, setManaged] = useState(false);
  const [posting, setPosting] = useState(false);
  const [revision, setRevision] = useState(0);
  const startPending = useRef(false);
  const refresh = useCallback(() => setRevision(n => n + 1), []);

  useEffect(() => {
    if (isDemoBackend || posting) return;
    let active = true;
    let reading = false;
    let timer: number;
    const read = async () => {
      if (reading || document.hidden) return;
      reading = true;
      let delay = 15000;
      try {
        const reply = await api<WorkerReply>(statusPath, { signal: AbortSignal.timeout(8000) });
        const next = stateOf(reply);
        if (active && !startPending.current) {
          setManaged(Boolean(reply.managed));
          setState(next);
          if (next === 'running') setMessage('');
          if (next === 'starting') delay = 1500;
        }
      } catch {
        if (active && !startPending.current) setState('unknown');
      } finally {
        reading = false;
        if (active) {
          window.clearTimeout(timer);
          timer = window.setTimeout(read, delay);
        }
      }
    };
    void read();
    document.addEventListener('visibilitychange', read);
    return () => { active = false; window.clearTimeout(timer); document.removeEventListener('visibilitychange', read); };
  }, [posting, revision]);

  async function start() {
    if (startPending.current || state !== 'stopped') return;
    startPending.current = true;
    setPosting(true);
    setState('starting');
    setMessage('');
    try {
      setState(stateOf(await api<WorkerReply>('/api/operations/worker-start', { method: 'POST', signal: AbortSignal.timeout(25000) })));
    } catch (error) {
      setState('unknown');
      setMessage(error instanceof Error ? error.message : '워커를 실행할 수 없습니다.');
    } finally {
      startPending.current = false;
      setPosting(false);
      refresh();
    }
  }

  return { state, message, start, refresh, managed };
}

export default function WorkerStatus({ control }: { control: ReturnType<typeof useWorkerControl> }) {
  if (isDemoBackend) return null;
  const { state, message, start, refresh, managed } = control;
  return (
    <div className="rail-worker" data-state={state}>
      <span role="status" className="rail-worker-state"><i aria-hidden="true" />워커 {labels[state]}</span>
      {state === 'stopped' && !managed && <button type="button" onClick={start}>실행하기</button>}
      {state === 'unknown' && <button type="button" onClick={refresh}>다시 확인</button>}
      {message && <p role="alert">{message}</p>}
    </div>
  );
}
