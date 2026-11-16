package kr.swax.intake;

import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;
import static org.assertj.core.api.Assertions.assertThat;

class MailDraftsTest {
    final JsonMapper json = JsonMapper.builder().build();

    ObjectNode view(ObjectNode row) {
        var db = new JdbcTemplate() {
            @Override public int update(String sql, Object... args) { throw new AssertionError("Viewing a draft must not write it"); }
        };
        var data = new WorkflowData(db,json,null) {
            @Override UUID scope(String staff, Resource resource, UUID id) { return id; }
            @Override ObjectNode one(String sql, Object... args) { return row.deepCopy(); }
        };
        return (ObjectNode)new MailDrafts(data,null,"local").view(() -> "staff",UUID.randomUUID());
    }

    ObjectNode row() {
        return (ObjectNode)json.readTree("""
            {"info":{"state":"draft","subject":null,"body":null},"recipient":"leader@example.test","eligible":true,
             "source":{"name":"Alpha","kind":"보완 요청","version":1,"files":[{"id":"a","name":"학생신청서.hwp"}],
               "output":{"documents":{"01":[{"id":"a"}]},"agent_decision":{"확정오류":[
                 {"문서유형":"지급확인서","대상자":"대표","검사항목":"이메일","문제유형":"누락"}]}}}}
            """);
    }

    @Test void unsavedDraftUsesTheConcreteTemplateWithRealFileName() {
        var result = view(row());
        assertThat(result.path("body").asString()).contains("학생신청서.hwp","대표 / 이메일: 누락","재제출")
            .doesNotContain("제출 1차","검토 결과입니다");
    }

    @Test void staffEditedSubjectAndBodyArePreserved() {
        var row = row();
        ((ObjectNode)row.path("info")).put("subject","담당자가 수정한 제목").put("body","담당자가 확인한 보완 항목\n월요일까지 보내 주세요.");
        var result = view(row);
        assertThat(result.path("subject").asString()).isEqualTo("담당자가 수정한 제목");
        assertThat(result.path("body").asString()).isEqualTo("담당자가 확인한 보완 항목\n월요일까지 보내 주세요.");
        ((ObjectNode)row.path("info")).putNull("subject");
        assertThat(view(row).path("body").asString()).isEqualTo("담당자가 확인한 보완 항목\n월요일까지 보내 주세요.");
    }

    @Test void confirmedStaffReasonIsRenderedWithoutSavingTheDraft() {
        var row=row();
        ((ObjectNode)row.path("source")).put("decision","보완 필요").put("note","동의서 없음");
        ((ObjectNode)row.path("source").path("output").path("agent_decision")).putArray("확정오류");
        var result=view(row);
        assertThat(result.path("body").asString()).contains("동의서 없음","재제출");
        assertThat(result.path("generation_reason").asString()).isEmpty();
    }

    @Test void noActionableContentReturnsExplanationOutsideTheMailBody() {
        var row=row();
        ((ObjectNode)row.path("source").path("output").path("agent_decision")).putArray("확정오류");
        var result=view(row);
        assertThat(result.path("body").asString()).isEmpty();
        assertThat(result.path("generation_reason").asString()).contains("AI가","확정한 보완 항목");
    }

    @Test void savedBlankAndEditedDraftsArePreservedAfterTheStaffReasonChanges() {
        var row=row();
        ((ObjectNode)row.path("source")).put("decision","보완 필요").put("note","새로운 보완 사유");
        var info=(ObjectNode)row.path("info");
        info.put("subject","수정한 제목").put("body","");
        var blank=view(row);
        assertThat(blank.path("body").asString()).isEmpty();
        assertThat(blank.path("generation_reason").asString()).contains("저장된 본문이 비어");
        info.put("body","담당자가 직접 작성한 최종 안내");
        var edited=view(row);
        assertThat(edited.path("body").asString()).isEqualTo("담당자가 직접 작성한 최종 안내");
        assertThat(edited.path("generation_reason").asString()).isEmpty();
    }
}
