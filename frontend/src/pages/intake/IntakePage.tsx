import { Link, NavLink, useParams } from 'react-router';
import { formatDate, useApi, bytes } from '../../api/client';
import { paths, teamLabel, type BatchDetails, type BatchSummary } from '../../api/intake';
import { Page } from '../../components/Layout';
import { Notice, PageHeader, buttonStyles, cx } from '../../components/ui';
import { useEvent } from '../../context/EventContext';
import Upload from './Upload';

/** /intake (업로드), /intake/batches (접수 내역), /intake/batches/:id (접수 상세) */
export default function IntakePage({ view }: { view: 'upload' | 'history' | 'detail' }) {
  const { event, events, eventsError, teams, teamsError, refresh } = useEvent();

  return (
    <Page tone="gray" width="normal">
      <PageHeader title="원본 접수" lead="여러 팀의 01·02·03 원본을 섞어서 올려도 됩니다. 저장이 끝나면 접수번호가 발급되고, 팀 배정과 판정은 뒤에서 진행됩니다." />
      <nav aria-label="원본 접수" className="flex gap-1.5 self-start rounded-full bg-white p-1">
        {[
          ['/intake', '접수하기', true],
          ['/intake/batches', '접수 내역', false],
        ].map(([to, label, end]) => (
          <NavLink
            key={to as string}
            to={to as string}
            end={end as boolean}
            className={({ isActive }) => cx('inline-flex min-h-10 items-center rounded-full px-[18px] text-sm', isActive ? 'bg-ink font-bold text-white' : 'text-muted')}
          >
            {label}
          </NavLink>
        ))}
      </nav>
      {!events ? (
        <Notice error={eventsError && `${eventsError} (접수 API 서버가 실행 중인지 확인해 주세요.)`} onRetry={refresh} />
      ) : !event ? (
        <p className="rounded-2xl bg-white px-5 py-4 text-sm">
          등록된 대회가 없습니다.{' '}
          <Link to="/manage" className="font-bold text-brand-strong underline underline-offset-2">
            대회·팀 관리
          </Link>
          에서 먼저 대회를 등록해 주세요.
        </p>
      ) : !teams ? (
        <Notice error={teamsError} onRetry={refresh} />
      ) : view === 'upload' ? (
        <Upload key={event.id} event={event} teams={teams} />
      ) : view === 'history' ? (
        <History eventId={event.id} />
      ) : (
        <Detail eventId={event.id} />
      )}
    </Page>
  );
}

function History({ eventId }: { eventId: string }) {
  const { revision, refresh } = useEvent();
  const result = useApi<BatchSummary[]>(paths.batches(eventId), revision);
  if (!result.data) return <Notice error={result.error} onRetry={refresh} />;
  return (
    <section className="flex flex-col gap-4 rounded-[22px] border border-line bg-white p-[clamp(18px,3vw,32px)]">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-extrabold">
          접수 목록 <em className="ml-1 text-base not-italic text-brand-strong">{result.data.length}</em>
        </h2>
        <button type="button" onClick={refresh} className={buttonStyles.text}>
          새로고침
        </button>
      </div>
      {result.data.length === 0 ? (
        <p className="py-6 text-sm text-muted">아직 접수한 원본이 없습니다.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-canvas text-left text-[13px] text-muted">
                {['접수번호', '접수 일시', '지정 팀', '원본', '상태'].map((h) => (
                  <th key={h} scope="col" className="whitespace-nowrap px-2 py-3 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.data.map((batch) => (
                <tr key={batch.batch_id} className="border-b border-line-soft">
                  <td className="whitespace-nowrap px-2 py-3">
                    <Link to={`/intake/batches/${batch.batch_id}`} className="font-mono text-brand-strong underline underline-offset-2">
                      {batch.batch_id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-2 py-3">{formatDate(batch.created_at)}</td>
                  <td className="whitespace-nowrap px-2 py-3">{batch.team_name ? teamLabel({ name: batch.team_name, rep: batch.team_rep }) : '미지정'}</td>
                  <td className="whitespace-nowrap px-2 py-3">{batch.file_count}개</td>
                  <td className="whitespace-nowrap px-2 py-3">
                    <span className="rounded-full bg-brand-tint px-2.5 py-1 text-xs font-bold text-brand-strong">원본 접수 완료</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Detail({ eventId }: { eventId: string }) {
  const { id = '' } = useParams();
  const { revision, refresh } = useEvent();
  const result = useApi<BatchDetails>(paths.batch(id), revision);
  if (!result.data) return <Notice error={result.error} onRetry={refresh} />;
  const { batch, files } = result.data;
  if (batch.event_id !== eventId)
    return (
      <p role="alert" className="rounded-2xl bg-alert-soft px-5 py-4 text-sm text-alert-strong">
        선택한 대회의 접수번호가 아닙니다.
      </p>
    );
  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-[22px] border border-line bg-white p-[clamp(18px,3vw,32px)]">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-xl font-extrabold">접수 상세</h2>
          <span className="rounded-full bg-brand-tint px-2.5 py-1 text-xs font-bold text-brand-strong">원본 접수 완료</span>
        </div>
        <dl className="grid grid-cols-[86px_minmax(0,1fr)] gap-3 text-sm">
          <dt className="text-muted">접수번호</dt>
          <dd className="break-all font-mono">{batch.batch_id}</dd>
          <dt className="text-muted">접수 일시</dt>
          <dd>{formatDate(batch.created_at)}</dd>
          <dt className="text-muted">지정 팀</dt>
          <dd>{batch.team_name ? teamLabel({ name: batch.team_name, rep: batch.team_rep }) : '미지정 · 혼합 접수'}</dd>
          <dt className="text-muted">검토 상태</dt>
          <dd>내용 판독 전</dd>
        </dl>
      </section>
      <section className="rounded-[22px] border border-line bg-white p-[clamp(18px,3vw,32px)]">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xl font-extrabold">
            접수 원본 <em className="ml-1 text-base not-italic text-brand-strong">{files.length}</em>
          </h2>
          <span className="text-sm text-muted">{bytes(batch.total_bytes)}</span>
        </div>
        <ol>
          {files.map((file) => (
            <li key={file.item_id} className="flex flex-wrap items-center gap-2.5 border-b border-line-soft py-3 text-sm">
              <span className="flex-[1_1_160px] break-all">{file.name}</span>
              <small className="whitespace-nowrap text-muted">{bytes(file.size)}</small>
              <a className={buttonStyles.text} href={paths.original(batch.batch_id, file.item_id)} download>
                원본 받기
              </a>
            </li>
          ))}
        </ol>
      </section>
      <div>
        <Link to="/intake/batches" className={buttonStyles.secondary}>
          접수 목록으로
        </Link>
      </div>
    </div>
  );
}
