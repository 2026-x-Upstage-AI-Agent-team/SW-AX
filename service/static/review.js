import {
  $,
  api,
  badge,
  empty,
  esc,
  field,
  head,
  icon,
  issueOptions,
  modal,
  notice,
  documentPreviewFrame,
  editDocumentLink,
  section,
  teamTable,
  types,
  when,
} from "./common.js";
import { openUpload } from "./intake.js";

export function reviewsPage(d) {
  return (
    head("팀별 서류 검토", "팀을 선택해 원문, Studio 판정, 담당자 결론을 함께 확인합니다.") +
    '<section class="panel">' +
    section("접수 팀 " + d.teams.length + "개") +
    teamTable(d.teams) +
    "</section>"
  );
}
const payout = {
  rrn_display: "주민번호 · 마스킹 표기",
  bank_name: "은행명",
  account_number: "계좌번호",
  account_holder: "예금주",
};
const person = { role: "구분", name: "성명", student_id: "학번", major: "전공", school: "학교" };
function personRow(m) {
  return (
    "<tr>" +
    Object.keys(person)
      .map(
        (k) =>
          '<td><input aria-label="' +
          person[k] +
          '" data-key="' +
          k +
          '" value="' +
          esc(m[k] || "") +
          '"></td>',
      )
      .join("") +
    '<td><button type="button" class="icon-btn del-member" aria-label="명단 행 제외">✕</button></td></tr>'
  );
}
function reviewFields(s) {
  const f = s.fields;
  return (
    '<form class="panel stack" id="review-form">' +
    section("담당자 서류 검토") +
    "<details " +
    (s.state === "done" ? "open" : "") +
    "><summary>학생 명단 " +
    f.members.length +
    '명</summary><div class="table-scroll"><table class="member-edit"><thead><tr>' +
    Object.values(person)
      .map((v) => "<th>" + v + "</th>")
      .join("") +
    '<th></th></tr></thead><tbody id="people">' +
    f.members.map(personRow).join("") +
    '</tbody></table></div><button type="button" id="add-person" class="sm">학생 추가</button></details>' +
    '<details><summary>대표 계좌·신원 대조</summary><div class="fields">' +
    Object.entries(payout)
      .map(([k, label]) => field(label, "pay-" + k, f.recipient[k]))
      .join("") +
    "</div></details>" +
    '<label class="field">검토 결론<select id="decision">' +
    ["작성 중", "승인", "보완 필요"]
      .map(
        (v) =>
          "<option " +
          (s.decision === v ? "selected" : "") +
          ' value="' +
          v +
          '">' +
          { "작성 중": "작성 중", 승인: "이상 없음 · 제출본 승인", "보완 필요": "보완 필요" }[v] +
          "</option>",
      )
      .join("") +
    '</select></label><div id="issue-box" ' +
    (s.decision === "보완 필요" ? "" : "hidden") +
    '><b>팀장 안내 항목</b><div class="checklist">' +
    Object.entries(issueOptions)
      .map(
        ([k, v]) =>
          '<label><input type="checkbox" name="issue" value="' +
          k +
          '" ' +
          ((s.result?.issues || []).includes(k) ? "checked" : "") +
          ">" +
          v +
          "</label>",
      )
      .join("") +
    "</div></div>" +
    '<label class="field">원본 대조 기록<textarea id="review-note" placeholder="확인한 원본과 판단 근거">' +
    esc(s.note) +
    '</textarea></label><button class="primary" ' +
    (s.state !== "done" || s.held || s.current !== s.id ? "disabled" : "") +
    ">검토 저장</button></form>"
  );
}

export function reviewPage(d, s) {
  const r = s.result;
  return (
    '<a href="#review" class="back">← 팀별 서류 검토</a>' +
    head(
      s.team_name,
      s.version + "차 제출 · 원본 " + s.count + "부 · " + when(s.updated) + " 갱신",
      '<button id="supplement" ' +
        (s.current !== s.id ? "disabled" : "") +
        ">" +
        icon("upload") +
        "보완본 접수</button>",
    ) +
    (s.held
      ? '<div class="callout warn">미배정 원본이 있습니다. 관련 파일의 소속을 확정하세요.</div>'
      : "") +
    '<div class="review-grid"><div><section class="panel">' +
    section("원문 미리보기") +
    '<div class="tabs" id="doc-tabs">' +
    s.files
      .map(
        (f, i) =>
          '<button class="sm ' +
          (!i ? "on" : "") +
          '" data-file="' +
          f.id +
          '">' +
          esc(types[f.kind] || "서류") +
          "</button>",
      )
      .join("") +
    '</div><div id="doc-edit">' + (s.files[0] ? editDocumentLink(s.files[0]) : '') +
    '</div><div id="doc-frame">' +
    (s.files[0] ? documentPreviewFrame(s.files[0]) : "") +
    '</div><div id="file-caption" class="muted break">' +
    esc(s.files[0]?.name) +
    '</div><details id="confirmed-files"><summary>확정 접수 목록 · ' +
    s.files.length +
    "부</summary>" +
    s.files
      .map(
        (f) =>
          '<div class="file-line">' +
          icon("files") +
          "<span>" +
          esc(f.name) +
          "</span><small>" +
          f.pages +
          "쪽</small></div>",
      )
      .join("") +
    "</details></section>" +
    '<section class="panel">' +
    section("제출·발송 이력") +
    '<div class="feed">' +
    s.history
      .map(
        (h) =>
          '<a href="#review/' +
          h.id +
          '"><b>' +
          h.version +
          "차 제출</b> " +
          badge(h.state) +
          " <small>" +
          esc(h.job || "Job 생성 대기") +
          "</small></a>",
      )
      .join("") +
    s.mail.map((m) => "<article>" + esc(m.kind) + " " + badge(m.state) + "</article>").join("") +
    "</div>" +
    (d.smtp
      ? '<button id="email" class="sm">팀장 수신 주소 확인</button>'
      : '<p class="muted">메일 수신처 · 로컬 테스트 메일함</p>') +
    "</section></div>" +
    '<div><section class="panel">' +
    section("Studio 판정", badge(r?.verdict || s.state)) +
    '<div class="muted">설정 ' +
    esc(s.config_version || d.config) +
    (s.job ? " · " + esc(s.job) : "") +
    "</div>" +
    (s.error ? '<div class="callout warn">' + esc(s.error) + "</div>" : "") +
    (r
      ? '<p class="callout ' +
        (r.verdict === "성공" ? "" : "warn") +
        '">' +
        esc(r.reason.replace(/【†\d+】/g, "")) +
        '</p><div class="muted">신청 프로그램 · ' +
        esc(r.program || "미확인") +
        "</div>"
      : '<p class="muted">처리가 끝나면 판정과 검토 근거가 표시됩니다.</p>') +
    (["access", "paused", "invalid", "uncertain", "failed"].includes(s.state)
      ? '<button id="retry" class="sm">처리 재개</button>'
      : "") +
    "</section>" +
    (r
      ? '<section class="panel">' +
        section("원본 대조 체크리스트") +
        r.checks
          .map(
            (c) =>
              '<div class="check ' +
              (c.passed ? "" : "warn") +
              '"><b>' +
              (!c.passed ? "확인" : "✓") +
              "</b><span>" +
              esc(c.label) +
              "</span>" +
              (c.refs.length
                ? c.refs
                    .map(
                      (ref) =>
                        '<button class="sm" data-ref="' +
                        ref.id +
                        '" data-page="' +
                        ref.page +
                        '" data-row="' +
                        (ref.row || "") +
                        '">' +
                        esc(s.files.find((f) => f.id === ref.id)?.kind || "") +
                        " · " +
                        ref.page +
                        "쪽" +
                        (ref.row ? " " + ref.row + "행" : "") +
                        "</button>",
                    )
                    .join("")
                : '<button class="sm" data-list-jump>접수 목록</button>') +
              "</div>",
          )
          .join("") +
        '<details><summary>Studio 검토보고서 원문</summary><pre class="scroll-text">' +
        esc(r.staff_report) +
        "</pre></details></section>" +
        reviewFields(s)
      : "") +
    "</div></div>"
  );
}

export function bindReview(d, s, refresh) {
  const select = (id, p = 1, row, original = false) => {
    const f = s.files.find((x) => x.id === id);
    if (!f) return;
    $("#doc-edit").innerHTML = editDocumentLink(f);
    $("#doc-frame").innerHTML = documentPreviewFrame(f, p, original);
    $("#file-caption").textContent = f.name + " · " + p + "쪽" + (row ? " · 작성자 " + row + "행" : "");
    document
      .querySelectorAll("[data-file]")
      .forEach((b) => b.classList.toggle("on", b.dataset.file === id));
  };
  document.querySelectorAll("[data-file]").forEach((b) => (b.onclick = () => select(b.dataset.file)));
  document.querySelectorAll("[data-ref]").forEach(
    (b) =>
      (b.onclick = () => {
        select(b.dataset.ref, +b.dataset.page, b.dataset.row, true);
        $("#doc-frame").scrollIntoView({ block: "nearest" });
      }),
  );
  document.querySelectorAll("[data-list-jump]").forEach(
    (b) =>
      (b.onclick = () => {
        $("#confirmed-files").open = true;
        $("#confirmed-files").scrollIntoView({ block: "nearest" });
      }),
  );
  $("#supplement").onclick = () => openUpload(d, s);
  if ($("#email"))
    $("#email").onclick = () => {
      modal(
        "팀장 수신 주소 확인",
        '<form class="stack" id="email-form"><label class="field">원접수에서 확인한 이메일 주소' +
          '<input id="address" inputmode="email" autocomplete="email" spellcheck="false" value="' +
          esc(s.email) +
          '"></label>' +
          '<button class="primary">확인 주소 저장</button></form>',
      );
      $("#email-form").onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api("/api/teams/" + s.team + "/email", "PUT", { email: $("#address").value.trim() });
          $("#dialog").close();
          await refresh();
        } catch (error) {
          notice(error.message);
        }
      };
    };
  if ($("#retry"))
    $("#retry").onclick = () => {
      modal(
        "Studio 처리 재개",
        '<form class="stack" id="recovery"><p>' +
          esc(s.error) +
          "</p>" +
          (s.state === "uncertain"
            ? field("Studio 이력에서 확인한 기존 Job ID", "job") +
              '<label><input type="checkbox" id="absent"> 실행이 생성되지 않았음을 Studio에서 확인했습니다.</label>'
            : "") +
          '<button class="primary">재개</button></form>',
      );
      $("#recovery").onsubmit = async (e) => {
        e.preventDefault();
        await api("/api/submissions/" + s.id + "/retry", "POST", {
          job: $("#job")?.value || "",
          confirmed_absent: $("#absent")?.checked || false,
        });
        $("#dialog").close();
        await refresh();
      };
    };
  if (!$("#review-form")) return;
  $("#decision").onchange = () => ($("#issue-box").hidden = $("#decision").value !== "보완 필요");
  $("#add-person").onclick = () =>
    $("#people").insertAdjacentHTML("beforeend", personRow({ role: "팀원" }));
  $("#people").onclick = (e) => {
    if (e.target.matches(".del-member")) e.target.closest("tr").remove();
  };
  $("#review-form").onsubmit = async (e) => {
    e.preventDefault();
    const people = [...$("#people").rows].map((tr) =>
      Object.fromEntries([...tr.querySelectorAll("input")].map((i) => [i.dataset.key, i.value.trim()])),
    );
    await api("/api/submissions/" + s.id + "/review", "PUT", {
      revision: s.revision,
      decision: $("#decision").value,
      note: $("#review-note").value,
      members: people,
      recipient: Object.fromEntries(Object.keys(payout).map((k) => [k, $("#pay-" + k).value])),
      issues: [...document.querySelectorAll("[name=issue]:checked")].map((i) => i.value),
    });
    notice("서류 검토 결과를 저장했습니다.");
    await refresh();
  };
}
