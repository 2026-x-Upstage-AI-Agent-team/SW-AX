import { useEffect, useState, type FormEvent } from 'react';
import { ExternalLink } from 'lucide-react';
import { reviewLive } from '../api/backend';
import { connectGmail, startGmailOAuth, type Dashboard } from '../api/service';
import { Page } from '../components/Layout';
import { Card, Feedback, Notice, PageHeader, buttonStyles, cx, inputStyle } from '../components/ui';
import { useEvent } from '../context/EventContext';

const localHosts = ['localhost', '127.0.0.1', '[::1]'];
const setupHelp = 'Windows 검토 서비스에서 MAIL_MODE를 gmail로, GMAIL_ADDRESS를 담당자 주소로 설정한 뒤 서비스를 다시 시작하세요.';

function getReviewOrigin() {
  const configured = import.meta.env.VITE_REVIEW_SERVICE_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return undefined;
      return url;
    } catch {
      return undefined;
    }
  }
  if (localHosts.includes(location.hostname)) return new URL('http://127.0.0.1:8765');
  return reviewLive ? new URL(location.origin) : undefined;
}

function SetupLink({ origin, method, children }: { origin: URL; method: 'google' | 'password'; children: string }) {
  return (
    <a href={new URL('/#mail/' + method, origin).href} target="_blank" rel="noopener noreferrer"
      className={method === 'google' ? buttonStyles.primary : buttonStyles.secondary}>
      {children}<ExternalLink size={15} aria-hidden="true" /><span className="sr-only"> (새 탭)</span>
    </a>
  );
}

export default function Gmail() {
  const { dashboard, dashboardError, refresh } = useEvent();
  const origin = getReviewOrigin();
  useEffect(() => {
    if (!reviewLive) return;
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);

  let content;
  if (!origin) {
    content = <Feedback error="운영자가 이 웹앱에 Windows 검토 서비스 주소(VITE_REVIEW_SERVICE_URL)를 설정해야 합니다." />;
  } else if (!reviewLive) {
    content = (
      <Card className="flex max-w-2xl flex-col items-start gap-4 p-6">
        <h2 className="panel-title">담당자 계정 인증</h2>
        <p className="text-sm text-muted">인증과 연결 상태 확인은 Windows 검토 서비스에서 진행합니다. 선택한 방법이 새 탭에서 열립니다.</p>
        <div className="flex flex-wrap gap-2">
          <SetupLink origin={origin} method="google">Google로 연결</SetupLink>
          <SetupLink origin={origin} method="password">앱 비밀번호로 연결</SetupLink>
        </div>
        {localHosts.includes(origin.hostname) && <p className="text-sm text-muted">화면이 열리지 않으면 이 PC의 프로젝트 폴더에서 <code>./start-service.ps1</code>을 실행하세요.</p>}
        <a href={new URL('/#mail', origin).href} target="_blank" rel="noopener noreferrer" className={buttonStyles.text}>현재 연결 상태 보기 <span className="sr-only">(새 탭)</span></a>
      </Card>
    );
  } else if (dashboardError || !dashboard) {
    content = <Notice error={dashboardError} onRetry={refresh} />;
  } else {
    content = <AccountSetup key={dashboard.gmail_account ?? ''} d={dashboard} origin={origin} refresh={refresh} />;
  }
  return (
    <Page tone="gray" width="normal">
      <PageHeader title="Gmail 연결" lead="팀장 안내와 담당자 알림을 보낼 Gmail 계정을 연결합니다." />
      {content}
    </Page>
  );
}

function AccountSetup({ d, origin, refresh }: { d: Dashboard; origin: URL; refresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const account = d.gmail_account;
  const connected = !!account && d.mail_ready;
  // Google 콜백에 시작 요청의 호스트 전용 state 쿠키가 전달돼야 한다.
  const sameCookieHost = origin.hostname === location.hostname && origin.protocol === location.protocol;

  async function submit(e: FormEvent<HTMLFormElement>, method: 'google' | 'password') {
    e.preventDefault();
    if (busy) return;
    const form = e.currentTarget;
    const data = new FormData(form);
    setBusy(true); setError(''); setMessage('');
    try {
      if (method === 'google') {
        const file = data.get('client');
        if (!(file instanceof File) || !file.size || file.size > 32768) throw new Error('32 KiB 이하의 Google Cloud 웹 클라이언트 JSON을 선택하세요.');
        const { url } = await startGmailOAuth(await file.text());
        window.location.assign(url);
      } else {
        const password = String(data.get('password') ?? '').replace(/\s/g, '');
        form.reset();
        if (!/^[A-Za-z0-9]{16}$/.test(password)) throw new Error('Google이 발급한 16자리 앱 비밀번호를 입력하세요.');
        const result = await connectGmail(password);
        setMessage(result.address + ' 계정을 연결했습니다.');
        refresh();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex max-w-2xl flex-col gap-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h2 className="panel-title">담당자 발신 계정</h2>{account && <p className="mt-1 break-all text-sm">{account}</p>}</div>
        <span className={cx('rounded-md px-2.5 py-1 text-sm font-semibold', connected ? 'bg-brand-tint text-brand-deep' : 'bg-caution-tint text-caution')}>
          {connected ? (d.gmail_oauth_connected ? 'Google 계정 연결됨' : '앱 비밀번호 연결됨') : account ? '인증 대기' : '주소 미설정'}
        </span>
      </div>
      {!account ? (
        <div><p className="mb-2 text-sm text-muted">{setupHelp}</p><button type="button" className={buttonStyles.secondary} onClick={refresh}>설정 다시 확인</button></div>
      ) : (
        <>
          {sameCookieHost ? (
            <form onSubmit={(e) => submit(e, 'google')} className="flex flex-col items-start gap-3 border-t border-line pt-4">
              <label className="flex max-w-full flex-col gap-2 text-sm font-semibold">
                Google Cloud 웹 클라이언트 JSON
                <input type="file" name="client" accept=".json,application/json" required disabled={busy} className="max-w-full text-sm file:mr-2 file:rounded-md file:border file:border-line-2 file:px-3 file:py-2" />
              </label>
              <details className="max-w-full text-sm text-muted"><summary className="cursor-pointer">처음 연결할 때</summary>
                <p className="mt-2">Google Cloud에서 Gmail API를 사용 설정하고 웹 클라이언트의 승인된 리디렉션 URI에 아래 주소를 등록하세요.</p>
                <code className="mt-1 block select-all break-all">{new URL('/api/settings/gmail/callback', origin).href}</code>
              </details>
              <button className={buttonStyles.primary} disabled={busy}>{connected ? 'Google로 다시 연결' : 'Google로 연결'}</button>
            </form>
          ) : <div><SetupLink origin={origin} method="google">{connected ? 'Google로 다시 연결' : 'Google로 연결'}</SetupLink></div>}
          <details className="border-t border-line pt-4">
            <summary className="cursor-pointer text-sm font-semibold">앱 비밀번호로 연결</summary>
            <form onSubmit={(e) => submit(e, 'password')} className="mt-3 flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-sm">Google이 발급한 16자리 코드
                <input type="password" name="password" autoComplete="off" required disabled={busy} className={inputStyle} />
              </label>
              <button className={buttonStyles.secondary} disabled={busy}>인증하고 연결</button>
            </form>
          </details>
        </>
      )}
      <Feedback error={error} message={message} />
    </Card>
  );
}
