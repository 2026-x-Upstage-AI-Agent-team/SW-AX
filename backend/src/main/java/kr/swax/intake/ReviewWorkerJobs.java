package kr.swax.intake;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

@Service
class ReviewWorkerJobs {
    record ClaimRequest(String workerId, UUID eventId, UUID reviewJobId) {}
    record Claim(UUID reviewJobId, UUID eventId, UUID team, UUID submissionId, int version, int attempt,
                 UUID claimToken, OffsetDateTime leaseUntil, String studioJobId, List<TeamSubmissions.Original> files) {}
    record Checkpoint(String studioJobId) {}
    record Lease(OffsetDateTime leaseUntil, String studioJobId) {}
    record Result(String state, String studioJobId, String verdict, String reason, ObjectNode output) {}
    private record Owned(UUID submission, String state, String studioId, boolean live) {
        void requireLive() {
            if (!"running".equals(state) || !live) throw lostClaim();
        }
        String studioId(String requested) {
            if (requested == null) return studioId;
            if (requested.isBlank() || requested.length() > 160) throw ApiErrors.error(422, "Studio 실행 ID를 확인해 주세요.");
            if (studioId != null && !studioId.equals(requested)) throw ApiErrors.error(409, "이미 다른 Studio 실행이 연결돼 있습니다.");
            return requested;
        }
    }

    private static final Set<String> VERDICTS = Set.of("성공", "담당자확인", "재제출요청");
    private final JdbcTemplate db;
    private final TeamSubmissions submissions;
    private final ObjectMapper mapper;
    private final int leaseSeconds;

    ReviewWorkerJobs(JdbcTemplate db, TeamSubmissions submissions, ObjectMapper mapper,
                     @Value("${awards.review.lease-seconds}") int leaseSeconds) {
        if (leaseSeconds < 1) throw new IllegalArgumentException("워커 임대 시간은 1초 이상이어야 합니다.");
        this.db = db;
        this.submissions = submissions;
        this.mapper = mapper;
        this.leaseSeconds = leaseSeconds;
    }

    @Transactional
    Optional<Claim> claim(ClaimRequest request) {
        if (request.workerId() == null || request.workerId().isBlank() || request.workerId().length() > 80) {
            throw ApiErrors.error(422, "워커 식별자는 1~80자로 입력해 주세요.");
        }
        return db.query("""
                WITH candidate AS (
                    SELECT j.id, t.event_id, s.team_id, s.version
                    FROM review_job j JOIN team_submission s ON s.id = j.submission_id
                    JOIN award_team t ON t.id = s.team_id
                    JOIN intake_team_confirmation c ON c.submission_id = s.id AND c.state = 'confirmed'
                    WHERE (j.work_state = 'queued' OR (j.work_state = 'running' AND j.lease_until <= statement_timestamp()))
                      AND (?::uuid IS NULL OR t.event_id = ?)
                      AND (?::uuid IS NULL OR j.id = ?)
                    ORDER BY j.registered_at, j.id LIMIT 1 FOR UPDATE OF c, j SKIP LOCKED
                )
                UPDATE review_job j SET work_state = 'running', worker_id = ?, claim_token = gen_random_uuid(),
                    claim_attempt = claim_attempt + 1, lease_until = clock_timestamp() + ? * interval '1 second'
                FROM candidate c WHERE j.id = c.id
                RETURNING j.id, c.event_id, c.team_id, j.submission_id, c.version, j.claim_attempt,
                          j.claim_token, j.lease_until, j.studio_job_id
                """, (rs, n) -> {
            UUID id = rs.getObject("id", UUID.class);
            UUID submission = rs.getObject("submission_id", UUID.class);
            return new Claim(id, rs.getObject("event_id", UUID.class), rs.getObject("team_id", UUID.class),
                    submission, rs.getInt("version"), rs.getInt("claim_attempt"), rs.getObject("claim_token", UUID.class),
                    rs.getObject("lease_until", OffsetDateTime.class), rs.getString("studio_job_id"),
                    submissions.originals(submission, (batch, file) -> ReviewWorkerController.PATH + "/" + id + "/files/" + file + "/original"));
        }, request.eventId(), request.eventId(), request.reviewJobId(), request.reviewJobId(), request.workerId().strip(), leaseSeconds).stream().findFirst();
    }

    @Transactional
    IntakeStore.Original original(UUID id, UUID token, UUID file) {
        Owned claim = owned(id, token);
        claim.requireLive();
        return db.query("""
                SELECT f.name, f.original FROM team_submission_file sf JOIN intake_file f ON f.id = sf.file_id
                WHERE sf.submission_id = ? AND sf.file_id = ?
                """, (rs, n) -> new IntakeStore.Original(rs.getString("name"), rs.getBytes("original")), claim.submission(), file)
                .stream().findFirst().orElseThrow(() -> ApiErrors.error(404, "배정된 제출본의 원본을 찾을 수 없습니다."));
    }

    @Transactional
    Lease renew(UUID id, UUID token, Checkpoint checkpoint) {
        Owned claim = owned(id, token);
        claim.requireLive();
        return db.queryForObject("""
                UPDATE review_job SET studio_job_id = ?, lease_until = clock_timestamp() + ? * interval '1 second'
                WHERE id = ? RETURNING lease_until, studio_job_id
                """, (rs, n) -> new Lease(rs.getObject("lease_until", OffsetDateTime.class), rs.getString("studio_job_id")),
                claim.studioId(checkpoint.studioJobId()), leaseSeconds, id);
    }

    @Transactional
    void finish(UUID id, UUID token, Result request) {
        Owned claim = owned(id, token);
        String studioId = claim.studioId(request.studioJobId());
        boolean done = "done".equals(request.state());
        boolean failed = "failed".equals(request.state());
        if (request.reason() == null || request.reason().isBlank()
                || !(done || failed)
                || (done && (studioId == null || request.verdict() == null || !VERDICTS.contains(request.verdict())))
                || (failed && (request.verdict() != null || request.output() != null))) {
            throw ApiErrors.error(422, "완료 시 Studio 실행 ID·최종판정·사유, 실패 시 기술적 사유를 보내 주세요.");
        }
        String result = mapper.writeValueAsString(new Result(request.state(), studioId, request.verdict(), request.reason(), request.output()));
        if (!"running".equals(claim.state())) {
            if (db.queryForObject("SELECT result = ?::jsonb FROM review_job WHERE id = ?", Boolean.class, result, id)) return;
            throw ApiErrors.error(409, "이미 다른 결과가 등록됐습니다.");
        }
        claim.requireLive();
        db.update("""
                UPDATE review_job SET work_state = ?, studio_job_id = ?, result = ?::jsonb,
                    finished_at = clock_timestamp(), lease_until = NULL WHERE id = ?
                """, request.state(), studioId, result, id);
    }

    private Owned owned(UUID id, UUID token) {
        return db.query("""
                WITH owned AS MATERIALIZED (
                    SELECT j.submission_id, j.work_state, j.studio_job_id, j.lease_until
                    FROM review_job j JOIN intake_team_confirmation c ON c.submission_id = j.submission_id
                    WHERE j.id = ? AND j.claim_token = ? AND c.state = 'confirmed' FOR UPDATE OF j
                )
                SELECT submission_id, work_state, studio_job_id, lease_until > clock_timestamp() AS live FROM owned
                """, (rs, n) -> new Owned(rs.getObject("submission_id", UUID.class), rs.getString("work_state"),
                rs.getString("studio_job_id"), rs.getBoolean("live")), id, token)
                .stream().findFirst().orElseThrow(ReviewWorkerJobs::lostClaim);
    }

    private static RuntimeException lostClaim() { return ApiErrors.error(409, "이 작업의 유효한 워커 배정이 없습니다."); }
}
