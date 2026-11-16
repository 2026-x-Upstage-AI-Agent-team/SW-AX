package kr.swax.intake;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;
import static org.assertj.core.api.Assertions.assertThat;

class MailTemplateTest {
    @Test void missingTeamNameIsShownAsUnknown() {
        var source = new ObjectMapper().readTree("""
            {"name":" ","kind":"검토 완료","version":1,"output":{}}
            """);
        var template = MailTemplate.from(source);
        assertThat(template.subject()).endsWith("미확인");
        assertThat(template.body()).startsWith("미확인 팀장님");
    }

    @Test void draftKeepsLocationsAndFieldNamesWithoutCopyingPrivateValues() {
        var json=new ObjectMapper();
        var source=(ObjectNode)json.readTree("""
            {"name":"Alpha","kind":"보완 요청","version":2,"output":{
                "issues":["student_id","representative","identity"],"reason":"private",
                "documents":{"01":[{"id":"a","page":1}],"03":[]},
                "checks":[{"issue":"student_id","passed":false,"refs":[{"id":"a","page":2,"row":1}],"fields":["representative_phone"],"value":"private"},
                          {"issue":"representative","passed":true,"refs":[{"id":"a","page":3}]}]}}
            """);
        var template=MailTemplate.from(source);
        assertThat(template.subject()).isEqualTo("[시상금 서류 보완 요청] Alpha");
        assertThat(template.body()).contains("[01 2쪽 1행 · 대표 전화번호] 기재 내용을 확인",
                "[01 1쪽, 접수 목록 03 미제출] 지급확인서의 대표 성명","기존 제출 경로").doesNotContain("제출 2차","검토 결과입니다","해당 학번","private","3쪽");
        source.put("decision","보완 필요");
        source.putArray("issues").add("identity");
        assertThat(MailTemplate.from(source).body()).contains("[접수 목록 03 미제출]").doesNotContain("학번","대표 전화번호");
    }

    @Test void concreteAgentErrorsAreGroupedByActualFileWithoutInternalNotes() {
        var source = new ObjectMapper().readTree("""
            {"name":"가상검토팀14","kind":"보완 요청","version":1,"files":[
                {"id":"a","name":"set14_A_신청서.hwp"},{"id":"b","name":"set14_B_동의서.hwp"},{"id":"c","name":"set14_C_사본.hwpx"}],
             "output":{"documents":{"01":[{"id":"a"}],"02":[{"id":"b"}],"03":[{"id":"c"}]},
                "issues":["consent","account","other"],"agent_decision":{"확정오류":[
                    {"문서유형":"개인정보동의서","대상자":"박정인","검사항목":"제3자 제공 동의","문제유형":"명시적 비동의","근거":"private 123456789012"},
                    {"문서유형":"수혜학생 신청 및 시상금 지급 확인서 / 통장 사본","대상자":"김종민","검사항목":"계좌번호","문제유형":"누락","근거":"private@example.test"},
                    {"문서유형":"수혜학생 신청 및 시상금 지급 확인서 / 통장 사본","대상자":"김종민","검사항목":"은행명","문제유형":"불일치【†1】","근거":"private"}],
                  "확인필요":[{"문서유형":"신분증","대상자":"대표","검사항목":"판독 신뢰도","문제유형":"내부 확인","근거":"private"}]}}}
            """);
        var body = MailTemplate.from(source).body();
        assertThat(body).isEqualTo("""
            가상검토팀14 팀장님,

            1. set14_B_동의서.hwp
               - 박정인 / 제3자 제공 동의: 비동의로 표시됨

            2. set14_A_신청서.hwp / set14_C_사본.hwpx
               - 김종민 / 계좌번호: 누락
               - 김종민 / 은행명: 불일치

            위 항목을 다시 확인한 후 보완한 서류를 기존 제출 경로로 재제출해 주세요.
            """.stripTrailing());
        assertThat(body).doesNotContain("제출 1차","검토 결과","private","123456789012","【","판독 신뢰도","작성자 명단");
    }

    @Test void missingFileAndStudentFieldsAreNamedAndUncertainFindingsAreExcluded() {
        var source = (ObjectNode)new ObjectMapper().readTree("""
            {"name":"Alpha","kind":"보완 요청","output":{"documents":{},"issues":["consent","other"],
              "agent_decision":{"확정오류":[
                {"문서유형":"개인정보동의서","대상자":"문서 전체","검사항목":"필수 제출 서류","문제유형":"미제출","근거":"private"},
                {"문서유형":"지급확인서","대상자":"팀원 가상학생","검사항목":"participants[1].student_id","문제유형":"누락","근거":"private"},
                {"문서유형":"지급확인서","대상자":"대표","검사항목":"representative_email","문제유형":"누락","근거":"private"},
                {"문서유형":"지급확인서","대상자":"팀원 가상학생","검사항목":"members.name","문제유형":"누락","근거":"private"}],
                "확인필요":[{"문서유형":"통장","대상자":"대표","검사항목":"계좌번호","문제유형":"판독 확인","근거":"private"}]}}}
            """);
        assertThat(MailTemplate.from(source).body()).contains("개인정보 수집·이용·제공 동의서", "필수 제출 서류: 미제출",
            "가상학생 / 학번: 누락","대표 이메일: 누락","가상학생 / 성명: 누락")
            .doesNotContain("문서 전체","participants","members.","representative_email","판독 확인","private");
        ((ObjectNode)source.path("output").path("agent_decision")).putArray("확정오류");
        assertThat(MailTemplate.from(source).body()).isEmpty();
    }

    @Test void staffSelectedCategoriesAreRespectedForStructuredErrors() {
        var source = new ObjectMapper().readTree("""
            {"name":"Alpha","kind":"보완 요청","decision":"보완 필요","issues":["consent"],"output":{
              "documents":{},"checks":[
                {"label":"개인정보동의서 · 학생 · 서명 · 누락: private","issue":"consent","passed":false},
                {"label":"지급확인서 · 대표 · 이메일 · 누락: private","issue":"other","passed":false}],
              "agent_decision":{"확정오류":[
                {"문서유형":"개인정보동의서","대상자":"학생","검사항목":"서명","문제유형":"누락","근거":"private"},
                {"문서유형":"지급확인서","대상자":"대표","검사항목":"이메일","문제유형":"누락","근거":"private"}]}}}
            """);
        assertThat(MailTemplate.from(source).body()).contains("학생 / 서명: 누락").doesNotContain("이메일");
    }

    @Test void confirmedStaffReasonCreatesDraftWhenAgentHasOnlyReviewFindings() {
        var source=new ObjectMapper().readTree("""
            {"name":"가상검토팀05","kind":"보완 요청","decision":"보완 필요","note":"동의서 없음",
             "issues":["consent","other"],"output":{"agent_decision":{"확정오류":[],"확인필요":[
               {"검사항목":"중복 제출 여부","근거":"내부 검토 정보"},{"검사항목":"사본 판독","근거":"내부 검토 정보"}]}}}
            """);
        var template=MailTemplate.from(source);
        assertThat(template.body()).contains("가상검토팀05 팀장님,","보완할 사항\n- 동의서 없음","재제출")
            .doesNotContain("내부 검토 정보","중복 제출 여부","사본 판독","제출 1차");
        assertThat(template.emptyReason()).isEmpty();
    }

    @Test void internalNotesAreNotForwardedBeforeSupplementIsConfirmed() {
        var source=(ObjectNode)new ObjectMapper().readTree("""
            {"name":"Alpha","kind":"보완 요청","note":"내부 검토 메모","decision":"작성 중",
             "output":{"agent_decision":{"확정오류":[],"확인필요":[]}}}
            """);
        for (String decision:java.util.List.of("작성 중","승인")) {
            source.put("decision",decision);
            var template=MailTemplate.from(source);
            assertThat(template.body()).isEmpty();
            assertThat(template.emptyReason()).contains("확정한 보완 항목이 없어");
        }
    }

    @Test void confirmedReasonKeepsLinesAndMasksDirectIdentifiers() {
        var source=new ObjectMapper().readTree("""
            {"name":"Alpha","kind":"보완 요청","decision":"보완 필요",
             "note":"동의서를 다시 제출해 주세요.【†1】\\n동의서를 다시 제출해 주세요.\\n학번 20201234, 전화 010-1234-5678, 계좌 1234-56-1234567, 이메일 student@example.test, 주민번호 010327-3******",
             "output":{"agent_decision":{"확정오류":[],"확인필요":[]}}}
            """);
        var body=MailTemplate.from(source).body();
        assertThat(body).contains("- 동의서를 다시 제출해 주세요.","[번호 가림]","[이메일 가림]","[주민번호 가림]")
            .doesNotContain("20201234","010-1234-5678","1234-56-1234567","student@example.test","010327-3******","【†1】");
        assertThat(body.indexOf("- 동의서를 다시 제출해 주세요.")).isEqualTo(body.lastIndexOf("- 동의서를 다시 제출해 주세요."));
    }

    @Test void emptyConfirmedReasonProvidesAnActionableExplanation() {
        var source=new ObjectMapper().readTree("""
            {"name":"Alpha","kind":"보완 요청","decision":"보완 필요","note":" ","issues":["consent"],
             "output":{"agent_decision":{"확정오류":[],"확인필요":[]}}}
            """);
        var template=MailTemplate.from(source);
        assertThat(template.body()).isEmpty();
        assertThat(template.emptyReason()).contains("담당자가 확정한 보완 사유","직접 작성");
    }
}
