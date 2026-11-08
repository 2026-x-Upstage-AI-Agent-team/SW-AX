package kr.swax.intake;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonInclude;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Service
class ReviewJobs {
    record Reference(UUID reviewJobId, String state, String statusUrl,
                     @JsonInclude(JsonInclude.Include.NON_NULL) String verdict) {}
    record Job(UUID reviewJobId, String state, UUID eventId, UUID team, UUID submissionId, int version,
               OffsetDateTime registeredAt, String submissionUrl, String statusUrl, String workerId,
               String studioJobId, OffsetDateTime finishedAt, String verdict,
               @JsonInclude(JsonInclude.Include.NON_NULL) JsonNode result) {}

    private static String select(boolean withResult) {
        return """
                SELECT j.review_job_id, j.state, j.event_id, j.team_id, j.submission_id, j.version, j.registered_at,
                       j.worker_id, j.studio_job_id, j.finished_at, j.verdict,
                """ + (withResult ? "j.result" : "NULL") + " AS result FROM review_job_status j ";
    }
    private static final String ORDER = " ORDER BY j.registered_at, j.review_job_id";
    private static final Set<String> STATES = Set.of("queued", "running", "done", "failed", "blocked", "superseded");
    private final JdbcTemplate db;
    private final AwardCatalog catalog;
    private final ObjectMapper mapper;

    ReviewJobs(JdbcTemplate db, AwardCatalog catalog, ObjectMapper mapper) {
        this.db = db;
        this.catalog = catalog;
        this.mapper = mapper;
    }

    @Transactional
    Job register(String login, UUID submission) {
        // Confirmation/reassignment uses the same team lock. Recheck eligibility after acquiring it.
        if (db.queryForList("""
                SELECT t.id FROM team_submission s JOIN award_team t ON t.id = s.team_id
                JOIN event_staff a ON a.event_id = t.event_id
                WHERE s.id = ? AND a.login = ? FOR NO KEY UPDATE OF t FOR KEY SHARE OF a
                """, UUID.class, submission, login).isEmpty()) {
            throw ApiErrors.error(404, "팀 제출본을 찾을 수 없습니다.");
        }
        if (!db.queryForObject("""
                SELECT EXISTS (SELECT 1 FROM intake_team_confirmation WHERE submission_id = ? AND state = 'confirmed')
                """, Boolean.class, submission)) {
            throw ApiErrors.error(409, "현재 확정된 팀 제출본에만 판정 작업을 등록할 수 있습니다.");
        }
        db.update("INSERT INTO review_job (submission_id) VALUES (?) ON CONFLICT (submission_id) DO NOTHING", submission);
        return db.queryForObject(select(true) + " WHERE j.submission_id = ?", this::job, submission);
    }

    Job get(String login, UUID id) {
        return db.query(select(true) + """
                JOIN event_staff a ON a.event_id = j.event_id WHERE a.login = ? AND j.review_job_id = ?
                """, this::job, login, id).stream().findFirst()
                .orElseThrow(() -> ApiErrors.error(404, "판정 작업을 찾을 수 없습니다."));
    }

    @Transactional
    List<Job> list(String login, UUID event, String state) {
        catalog.requireEvent(login, event);
        String sql = select(false) + " WHERE j.event_id = ?";
        if (state == null) return db.query(sql + ORDER, this::job, event);
        if (!STATES.contains(state)) throw ApiErrors.error(422, "판정 작업 상태를 확인해 주세요.");
        return db.query(sql + " AND j.state = ?" + ORDER, this::job, event, state);
    }

    static Reference reference(ResultSet rs) throws SQLException {
        UUID id = rs.getObject("review_job_id", UUID.class);
        if (id == null) return null;
        String state = rs.getString("job_state");
        return new Reference(id, state, url(id), "done".equals(state) ? rs.getString("verdict") : null);
    }

    private Job job(ResultSet rs, int row) throws SQLException {
        UUID id = rs.getObject("review_job_id", UUID.class);
        UUID submission = rs.getObject("submission_id", UUID.class);
        String result = rs.getString("result");
        return new Job(id, rs.getString("state"), rs.getObject("event_id", UUID.class), rs.getObject("team_id", UUID.class),
                submission, rs.getInt("version"), rs.getObject("registered_at", OffsetDateTime.class),
                "/api/submissions/" + submission, url(id), rs.getString("worker_id"), rs.getString("studio_job_id"),
                rs.getObject("finished_at", OffsetDateTime.class), rs.getString("verdict"), result == null ? null : mapper.readTree(result));
    }

    private static String url(UUID id) { return "/api/review-jobs/" + id; }
}
