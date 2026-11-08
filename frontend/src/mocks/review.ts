// 시연용 mock 데이터. 판정·근거는 output/json/유잇_미션2_answer.json(set01–set10) 기준이다.
// set03–set10은 공식 자료에 팀명이 없어 "테스트 팀 NN"으로 표기한다.
// 학생 이름·학번·계좌 등 개인정보는 넣지 않는다.
import type { AdminAlert, AssignItem, Check, CheckState, DocCode, DocState, MailRecord, Submission, Verdict } from '../api/review';

const BASE_CHECKS: Check[] = [
  { title: '문서 구성', detail: '01·02·03 각 1건', state: 'pass', location: '목록' },
  { title: '예상 밖 문서', detail: 'other 없음', state: 'pass', location: '목록' },
  { title: '대표 필수 정보', detail: '성명·은행·계좌번호 있음', state: 'pass', location: '01 p1' },
  { title: '대표 신분증 성명', detail: '01 대표 ↔ 03 신분증 일치', state: 'pass', location: '03 p1' },
  { title: '예금주', detail: '01 대표 ↔ 03 예금주 일치', state: 'pass', location: '03 p1' },
  { title: '계좌번호', detail: '01 ↔ 03 정규화 후 일치', state: 'pass', location: '01·03' },
  { title: '팀원 필수 정보', detail: '성명·학번·전공 있음', state: 'pass', location: '01 p1' },
  { title: '동의서 인원', detail: '01 명단 ↔ 02 작성자 대응', state: 'pass', location: '02' },
  { title: '동의 표시', detail: '수집·고유식별·제3자 제공 표시됨', state: 'pass', location: '02' },
  { title: '서명', detail: '서명 흔적 확인', state: 'pass', location: '01·02' },
];

type Override = { state: CheckState; detail: string; location?: string };

function checks(overrides: Record<string, Override> = {}): Check[] {
  const list = BASE_CHECKS.map((c) => (overrides[c.title] ? { ...c, ...overrides[c.title] } : c));
  // 실패·확인 항목을 위로 올린다.
  const rank: Record<CheckState, number> = { fail: 0, check: 1, na: 2, pass: 3 };
  return list.sort((a, b) => rank[a.state] - rank[b.state]);
}

const FULL: Record<DocCode, DocState> = { '01': 'ok', '02': 'ok', '03': 'ok' };
const NA = (detail: string): Override => ({ state: 'na', detail });

function redo(subject: string, body: string) {
  return { state: 'sent' as const, subject: `[시상금 서류 보완 요청] ${subject}`, body };
}

function team(
  n: number,
  verdict: Verdict,
  reason: string,
  summary: string,
  extra: Partial<Submission> = {},
): Submission {
  const id = `set${String(n).padStart(2, '0')}`;
  return {
    id,
    teamName: `테스트 팀 ${String(n).padStart(2, '0')}`,
    placeholderName: true,
    version: 1,
    docs: FULL,
    verdict,
    reason,
    summary,
    checks: checks(),
    mail: { state: 'none' },
    ...extra,
  };
}

export const submissions: Submission[] = [
  {
    ...team(1, '성공',
      '필수 서류 세 유형이 모두 제출되었고, 팀원 4명의 필수 정보·동의 표시·서명이 갖춰져 있으며 대표 인적사항과 은행·계좌정보가 문서 간 일치합니다.',
      '필수 서류 3종과 팀원 4명의 동의·서명, 대표 계좌가 모두 일치합니다.'),
    teamName: 'Nextify',
    placeholderName: false,
    memberCount: 4,
  },
  {
    ...team(2, '성공',
      "필수 서류와 동의·서명 요건이 충족되며, 통장 이미지의 배치가 달라도 은행명·예금주·계좌번호를 확인할 수 있습니다. 지급확인서의 '국민'과 통장 사본의 'KB국민은행'은 같은 은행의 표기 차이이고, 정규화 후 대표 정보와 계좌정보가 일치합니다.",
      "'국민'과 'KB국민은행'은 같은 은행 표기 차이로, 정규화 후 일치합니다."),
    teamName: 'AutoAI',
    placeholderName: false,
    // docs/IMPLEMENTATION_PLAN.md: 공식 set01·02 → 학생 7행·대표 2행
    memberCount: 3,
  },
  team(3, '재제출요청',
    '수혜학생 신청 및 시상금 지급 확인서의 대표 계좌번호와 통장 사본의 계좌번호가 끝자리에서 서로 다릅니다.',
    '01 대표 계좌번호와 03 통장 계좌번호의 끝자리가 다릅니다.',
    {
      checks: checks({ 계좌번호: { state: 'fail', detail: '01 ↔ 03 끝자리 다름', location: '01 p1' } }),
      highlight: { doc: '01', field: 'account' },
      mail: redo('대표 계좌 정보 확인',
        '01 신청서와 03 통장 사본의 대표 계좌번호가 서로 다릅니다. 두 서류를 대조해 잘못 기재된 서류를 보완한 뒤 기존 제출 경로로 보내 주세요.'),
    }),
  team(4, '재제출요청',
    '필수 제출 서류인 개인정보 수집·이용·제공 동의서가 누락되었습니다.',
    '개인정보 수집·이용·제공 동의서(02)가 누락되었습니다.',
    {
      docs: { '01': 'ok', '02': 'missing', '03': 'ok' },
      checks: checks({
        '문서 구성': { state: 'fail', detail: '02 동의서 없음' },
        '동의서 인원': NA('02가 없어 확인할 수 없음'),
        '동의 표시': NA('02가 없어 확인할 수 없음'),
      }),
      mail: redo('02 개인정보 동의서 제출',
        '개인정보 수집·이용·제공 동의서(02)가 접수되지 않았습니다. 팀원 전원이 작성한 02를 기존 제출 경로로 보내 주세요.'),
    }),
  team(5, '재제출요청',
    '개인정보 수집·이용·제공 동의서가 파일명만 다르게 중복 제출되었고, 필수 서류인 대표 신분증 사본 및 통장 사본 통합 파일이 누락되었습니다.',
    '02가 파일명만 다르게 중복 제출되었고, 03 대표 증빙이 없습니다.',
    {
      docs: { '01': 'ok', '02': 'duplicate', '03': 'missing' },
      checks: checks({
        '문서 구성': { state: 'fail', detail: '02 중복 · 03 없음' },
        '대표 신분증 성명': NA('03이 없어 확인할 수 없음'),
        예금주: NA('03이 없어 확인할 수 없음'),
        계좌번호: NA('03이 없어 확인할 수 없음'),
      }),
      mail: redo('02 중복 정리 · 03 대표 증빙 제출',
        '같은 동의서(02)가 두 번 접수되었고, 대표 신분증·통장 사본(03)이 없습니다. 최종 02 한 부와 03을 기존 제출 경로로 보내 주세요.'),
    }),
  team(6, '담당자확인',
    '통장 사본 사진의 초점이 흐려 계좌번호 일부를 확실히 판독할 수 없어 지급확인서의 대표 계좌번호와 일치하는지 확인할 수 없습니다.',
    '통장 사본이 흐려 계좌번호 일부를 판독할 수 없습니다.',
    {
      checks: checks({ 계좌번호: { state: 'check', detail: '03 통장 사본 흐림 · 일부 판독 불가', location: '03 p1' } }),
      mail: { state: 'waiting' },
    }),
  team(7, '재제출요청',
    '개인정보 수집·이용·제공 동의서에서 인적사항과 서명이 있는 학생 한 명의 제3자 제공 동의 칸이 비어 있어 필수 동의 표시가 누락되었습니다.',
    '02에서 학생 한 명의 제3자 제공 동의 칸이 비어 있습니다.',
    {
      checks: checks({ '동의 표시': { state: 'fail', detail: '1명 제3자 제공 동의 비어 있음', location: '02 p1' } }),
      mail: redo('02 제3자 제공 동의 표시',
        '동의서(02)에서 한 명의 제3자 제공 동의 칸이 비어 있습니다. 해당 학생이 표시한 02를 기존 제출 경로로 보내 주세요.'),
    }),
  team(8, '재제출요청',
    '수혜학생 신청 및 시상금 지급 확인서에서 성명과 전공이 기재된 팀원 한 명의 학번 칸이 비어 있어 필수 기재값이 누락되었습니다.',
    '01에서 팀원 한 명의 학번 칸이 비어 있습니다.',
    {
      checks: checks({ '팀원 필수 정보': { state: 'fail', detail: '팀원 1명 학번 비어 있음', location: '01 p1' } }),
      mail: redo('01 팀원 학번 기재',
        '신청서(01)에서 팀원 한 명의 학번 칸이 비어 있습니다. 학번을 기재한 01을 기존 제출 경로로 보내 주세요.'),
    }),
  team(9, '재제출요청',
    '개인정보 수집·이용·제공 동의서에서 인적사항과 동의 표시가 있는 학생 한 명의 서명란에 서명 이미지가 없어 필수 서명이 누락되었습니다.',
    '02에서 학생 한 명의 서명란에 서명이 없습니다.',
    {
      checks: checks({ 서명: { state: 'fail', detail: '02에서 1명 서명 없음', location: '02 p1' } }),
      mail: redo('02 서명 누락',
        '동의서(02)에서 한 명의 서명란이 비어 있습니다. 서명한 02를 기존 제출 경로로 보내 주세요.'),
    }),
  team(10, '재제출요청',
    '지급확인서에 기재된 팀원 4명 중 1명이 개인정보 수집·이용·제공 동의서의 수혜인력 명단에서 누락되어 전원 동의 요건을 충족하지 못했습니다.',
    '01 팀원 4명 중 1명이 02 동의서 명단에 없습니다.',
    {
      checks: checks({ '동의서 인원': { state: 'fail', detail: '01 팀원 1명이 02에 없음', location: '02' } }),
      mail: redo('02 동의서 명단 누락 팀원',
        '신청서(01)의 팀원 중 한 명이 동의서(02)에 없습니다. 팀원 전원이 작성한 02를 기존 제출 경로로 보내 주세요.'),
    }),
];

export const assignQueue: AssignItem[] = [
  {
    id: 'f-autoai-03',
    fileName: '01_[원본 파일명]',
    classifiedAs: '03 대표 증빙',
    status: 'pending',
    candidate: 'AutoAI',
    reason:
      '파일명은 01_로 시작하지만 본문은 신분증·통장 사본입니다. 신분증 성명이 AutoAI 대표와 같지만, 파일명과 본문 어디에도 팀명이 없어 후보로만 표시합니다.',
    evidence: [
      { label: '신분증 성명 ↔ 01 대표', result: '일치', tone: 'ok' },
      { label: '파일명·본문의 팀명', result: '없음', tone: 'warn' },
      { label: '같은 대회 동명이인', result: '발견 안 됨', tone: 'neutral' },
      { label: '예금주·계좌번호', result: '소속 판단에 쓰지 않음', tone: 'neutral' },
    ],
  },
  { id: 'f-nextify-01', fileName: '[Nextify 신청서].hwp', classifiedAs: '01 신청서', status: 'auto', team: 'Nextify', reason: '본문 팀명·대표 일치' },
  { id: 'f-nextify-02', fileName: '[Nextify 동의서].hwp', classifiedAs: '02 동의서', status: 'auto', team: 'Nextify', reason: '작성자 전원이 01 명단과 일치' },
  { id: 'f-autoai-01', fileName: '[AutoAI 신청서].hwp', classifiedAs: '01 신청서', status: 'auto', team: 'AutoAI', reason: '본문 팀명·대표 일치' },
  { id: 'f-autoai-02', fileName: '[AutoAI 동의서].hwp', classifiedAs: '02 동의서', status: 'auto', team: 'AutoAI', reason: '작성자 전원이 01 명단과 일치' },
];

/** 공식 ZIP의 HWP 21개 + HWPX 8개 */
export const TOTAL_INTAKE_FILES = 29;

export const mails: MailRecord[] = submissions.map((s) => ({
  submissionId: s.id,
  teamName: s.teamName,
  version: s.version,
  kind: s.verdict === '재제출요청' ? '보완 요청' : s.verdict === '담당자확인' ? '결과 안내' : '—',
  subject:
    s.mail.subject ?? (s.verdict === '담당자확인' ? '원본 대조 후 결과 안내 예정' : '최초 정상 제출 · 보낼 안내 없음'),
  state: s.mail.state,
}));

export const adminAlerts: AdminAlert[] = submissions
  .filter((s) => s.verdict !== '성공')
  .map((s) => ({ submissionId: s.id, teamName: s.teamName, message: s.summary, verdict: s.verdict }));
