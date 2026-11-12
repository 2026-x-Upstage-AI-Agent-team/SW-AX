import { useState } from 'react';
import { Download, MonitorCheck, RefreshCw } from 'lucide-react';
import { useOutletContext } from 'react-router';
import { api, ApiError } from '../api/client';
import { installationKnown, pairPc, pcLabel, type usePcConnection } from '../api/pcConnection';
import { Page } from '../components/Layout';
import { buttonStyles, Card, cx, Feedback, Notice, PageHeader } from '../components/ui';

export default function PcConnect() {
  const { status, error, refresh } = useOutletContext<ReturnType<typeof usePcConnection>>();
  const [pairUri, setPairUri] = useState<string>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const known = Boolean(status?.device?.id) || installationKnown();
  const ready = Boolean(status?.device?.online && status.device.hancom_ready && !error);
  async function connect() {
    setBusy(true); setMessage('');
    try {
      const { uri } = await pairPc();
      setPairUri(uri);
      window.location.href = uri;
    } catch (cause) { setMessage(cause instanceof ApiError ? cause.message : 'PC 연결을 시작하지 못했습니다.'); }
    finally { setBusy(false); }
  }
  async function revoke() {
    if (!status?.device?.id) return;
    setBusy(true); setMessage('');
    try { await api('/api/pc-connections/' + status.device.id, { method: 'DELETE' }); setPairUri(undefined); refresh(); }
    catch { setMessage('연결을 해제하지 못했습니다. 다시 시도해 주세요.'); }
    finally { setBusy(false); }
  }
  return (
    <Page tone="gray" width="normal">
      <PageHeader title="내 PC 연결" lead="이 PC에 설치된 한글로 내 서류를 변환하고 PDF를 출력합니다." />
      {!status ? <Notice error={error || undefined} onRetry={refresh} /> : !status.enabled ? (
        <Card className="p-5 text-sm text-muted sm:p-6">현재 환경에서는 내 PC 연결 기능을 사용할 수 없습니다.</Card>
      ) : <>
      <Card className="grid gap-4 p-5 sm:p-6">
        <div className="flex items-center gap-3">
          <span className={cx('grid size-11 shrink-0 place-items-center rounded-xl', ready ? 'bg-brand-tint text-brand-strong' : 'bg-canvas text-muted')}>
            <MonitorCheck size={23} aria-hidden="true" />
          </span>
          <div className="min-w-0" role="status">
            <h2 className="panel-title flex items-center gap-2">
              <span className={cx('pc-connection-indicator', ready && 'is-active')} aria-hidden="true" />
              {error || pcLabel(status)}
            </h2>
            {status.device?.name && <p className="text-sm text-subtle">{status.device.name}</p>}
          </div>
        </div>
        <p className="text-sm text-muted">{ready ? '이 PC에서 내 작업을 자동으로 처리합니다.'
          : known ? '연결 프로그램을 실행해 주세요. 계정 연결이 풀렸다면 여기서 다시 연결할 수 있습니다.'
            : '프로그램을 설치했다면 이 PC 연결을 누르세요. 처음이라면 아래 설치 방법을 확인하세요.'}</p>
        {status.device?.online && !status.device.hancom_ready && <Feedback error="한글이 설치된 Windows PC인지 확인한 뒤 연결 프로그램을 다시 실행해 주세요." />}
        <div className="flex flex-wrap gap-3">
          {!ready && <button type="button" className={buttonStyles.primary} disabled={busy} onClick={connect}>
            {busy ? '연결 준비 중…' : known ? '연결 프로그램 실행·재연결' : '이 PC 연결'}
          </button>}
          <button type="button" className={buttonStyles.secondary} onClick={refresh}><RefreshCw size={16} aria-hidden="true" />연결 확인</button>
          {status.device?.registered && <button type="button" className={buttonStyles.outline} onClick={revoke} disabled={busy}>이 계정의 PC 연결 해제</button>}
        </div>
        {pairUri && !ready && <div className="grid gap-2 rounded-xl bg-canvas p-4 text-sm">
          <p>브라우저에 프로그램 열기 확인창이 뜨면 허용해 주세요.</p>
          <a href={pairUri} className="w-fit font-semibold text-brand-strong underline">연결 프로그램 다시 열기</a>
          <p className="text-subtle">연결 요청은 5분 동안 한 번 사용할 수 있습니다. 만료되면 실행·재연결 버튼을 다시 누르세요.</p>
        </div>}
        <Feedback error={message} />
        <p className="text-sm text-subtle">변환 중에는 이 PC의 전원·Windows 로그인·인터넷 연결을 유지해 주세요. Windows 로그인 후 연결 프로그램은 자동으로 시작합니다.</p>
        {Boolean(status.pending) && <p role="status" className={cx('rounded-xl p-3 text-sm font-semibold', ready ? 'bg-canvas text-muted' : 'bg-caution-bg text-caution')}>
          내 PC에서 처리할 작업 {status.pending}건{!ready && '이 연결을 기다리고 있습니다.'}
        </p>}
      </Card>
      <Card className="p-5 sm:p-6">
        <details key={String(known)} open={!known}>
          <summary className="panel-title cursor-pointer">{known ? '프로그램 복구·다른 브라우저에서 연결 도움말' : '처음 사용하는 PC의 설치 방법'}</summary>
          <div className="mt-4 grid gap-4 border-t border-line pt-4 text-sm">
            <ol className="list-decimal space-y-2 pl-5 text-muted">
              <li>한글이 설치된 Windows PC에서 연결 프로그램을 내려받아 실행합니다.</li>
              <li>설치 안내를 확인하고 설치를 완료합니다.</li>
              <li>이 화면으로 돌아와 이 PC 연결을 누르고 연결 상태를 확인합니다.</li>
            </ol>
            {status.download_available ? <a href="/api/pc-connections/installer" className={cx(buttonStyles.secondary, 'justify-self-start')}>
              <Download size={16} aria-hidden="true" />PC 연결 프로그램 다운로드
            </a> : <p className="text-subtle">설치 파일을 준비 중입니다.</p>}
          </div>
        </details>
      </Card>
      </>}
    </Page>
  );
}
