import {
  $,
  api,
  badge,
  empty,
  esc,
  head,
  icon,
  modal,
  notice,
  previewFrame,
  section,
  when,
} from "./common.js";

export function reportsPage(d) {
  return (
    head("지급내역서", "승인한 제출본의 팀 순서와 지급액을 확인하고 편집용 한글과 PDF를 생성합니다.") +
    '<section class="panel">' +
    section("편철할 팀 선택") +
    (d.teams.length
      ? '<div class="table-scroll"><table><thead><tr><th>포함</th><th>팀 / 버전</th><th>명단</th><th>시상구분 / 팀 지원액</th><th>검토</th><th>순서</th></tr></thead><tbody id="report-order">' +
        d.teams
          .map((t) => {
            const s = t.submission,
              eligible = s?.decision === "승인" && !t.held;
            return (
              '<tr><td><input type="checkbox" aria-label="' +
              esc(t.name) +
              ' 포함" value="' +
              esc(s?.id) +
              '" ' +
              (eligible ? "checked" : "disabled") +
              "></td><td><b>" +
              esc(t.name) +
              "</b><small>" +
              (s ? s.version + "차" : "배정 중") +
              "</small></td><td>" +
              (s ? s.students + "명" : "—") +
              "</td><td>" +
              esc(s?.award_type || "미확인") +
              "<small>" +
              esc(
                s?.support_amount
                  ? Number(s.support_amount.replaceAll(",", "")).toLocaleString("ko-KR") + "원"
                  : "미확인",
              ) +
              "</small></td><td>" +
              badge(t.held ? "unassigned" : s?.decision || s?.verdict || s?.state || "waiting") +
              '</td><td><button class="sm" data-up aria-label="팀 순서 올리기">↑</button> <button class="sm" data-down aria-label="팀 순서 내리기">↓</button></td></tr>'
            );
          })
          .join("") +
        '</tbody></table></div><div class="actions" style="margin-top:15px"><button class="primary" id="build-report">' +
        icon("book") +
        "지급내역서 생성</button></div>"
      : empty("편철할 제출본이 없습니다", "팀별 서류를 검토하면 이곳에서 선택할 수 있습니다.", "book")) +
    "</section>" +
    '<section class="panel"><details id="draft"><summary>전체 학생·대표 지급 명단 초안</summary><div id="draft-content"></div></details></section>' +
    '<section class="panel">' +
    section("보고서 버전") +
    (d.reports.length
      ? '<div class="feed">' +
        d.reports
          .map(
            (r) =>
              '<a href="#report/' +
              r.id +
              '"><b>시상금 지급내역서 · v' +
              r.version +
              "</b> " +
              badge(r.state) +
              "<small>" +
              when(r.created) +
              "</small></a>",
          )
          .join("") +
        "</div>"
      : empty(
          "생성된 보고서가 없습니다",
          "생성이 끝나면 PDF 미리보기로 편철 순서를 확인할 수 있습니다.",
          "book",
        )) +
    "</section>"
  );
}
export function bindReports(d) {
  $("#draft").ontoggle = async (e) => {
    if (!e.target.open) return;
    const { teams } = await api("/api/events/" + d.event + "/draft");
    const table = (headers, body) =>
      '<div class="table-scroll"><table><thead><tr>' +
      headers.map((h) => "<th>" + h + "</th>").join("") +
      "</tr></thead><tbody>" +
      body
        .map((r) => "<tr>" + r.map((v) => "<td>" + esc(v ?? "미확인") + "</td>").join("") + "</tr>")
        .join("") +
      "</tbody></table></div>";
    const target = $("#draft-content");
    if (!target) return;
    if (!teams.length) {
      target.innerHTML = empty("명단이 없습니다", "팀별 제출본의 정보가 추출되면 초안에 표시됩니다.");
      return;
    }
    const people = teams.flatMap((t) =>
      t.members.map((m, i) => [
        t.team,
        m.name,
        m.student_id || "미확인",
        m.school || "미확인",
        m.major || "미확인",
        i ? "" : t.award_type || "미확인",
        i ? "" : t.support_amount || "미확인",
      ]),
    );
    const recipients = teams.map((t) => [
      t.team,
      t.rep,
      t.recipient.rrn_display || "미확인",
      t.recipient.bank_name || "미확인",
      t.recipient.account_number || "미확인",
      t.recipient.account_holder || "미확인",
      t.recipient.gross_amount || "미확인",
      t.recipient.tax_amount || "미확인",
      t.recipient.net_amount || "미확인",
    ]);
    target.innerHTML =
      "<h3>전체 학생 " +
      people.length +
      "명</h3>" +
      table(["팀명", "성명", "학번", "학교", "전공", "시상구분", "팀 지원액"], people) +
      "<h3>지급 대상 대표 " +
      recipients.length +
      "명</h3>" +
      table(
        ["팀명", "대표", "주민번호", "은행", "계좌", "예금주", "총액", "세액", "차인지급액"],
        recipients,
      ) +
      teams
        .filter((t) => t.pending.length)
        .map((t) => '<p class="muted">' + esc(t.team) + " · " + esc(t.pending.join(" / ")) + "</p>")
        .join("");
  };
  const list = $("#report-order");
  if (!list) return;
  list.onclick = (e) => {
    const tr = e.target.closest("tr");
    if (!tr) return;
    if (e.target.matches("[data-up]") && tr.previousElementSibling)
      list.insertBefore(tr, tr.previousElementSibling);
    if (e.target.matches("[data-down]") && tr.nextElementSibling)
      list.insertBefore(tr.nextElementSibling, tr);
  };
  $("#build-report").onclick = async () => {
    const ids = [...list.querySelectorAll("input:checked")].map((i) => i.value);
    const r = await api("/api/reports", "POST", { event: d.event, submissions: ids });
    location.hash = "report/" + r.id;
  };
}
export function reportPage(r) {
  const url = "/api/reports/" + r.id,
    ready = ["preview", "confirmed"].includes(r.state) && !r.stale;
  return (
    '<a class="back" href="#report">← 지급내역서 목록</a>' +
    head("시상금 지급내역서 · v" + r.version, r.teams.join(" → "), badge(r.state)) +
    (r.stale
      ? '<div class="callout warn">제출본 또는 지급정보가 변경됐습니다. 목록에서 새 보고서를 생성하세요.</div>'
      : "") +
    (r.error ? '<div class="callout warn">' + esc(r.error) + "</div>" : "") +
    (ready
      ? '<section class="panel">' +
        section(
          "PDF 미리보기",
          r.state === "preview"
            ? '<button class="primary" id="confirm-report">' + icon("check") + "이 버전 확정</button>"
            : '<div class="actions"><a class="button primary" href="' +
                url +
                '/hwpx">' +
                icon("download") +
                '한글 다운로드</a><a class="button" href="' +
                url +
                '/pdf">' +
                icon("download") +
                "PDF 다운로드</a></div>",
        ) +
        previewFrame(url + "/preview", 1, "reportview") +
        "</section>" +
        (r.state === "confirmed"
          ? '<section class="panel">' +
            section("한글에서 편집한 버전") +
            '<label class="field">다운로드한 HWPX를 수정했다면 편집본을 선택해 새 PDF를 만드세요.<input id="edited-file" type="file" accept=".hwpx"></label><button class="sm" id="send-edited" style="margin-top:9px">편집본으로 새 버전 생성</button></section>'
          : "")
      : r.state === "queued" || r.state === "building"
        ? '<section class="panel">' +
          empty(
            "한글에서 보고서를 생성하고 있습니다",
            "원본 증빙과 편철 결과의 쪽수·본문·이미지를 대조한 뒤 미리보기가 열립니다.",
            "clock",
          ) +
          "</section>"
        : "")
  );
}
export function bindReport(r, refresh) {
  if ($("#confirm-report"))
    $("#confirm-report").onclick = async () => {
      await api("/api/reports/" + r.id + "/confirm", "POST");
      notice("확정한 두 파일을 다운로드할 수 있습니다.");
      await refresh();
    };
  if ($("#send-edited"))
    $("#send-edited").onclick = async () => {
      const file = $("#edited-file").files[0];
      if (!file) return notice("편집한 HWPX 파일을 선택하세요.");
      const form = new FormData();
      form.set("file", file);
      const x = await api("/api/reports/" + r.id + "/edited", "POST", form);
      location.hash = "report/" + x.id;
    };
}

function gmailConnectionActions(managing) {
  const googleLabel = managing ? "Google로 다시 인증" : "Google로 연결";
  const passwordLabel = managing ? "앱 비밀번호로 인증" : "앱 비밀번호로 연결";
  return '<div class="actions"><button class="primary" data-gmail-method="google">' + googleLabel +
    '</button><button class="sm" data-gmail-method="password">' + passwordLabel + '</button></div>';
}

export function mailPage(d) {
  const gmail = d.gmail_account
    ? '<section class="panel">' +
      section(
        "담당자 Gmail",
        d.mail_ready
          ? '<div class="actions"><span class="badge good gmail-status">' + icon("check") +
            '연결 완료</span><button class="sm" id="gmail-manage" aria-haspopup="dialog">연결 관리</button></div>'
          : gmailConnectionActions(false),
      ) +
      "<strong>" +
      esc(d.gmail_account) +
      '</strong><p class="muted">' +
      (d.mail_ready
        ? (d.gmail_oauth_connected ? "Google 로그인" : "앱 비밀번호") + " · 발신 및 관리자 알림 수신"
        : "인증 대기 · 연결하면 대기 중인 알림을 발송합니다.") +
      "</p></section>"
    : "";
  return (
    head(
      "발송 이력",
      d.smtp
        ? "담당자 알림과 팀장 안내의 발송 상태를 확인합니다."
        : "로컬 테스트 메일함에 도착한 안내를 확인합니다.",
    ) +
    gmail +
    '<section class="panel">' +
    section("메일 " + d.mail.length + "건") +
    (d.mail.length
      ? '<div class="table-scroll"><table><thead><tr><th>팀 / 제출본</th><th>안내 종류</th><th>처리 상태</th><th>생성 시각</th><th>본문</th></tr></thead><tbody>' +
        d.mail
          .map(
            (m) =>
              "<tr><td>" +
              esc(m.name) +
              "<small>" +
              m.version +
              "차</small></td><td>" +
              esc(m.kind) +
              "</td><td>" +
              badge(m.state) +
              "</td><td>" +
              when(m.created) +
              '</td><td><button class="sm" data-mail="' +
              m.id +
              '">열기</button></td></tr>',
          )
          .join("") +
        "</tbody></table></div>"
      : empty("아직 발송한 안내가 없습니다", "", "mail")) +
    "</section>"
  );
}

function bindGmailActions(container, refresh) {
  const google = container.querySelector('[data-gmail-method="google"]');
  if (google) google.onclick = () => {
    const redirect = location.origin + "/api/settings/gmail/callback";
    modal("Google로 Gmail 연결",
      '<form class="stack" id="google-form"><p>Chrome 또는 Edge에서 담당자 계정으로 로그인해 메일 발송을 승인합니다.</p>'+
      '<details><summary>처음 연결할 때 · Google Cloud 설정</summary><ol>'+
      '<li>프로젝트에서 <a target="_blank" rel="noopener noreferrer" href="https://console.cloud.google.com/apis/library/gmail.googleapis.com">Gmail API</a>를 사용 설정하세요.</li>'+
      '<li>외부 앱이 테스트 중이면 <a target="_blank" rel="noopener noreferrer" href="https://console.cloud.google.com/auth/audience">대상</a>의 테스트 사용자에서 ‘사용자 추가’를 눌러 담당자 Gmail 주소를 저장하세요.</li>'+
      '<li><a target="_blank" rel="noopener noreferrer" href="https://console.cloud.google.com/auth/clients">클라이언트</a>에서 웹 애플리케이션을 만들고 아래 URI를 등록한 뒤 JSON을 내려받으세요.</li></ol></details>'+
      '<label class="field">승인된 리디렉션 URI<input readonly value="'+esc(redirect)+'"></label>'+
      '<label class="field">Google Cloud 클라이언트 JSON<input id="google-client" type="file" accept=".json,application/json" required></label>'+
      '<p id="google-error" role="alert"></p><button class="primary">Google 로그인으로 이동</button></form>');
    $("#google-form").onsubmit = async (event) => {
      event.preventDefault();
      const button = event.currentTarget.querySelector("button");
      button.disabled = true;
      try {
        const file = $("#google-client").files[0];
        if (!file || file.size > 32768) throw Error("Google Cloud 클라이언트 JSON을 선택하세요.");
        const result = await api("/api/settings/gmail/oauth/start", "POST", {client_json: await file.text()});
        location.assign(result.url);
      } catch (error) {
        $("#google-error").textContent = error.message;
        button.disabled = false;
      }
    };
  };
  const connect = container.querySelector('[data-gmail-method="password"]');
  if (connect)
    connect.onclick = () => {
      modal(
        "담당자 Gmail 연결",
        '<form class="stack" id="gmail-form">' +
          '<p>Google 계정의 2단계 인증을 켠 뒤 <a target="_blank" rel="noopener noreferrer" href="https://myaccount.google.com/apppasswords">앱 비밀번호 발급</a>에서 ‘시상금 서류 알림’용 코드를 만드세요. 평소 Gmail 비밀번호는 Google 로그인 화면에서만 입력하세요.</p>' +
          '<label class="field">Google이 발급한 16자리 코드<input id="gmail-secret" type="password" autocomplete="off" required></label>' +
          '<p id="gmail-error" role="alert"></p><button class="primary">인증하고 연결</button></form>',
      );
      const input = $("#gmail-secret");
      $("#dialog").addEventListener(
        "close",
        () => {
          input.value = "";
        },
        { once: true },
      );
      $("#gmail-form").onsubmit = async (e) => {
        e.preventDefault();
        const button = e.currentTarget.querySelector("button");
        button.disabled = true;
        $("#gmail-error").textContent = "";
        try {
          await api("/api/settings/gmail/connect", "POST", { app_password: input.value });
          $("#dialog").close();
          notice("담당자 Gmail 인증을 완료했습니다.");
          await refresh();
        } catch (error) {
          $("#gmail-error").textContent = error.message;
        } finally {
          input.value = "";
          button.disabled = false;
        }
      };
    };
}

export function bindMail(refresh) {
  const manage = $("#gmail-manage");
  if (manage) {
    manage.onclick = () => {
      modal("담당자 Gmail 연결 관리", gmailConnectionActions(true));
      bindGmailActions($("#dialog"), refresh);
    };
  } else {
    bindGmailActions($("#view"), refresh);
  }
  document.querySelectorAll("[data-mail]").forEach(
    (b) =>
      (b.onclick = async () => {
        const m = await api("/api/mail/" + b.dataset.mail);
        modal(
          m.subject || m.kind,
          '<div class="muted">' +
            esc(m.sent_to || "발송 대기") +
            " · " +
            badge(m.state) +
            '</div><pre class="scroll-text">' +
            esc(m.body) +
            "</pre>" +
            (["failed", "uncertain"].includes(m.state)
              ? '<label><input type="checkbox" id="unsent"> 미발송을 확인했습니다.</label> <button id="mail-retry" class="sm">발송 재개</button>'
              : ""),
        );
        if ($("#mail-retry"))
          $("#mail-retry").onclick = async () => {
            await api("/api/mail/" + m.id + "/retry", "POST", {
              confirmed_absent: $("#unsent").checked,
            });
            $("#dialog").close();
            await refresh();
          };
      }),
  );
}
