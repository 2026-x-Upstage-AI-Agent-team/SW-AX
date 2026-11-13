import { useEffect, useState, type FormEvent } from 'react';
import { ExternalLink } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { isDemoBackend } from '../api/backend';
import { useApi } from '../api/client';
import { connectGmail, disconnectGmail, startGmailOAuth, type Dashboard } from '../api/service';
import { Page } from '../components/Layout';
import { Card, Feedback, Notice, PageHeader, buttonStyles, cx, inputStyle } from '../components/ui';
import { useEvent } from '../context/EventContext';

const localHosts = ['localhost', '127.0.0.1', '[::1]'];
type Account = Pick<Dashboard, 'gmail_account' | 'gmail_oauth_connected' | 'mail_ready'>;
const results: Record<string, string> = {
  connected: 'Google 계정을 연결했습니다.',
  disconnected: 'Google 계정의 메일 발송 권한을 해제했습니다.',
  cancelled: 'Google 연결을 취소했습니다. 기존 연결 상태를 유지합니다.',
  expired: '연결 요청이 만료되었거나 다른 브라우저에서 열렸습니다. 여기서 다시 시작하세요.',
  permission: '메일을 발송하려면 Google 동의 화면에서 이메일 보내기를 허용하세요.',
  account: '선택한 Google 계정의 이메일 주소를 확인하지 못했습니다. 다시 연결하세요.',
  failed: 'Google 인증을 완료하지 못했습니다. 잠시 후 다시 시도하세요.',
};

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
  return isDemoBackend ? new URL(location.origin) : undefined;
}

function ReviewGoogleLink({ origin, children }: { origin: URL; children: string }) {
  return (
    <a href={new URL('/#mail/google', origin).href} target="_blank" rel="noopener noreferrer" className={buttonStyles.primary}>
      {children}<ExternalLink size={15} aria-hidden="true" /><span className="sr-only"> (새 탭)</span>
    </a>
  );
}

export default function Gmail() {
  const { dashboard, dashboardError, refresh } = useEvent();
  const [revision, setRevision] = useState(0);
  const status = useApi<Account & { redirect_uri: string }>(isDemoBackend ? null : '/api/settings/gmail', revision);
  const [params, setParams] = useSearchParams();
  const [result, setResult] = useState(() => params.get('result') ?? '');
  useEffect(() => {
    if (params.has('result')) setParams({}, { replace: true });
  }, [params, setParams]);
  const origin = isDemoBackend ? getReviewOrigin() : undefined;
  useEffect(() => {
    const onFocus = () => isDemoBackend ? refresh() : setRevision((v) => v + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  let content;
  if (!isDemoBackend) {
    const reload = () => setRevision((v) => v + 1);
    content = status.data
      ? <AccountSetup d={status.data} callback={new URL(status.data.redirect_uri)} refresh={() => { reload(); refresh(); }} onDisconnected={() => {
          setResult('disconnected');
          reload();
          refresh();
        }} />
      : <Notice error={status.error} onRetry={reload} />;
  } else if (!origin) {
    content = <Feedback error="운영자가 이 웹앱에 Windows 검토 서비스 주소(VITE_REVIEW_SERVICE_URL)를 설정해야 합니다." />;
  } else if (dashboardError || !dashboard) {
    content = <Notice error={dashboardError} onRetry={refresh} />;
  } else {
    content = <AccountSetup key={dashboard.gmail_account ?? ''} d={dashboard} callback={new URL('/api/settings/gmail/callback', origin)} refresh={refresh} />;
  }
  return (
    <Page tone="gray" width="normal">
      <PageHeader title="Gmail 연결" lead="내 Google 계정을 연결하고 팀장 안내 메일의 발신 계정으로 사용하세요." />
      {Object.hasOwn(results, result) && <Feedback {...(['connected', 'cancelled', 'disconnected'].includes(result) ? { message: results[result] } : { error: results[result] })} />}
      {content}
    </Page>
  );
}

function AccountSetup({ d, callback, refresh, onDisconnected }: { d: Account; callback: URL; refresh: () => void; onDisconnected?: () => void }) {
  const [action, setAction] = useState<'google' | 'password' | 'disconnect' | null>(null);
  const busy = action !== null;
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const account = d.gmail_account;
  const connected = !!account && d.mail_ready;
  // Google 콜백에 시작 요청의 호스트 전용 state 쿠키가 전달돼야 한다.
  const sameCookieHost = callback.hostname === location.hostname && callback.protocol === location.protocol;

  async function disconnect() {
    if (busy || !onDisconnected) return;
    setAction('disconnect'); setError(''); setMessage('');
    try {
      await disconnectGmail();
      onDisconnected();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAction(null);
    }
  }

  async function submit(e: FormEvent<HTMLFormElement>, method: 'google' | 'password') {
    e.preventDefault();
    if (busy) return;
    const form = e.currentTarget;
    const data = new FormData(form);
    setAction(method); setError(''); setMessage('');
    try {
      if (method === 'google') {
        const file = data.get('client');
        if (isDemoBackend && (!(file instanceof File) || !file.size || file.size > 32768)) throw new Error('32 KiB 이하의 Google Cloud 웹 클라이언트 JSON을 선택하세요.');
        const { url } = await startGmailOAuth(file instanceof File ? await file.text() : undefined);
        window.location.assign(url);
      } else {
        const password = String(data.get('password') ?? '').replace(/\s/g, '');
        form.reset();
        if (!/^[A-Za-z0-9]{16}$/.test(password)) throw new Error('Google이 발급한 16자리 앱 비밀번호를 입력하세요.');
        const result = await connectGmail(password, String(data.get('address') ?? account ?? '').trim());
        setMessage(result.address + ' 계정을 연결했습니다.');
        refresh();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAction(null);
    }
  }

  return (
    <Card className="flex max-w-2xl flex-col gap-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h2 className="panel-title">내 발신 계정</h2>{account && <p className="mt-1 break-all text-sm">{account}</p>}</div>
        <span className={cx('rounded-md px-2.5 py-1 text-sm font-semibold', connected ? 'bg-brand-tint text-brand-deep' : 'bg-caution-tint text-caution')}>
          {connected ? (d.gmail_oauth_connected ? 'Google 계정 연결됨' : '앱 비밀번호 연결됨') : account ? '다시 연결 필요' : '연결 안 됨'}
        </span>
      </div>
      {!account && isDemoBackend ? (
        <div><p className="mb-2 text-sm text-muted">Windows 검토 서비스에서 MAIL_MODE를 gmail로, GMAIL_ADDRESS를 담당자 주소로 설정하세요.</p><button type="button" className={buttonStyles.secondary} onClick={refresh}>설정 다시 확인</button></div>
      ) : (
        <>
          {!isDemoBackend && <p className="text-sm text-muted">연결 정보는 내 담당자 계정에만 저장됩니다. 내가 발송을 승인한 메일은 연결한 계정으로 보냅니다.</p>}
          {sameCookieHost ? (
            <form onSubmit={(e) => submit(e, 'google')} className="flex flex-col items-start gap-3 border-t border-line pt-4">
              {isDemoBackend ? <label className="flex max-w-full flex-col gap-2 text-sm font-semibold">
                Google Cloud 웹 클라이언트 JSON
                <input type="file" name="client" accept=".json,application/json" required disabled={busy} className="max-w-full text-sm file:mr-2 file:rounded-md file:border file:border-line-2 file:px-3 file:py-2" />
              </label> : <p className="text-sm text-muted">Google에서 본인 계정을 선택하고 메일 발송을 허용해 주세요. 계정 변경을 완료하기 전까지 기존 연결을 유지합니다.</p>}
              <button className={buttonStyles.primary} disabled={busy}>{action === 'google' ? '연결 중…' : isDemoBackend ? 'Google로 연결' : connected ? '다른 Google 계정으로 변경' : 'Google 계정 연결'}</button>
              <details className="max-w-full text-sm text-muted"><summary className="cursor-pointer">연결 오류 시 관리자 확인사항</summary>
                <p className="mt-2">Google Cloud에서 Gmail API를 사용 설정하고 웹 클라이언트의 승인된 리디렉션 URI에 아래 주소를 등록하세요.</p>
                <code className="mt-1 block select-all break-all">{callback.href}</code>
              </details>
            </form>
          ) : isDemoBackend ? <div><ReviewGoogleLink origin={callback}>Google로 연결</ReviewGoogleLink></div>
            : <div><p className="mb-2 text-sm text-muted">Google 인증과 담당자 로그인이 같은 주소를 사용해야 합니다.</p>
              <a className={buttonStyles.primary} href={new URL('/#/gmail', callback).href}>등록된 주소에서 Gmail 연결 열기</a></div>}
          <details className="border-t border-line pt-4">
            <summary className="cursor-pointer text-sm font-semibold">앱 비밀번호로 연결</summary>
            <form onSubmit={(e) => submit(e, 'password')} className="mt-3 flex flex-wrap items-end gap-2">
              {!isDemoBackend && <label className="flex w-full flex-col gap-1 text-sm">Google 계정 이메일
                <input key={account} type="email" name="address" autoComplete="email" defaultValue={account ?? ''} required disabled={busy} className={inputStyle} placeholder="name@gmail.com" />
              </label>}
              <label className="flex flex-col gap-1 text-sm">Google이 발급한 16자리 코드
                <input type="password" name="password" autoComplete="off" required disabled={busy} className={inputStyle} />
              </label>
              <button className={buttonStyles.secondary} disabled={busy}>인증하고 연결</button>
            </form>
          </details>
          {connected && onDisconnected && <div className="flex flex-col items-start gap-3 border-t border-line pt-4">
            <p className="text-sm text-muted">연결을 해제하면 내 계정으로 보낼 대기 메일은 다시 연결할 때까지 발송되지 않습니다. 다른 발신 계정으로 변경한 대기 메일은 다시 승인해 주세요.</p>
            <button type="button" className={buttonStyles.danger} disabled={busy} onClick={disconnect}>
              {action === 'disconnect' ? '해제 중…' : '연결 해제'}
            </button>
          </div>}
        </>
      )}
      <Feedback error={error} message={message} />
    </Card>
  );
}
