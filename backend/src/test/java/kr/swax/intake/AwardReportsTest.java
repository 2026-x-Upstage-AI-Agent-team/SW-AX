package kr.swax.intake;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import static org.assertj.core.api.Assertions.assertThat;

class AwardReportsTest {
    final JsonMapper json = JsonMapper.builder().build();
    final UUID event = UUID.randomUUID(), submission = UUID.randomUUID();
    final List<UUID> files = List.of(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID());
    final ObjectNode source = (ObjectNode)json.readTree("""
        {"name":"등록 팀명","revision":2,"output":{"team_name":"API 팀명","documents":{"?":[]}},
         "fields":{"team_name":"이전 등록 팀명","award_type":"대상","support_amount":"100",
           "members":[{"role":"대표","name":"담당자 수정 성명"}],
           "recipient":{"bank_name":"담당자 수정 은행","gross_amount":"100","tax_amount":"0","net_amount":"100"}}}
        """);
    JsonNode saved;
    final JdbcTemplate db = new JdbcTemplate() {
        @Override public <T> List<T> queryForList(String sql, Class<T> type, Object... args) {
            return sql.contains("SELECT file_id") ? files.stream().map(type::cast).toList() : List.of();
        }
        @Override public <T> T queryForObject(String sql, Class<T> type, Object... args) { return type.cast(event); }
    };
    final AwardCatalog catalog = new AwardCatalog(db) {
        @Override void requireEvent(String staff, UUID id) {}
    };
    final WorkflowData data = new WorkflowData(db, json, catalog) {
        @Override List<JsonNode> list(String sql, Object... args) { return List.of(); }
        @Override ObjectNode one(String sql, Object... args) {
            if (sql.contains("INSERT INTO award_report")) {
                saved = json.readTree((String)args[4]);
                return json.createObjectNode().put("id", UUID.randomUUID().toString());
            }
            if (sql.contains("FROM ops_submission")) return source;
            return json.createObjectNode().put("name", "담당자 입력 행사");
        }
    };

    AwardReportsTest() {
        var docs = (ObjectNode)source.path("output").path("documents");
        for (int i=0; i<files.size(); i++) docs.putArray("0"+(i+1)).addObject().put("id", files.get(i).toString());
    }

    @Test void reportUsesExtractedTeamNameAndKeepsStaffCorrections() {
        new AwardReports(data).create(() -> "staff", new AwardReports.Order(event, new ArrayList<>(List.of(submission))));
        var team = saved.path("teams").get(0);
        assertThat(team.path("team_name").asString()).isEqualTo("API 팀명");
        assertThat(team.path("members")).isEqualTo(source.path("fields").path("members"));
        assertThat(team.path("recipient")).isEqualTo(source.path("fields").path("recipient"));
        assertThat(team.path("file_ids").size()).isEqualTo(3);
    }

    @Test void missingExtractedTeamNameStaysEmptyDespiteRegisteredAndLegacyValues() {
        ((ObjectNode)source.path("output")).remove("team_name");
        new AwardReports(data).create(() -> "staff", new AwardReports.Order(event, new ArrayList<>(List.of(submission))));
        assertThat(saved.path("teams").get(0).path("team_name").asString()).isEmpty();
    }
}
