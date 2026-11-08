import {
  $,
  api,
  badge,
  empty,
  esc,
  field,
  head,
  icon,
  modal,
  notice,
  section,
  teamTable,
  when,
} from "./common.js";
import { batchPage, batchesTable, bindBatch, intakePage, openUpload } from "./intake.js";
import { bindReview, reviewPage, reviewsPage } from "./review.js";
import { bindMail, bindReport, bindReports, mailPage, reportPage, reportsPage } from "./report.js";

let selected = sessionStorage.getItem("award-event") || "wave",
  generation = 0,
  timer,
  dirty = false;
document.querySelectorAll("[data-icon]").forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
window.addEventListener("unhandledrejection", (e) => {
  notice(e.reason?.message || "요청 중 문제가 발생했습니다.");
  e.preventDefault();
});
function home(d) {
  const total = d.teams.length,
    pending = d.batches.reduce((n, b) => n + (b.pending || 0), 0),
    review = d.teams.filter((t) => t.submission?.verdict && !t.submission?.decision).length;
  const metrics = [
    ["접수 팀", total, "팀", "users"],
    ["팀 배정 확인", pending, "부", "inbox"],
    ["담당자 검토 대기", review, "팀", "files"],
    ["생성한 보고서", d.reports.length, "건", "book"],
  ];
  const alerts = d.teams.filter(
    (t) =>
      t.submission &&
      (t.submission.error ||
        (t.submission.verdict !== "성공" && t.submission.verdict && !t.submission.decision)),
  );
  const queued = d.teams
    .filter((t) => t.submission?.state === "queued")
    .map((t) => t.submission.created);
  return (
    head(
      "업무 현황",
      "선택한 대회의 서류 접수와 검토 진행 상황입니다.",
      '<button class="primary" id="upload">' + icon("upload") + "서류 접수</button>",
    ) +
    '<div class="metrics">' +
    metrics
      .map(
        ([name, val, unit, glyph]) =>
          '<div class="metric"><div class="row"><span>' +
          name +
          "</span>" +
          icon(glyph) +
          "</div><strong>" +
          val +
          "<small>" +
          unit +
          "</small></strong></div>",
      )
      .join("") +
    "</div>" +
    '<div class="split"><div><section class="panel">' +
    section("팀별 검토 현황", '<a href="#review" class="link">전체 보기</a>') +
    teamTable(d.teams) +
    '</section><section class="panel">' +
    section("최근 일괄 접수", '<a href="#intake" class="link">접수 목록</a>') +
    batchesTable(d.batches.slice(0, 5)) +
    "</section></div>" +
    '<div><section class="panel">' +
    section("담당자 알림") +
    (alerts.length || pending
      ? '<div class="feed">' +
        d.batches
          .filter((b) => b.pending)
          .map(
            (b) =>
              '<a href="#intake/' +
              b.id +
              '"><b>팀 배정 확인 · ' +
              b.pending +
              "부</b><small>접수 " +
              b.id.slice(0, 8) +
              "</small></a>",
          )
          .join("") +
        alerts
          .map(
            (t) =>
              '<a href="#review/' +
              t.current +
              '"><b>' +
              esc(t.name) +
              "</b> " +
              badge(t.submission.verdict || t.submission.state) +
              "<small>" +
              esc(t.submission.error || "원문과 판정 근거 확인") +
              "</small></a>",
          )
          .join("") +
        "</div>"
      : empty("대기 중인 알림이 없습니다", "", "check")) +
    "</section>" +
    '<section class="panel">' +
    section("처리 환경") +
    '<ul class="flow"><li><span class="ico-box">' +
    icon("files") +
    "</span><div><b>Upstage Studio</b><small>에이전트 설정 " +
    esc(d.config) +
    " · " +
    (d.connected ? "키 등록됨" : "키 등록 필요") +
    '</small></div></li><li><span class="ico-box">' +
    icon("mail") +
    "</span><div><b>메일 알림</b><small>" +
    (d.gmail_account
      ? '<a href="#mail">' + (d.mail_ready ? "담당자 Gmail 연결 완료" : "담당자 Gmail 인증 대기") + "</a>"
      : d.smtp
        ? "SMTP 발송"
        : "로컬 테스트 메일함") +
    '</small></div></li><li><span class="ico-box">' +
    icon("clock") +
    "</span><div><b>판정 대기 " +
    queued.length +
    "팀</b><small>" +
    (queued.length ? "가장 이른 접수 " + when(Math.min(...queued)) : "대기 중인 판정 작업 없음") +
    "</small></div></li></ul></section></div></div>"
  );
}
async function render(autopoll = false) {
  clearTimeout(timer);
  const gen = ++generation;
  const [page = "home", id] = (location.hash.slice(1) || "home").split("/");
  if (autopoll && (dirty || $("#dialog").open)) {
    timer = setTimeout(() => render(true), 3000);
    return;
  }
  if (!autopoll) dirty = false;
  try {
    const [d, v] = await Promise.all([
      api("/api/dashboard?event=" + encodeURIComponent(selected)),
      id && ["intake", "review", "report"].includes(page)
        ? api(
            "/api/" +
              { intake: "intake-batches", review: "submissions", report: "reports" }[page] +
              "/" +
              encodeURIComponent(id),
          )
        : null,
    ]);
    if (gen !== generation) return;
    $("#event").innerHTML = d.events
      .map(
        (e) =>
          '<option value="' +
          e.id +
          '" ' +
          (e.id === selected ? "selected" : "") +
          ">" +
          esc(e.name) +
          "</option>",
      )
      .join("");
    document
      .querySelectorAll("[data-nav]")
      .forEach((a) => a.classList.toggle("active", a.dataset.nav === page));
    const view = $("#view");
    let polling = false,
      delay = 3000;
    if (page === "intake") {
      view.innerHTML = id ? batchPage(d, v) : intakePage(d);
      if (id) bindBatch(d, v, () => render());
      polling = id ? v.state === "preparing" : d.batches.some((b) => b.state === "preparing");
    } else if (page === "review") {
      view.innerHTML = id ? reviewPage(d, v) : reviewsPage(d);
      if (id) bindReview(d, v, () => render());
      polling = id
        ? ["queued", "creating", "polling", "paused", "access", "uncertain"].includes(v.state)
        : d.teams.some((t) => t.submission && !t.submission.verdict);
      if (v?.error) delay = 15000;
    } else if (page === "report") {
      view.innerHTML = id ? reportPage(v) : reportsPage(d);
      if (id) bindReport(v, () => render());
      else bindReports(d);
      polling = id
        ? ["queued", "building"].includes(v.state)
        : d.reports.some((r) => ["queued", "building"].includes(r.state));
    } else if (page === "mail") {
      view.innerHTML = mailPage(d);
      bindMail(() => render());
      polling = d.mail.some((m) => ["waiting", "sending"].includes(m.state));
    } else {
      view.innerHTML = home(d);
      polling =
        d.batches.some((b) => b.state === "preparing") ||
        d.teams.some(
          (t) => t.submission && ["polling", "creating", "queued"].includes(t.submission.state),
        );
    }
    if ($("#upload")) $("#upload").onclick = () => openUpload(d);
    if (polling) timer = setTimeout(() => render(true), delay);
  } catch (e) {
    if (gen !== generation) return;
    if (autopoll) {
      notice(e.message);
      timer = setTimeout(() => render(true), 15000);
    } else {
      $("#view").innerHTML =
        '<section class="panel"><div class="callout warn">' +
        esc(e.message) +
        '</div><button id="refresh">다시 불러오기</button></section>';
      $("#refresh").onclick = () => render();
    }
  }
}
$("#event").onchange = (e) => {
  selected = e.target.value;
  sessionStorage.setItem("award-event", selected);
  location.hash = "home";
  render();
};
$("#add-event").onclick = () => {
  modal(
    "대회 추가",
    '<form id="new-event" class="stack">' +
      field("대회 공식 명칭", "event-name") +
      '<button class="primary">대회 등록</button></form>',
  );
  $("#new-event").onsubmit = async (e) => {
    e.preventDefault();
    const v = await api("/api/events", "POST", { name: $("#event-name").value });
    $("#dialog").close();
    selected = v.id;
    sessionStorage.setItem("award-event", selected);
    location.hash = "home";
    await render();
  };
};
$("#view").addEventListener("input", () => (dirty = true));
window.addEventListener("hashchange", () => {
  window.scrollTo(0, 0);
  render();
});
render();
