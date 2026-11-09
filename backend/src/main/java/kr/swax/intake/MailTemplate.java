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
    private static final Map<String,String> FIELDS = Map.of(
        "representative_name","대표 성명", "representative_student_id","대표 학번", "representative_phone","대표 전화번호",
        "representative_email","대표 이메일", "representative_signed","대표 서명", "applicant_signed","신청인 서명",
        "project_name","과제명", "representative_account","대표 계좌 기재란", "account_number","통장 계좌 기재란", "written_date","작성일");

    static MailTemplate from(JsonNode mail) {
        String name = mail.path("name").asString("").replaceAll("\\R", " ");
        String kind = mail.path("kind").asString();
        int version = mail.path("version").asInt();
        var lines = new ArrayList<String>();
        lines.add(name + " 팀장님, 제출 " + version + "차 서류의 검토 결과입니다.");
        lines.add("");
        if (kind.equals("보완 요청")) {
            JsonNode output = mail.path("output");
            JsonNode selected = "보완 필요".equals(mail.path("decision").asString("")) ? mail.path("issues") : output.path("issues");
            var issues = new LinkedHashSet<String>();
            selected.forEach(item -> issues.add(item.asString("")));
            if (issues.isEmpty()) issues.add("other");
            for (String issue : issues) if (INSTRUCTIONS.containsKey(issue)) lines.add(instruction(issue,output));
            lines.add("보완한 서류는 기존 제출 경로로 담당자에게 보내 주세요.");
        } else lines.add("제출한 서류의 검토를 완료했습니다.");
        return new MailTemplate("[시상금 서류 " + kind + "] " + name, String.join("\n",lines));
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
        return (hints.length() == 0 ? "" : "[" + hints + "] ") + INSTRUCTIONS.get(issue);
    }

    private static boolean validPosition(JsonNode value) {
        return value.isIntegralNumber() && value.asInt() > 0 && value.asInt() <= 999;
    }
}
