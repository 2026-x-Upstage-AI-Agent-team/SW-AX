import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useAsync } from '../api/client';
import { getSubmission, type DocCode, type Submission } from '../api/review';
import { Page } from '../components/Layout';
import { CheckIcon, DemoBadge, MailBadge, Notice, VerdictBadge, buttonStyles, cx } from '../components/ui';

const docTitles: Record<DocCode, string> = { '01': '01 신청서', '02': '02 동의서', '03': '03 신분증·통장' };

/** "02 p1" 같은 위치 표기에서 서류 번호를 꺼낸다. */
function toDoc(location?: string): DocCode | undefined {
  const code = location?.slice(0, 2);
  return code === '01' || code === '02' || code === '03' ? code : undefined;
}

export default function TeamReview() {
  const { id = '' } = useParams();
  const result = useAsync(() => getSubmission(id), [id]);

  return (
    <Page tone="gray">
      <div className="flex flex-col gap-3.5">
        <Link to="/" className="text-sm text-brand-strong hover:text-brand-deep">
          ← 업무 현황
        </Link>
        {!result.data ? <Notice error={result.error} onRetry={result.reload} /> : <Review key={result.data.id} s={result.data} />}
      </div>
    </Page>
  );
}

function Review({ s }: { s: Submission }) {
  const firstIssue = s.checks.find((c) => c.state === 'fail' || c.state === 'check');
  const [doc, setDoc] = useState<DocCode>(s.highlight?.doc ?? toDoc(firstIssue?.location) ?? '01');
  const openDoc = (location: string) => {
    const code = toDoc(location);
    if (code) setDoc(code);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <h1 className="text-4xl font-extrabold tracking-[-0.03em]">{s.teamName}</h1>
        <span className="font-mono text-[13px] text-subtle">
          {s.id} · 제출 v{s.version}
        </span>
        <VerdictBadge verdict={s.verdict} size="md" />
        <DemoBadge />
        <div className="flex-auto" />
        <button type="button" className={buttonStyles.secondary} disabled title="원본 파일 API 연결 후 사용">
          원본 내려받기
        </button>
        <Link to="/intake" className={cx(buttonStyles.primary, 'min-h-11 px-5 text-sm')}>
          보완본 접수
        </Link>
      </div>
      <p className="max-w-4xl text-[17px] leading-relaxed text-ink-2">{s.reason}</p>
      {s.verdict !== '성공' && <p className="text-sm text-muted">어느 원본값이 맞는지는 자동으로 고르지 않습니다.</p>}

      <div className="mt-4 flex flex-wrap items-start gap-6">
        <section aria-label="원문 미리보기" className="min-w-0 flex-[999_1_560px] overflow-hidden rounded-[22px] border border-line bg-white">
          <div role="tablist" aria-label="서류" className="flex flex-wrap gap-1 border-b border-line px-4 py-3">
            {(Object.keys(docTitles) as DocCode[]).map((code) => (
              <button
                key={code}
                type="button"
                role="tab"
                aria-selected={doc === code}
                onClick={() => setDoc(code)}
                className={cx('min-h-10 rounded-[10px] px-3.5 text-[13px]', doc === code ? 'bg-ink font-bold text-white' : 'text-muted hover:bg-canvas')}
              >
                {docTitles[code]}
                {s.docs[code] === 'missing' && ' · 없음'}
                {s.docs[code] === 'duplicate' && ' · 2건'}
              </button>
            ))}
          </div>
          <div className="flex justify-center bg-paper p-3 sm:p-8">
            <DocPreview s={s} doc={doc} />
          </div>
        </section>

        <aside aria-label="검토 체크리스트" className="flex min-w-0 flex-[1_1_360px] flex-col gap-4">
          <div className="rounded-[22px] border border-line bg-white py-2">
            <h2 className="px-[22px] pb-2 pt-4 text-[17px] font-extrabold">검토 체크리스트</h2>
            <ul>
              {s.checks.map((c) => (
                <li key={c.title} className="border-t border-line-soft">
                  <button
                    type="button"
                    onClick={() => openDoc(c.location)}
                    className={cx('flex min-h-[52px] w-full items-center gap-3 px-[22px] py-3 text-left hover:bg-canvas', c.state === 'fail' && 'bg-alert-soft', c.state === 'check' && 'bg-caution-bg')}
                  >
                    <CheckIcon state={c.state} />
                    <span className="flex flex-1 flex-col gap-0.5">
                      <span className="text-sm font-medium text-ink">{c.title}</span>
                      <span className="text-xs text-subtle">{c.detail}</span>
                    </span>
                    <span className="font-mono text-[11px] text-subtle">{c.location}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <MailCard s={s} />
        </aside>
      </div>
    </>
  );
}

function MailCard({ s }: { s: Submission }) {
  const [decision, setDecision] = useState<'이상 없음' | '보완 필요' | null>(null);
  return (
    <div className="flex flex-col gap-3 rounded-[22px] border border-line bg-white p-[22px]">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[17px] font-extrabold">팀장 안내 메일</h2>
        <MailBadge state={s.mail.state} />
      </div>
      {s.mail.state === 'sent' && s.mail.subject ? (
        <>
          <div className="text-xs text-subtle">받는 사람 · 01 팀 대표 E-mail (담당자 확인) · [발송 시각]</div>
          <div className="flex flex-col gap-2 rounded-[14px] bg-canvas p-4">
            <strong className="text-sm">{s.mail.subject}</strong>
            <p className="text-[13px] leading-relaxed text-ink-2">{s.mail.body}</p>
          </div>
        </>
      ) : s.mail.state === 'waiting' ? (
        decision ? (
          <p role="status" className="rounded-[14px] bg-brand-tint p-4 text-sm leading-relaxed text-brand-deep">
            ‘{decision}’으로 기록했습니다. 결과 안내 한 통이 팀장에게 발송됩니다. (발송 API 연결 전)
            <button type="button" onClick={() => setDecision(null)} className="ml-2 font-bold underline underline-offset-2">
              되돌리기
            </button>
          </p>
        ) : (
          <>
            <p className="text-sm leading-relaxed text-ink-2">원본을 대조한 뒤 결과를 기록하면 팀장에게 한 통이 발송됩니다.</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={buttonStyles.secondary} onClick={() => setDecision('이상 없음')}>이상 없음</button>
              <button type="button" className={buttonStyles.secondary} onClick={() => setDecision('보완 필요')}>보완 필요</button>
            </div>
          </>
        )
      ) : (
        <p className="text-sm text-muted">최초 정상 제출이라 보낼 안내가 없습니다.</p>
      )}
      <p className="text-xs text-subtle">원본 첨부, 주민번호·계좌번호·학번, 다른 팀 정보는 메일에 넣지 않습니다.</p>
    </div>
  );
}

const cell = 'border-[#cdcfcf] p-2';

function DocPreview({ s, doc }: { s: Submission; doc: DocCode }) {
  if (s.docs[doc] === 'missing') {
    return (
      <div className="flex w-full max-w-[560px] flex-col items-center gap-2 rounded-xl border-2 border-dashed border-alert-strong bg-white px-8 py-16 text-center">
        <strong className="text-alert-strong">{docTitles[doc]}이(가) 접수되지 않았습니다</strong>
        <span className="text-sm text-muted">이 팀의 확정 접수 목록에 해당 서류가 없습니다.</span>
      </div>
    );
  }
  const highlightAccount = s.highlight?.doc === doc && s.highlight.field === 'account';
  return (
    <div className="flex w-full max-w-[560px] flex-col gap-[18px] bg-white px-4 py-6 text-xs sm:px-9 sm:py-10 text-ink-2 shadow-[0_6px_24px_rgba(0,0,0,0.08)]">
      {s.docs[doc] === 'duplicate' && (
        <p className="rounded-lg bg-alert-tint px-3 py-2 text-alert-strong">같은 서류가 파일명만 다르게 2건 접수되었습니다.</p>
      )}
      {doc === '01' && (
        <>
          <div className="text-center text-[15px] font-bold text-ink">SW수혜학생 신청 및 시상금 지급 확의서</div>
          <div className="grid grid-cols-[90px_1fr] border border-[#cdcfcf]">
            <div className={cx(cell, 'border-b border-r bg-canvas')}>프로그램명</div>
            <div className={cx(cell, 'border-b')}>[프로그램명]</div>
            <div className={cx(cell, 'border-r bg-canvas')}>팀명</div>
            <div className={cell}>{s.placeholderName ? '[팀명]' : s.teamName}</div>
          </div>
          <div className="grid grid-cols-4 border border-[#cdcfcf]">
            {['구분', '성명', '학번', '전공'].map((h, i) => (
              <div key={h} className={cx(cell, 'bg-canvas', i < 3 && 'border-r')}>{h}</div>
            ))}
            {['팀 대표', '팀원'].flatMap((role) =>
              [role, '○○○', '[학번]', '[전공]'].map((v, i) => (
                <div key={role + i} className={cx(cell, 'border-t', i < 3 && 'border-r')}>{v}</div>
              )),
            )}
          </div>
          <div className="grid grid-cols-[90px_1fr] border border-[#cdcfcf]">
            <div className={cx(cell, 'border-b border-r bg-canvas')}>은행명</div>
            <div className={cx(cell, 'border-b')}>[은행명]</div>
            <div className={cx(cell, 'border-r bg-canvas')}>계좌번호</div>
            <div className={cx(cell, 'font-mono', highlightAccount && 'bg-info-tint outline-[3px] -outline-offset-2 outline-info outline')}>
              ••••-••-••••{highlightAccount && <strong className="text-alert-strong">12</strong>}
            </div>
          </div>
          <div className="flex h-16 items-center justify-center border border-dashed border-[#cdcfcf] text-subtle">지급 확인 및 서명 영역</div>
        </>
      )}
      {doc === '02' && (
        <>
          <div className="text-center text-[15px] font-bold text-ink">수혜학생 개인정보 수집·이용·제공 동의서</div>
          <div className="h-20 rounded bg-canvas p-3 text-subtle">개인정보 수집·이용 안내문</div>
          <div className="grid grid-cols-6 border border-[#cdcfcf]">
            {['성명', '학과', '수집', '고유식별', '제3자', '서명'].map((h, i) => (
              <div key={h} className={cx(cell, 'bg-canvas', i < 5 && 'border-r')}>{h}</div>
            ))}
            {[0, 1, 2].flatMap((row) =>
              ['○○○', '[학과]', '☑', '☑', '☑', '[서명]'].map((v, i) => (
                <div key={row + '-' + i} className={cx(cell, 'border-t', i < 5 && 'border-r')}>{v}</div>
              )),
            )}
          </div>
        </>
      )}
      {doc === '03' && (
        <>
          <div className="text-center text-[15px] font-bold text-ink">팀장 신분증 사본 및 통장 사본</div>
          <div className="grid grid-cols-2 gap-3">
            {['신분증 사본', '통장 사본'].map((label) => (
              <div key={label} className="flex aspect-[4/3] items-center justify-center rounded-lg bg-paper text-subtle">
                {label}
              </div>
            ))}
          </div>
        </>
      )}
      <p className="text-center text-[11px] text-subtle">원문 미리보기 자리 · 원본 렌더링 API 연결 전</p>
    </div>
  );
}
