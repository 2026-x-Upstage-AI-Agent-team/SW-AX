// 검토 서비스(service/static/common.js)와 같은 상태·서류 표기

export const stateLabels: Record<string, string> = {
  preparing: '파일 판독 중',
  conflict: '보완본 담당자 확인',
  conflict_reviewed: '보완본 확인 완료',
  review: '팀 배정 확인',
  assigned: '배정 완료',
  read: '파일 판독 완료',
  waiting: '대기',
  recipient_check: '수신자 확인 필요',
  unassigned: '팀 배정 확인',
  outside: '대상 외',
  error: '파일 확인',
  queued: '처리 대기',
  running: '판정 처리 중',
  blocked: '판정 보류',
  superseded: '이전 버전',
  creating: '실행 요청 중',
  polling: 'Studio 검토 중',
  uncertain: '실행 이력 확인',
  access: '접근 권한 확인',
  paused: '운영 확인',
  invalid: '결과 형식 확인',
  failed: '처리 실패',
  ownership: '소속 재확인',
  done: '검토 완료',
  printing: '전용 PC 출력 대기',
  verifying: '출력 검증 중',
  building: '문서 생성 중',
  preview: '미리보기 준비',
  confirmed: '제출본 확정',
  sent: '발송 완료',
  local: '로컬 수신',
  sending: '발송 중',
  obsolete: '이전 버전',
  received: '원본 접수 완료',
};

export const stateLabel = (state?: string | null) => (state ? stateLabels[state] ?? state : '—');

export const docLabels: Record<string, string> = {
  '01': '지급확인서',
  '02': '개인정보 동의서',
  '03': '신분증·통장 사본',
  '00': '출력 양식',
  '?': '종류 확인',
};

export const issueLabels: Record<string, string> = {
  application: '지급확인서',
  consent: '동의서·작성자',
  identity: '신분증·통장',
  account: '계좌·예금주',
  signature: '동의·서명',
  affiliation: '소속 표기',
  duplicate: '중복 제출',
  student_id: '학번 기재란',
  representative: '대표 성명 대조',
  other: '기타 원본 확인',
};

/** Studio Job 처리가 진행 중인 상태 */
export const busyStates = new Set(['queued', 'running', 'printing', 'verifying', 'creating', 'polling', 'preparing', 'building', 'sending']);

/** 담당자가 재개를 눌러야 하는 제출본 상태 */
export const recoverableStates = new Set(['failed', 'uncertain', 'invalid', 'paused', 'access']);

export const ADMIN_NOTICE = '담당자 알림';

export const when = (ts?: number | null) =>
  ts
    ? new Date(ts * 1000).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    : '—';
