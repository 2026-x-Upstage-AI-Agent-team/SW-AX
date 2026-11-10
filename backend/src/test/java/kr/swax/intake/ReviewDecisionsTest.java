package kr.swax.intake;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ReviewDecisionsTest {
    final JsonMapper json = JsonMapper.builder().propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE).build();
    ObjectNode saved;
    final JdbcTemplate db = new JdbcTemplate() {
        @Override public int update(String sql, Object... args) {
            if (sql.contains("INSERT INTO review_resolution")) saved = (ObjectNode)json.readTree((String)args[3]);
            return 1;
        }
    };
    final WorkflowData data = new WorkflowData(db, json, null) {
        @Override UUID scope(String staff, Resource resource, UUID id) { return id; }
        @Override void lockCurrent(UUID id) {}
        @Override ObjectNode one(String sql, Object... args) {
            return (ObjectNode)json.readTree("""
                {"revision":0,"state":"done","decision":null,"verdict":"성공"}
                """);
        }
        @Override void audit(UUID id, String staff, String action) {}
    };

    ReviewDecisions.Review form(String decision, String name, String rrn) {
        return new ReviewDecisions.Review(0, decision, "원본 대조", List.of(
            new ReviewDecisions.Member("대표", name, "00202601", "가상학과", "가상대학교")),
            Map.of("bank_name", "가상은행", "account_number", "001-0002", "rrn_display", rrn),
            List.of());
    }

    @Test void draftKeepsTheIncompleteMemberAndTheOriginalMask() {
        new ReviewDecisions(data).review(() -> "staff", UUID.randomUUID(), form("작성 중", "", "020101 - XXXXXXX"));
        assertThat(saved.path("members").get(0).path("name").asString()).isEmpty();
        assertThat(saved.path("members").get(0).path("student_id").asString()).isEqualTo("00202601");
        assertThat(saved.path("recipient").path("rrn_display").asString()).isEqualTo("020101 - XXXXXXX");
        assertThat(saved.path("recipient").path("account_number").asString()).isEqualTo("001-0002");
    }

    @Test void incompleteMemberCannotBeApproved() {
        assertThatThrownBy(() -> new ReviewDecisions(data).review(() -> "staff", UUID.randomUUID(), form("승인", "", "")))
            .isInstanceOf(ResponseStatusException.class).hasMessageContaining("409");
        assertThat(saved).isNull();
    }

    @Test void maskVariantsAreAcceptedAndUnmaskedNumbersAreRejected() {
        for (String value : List.of("020101-*******", "020101-3******", "020101 - XXXXXXX", "020101-●●●●●●●", "020101-********"))
            assertThat(ReviewDecisions.maskedRrn(value)).isTrue();
        assertThatThrownBy(() -> new ReviewDecisions(data).review(() -> "staff", UUID.randomUUID(), form("작성 중", "가상대표", "020101-1234567")))
            .isInstanceOf(ResponseStatusException.class).hasMessageContaining("422");
        assertThat(saved).isNull();
    }
}
