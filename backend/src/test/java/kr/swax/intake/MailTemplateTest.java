package kr.swax.intake;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;
import static org.assertj.core.api.Assertions.assertThat;

class MailTemplateTest {
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
        assertThat(template.body()).contains("제출 2차","[01 2쪽 1행 · 대표 전화번호] 지급확인서의 해당 학번",
                "[01 1쪽, 접수 목록 03 미제출] 지급확인서의 대표 성명","기존 제출 경로").doesNotContain("private","3쪽");
        source.put("decision","보완 필요");
        source.putArray("issues").add("identity");
        assertThat(MailTemplate.from(source).body()).contains("[접수 목록 03 미제출]").doesNotContain("학번","대표 전화번호");
    }
}
