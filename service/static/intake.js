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
  previewFrame,
  section,
  teamOptions,
  types,
  when,
} from "./common.js";

export function batchesTable(items) {
  return items.length
    ? '<div class="table-scroll"><table><thead><tr><th>접수번호</th><th>접수 시각</th><th>원본</th><th>상태</th></tr></thead><tbody>' +
        items
          .map(
            (b) =>
              '<tr><td><a class="team-link" href="#intake/' +
              b.id +
              '">' +
              b.id.slice(0, 8).toUpperCase() +
              "</a></td><td>" +
              when(b.created) +
              "</td><td>" +
              b.count +
              "부</td><td>" +
              badge(b.state) +
              (b.pending ? " · " + b.pending + "부" : "") +
              "</td></tr>",
          )
          .join("") +
        "</tbody></table></div>"
    : empty("일괄 접수 이력이 없습니다", "여러 팀의 한글 원본을 함께 올릴 수 있습니다.");
}

export function intakePage(d) {
  return (
    head(
      "접수·팀 배정",
      "접수한 원본과 팀 배정 근거를 확인합니다.",
      '<button class="primary" id="upload">' + icon("upload") + "서류 접수</button>",
    ) +
    '<section class="panel">' +
    section("일괄 접수 목록") +
    batchesTable(d.batches) +
    "</section>"
  );
}

export function openUpload(d, base = null) {
  let files = [],
    key = crypto.randomUUID(),
    busy = false;
  modal(
    base ? "보완본 접수" : "서류 접수",
    '<form id="upload-form" class="stack"><div class="muted">' +
      esc(d.events.find((e) => e.id === d.event).name) +
      "</div>" +
      (base
        ? '<div class="callout">' +
          esc(base.team_name) +
          " · " +
          base.version +
          '차에서 교체·제외할 원본을 선택하세요. 선택하지 않은 원본은 새 버전에 포함됩니다.</div><div class="stack">' +
          base.files
            .map(
              (f) =>
                '<label><input type="checkbox" name="removed" value="' +
                f.id +
                '"> ' +
                esc(f.name) +
                "</label>",
            )
            .join("") +
          "</div>"
        : '<label class="field">접수 단위<select id="target"><option value="">여러 팀 함께 · 본문으로 배정</option>' +
          teamOptions(d.teams) +
          "</select></label>") +
      '<label class="drop">' +
      icon("upload") +
      '<strong>파일을 끌어 놓거나 선택하세요</strong><small>HWP · HWPX / 파일당 40 MB</small><input aria-label="제출 원본 파일" id="local-files" type="file" accept=".hwp,.hwpx" multiple></label><div id="file-list"></div><div id="up-status" role="status"></div><button class="primary" id="send-upload" disabled>접수하기</button></form>',
  );
  const draw = () => {
    $("#file-list").innerHTML = files
      .map(
        (f, i) =>
          '<div class="file-line">' +
          icon("files") +
          "<span>" +
          esc(f.name) +
          "</span><small>" +
          Math.ceil(f.size / 1024) +
          ' KB</small><button type="button" data-remove="' +
          i +
          '" class="icon-btn" aria-label="목록에서 제외">✕</button></div>',
      )
      .join("");
    $("#send-upload").disabled = !files.length || busy;
    $("#file-list")
      .querySelectorAll("[data-remove]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            files.splice(+b.dataset.remove, 1);
            key = crypto.randomUUID();
            draw();
          }),
      );
  };
  $("#local-files").onchange = (e) => {
    files.push(...e.target.files);
    e.target.value = "";
    key = crypto.randomUUID();
    draw();
  };
  $("#upload-form").onchange = (e) => {
    if (e.target.id !== "local-files") key = crypto.randomUUID();
  };
  $("#upload-form").onsubmit = (e) => {
    e.preventDefault();
    if (!files.length || busy) return;
    const fd = new FormData();
    fd.set("event", d.event);
    fd.set("target", base ? base.team : $("#target").value);
    if (base) {
      fd.set("base", base.id);
      fd.set(
        "removed",
        JSON.stringify([...document.querySelectorAll("[name=removed]:checked")].map((x) => x.value)),
      );
    }
    files.forEach((f) => fd.append("files", f, f.name));
    fd.set("manifest", JSON.stringify(files.map((f) => ({ name: f.name, size: f.size }))));
    busy = true;
    draw();
    $("#local-files").disabled = true;
    $("#up-status").innerHTML =
      '<progress id="meter" max="100" value="0"></progress><span>원본 전송 중</span>';
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/intake-batches");
    xhr.setRequestHeader("X-Award-Client", "staff");
    xhr.setRequestHeader("Idempotency-Key", key);
    let timer;
    const watchdog = () => {
      clearTimeout(timer);
      timer = setTimeout(() => xhr.abort(), 120000);
    };
    watchdog();
    xhr.upload.onprogress = (e) => {
      watchdog();
      if (e.lengthComputable && $("#meter")) $("#meter").value = (e.loaded * 100) / e.total;
    };
    xhr.onloadend = () => {
      clearTimeout(timer);
      busy = false;
      const v = (() => {
        try {
          return JSON.parse(xhr.responseText);
        } catch {
          return {};
        }
      })();
      if (xhr.status === 200 || xhr.status === 202) {
        $("#dialog").close();
        notice("원본 " + files.length + "부를 접수했습니다.");
        location.hash = "intake/" + v.batch_id;
      } else if ($("#up-status")) {
        $("#up-status").textContent =
          typeof v.detail === "string"
            ? v.detail
            : "전송을 마치지 못했습니다. 같은 목록으로 다시 접수하세요.";
        $("#local-files").disabled = false;
        draw();
      }
    };
    xhr.send(fd);
  };
}

export function batchPage(d, b) {
  return (
    '<a class="back" href="#intake">← 접수 목록</a>' +
    head(
      "접수 " + b.id.slice(0, 8).toUpperCase(),
      when(b.created) + " 접수 · 원본 " + b.files.length + "부",
      badge(b.state),
    ) +
    '<section class="panel">' +
    section("파일별 소속 근거", '<button class="sm" id="new-team">팀 직접 등록</button>') +
    (b.state === "preparing"
      ? '<div class="callout">한글에서 검토용 PDF를 준비하고 있습니다. PC에 파일 접근 확인창이 뜨면 현재 접수한 원본 경로를 확인한 뒤 ‘접근 허용’을 누르세요.</div>'
      : "") +
    '<div class="table-scroll"><table><thead><tr><th>서류 / 원본</th><th>팀 배정</th><th>판독 근거</th><th>처리</th></tr></thead><tbody>' +
    b.files
      .map(
        (f) =>
          "<tr><td><b>" +
          esc(types[f.kind]) +
          "</b><small>" +
          esc(f.name) +
          "</small></td><td>" +
          esc(d.teams.find((t) => t.id === f.team)?.name || "—") +
          "<small>" +
          badge(f.state) +
          "</small></td><td>" +
          esc(f.reason || "판독 대기") +
          '</td><td><button class="sm" data-assign="' +
          f.id +
          '" ' +
          (b.state === "preparing" ? "disabled" : "") +
          ">원본 대조</button></td></tr>",
      )
      .join("") +
    "</tbody></table></div></section>" +
    '<section class="panel">' +
    section("확정된 팀별 제출본") +
    (b.teams.length
      ? '<div class="actions">' +
        b.teams
          .map(
            (t) =>
              '<a class="button" href="#review/' +
              t.submission_id +
              '">' +
              esc(d.teams.find((v) => v.id === t.team)?.name) +
              " 검토 " +
              icon("arrow") +
              "</a>",
          )
          .join("") +
        "</div>"
      : empty("팀별 판정 대기", "관련 미배정 파일을 해결하면 해당 팀의 검토가 시작됩니다.")) +
    "</section>"
  );
}

export function bindBatch(d, b, refresh) {
  $("#new-team").onclick = () => {
    modal(
      "팀 직접 등록",
      '<form id="team-form" class="stack">' +
        field("원접수 팀명", "team-name") +
        field("대표 성명", "team-rep") +
        '<button class="primary">팀 등록</button></form>',
    );
    $("#team-form").onsubmit = async (e) => {
      e.preventDefault();
      await api("/api/events/" + d.event + "/teams", "POST", {
        name: $("#team-name").value,
        rep: $("#team-rep").value,
      });
      $("#dialog").close();
      await refresh();
    };
  };
  document.querySelectorAll("[data-assign]").forEach(
    (btn) =>
      (btn.onclick = () => {
        const f = b.files.find((f) => f.id === btn.dataset.assign);
        modal(
          "원본 대조 · " + f.name,
          '<div class="stack">' +
            (f.url
              ? '<a target="_blank" rel="noopener" href="' +
                f.url +
                "#page=" +
                f.page +
                '">원문 PDF 새 창에서 보기 ↗</a>' +
                previewFrame(f.url, f.page)
              : '<div class="callout warn">' +
                esc(f.reason) +
                "</div>" +
                (f.state === "error"
                  ? '<button type="button" class="sm" id="retry-file">원본 판독 재개</button>'
                  : "")) +
            "<div><b>배정 근거</b><p>" +
            esc(f.reason) +
            "</p><small>후보 팀 · " +
            esc(
              f.candidates
                .map((id) => d.teams.find((t) => t.id === id)?.name)
                .filter(Boolean)
                .join(", ") || "추가 확인",
            ) +
            "</small></div>" +
            '<form id="assignment" class="stack"><label class="field">배정 결정<select id="choice"><option value="">팀 선택</option>' +
            teamOptions(d.teams, f.team) +
            '<option value="hold">미배정 유지</option><option value="outside">이 대회 대상 외</option></select></label><div id="exclusions" hidden>관련 없는 팀 제외<div class="checklist">' +
            d.teams
              .map(
                (t) =>
                  '<label><input type="checkbox" name="exclude" value="' +
                  t.id +
                  '" ' +
                  (f.excluded.includes(t.id) ? "checked" : "") +
                  ">" +
                  esc(t.name) +
                  "</label>",
              )
              .join("") +
            "</div></div>" +
            '<label class="field">원접수 확인 근거<input required minlength="2" id="assign-reason" placeholder="어느 제출 묶음에서 확인했는지 입력"></label><button class="primary">배정 저장</button></form></div>',
        );
        if ($("#retry-file"))
          $("#retry-file").onclick = async () => {
            await api("/api/intake-batches/" + b.id + "/files/" + f.id + "/retry", "POST");
            $("#dialog").close();
            await refresh();
          };
        $("#choice").onchange = () => ($("#exclusions").hidden = $("#choice").value !== "hold");
        $("#assignment").onsubmit = async (e) => {
          e.preventDefault();
          const v = $("#choice").value;
          if (!v) return notice("팀 또는 배정 결정을 선택하세요.");
          const special = ["hold", "outside"].includes(v);
          await api("/api/intake-batches/" + b.id + "/files/" + f.id + "/assignment", "PUT", {
            action: special ? v : "assign",
            team: special ? "" : v,
            revision: b.revision,
            reason: $("#assign-reason").value,
            exclude: [...document.querySelectorAll("[name=exclude]:checked")].map((x) => x.value),
          });
          $("#dialog").close();
          notice("배정 결정을 저장했습니다.");
          await refresh();
        };
      }),
  );
}
