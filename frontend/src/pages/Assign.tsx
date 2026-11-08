import { useEffect, useState } from 'react';
import { useAsync } from '../api/client';
import { assignFile, listAssignQueue, listSubmissions, type AssignItem } from '../api/review';
import { TOTAL_INTAKE_FILES } from '../mocks/review';
import { Page } from '../components/Layout';
import { Notice, PageHeader, buttonStyles, cx } from '../components/ui';

const toneText = { ok: 'text-brand-strong font-bold', warn: 'text-caution font-bold', neutral: 'text-ink-2' };

export default function Assign() {
  const queue = useAsync(listAssignQueue, []);
  const teams = useAsync(listSubmissions, []);
  const [items, setItems] = useState<AssignItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [other, setOther] = useState('');

  useEffect(() => {
    if (!queue.data) return;
    setItems(queue.data);
    setSelectedId(queue.data.find((i) => i.status === 'pending')?.id ?? queue.data[0]?.id);
  }, [queue.data]);

  const pending = items.filter((i) => i.status === 'pending').length;
  const selected = items.find((i) => i.id === selectedId);

  async function assign(item: AssignItem, team: string) {
    setSaving(true);
    await assignFile(item.id, team);
    setItems((list) => list.map((i) => (i.id === item.id ? { ...i, status: 'assigned', team } : i)));
    setSaving(false);
  }

  const undo = (item: AssignItem) =>
    setItems((list) => list.map((i) => (i.id === item.id ? { ...i, status: 'pending', team: undefined } : i)));

  return (
    <Page tone="gray">
      <PageHeader
        title="팀 배정 확인"
        demo
        lead="후보가 한 팀이고 근거가 서로 맞을 때만 자동으로 배정합니다. 근거가 모자라거나 부딪히는 파일만 여기 남습니다."
      />

      <section aria-label="배정 요약" className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
        <Stat label="접수 파일" value={TOTAL_INTAKE_FILES} />
        <Stat label="자동·담당자 배정" value={TOTAL_INTAKE_FILES - pending} />
        <Stat label="확인 필요" value={pending} warn={pending > 0} />
      </section>

      {!queue.data ? (
        <Notice error={queue.error} onRetry={queue.reload} />
      ) : (
        <div className="flex flex-wrap items-start gap-6">
          <section aria-labelledby="queue-h" className="min-w-0 flex-[1_1_340px] overflow-hidden rounded-[22px] border border-line bg-white">
            <h2 id="queue-h" className="px-[22px] pb-2.5 pt-[18px] text-base font-extrabold">
              파일
            </h2>
            <ul>
              {items.map((item) => (
                <li key={item.id} className="border-t border-line-soft">
                  <button
                    type="button"
                    aria-current={item.id === selectedId}
                    onClick={() => setSelectedId(item.id)}
                    className={cx(
                      'flex min-h-16 w-full flex-col items-start gap-1 border-l-[3px] px-[22px] py-3.5 text-left',
                      item.id === selectedId ? 'border-brand bg-brand-tint' : 'border-transparent hover:bg-canvas',
                    )}
                  >
                    <span className="font-mono text-[13px] text-ink">{item.fileName}</span>
                    {item.status === 'pending' && <span className="text-xs font-bold text-caution">확인 필요 · 후보 {item.candidate}</span>}
                    {item.status === 'assigned' && <span className="text-xs font-bold text-brand-strong">{item.team}에 배정함 · 담당자 처리</span>}
                    {item.status === 'auto' && (
                      <span className="text-xs text-muted">
                        자동 배정 · {item.team} — {item.reason}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            <p className="border-t border-line-soft px-[22px] pb-[18px] pt-3 text-xs text-subtle">자동 배정된 파일 중 일부만 표시</p>
          </section>

          {selected && (
            <section aria-labelledby="detail-h" className="flex min-w-0 flex-[999_1_600px] flex-col gap-4">
              {selected.status === 'assigned' && (
                <div role="status" className="flex flex-wrap items-center gap-3 rounded-2xl bg-brand-tint px-5 py-4 text-brand-deep">
                  <span className="flex-[1_1_300px] text-sm">
                    {selected.team}에 배정했습니다. 파일·변경 전후 팀·근거·처리자를 기록했고, {selected.team} 판정을 시작합니다.
                  </span>
                  <button type="button" onClick={() => undo(selected)} className="min-h-10 rounded-full border border-brand-strong px-3.5 text-[13px] font-bold">
                    되돌리기
                  </button>
                </div>
              )}

              <div className="flex flex-col gap-[22px] rounded-[22px] border border-line bg-white p-[26px]">
                <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
                  <h2 id="detail-h" className="font-mono text-lg font-medium">
                    {selected.fileName}
                  </h2>
                  <span className="rounded-full bg-canvas px-2.5 py-1 text-xs text-ink-2">본문 분류 · {selected.classifiedAs}</span>
                </div>
                <p className="text-[15px] leading-relaxed text-ink-2">{selected.reason}</p>

                {selected.evidence && (
                  <div className="flex flex-wrap gap-5">
                    <div className="flex aspect-[4/3] max-h-60 flex-[1_1_220px] flex-col items-center justify-center gap-2 rounded-[14px] bg-paper text-[13px] text-subtle">
                      원본 미리보기
                    </div>
                    <div className="min-w-0 flex-[2_1_320px] overflow-x-auto">
                      <table className="w-full border-collapse text-sm">
                        <caption className="pb-2 text-left text-[13px] text-muted">후보 팀 {selected.candidate}와의 대조</caption>
                        <tbody>
                          {selected.evidence.map((e) => (
                            <tr key={e.label} className="border-y border-line-soft">
                              <th scope="row" className="py-3 pr-2 text-left font-medium">
                                {e.label}
                              </th>
                              <td className={cx('py-3', toneText[e.tone])}>{e.result}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {selected.status === 'pending' && selected.candidate && (
                  <>
                    <div className="rounded-xl bg-canvas px-4 py-3.5 text-[13px] leading-relaxed text-ink-2">
                      팀장이 보낸 원래 제출 묶음과 대조한 뒤 배정하세요. 배정 전까지 {selected.candidate}의 03 누락 안내는 보내지 않습니다.
                    </div>
                    <div className="flex flex-wrap items-center gap-2.5">
                      <button type="button" disabled={saving} onClick={() => assign(selected, selected.candidate!)} className={buttonStyles.primary}>
                        {selected.candidate}에 배정
                      </button>
                      <label className="flex items-center gap-2 text-sm text-muted">
                        다른 팀
                        <select value={other} onChange={(e) => setOther(e.target.value)} className="h-12 rounded-xl border border-line-2 bg-white px-3 text-ink">
                          <option value="">팀 선택</option>
                          {teams.data
                            ?.filter((t) => t.teamName !== selected.candidate)
                            .map((t) => (
                              <option key={t.id} value={t.teamName}>
                                {t.teamName}
                              </option>
                            ))}
                        </select>
                      </label>
                      {other && (
                        <button type="button" disabled={saving} onClick={() => assign(selected, other)} className={buttonStyles.secondary}>
                          {other}에 배정
                        </button>
                      )}
                      <button type="button" disabled title="배정 API 연결 후 사용" className="min-h-12 px-4 text-sm text-alert-strong disabled:opacity-50">
                        대상 외 처리
                      </button>
                    </div>
                  </>
                )}
              </div>
            </section>
          )}
        </div>
      )}
    </Page>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className={cx('flex flex-col gap-1 rounded-[18px] bg-white px-[22px] py-5', warn && 'outline-2 outline-[#f5c37a] outline')}>
      <span className={cx('text-[13px]', warn ? 'font-bold text-caution' : 'text-muted')}>{label}</span>
      <span className="text-[32px] font-extrabold">{value}</span>
    </div>
  );
}
