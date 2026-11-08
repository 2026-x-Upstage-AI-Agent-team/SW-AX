package kr.swax.intake;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
class ReviewJobs {
    record Reference(UUID reviewJobId, String state, String statusUrl) {}
    record Job(UUID reviewJobId, String state, UUID eventId, UUID team, UUID submissionId, int version,
               OffsetDateTime registeredAt, String submissionUrl, String statusUrl) {}

    private static final String SELECT = """
            SELECT j.review_job_id, j.state, j.event_id, j.team_id, j.submission_id, j.version, j.registered_at
            FROM review_job_status j
            """;
    private static final String ORDER = " ORDER BY j.registered_at, j.review_job_id";
    private static final Set<String> STATES = Set.of("queued", "blocked", "superseded");
    private final JdbcTemplate db;
    private final AwardCatalog catalog;

    ReviewJobs(JdbcTemplate db, AwardCatalog catalog) {
        this.db = db;
        this.catalog = catalog;
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
        return db.queryForObject(SELECT + " WHERE j.submission_id = ?", ReviewJobs::job, submission);
    }

    Job get(String login, UUID id) {
        return db.query(SELECT + """
                JOIN event_staff a ON a.event_id = j.event_id WHERE a.login = ? AND j.review_job_id = ?
                """, ReviewJobs::job, login, id).stream().findFirst()
                .orElseThrow(() -> ApiErrors.error(404, "판정 작업을 찾을 수 없습니다."));
    }

    @Transactional
    List<Job> list(String login, UUID event, String state) {
        catalog.requireEvent(login, event);
        String sql = SELECT + " WHERE j.event_id = ?";
        if (state == null) return db.query(sql + ORDER, ReviewJobs::job, event);
        if (!STATES.contains(state)) throw ApiErrors.error(422, "판정 작업 상태를 확인해 주세요.");
        return db.query(sql + " AND j.state = ?" + ORDER, ReviewJobs::job, event, state);
    }

    static Reference reference(ResultSet rs) throws SQLException {
        UUID id = rs.getObject("review_job_id", UUID.class);
        return id == null ? null : new Reference(id, rs.getString("job_state"), url(id));
    }

    private static Job job(ResultSet rs, int row) throws SQLException {
        UUID id = rs.getObject("review_job_id", UUID.class);
        UUID submission = rs.getObject("submission_id", UUID.class);
        return new Job(id, rs.getString("state"), rs.getObject("event_id", UUID.class), rs.getObject("team_id", UUID.class),
                submission, rs.getInt("version"), rs.getObject("registered_at", OffsetDateTime.class),
                "/api/submissions/" + submission, url(id));
    }

    private static String url(UUID id) { return "/api/review-jobs/" + id; }
}
