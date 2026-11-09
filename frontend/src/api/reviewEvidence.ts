import { docLabels, issueLabels } from './labels';
import type { Check, DocKey, Ref, StudioResult, Verdict } from './service';

const kinds = ['01', '02', '03'] as const;
type Kind = (typeof kinds)[number];

// Only display labels from the form. Studio's observations can contain the actual account or ID.
const reportFields: Record<string, [Kind, string]> = {
  issued_date: ['03', '신분증 발급일'], identity_name: ['03', '신분증 성명'],
  identity_birth_date: ['03', '신분증 생년월일'], identity_type: ['03', '신분증 종류'],
  bank_name: ['03', '통장 은행명'], account_holder: ['03', '통장 예금주'], account_number: ['03', '통장 계좌번호'],
  student_id: ['01', '신청서 학번'], representative_student_id: ['01', '대표 학번'],
  representative_phone: ['01', '대표 전화번호'], representative_email: ['01', '대표 이메일'],
  representative_name: ['01', '대표 성명'], representative_account: ['01', '신청서 계좌번호'],
  representative_signed: ['01', '대표 서명'], applicant_signed: ['01', '신청인 서명'],
  project_name: ['02', '동의서 과제명'], collection_consent: ['02', '개인정보 수집·이용 동의'],
  identifier_consent: ['02', '고유식별정보 처리 동의'], third_party_consent: ['02', '제3자 제공 동의'],
  signed: ['02', '동의서 서명'],
};

function reportedFields(report: StudioResult['staff_report']) {
  const findings: Array<{ kind: Kind; label: string }> = [];
  if (typeof report !== 'string') return findings;
  let field = -1, result = -1, observation = -1;
  for (const line of report.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('|')) { field = -1; continue; }
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.replace(/[`*]/g, '').trim());
    const verdict = cells.findIndex(c => /^(결과|판정)$/.test(c));
    if (verdict >= 0) {
      result = verdict;
      field = cells.findIndex(c => /^(항목|필드|필드명|검사 필드|검사 항목|필수 항목)$/.test(c));
      observation = cells.findIndex(c => /^(관측 상태|추출값|실제값)$/.test(c));
      continue;
    }
    const item = field >= 0 && Object.hasOwn(reportFields, cells[field]) ? reportFields[cells[field]] : undefined;
    if (!item || !/^(실패|누락|미통과|불일치)$/.test(cells[result])) continue;
    const empty = /빈\s*(값|문자열)|미기재|^없음|^""/.test(cells[observation] ?? '');
    findings.push({ kind: item[0], label: item[1] + (empty ? ' 미기재' : ' 확인') });
  }
  return findings;
}

const checksByLabel: Record<string, [string, Kind[]]> = {
  '신청 명단과 동의서 작성자 일치': ['동의서 작성자 명단 대조', ['01', '02']],
  '동의서 명단에 없음': ['동의서 작성자 명단 대조', ['01', '02']],
  '신청서·동의서 소속 표기 일치': ['신청서·동의서 소속 표기 대조', ['01', '02']],
  '소속 표기 대조': ['신청서·동의서 소속 표기 대조', ['01', '02']],
  '동의 표시 또는 서명 확인': ['동의 표시·서명 확인', ['02']],
  '대표 계좌·예금주 일치': ['지급확인서·통장 계좌 정보 대조', ['01', '03']],
  '통장 계좌 신뢰도': ['통장 계좌 기재란 확인', ['03']], '확인서 계좌 신뢰도': ['신청서 계좌 기재란 확인', ['01']],
  '대표 계좌 길이': ['신청서 계좌번호 확인', ['01']], '학번 길이': ['신청서 학번 확인', ['01']],
  '전화 길이': ['신청서 전화번호 확인', ['01']], '이메일 길이': ['신청서 이메일 확인', ['01']],
  '과제명': ['동의서 과제명 확인', ['02']], '작성일 길이': ['작성일 확인', []],
  '대표 서명': ['대표 서명 확인', ['01']], '신청인 서명': ['신청인 서명 확인', ['01']],
};

/** A display-only view of the stored verdict. Keep evidence links when repeated findings are combined. */
export function reviewEvidence(result?: StudioResult | null, verdict?: Verdict | null) {
  const problems: Check[] = [], passed: Check[] = [];
  const decision = verdict ?? result?.verdict;
  if (!decision) return { summary: '', problems, passed };
  function add(label: string, state: Check['passed'], refs: Ref[]) {
    const list = state === true ? passed : problems;
    let entry = list.find(item => item.label === label);
    if (!entry) { entry = { label, passed: state, refs: [] }; list.push(entry); }
    if (state === false) entry.passed = false;
    for (const ref of refs) {
      if (!entry.refs.some(r => r.id === ref.id && r.page === ref.page && r.row === ref.row)) entry.refs.push(ref);
    }
  }
  const docs = result?.documents;
  const missing = new Set<DocKey>();
  const receipt = /^(지급확인서|동의서|신분증·통장) (\d{1,3})부 접수$/;
  const checks = result?.checks ?? [];
  const hasDocumentRefs = Object.values(docs ?? {}).some(refs => refs.length > 0);
  const receiptTitles = { '01': '지급확인서', '02': '동의서', '03': '신분증·통장' };
  for (const kind of kinds) {
    const refs = docs?.[kind];
    const name = docLabels[kind];
    // Older results can contain only a verdict and three placeholder empty arrays.
    const counted = checks.find(c => c.label.startsWith(receiptTitles[kind] + ' ') && receipt.test(c.label));
    const count = counted ? parseInt(counted.label.split(' ')[1], 10) : hasDocumentRefs ? refs?.length : undefined;
    if (count === undefined) continue;
    if (count === 0) {
      missing.add(kind);
      if (docs?.['?']?.length) add(name + ' 접수 여부 확인', null, docs['?']);
      else add(name + ' 미제출', false, []);
    } else if (count > 1) add(name + ' 중복 제출 (' + count + '부)', false, counted?.refs ?? refs ?? []);
    else add(name + ' 1부 접수', true, counted?.refs ?? refs ?? []);
  }

  if (result && decision !== '성공') {
    for (const { kind, label } of reportedFields(result.staff_report)) {
      if (!missing.has(kind)) add(label, false, docs?.[kind] ?? []);
    }
  }
  const unlabelled: Ref[] = [];
  for (const check of checks) {
    if (receipt.test(check.label)) continue;
    const key = check.label.split(' · ').at(-1) ?? '';
    const rule = Object.hasOwn(checksByLabel, key) ? checksByLabel[key] : undefined;
    if (!rule) {
      if (check.passed === true) continue;
      if (result?.reason?.includes(check.label)) {
        unlabelled.push(...check.refs);
        continue;
      }
      const fields = (check.fields ?? []).filter(f => Object.hasOwn(reportFields, f));
      if (fields.length) {
        for (const field of fields) {
          const [kind, label] = reportFields[field];
          if (!missing.has(kind)) add(label + ' 확인', check.passed, check.refs);
        }
      } else {
        const issue = check.issue;
        const label = issue && issue !== 'other' && Object.hasOwn(issueLabels, issue) ? issueLabels[issue] + ' 확인' : '제출 서류 원본 확인';
        add(label, check.passed, check.refs);
      }
      continue;
    }
    if (rule[1].some(kind => missing.has(kind))) continue;
    add(check.passed === true ? key : rule[0], check.passed, check.refs);
  }
  if (result && !problems.length && decision !== '성공') {
    for (const issue of result.issues ?? []) {
      if (issue !== 'other' && Object.hasOwn(issueLabels, issue)) add(issueLabels[issue] + ' 확인', null, unlabelled);
    }
    if (!problems.length) add('제출 서류 원본 확인', null, unlabelled);
  }
  const summary = decision === '성공' ? '보완 사항 없음' : problems.length
    ? problems.slice(0, 2).map(c => c.label).join(' · ') + (problems.length > 2 ? ' 외 ' + (problems.length - 2) + '건' : '')
    : '검토 상세에서 확인';
  return { summary, problems, passed };
}
