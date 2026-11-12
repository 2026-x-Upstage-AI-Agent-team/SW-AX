package kr.swax.intake;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ReviewWorkerJobsTest {
    @Test void completionStoresTheSupplementRequiredVerdictWithoutRenamingIt() throws Exception {
        var json = JsonMapper.builder().build();
        var row = mock(ResultSet.class);
        when(row.getObject("submission_id", UUID.class)).thenReturn(UUID.randomUUID());
        when(row.getString("work_state")).thenReturn("running");
        when(row.getBoolean("live")).thenReturn(true);
        JsonNode[] saved = new JsonNode[1];
        var db = new JdbcTemplate() {
            @Override public <T> List<T> queryForList(String sql, Class<T> type, Object... args) { return List.of(); }
            @Override public <T> List<T> query(String sql, RowMapper<T> mapper, Object... args) {
                try { return List.of(mapper.mapRow(row, 0)); }
                catch (SQLException error) { throw new AssertionError(error); }
            }
            @Override public int update(String sql, Object... args) {
                saved[0] = json.readTree((String)args[2]);
                return 1;
            }
        };
        var output = json.createObjectNode().put("verdict", "보완필요");
        new ReviewWorkerJobs(db, null, json, 300).finish(UUID.randomUUID(), UUID.randomUUID(),
            new ReviewWorkerJobs.Result("done", "job_config4_test", "보완필요", "Agent 판정 근거", output));
        assertThat(saved[0].path("verdict").asString()).isEqualTo("보완필요");
        assertThat(saved[0].path("reason").asString()).isEqualTo("Agent 판정 근거");
        assertThat(saved[0].path("output")).isEqualTo(output);
    }
}
