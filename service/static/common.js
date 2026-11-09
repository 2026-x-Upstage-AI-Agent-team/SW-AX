export const $ = (s) => document.querySelector(s);
export const esc = (x) =>
  String(x ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const paths = {
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  inbox: "M3 13l3-8h12l3 8v6H3z M3 13h5l2 3h4l2-3h5",
  files: "M7 3h8l4 4v13H7z M15 3v5h4 M4 7v15h11 M10 12h6 M10 15h4",
  book: "M5 3h14v18H6a2 2 0 0 1 0-4h13 M8 7h7 M8 10h5",
  mail: "M3 5h18v14H3z M3 6l9 7 9-7",
  upload: "M12 16V3m-5 5 5-5 5 5 M4 15v5h16v-5",
  users:
    "M14 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2 M12 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0 M16 4a3.5 3.5 0 0 1 0 7 M17 14c3 0 4 2 4 5",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l3 2",
  check: "M20 6l-10 12-6-6",
  folder: "M3 6h7l2 2h9v12H3z",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  download: "M12 3v13m-5-5 5 5 5-5 M4 17v4h16v-4",
};
export function icon(k) {
  return (
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + (paths[k] || paths.files) + '"/></svg>'
  );
}
export const when = (timestamp) =>
  timestamp
    ? new Date(timestamp * 1000).toLocaleString("ko-KR", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "—";
export const states = {
  preparing: "파일 판독 중",
  review: "팀 배정 확인",
  assigned: "배정 완료",
  read: "파일 판독 완료",
  waiting: "대기",
  draft: "승인 대기",
  approved: "승인됨 · 발송 대기",
  unassigned: "팀 배정 확인",
  outside: "대상 외",
  error: "파일 확인",
  queued: "처리 대기",
  creating: "실행 요청 중",
  polling: "Studio 검토 중",
  uncertain: "실행 이력 확인",
  access: "접근 권한 확인",
  paused: "운영 확인",
  invalid: "결과 형식 확인",
  failed: "처리 실패",
  ownership: "소속 재확인",
  done: "검토 완료",
  building: "문서 생성 중",
  preview: "미리보기 준비",
  confirmed: "제출본 확정",
  sent: "발송 접수",
  local: "로컬 수신",
  sending: "발송 중",
  obsolete: "이전 버전",
};
export const types = {
  "01": "지급확인서",
  "02": "개인정보 동의서",
  "03": "신분증·통장 사본",
  "00": "출력 양식",
  "?": "종류 확인",
};
export const issueOptions = {
  application: "지급확인서",
  consent: "동의서·작성자",
  identity: "신분증·통장",
  account: "계좌·예금주",
  signature: "동의·서명",
  affiliation: "소속 표기",
  duplicate: "중복 제출",
  other: "기타 원본 확인",
};
export function badge(value) {
  const color = ["성공", "승인", "assigned", "confirmed", "sent", "local", "done"].includes(value)
    ? "good"
    : [
          "담당자확인",
          "review",
          "unassigned",
          "ownership",
          "access",
          "uncertain",
          "paused",
          "invalid",
          "보완 필요",
        ].includes(value)
      ? "warn"
      : ["재제출요청", "failed", "error"].includes(value)
        ? "bad"
        : ["polling", "preparing", "building", "creating", "preview"].includes(value)
          ? "blue"
          : "";
  return '<span class="badge ' + color + '">' + esc(states[value] || value || "대기") + "</span>";
}
export function head(title, desc, action = "") {
  return (
    '<div class="title"><div><h1>' +
    esc(title) +
    "</h1><p>" +
    esc(desc) +
    "</p></div>" +
    action +
    "</div>"
  );
}
export function section(title, action = "") {
  return '<div class="section-head"><h2>' + esc(title) + "</h2>" + action + "</div>";
}
export function empty(title, detail = "", glyph = "folder") {
  return (
    '<div class="empty">' + icon(glyph) + "<strong>" + esc(title) + "</strong>" + esc(detail) + "</div>"
  );
}
export function field(label, id, value = "", type = "text") {
  return (
    '<label class="field">' +
    esc(label) +
    '<input type="' +
    type +
    '" id="' +
    id +
    '" value="' +
    esc(value) +
    '"></label>'
  );
}
export function teamOptions(teams, selected = "") {
  return teams
    .map(
      (t) =>
        '<option value="' +
        t.id +
        '" ' +
        (t.id === selected ? "selected" : "") +
        ">" +
        esc(t.name) +
        (t.rep ? " · " + esc(t.rep) : "") +
        "</option>",
    )
    .join("");
}
export async function api(path, method = "GET", data) {
  const h = { "X-Award-Client": "staff" };
  let body;
  if (data instanceof FormData) body = data;
  else if (data !== undefined) {
    h["Content-Type"] = "application/json";
    body = JSON.stringify(data);
  }
  const r = await fetch(path, { method, headers: h, body });
  const v = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(typeof v.detail === "string" ? v.detail : "입력값과 연결 상태를 확인하세요.");
  return v;
}
let noticeTimer;
export function notice(message) {
  const n = $("#notice");
  n.textContent = message;
  n.className = "show";
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (n.className = ""), 6500);
}
export function modal(title, content) {
  $("#dialog-content").innerHTML =
    section(title, '<button type="button" class="icon-btn" data-close aria-label="닫기">✕</button>') +
    content;
  $("#dialog").showModal();
  $("[data-close]").onclick = () => $("#dialog").close();
}
export function teamTable(teams) {
  if (!teams.length)
    return empty("아직 접수된 팀이 없습니다", "신청서를 접수하면 팀별 검토 현황이 표시됩니다.", "users");
  return (
    '<div class="table-scroll"><table><thead><tr><th>팀명 / 대표</th><th>제출본</th><th>검토 상태</th><th>담당자 결론</th></tr></thead><tbody>' +
    teams
      .map((t) => {
        const s = t.submission;
        return (
          "<tr><td>" +
          (s
            ? '<a class="team-link" href="#review/' + s.id + '">' + esc(t.name) + "</a>"
            : "<strong>" + esc(t.name) + "</strong>") +
          "<small>" +
          esc(t.rep || "대표 확인 전") +
          "</small></td><td>" +
          (s ? s.version + "차 · " + s.count + "부" : "배정 중") +
          "</td><td>" +
          badge(t.held ? "unassigned" : s?.verdict || s?.state || "waiting") +
          "</td><td>" +
          esc(s?.decision || "—") +
          "</td></tr>"
        );
      })
      .join("") +
    "</tbody></table></div>"
  );
}
export function previewFrame(url, page = 1, extra = "") {
  return (
    '<iframe title="원문 PDF 미리보기" class="docview ' +
    extra +
    '" src="' +
    esc(url) +
    "#page=" +
    Number(page) +
    '&amp;view=FitH"></iframe>'
  );
}

export function editDocumentLink(file) {
  const href = "/document-editor#/files/" + encodeURIComponent(file.id) + "/edit?from=" + encodeURIComponent(location.hash.slice(1));
  return '<a target="_blank" rel="noopener" href="' + esc(href) + '">한글 문서 편집</a>';
}

export function documentPreviewFrame(file, page = 1, original = false) {
  const query = new URLSearchParams({ page: String(page), pdf: file.url ? '1' : '0' });
  if (original) query.set('source', 'original');
  const url = '/document-editor#/files/' + encodeURIComponent(file.id) + '/preview?' + query;
  return '<iframe class="docview" title="' + esc(file.name + ' 문서 미리보기') + '" src="' + esc(url) + '"></iframe>';
}
