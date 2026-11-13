package kr.swax.intake;

import java.util.*;
import tools.jackson.databind.JsonNode;

/** Builds the original notice from approved wording and document locations, without copying raw Studio text. */
record MailTemplate(String subject, String body) {
    private static final Map<String,String> INSTRUCTIONS = Map.of(
        "application","팀의 지급확인서를 확인해 제출해 주세요.", "consent","전체 팀원의 개인정보 동의서와 작성자 명단을 확인해 주세요.",
        "identity","팀 대표의 신분증·통장 사본을 확인해 주세요.", "account","지급확인서와 통장 사본의 은행·계좌·예금주 표기를 대조해 주세요.",
        "signature","신청서와 동의서의 동의 표시와 서명을 확인해 주세요.", "affiliation","신청서와 동의서의 소속 표기를 확인해 주세요.",
        "duplicate","같은 종류로 중복 제출된 서류를 확인해 주세요.", "student_id","지급확인서의 해당 학번 기재란을 확인해 주세요.",
        "representative","지급확인서의 대표 성명과 신분증의 성명을 대조해 주세요.", "other","제출한 증빙의 기재 내용과 판독 상태를 담당자와 확인해 주세요.");
    private static final Map<String,String> FIELDS = Map.ofEntries(
        Map.entry("representative_name","대표 성명"), Map.entry("representative_student_id","대표 학번"), Map.entry("representative_phone","대표 전화번호"),
        Map.entry("representative_email","대표 이메일"), Map.entry("representative_signed","대표 서명"), Map.entry("applicant_signed","신청인 서명"),
        Map.entry("project_name","과제명"), Map.entry("representative_account","대표 계좌번호"), Map.entry("account_number","통장 계좌번호"), Map.entry("written_date","작성일"),
        Map.entry("name","성명"), Map.entry("student_id","학번"), Map.entry("email","이메일"), Map.entry("phone","전화번호"),
        Map.entry("bank_name","은행명"), Map.entry("representative_bank","대표 은행명"), Map.entry("account_holder","예금주"),
        Map.entry("birth_date","생년월일"), Map.entry("department","전공"), Map.entry("affiliation","소속"), Map.entry("gender","성별"));
    private static final Map<String,String> DOCUMENTS = Map.of(
        "01","수혜학생 신청 및 시상금 지급 확인서", "02","개인정보 수집·이용·제공 동의서", "03","신분증 사본 및 통장 사본");

    static MailTemplate from(JsonNode mail) {
        String name = mail.path("name").asString("").replaceAll("\\R", " ");
        if (name.isBlank()) name = "미확인";
        String kind = mail.path("kind").asString();
        String subject = "[시상금 서류 " + kind + "] " + name;
        var lines = new ArrayList<String>();
        lines.add(name + " 팀장님,");
        lines.add("");
        if (kind.equals("보완 요청")) {
            JsonNode output = mail.path("output");
            JsonNode selected = "보완 필요".equals(mail.path("decision").asString("")) ? mail.path("issues") : output.path("issues");
            var issues = new LinkedHashSet<String>();
            selected.forEach(item -> issues.add(item.asString("")));
            var errors = output.path("agent_decision").path("확정오류");
            if (errors.isArray()) {
                var groups = new LinkedHashMap<String,LinkedHashSet<String>>();
                for (var error : errors) {
                    String title = String.join(" · ", List.of("문서유형","대상자","검사항목","문제유형").stream()
                        .map(key -> error.path(key).asString("")).filter(value -> !value.isEmpty()).toList());
                    if ("보완 필요".equals(mail.path("decision").asString(""))) {
                        String issue = "";
                        for (var check : output.path("checks")) if (check.path("label").asString("").startsWith(title + ":"))
                            issue = check.path("issue").asString("");
                        if (!issue.isBlank() && !issues.contains(issue)) continue;
                    }
                    String target = clean(error.path("대상자").asString(""));
                    String field = field(error.path("검사항목").asString(""));
                    String problem = clean(error.path("문제유형").asString("")).replace("명시적 비동의","비동의로 표시됨");
                    if (field.isBlank() || problem.isBlank()) continue;
                    String item = (target.isBlank() || target.equals("문서 전체") || target.equals("팀 전체") || field.startsWith(target + " ") ? "" : target + " / ") + field + ": " + problem;
                    groups.computeIfAbsent(documents(error.path("문서유형").asString(""),mail),key -> new LinkedHashSet<>()).add(item);
                }
                int number = 0;
                for (var group : groups.entrySet()) {
                    if (number > 0) lines.add("");
                    lines.add(++number + ". " + group.getKey());
                    group.getValue().forEach(item -> lines.add("   - " + item));
                }
            } else {
                for (String issue : issues) if (INSTRUCTIONS.containsKey(issue)) {
                    String text = instruction(issue,output);
                    if (!text.isBlank()) lines.add("- " + text);
                }
            }
            if (lines.size() == 2) return new MailTemplate(subject, "");
            lines.add("");
            lines.add("위 항목을 다시 확인한 후 보완한 서류를 기존 제출 경로로 재제출해 주세요.");
        } else lines.add("제출한 서류의 검토를 완료했습니다.");
        return new MailTemplate(subject, String.join("\n",lines));
    }

    private static String documents(String description, JsonNode mail) {
        String compact = description.replaceAll("\\s", "");
        var kinds = new LinkedHashSet<String>();
        if (compact.contains("신청") || compact.contains("지급확인")) kinds.add("01");
        if (compact.contains("동의")) kinds.add("02");
        if (compact.contains("신분증") || compact.contains("통장")) kinds.add("03");
        var names = new LinkedHashSet<String>();
        for (String kind : kinds) {
            var found = new LinkedHashSet<String>();
            for (var ref : mail.path("output").path("documents").path(kind)) for (var file : mail.path("files"))
                if (ref.path("id").asString().equals(file.path("id").asString()) && !file.path("name").asString("").isBlank())
                    found.add(clean(file.path("name").asString()));
            if (found.isEmpty()) found.add(DOCUMENTS.get(kind));
            names.addAll(found);
        }
        return names.isEmpty() ? clean(description) : String.join(" / ",names);
    }

    private static String clean(String text) {
        return text.replaceAll("【[^】]*】|\\[(?:\\+|[†‡])\\s*\\d+\\]", "").replaceAll("\\s+", " ").trim();
    }

    private static String field(String text) {
        String key = text.replaceFirst("^(?:members|participants|beneficiaries)(?:\\[\\d+\\])?\\.", "");
        return FIELDS.getOrDefault(key,clean(text));
    }

    private static String instruction(String issue, JsonNode output) {
        var docs = output.path("documents");
        var kinds = List.of("01","02","03");
        var byId = new HashMap<String,String>();
        for (String kind : kinds) for (var ref : docs.path(kind)) byId.put(ref.path("id").asString(""),kind);
        var locations = new LinkedHashSet<String>();
        var fields = new LinkedHashSet<String>();
        for (var check : output.path("checks")) {
            if (!issue.equals(check.path("issue").asString("")) || !check.path("passed").isBoolean() || check.path("passed").asBoolean()) continue;
            for (var ref : check.path("refs")) {
                String kind = byId.get(ref.path("id").asString(""));
                var page = ref.path("page");
                var row = ref.path("row");
                if (kind != null && validPosition(page))
                    locations.add(kind + " " + page.asInt() + "쪽" + (validPosition(row) ? " " + row.asInt() + "행" : ""));
            }
            for (var field : check.path("fields")) {
                String label = FIELDS.get(field.asString(""));
                if (label != null) fields.add(label);
            }
        }
        boolean located = !locations.isEmpty();
        List<String> related = switch (issue) {
            case "application", "student_id" -> List.of("01");
            case "consent" -> List.of("02");
            case "identity" -> List.of("03");
            case "account", "representative" -> List.of("01","03");
            case "signature", "affiliation" -> List.of("01","02");
            case "duplicate" -> kinds.stream().filter(k -> docs.path(k).size() > 1).toList();
            default -> List.of();
        };
        for (String kind : related) {
            var refs = docs.path(kind);
            if (!refs.isArray()) continue;
            if (refs.isEmpty()) locations.add("접수 목록 " + kind + " 미제출");
            else if (!located) {
                var page = refs.get(0).path("page");
                locations.add(kind + (refs.size() > 1 ? " " + refs.size() + "부" : page.isIntegralNumber() && page.asInt()>0 ? " " + page.asInt() + "쪽" : ""));
            }
        }
        var hints = new StringJoiner(" · ");
        if (!locations.isEmpty()) hints.add(String.join(", ",locations));
        if (!fields.isEmpty()) hints.add(String.join(", ",fields));
        if (issue.equals("other") && fields.isEmpty()) return "";
        return (hints.length() == 0 ? "" : "[" + hints + "] ") + (fields.isEmpty() ? INSTRUCTIONS.get(issue) : "기재 내용을 확인해 주세요.");
    }

    private static boolean validPosition(JsonNode value) {
        return value.isIntegralNumber() && value.asInt() > 0 && value.asInt() <= 999;
    }
}
