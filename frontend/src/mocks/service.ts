// 검토 서비스에 연결하지 않았을 때 보여 줄 예시 데이터. 응답 형태는 service/app.py와 같다.
// 판정·근거는 output/json/유잇_미션2_answer.json(set01–set10) 기준이다.
// set03–set10은 공식 자료에 팀명이 없어 "테스트 팀 NN"으로 표기한다.
// 학생 이름·학번·계좌 등 개인정보는 넣지 않는다.
import type {
  BatchDetail,
  Check,
  Dashboard,
  DashTeam,
  DocKey,
  DraftTeam,
  FileInfo,
  MailRow,
  MailView,
  Member,
  Ref,
  SubInfo,
  SubmissionDetail,
  Verdict,
} from '../api/service';

const T0 = 1794100000; // 2026-11-08 경 (초)
const EVENT = { id: 'wave', name: 'WAVE 2026 대학생 AI/SW 아이디어 피칭대회' }; // service/db.py의 기본 대회

type Spec = {
  n: number;
  name?: string;
  verdict: Verdict;
  reason: string;
  /** 서류 종류별 부수 */
  docs?: Partial<Record<'01' | '02' | '03', number>>;
  /** 실패한 검사 [라벨, 서류 종류, 행, passed] */
  fails?: Array<[string, Array<'01' | '02' | '03'>, number?, (boolean | null)?]>;
  issues?: string[];
  members?: number;
};

const specs: Spec[] = [
  {
    n: 1,
    name: 'Nextify',
    verdict: '성공',
    reason:
      '필수 서류 세 유형이 모두 제출되었고, 팀원 4명의 필수 정보·동의 표시·서명이 갖춰져 있으며 대표 인적사항과 은행·계좌정보가 문서 간 일치합니다.',
    members: 4,
  },
  {
    n: 2,
    name: 'AutoAI',
    verdict: '성공',
    reason:
      "필수 서류와 동의·서명 요건이 충족되며, 통장 이미지의 배치가 달라도 은행명·예금주·계좌번호를 확인할 수 있습니다. 지급확인서의 '국민'과 통장 사본의 'KB국민은행'은 같은 은행의 표기 차이이고, 정규화 후 대표 정보와 계좌정보가 일치합니다.",
    members: 3,
  },
  {
    n: 3,
    verdict: '재제출요청',
    reason: '수혜학생 신청 및 시상금 지급 확인서의 대표 계좌번호와 통장 사본의 계좌번호가 끝자리에서 서로 다릅니다.',
    fails: [['대표 계좌·예금주 일치', ['01', '03']]],
    issues: ['account'],
  },
  {
    n: 4,
    verdict: '재제출요청',
    reason: '필수 제출 서류인 개인정보 수집·이용·제공 동의서가 누락되었습니다.',
    docs: { '02': 0 },
    issues: ['consent'],
  },
  {
    n: 5,
    verdict: '재제출요청',
    reason:
      '개인정보 수집·이용·제공 동의서가 파일명만 다르게 중복 제출되었고, 필수 서류인 대표 신분증 사본 및 통장 사본 통합 파일이 누락되었습니다.',
    docs: { '02': 2, '03': 0 },
    issues: ['duplicate', 'identity'],
  },
  {
    n: 6,
    verdict: '담당자확인',
    reason:
      '통장 사본 사진의 초점이 흐려 계좌번호 일부를 확실히 판독할 수 없어 지급확인서의 대표 계좌번호와 일치하는지 확인할 수 없습니다.',
    fails: [['통장 사본 계좌번호 판독', ['03'], undefined, null]],
    issues: ['account'],
  },
  {
    n: 7,
    verdict: '재제출요청',
    reason:
      '개인정보 수집·이용·제공 동의서에서 인적사항과 서명이 있는 학생 한 명의 제3자 제공 동의 칸이 비어 있어 필수 동의 표시가 누락되었습니다.',
    fails: [['팀원 C · 동의 표시 또는 서명 확인', ['01', '02'], 3]],
    issues: ['signature'],
  },
  {
    n: 8,
    verdict: '재제출요청',
    reason:
      '수혜학생 신청 및 시상금 지급 확인서에서 성명과 전공이 기재된 팀원 한 명의 학번 칸이 비어 있어 필수 기재값이 누락되었습니다.',
    fails: [['팀원 학번 기재', ['01'], 2]],
    issues: ['application'],
  },
  {
    n: 9,
    verdict: '재제출요청',
    reason:
      '개인정보 수집·이용·제공 동의서에서 인적사항과 동의 표시가 있는 학생 한 명의 서명란에 서명 이미지가 없어 필수 서명이 누락되었습니다.',
    fails: [['팀원 B · 동의 표시 또는 서명 확인', ['01', '02'], 2]],
    issues: ['signature'],
  },
  {
    n: 10,
    verdict: '재제출요청',
    reason:
      '지급확인서에 기재된 팀원 4명 중 1명이 개인정보 수집·이용·제공 동의서의 수혜인력 명단에서 누락되어 전원 동의 요건을 충족하지 못했습니다.',
    fails: [
      ['신청 명단과 동의서 작성자 일치', ['01', '02']],
      ['팀원 D · 동의서 명단에 없음', ['01', '02'], 4],
    ],
    issues: ['consent'],
    members: 4,
  },
];

const pad = (n: number) => String(n).padStart(2, '0');
const docTitle: Record<'01' | '02' | '03', string> = { '01': '지급확인서', '02': '동의서', '03': '신분증·통장' };

function build(spec: Spec) {
  const set = 'set' + pad(spec.n);
  const teamId = 'team-' + set;
  const sid = 'sub-' + set;
  const name = spec.name ?? `테스트 팀 ${pad(spec.n)}`;
  const count = { '01': 1, '02': 1, '03': 1, ...spec.docs };

  const files: FileInfo[] = [];
  const documents: Record<DocKey, Ref[]> = { '01': [], '02': [], '03': [], '?': [] };
  (['01', '02', '03'] as const).forEach((kind) => {
    for (let i = 0; i < count[kind]; i++) {
      const id = `${set}-${kind}${i ? '-' + (i + 1) : ''}`;
      files.push({
        id,
        name: `${kind}. ${docTitle[kind]}${i ? ` (${i + 1})` : ''}.hwp`,
        kind,
        state: 'assigned',
        team: teamId,
        reason: '본문 팀명·대표 일치',
        pages: kind === '02' ? 2 : 1,
        size: 48_000 + spec.n * 1000,
        candidates: [teamId],
        excluded: [],
        page: 1,
        url: '',
      });
      documents[kind].push({ id, page: 1 });
    }
  });

  const refs = (kinds: Array<'01' | '02' | '03'>, row?: number) =>
    kinds.flatMap((k) => documents[k].map((r) => (row ? { ...r, row } : r)));

  const checks: Check[] = (['01', '02', '03'] as const).map((k) => ({
    label: `${docTitle[k]} ${count[k]}부 접수`,
    passed: count[k] === 1,
    refs: refs([k]),
  }));
  const failed = new Set((spec.fails ?? []).map(([label]) => label));
  if (count['02']) {
    if (!failed.has('신청 명단과 동의서 작성자 일치'))
      checks.push({ label: '신청 명단과 동의서 작성자 일치', passed: true, refs: refs(['01', '02']) });
    checks.push({ label: '신청서·동의서 소속 표기 일치', passed: true, refs: refs(['01', '02']) });
  }
  if (count['03'] && !failed.has('대표 계좌·예금주 일치'))
    checks.push({ label: '대표 계좌·예금주 일치', passed: !failed.has('통장 사본 계좌번호 판독'), refs: refs(['01', '03']) });
  for (const [label, kinds, row, passed] of spec.fails ?? [])
    checks.push({ label, passed: passed === undefined ? false : passed, refs: refs(kinds, row) });
  if (spec.fails?.some(([, , , p]) => p === null)) {
    const i = checks.findIndex((c) => c.label === '대표 계좌·예금주 일치');
    if (i >= 0) checks[i] = { ...checks[i], passed: null };
  }

  const size = spec.members ?? 3;
  const members: Member[] = Array.from({ length: size }, (_, i) => ({
    role: i === 0 ? '대표' : '팀원',
    name: i === 0 ? '팀장 A' : `팀원 ${String.fromCharCode(65 + i)}`,
    student_id: spec.n === 8 && i === 1 ? '' : '[학번]',
    major: '[전공]',
    school: '[학교]',
  }));

  const leaderMail = spec.verdict === '재제출요청';
  const mails: MailRow[] = [];
  if (spec.verdict !== '성공')
    mails.push({ id: `mail-${set}-admin`, submission: sid, kind: '담당자 알림', state: 'local', sent_to: '[담당자 Gmail]', created: T0 + spec.n * 60, version: 1, name });
  if (leaderMail)
    mails.push({ id: `mail-${set}-leader`, submission: sid, kind: '보완 요청', state: 'local', sent_to: '[팀장 이메일]', created: T0 + spec.n * 60 + 5, version: 1, name });

  const info: SubInfo = {
    id: sid,
    team: teamId,
    version: 1,
    created: T0 + spec.n * 60,
    updated: T0 + spec.n * 60 + 40,
    state: 'done',
    error: '',
    job: `job_example_${set}`,
    decision: null,
    revision: 0,
    attempts: 0,
    verdict: spec.verdict,
    students: size,
    count: files.length,
    award_type: '',
    support_amount: '',
    status_url: `/api/submissions/${sid}`,
  };

  const detail: SubmissionDetail = {
    ...info,
    team_name: name,
    rep: '팀장 A',
    email: leaderMail ? '[팀장 이메일]' : '',
    held: false,
    current: sid,
    note: '',
    fields: { members, recipient: { bank_name: '[은행명]', account_number: '[계좌번호]', account_holder: '팀장 A', rrn_display: '' }, award_type: '', support_amount: '' },
    result: {
      verdict: spec.verdict,
      reason: spec.reason,
      program: EVENT.name,
      team_name: name,
      rep: '팀장 A',
      members,
      recipient: {},
      documents,
      checks,
      issues: spec.issues ?? [],
      consent_names: members.map((m) => m.name),
      staff_report: '',
    },
    files,
    history: [{ id: sid, version: 1, state: 'done', job: info.job, decision: null }],
    mail: mails,
    audit: [{ ts: info.updated, action: 'Studio 판정', actor: '서비스' }],
  };

  const team: DashTeam = { id: teamId, name, rep: '팀장 A', email: detail.email, current: sid, held: false, submission: info };
  return { team, detail, mails };
}

const built = specs.map(build);

const pendingFile: FileInfo = {
  id: 'file-unassigned',
  name: '01_[원본 파일명].hwp',
  kind: '03',
  state: 'unassigned',
  team: null,
  reason: '파일명은 01_로 시작하지만 본문은 신분증·통장 사본입니다. 신분증 성명이 AutoAI 대표와 같지만 파일명과 본문에 팀명이 없어 후보로만 표시합니다.',
  pages: 1,
  size: 61_000,
  candidates: ['team-set02'],
  excluded: [],
  page: 1,
  url: '',
};

const exampleBatch: BatchDetail = {
  id: 'batch-example',
  event: EVENT.id,
  state: 'review',
  revision: 3,
  created: T0,
  target: null,
  base: null,
  files: [pendingFile, ...built.slice(0, 2).flatMap((b) => b.detail.files)],
  teams: built.slice(0, 2).map((b) => ({ team: b.team.id, submission_id: b.detail.id, status_url: b.detail.status_url })),
};

const delay = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(structuredClone(value)), 120));
const missing = () => Promise.reject(new Error('예시 데이터에 없는 항목입니다.'));

export const dashboard = () =>
  delay<Dashboard>({
    events: [EVENT],
    teams: built.map((b) => b.team),
    batches: [{ id: exampleBatch.id, state: exampleBatch.state, created: T0, count: 29, pending: 1 }],
    reports: [],
    mail: built.flatMap((b) => b.mails).reverse(),
    smtp: false,
    gmail_account: null,
    gmail_oauth_connected: false,
    mail_ready: true,
    config: '23',
    connected: false,
    event: EVENT.id,
  });

export const submission = (sid: string) => {
  const found = built.find((b) => b.detail.id === sid);
  return found ? delay(found.detail) : missing();
};

export const batch = (bid: string) => (bid === exampleBatch.id ? delay(exampleBatch) : missing());

export const draft = () =>
  delay<{ teams: DraftTeam[] }>({
    teams: built.map(({ team, detail }) => ({
      ...detail.fields,
      team: team.name,
      submission: detail.id,
      rep: team.rep,
      version: detail.version,
      pending: [
        ...(detail.decision !== '승인' ? ['현재 제출본 승인'] : []),
        ...(!detail.fields.award_type || !detail.fields.support_amount ? ['시상구분·지원액 입력'] : []),
      ],
    })),
  });

export const mail = (mid: string) => {
  for (const b of built) {
    const m = b.mails.find((x) => x.id === mid);
    if (m)
      return delay<MailView>({
        ...m,
        subject: `[시상금 서류 ${m.kind}] ${b.team.name}`,
        body:
          m.kind === '담당자 알림'
            ? `${b.team.name} 팀의 1차 서류 판정은 ${b.detail.verdict}입니다.\n담당자 PC의 ‘팀별 서류 검토’에서 원본과 확인 항목을 열어 주세요.`
            : `${b.team.name} 팀장님, 제출 1차 서류의 검토 결과입니다.\n\n${b.detail.result?.reason ?? ''}\n보완한 서류는 기존 제출 경로로 담당자에게 보내 주세요.`,
      });
  }
  return missing();
};
