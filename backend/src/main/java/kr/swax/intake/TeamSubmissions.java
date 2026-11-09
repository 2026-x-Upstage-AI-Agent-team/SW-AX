package kr.swax.intake;

import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.function.BiFunction;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

@Service
class TeamSubmissions {
    record Confirmation(Integer revision) {}
    record Link(UUID team, String state, UUID submissionId, Integer version, String statusUrl, ReviewJobs.Reference reviewJob) {}
    record Original(UUID itemId, UUID batchId, int position, String name, int size, String sha256, String originalUrl) {}
    record Snapshot(UUID submissionId, UUID eventId, UUID team, int version, String state, String confirmedBy,
                    OffsetDateTime confirmedAt, List<Original> files, ReviewJobs.Reference reviewJob) {}
    private record Version(UUID id, int number, String digest) {}
    private record Batch(UUID event, int revision) {}

    private static final String LINKS = """
            SELECT c.team_id, c.state, s.id, s.version, j.review_job_id, j.state AS job_state, j.verdict
            FROM intake_team_confirmation c JOIN team_submission s ON s.id = c.submission_id
            LEFT JOIN review_job_status j ON j.submission_id = s.id WHERE c.batch_id = ?
            """;
    private final JdbcTemplate db;
    private final IntakeStore intake;

    TeamSubmissions(JdbcTemplate db, IntakeStore intake) {
        this.db = db;
        this.intake = intake;
    }

    @Transactional
    Link confirm(String login, UUID batch, UUID team, Confirmation command) {
        Batch receipt = db.query("""
                SELECT b.event_id, b.assignment_revision FROM intake_batch b
                JOIN event_staff a ON a.event_id = b.event_id
                WHERE b.id = ? AND a.login = ? FOR UPDATE OF b FOR KEY SHARE OF a
                """, (rs, n) -> new Batch(rs.getObject("event_id", UUID.class), rs.getInt("assignment_revision")),
                batch, login).stream().findFirst().orElseThrow(() -> ApiErrors.error(404, "접수번호를 찾을 수 없습니다."));
        if (command.revision() == null || command.revision() < 0) {
            throw ApiErrors.error(422, "조회한 접수 목록의 버전을 보내 주세요.");
        }
        if (receipt.revision() != command.revision()) {
            throw ApiErrors.error(409, "접수 목록이 변경됐습니다. 새로 조회한 뒤 확정해 주세요.");
        }
        if (db.queryForList("SELECT id FROM award_team WHERE event_id = ? AND id = ? FOR NO KEY UPDATE",
                UUID.class, receipt.event(), team).isEmpty()) {
            throw ApiErrors.error(422, "같은 대회의 팀을 지정해 주세요.");
        }
        return reconcile(login, batch, team, receiptLink(batch, team), intake.files(batch), true);
    }

    // The assignment caller holds the receipt lock. Other receipts can confirm the same teams concurrently.
    void refresh(String login, UUID batch, UUID before, UUID after) {
        // Moving an assigned file between two teams leaves every other team's candidate holds untouched.
        Set<UUID> affected = Set.copyOf(db.queryForList("""
                SELECT t.id FROM intake_team_confirmation c JOIN award_team t ON t.id = c.team_id
                WHERE c.batch_id = ? AND (? OR t.id IN (?, ?)) ORDER BY t.id FOR NO KEY UPDATE OF t
                """, UUID.class, batch, before == null || after == null, before, after));
        if (affected.isEmpty()) return;
        List<IntakeStore.Item> files = intake.files(batch);
        for (Link previous : links(db, batch)) {
            if (!affected.contains(previous.team())) continue;
            if (previous.state().equals("superseded")) {
                if (previous.team().equals(before) || previous.team().equals(after)) throw newerReceipt();
                continue;
            }
            reconcile(login, batch, previous.team(), previous, files, false);
        }
    }

    private Link reconcile(String login, UUID batch, UUID team, Link previous, List<IntakeStore.Item> files,
                           boolean explicit) {
        // All callers hold the batch lock, also used when preparation finishes or a file is retried.
        boolean read = db.queryForObject("""
                SELECT EXISTS(SELECT FROM intake_preparation WHERE batch_id=? AND state IN ('ready','prepared'))
                """, Boolean.class, batch);
        if (!read && explicit) {
            throw ApiErrors.error(409, "접수 원본의 판독이 끝난 뒤 팀 제출본을 확정해 주세요.");
        }
        boolean blocked = !read || files.stream().anyMatch(f -> f.holds(team));
        List<IntakeStore.Item> selected = new ArrayList<>(db.query("""
                SELECT f.id,f.name,f.size_bytes,f.sha256,sf.position FROM intake_batch b
                JOIN team_submission_file sf ON sf.submission_id=b.base_submission JOIN intake_file f ON f.id=sf.file_id
                WHERE b.id=? AND b.target_team_id=? AND f.id<>ALL(b.replaced) ORDER BY sf.position
                """, (rs,n) -> new IntakeStore.Item(rs.getObject("id",UUID.class),rs.getInt("position"),rs.getString("name"),
                rs.getInt("size_bytes"),rs.getString("sha256"),team,"assigned","",List.of(),List.of()),batch,team));
        selected.addAll(files.stream().filter(f -> team.equals(f.team())).toList());
        if (previous == null && db.queryForObject("""
                SELECT EXISTS(SELECT FROM intake_batch b WHERE b.id=? AND b.target_team_id=? AND b.base_submission IS NOT NULL
                    AND NOT EXISTS(SELECT FROM intake_team_confirmation c WHERE c.team_id=? AND c.state='confirmed'
                    AND c.submission_id=b.base_submission))
                """,Boolean.class,batch,team,team)) throw newerReceipt();
        if (blocked || selected.isEmpty()) {
            if (explicit) throw ApiErrors.error(409, blocked ? "이 팀에 속할 수 있는 미배정 원본이 남아 있습니다."
                    : "이 팀에 배정된 원본이 없습니다.");
            if (previous == null) return null;
            String state = blocked ? "blocked" : "empty";
            if (!state.equals(previous.state())) {
                db.update("UPDATE intake_team_confirmation SET state = ? WHERE batch_id = ? AND team_id = ?",
                        state, batch, team);
            }
            return receiptLink(batch, team);
        }

        var hash = IntakeUpload.sha256();
        selected.stream().map(IntakeStore.Item::sha256).sorted()
                .forEach(value -> hash.update(value.getBytes(StandardCharsets.US_ASCII)));
        String digest = HexFormat.of().formatHex(hash.digest());
        Version latest = db.query("""
                SELECT id, version, digest FROM team_submission WHERE team_id = ? ORDER BY version DESC LIMIT 1
                """, (rs, n) -> new Version(rs.getObject("id", UUID.class), rs.getInt("version"), rs.getString("digest")),
                team).stream().findFirst().orElse(null);
        if (previous != null && previous.state().equals("superseded")) {
            if (previous.submissionId().equals(latest.id()) && digest.equals(latest.digest())) return previous;
            throw newerReceipt();
        }
        if (latest == null || !digest.equals(latest.digest())) {
            latest = create(login, team, latest == null ? 1 : latest.number() + 1, digest, selected);
        }
        if (previous != null && previous.state().equals("confirmed") && latest.id().equals(previous.submissionId())) {
            return previous;
        }
        if (previous == null) {
            db.update("""
                    UPDATE intake_team_confirmation SET state = 'superseded'
                    WHERE team_id = ? AND state <> 'superseded'
                    """, team);
        }
        db.update("""
                INSERT INTO intake_team_confirmation(batch_id, team_id, submission_id, state) VALUES (?, ?, ?, 'confirmed')
                ON CONFLICT (batch_id, team_id) DO UPDATE SET submission_id = EXCLUDED.submission_id, state = 'confirmed'
                """, batch, team, latest.id());
        return receiptLink(batch, team);
    }

    private Version create(String login, UUID team, int number, String digest, List<IntakeStore.Item> files) {
        UUID id = UUID.randomUUID();
        db.update("INSERT INTO team_submission(id, team_id, version, digest, confirmed_by) VALUES (?, ?, ?, ?, ?)",
                id, team, number, digest, login);
        List<Object[]> rows = new ArrayList<>(files.size());
        for (int i = 0; i < files.size(); i++) rows.add(new Object[] {id, i + 1, files.get(i).itemId()});
        db.batchUpdate("INSERT INTO team_submission_file(submission_id, position, file_id) VALUES (?, ?, ?)", rows);
        return new Version(id, number, digest);
    }

    static List<Link> links(JdbcTemplate db, UUID batch) {
        return db.query(LINKS + " ORDER BY c.team_id", TeamSubmissions::link, batch);
    }

    @Transactional
    void confirmPrepared(UUID batch) {
        var phases=db.queryForList("""
                SELECT p.state FROM intake_preparation p JOIN intake_batch b ON b.id=p.batch_id
                WHERE b.id=? FOR UPDATE OF b,p
                """,String.class,batch);
        if (phases.isEmpty() || phases.getFirst().equals("pending")) return;
        List<IntakeStore.Item> files=intake.files(batch);
        var teams=db.queryForList("""
                SELECT t.id FROM award_team t WHERE t.id IN (SELECT team_id FROM intake_file_state WHERE batch_id=?
                    UNION SELECT target_team_id FROM intake_batch WHERE id=? AND base_submission IS NOT NULL
                      UNION SELECT team_id FROM intake_team_confirmation WHERE batch_id=?)
                ORDER BY t.id FOR NO KEY UPDATE
                """,UUID.class,batch,batch,batch);
        for (UUID team : teams) {
            Link previous=receiptLink(batch,team);
            if (previous==null && files.stream().anyMatch(f -> f.holds(team))) continue;
            if (previous!=null && previous.state().equals("superseded")) continue;
            // An older pending batch cannot take ownership back from a more recent receipt.
            if (db.queryForObject("""
                    SELECT EXISTS(SELECT FROM intake_team_confirmation c JOIN intake_batch current ON current.id=c.batch_id
                        JOIN intake_batch original ON original.id=? WHERE c.team_id=? AND c.state<>'superseded'
                        AND current.created_at>original.created_at)
                    """,Boolean.class,batch,team)) continue;
            reconcile("@workflow",batch,team,previous,files,false);
        }
        db.update("UPDATE intake_preparation SET state='prepared' WHERE batch_id=?",batch);
    }

    private Link receiptLink(UUID batch, UUID team) {
        return db.query(LINKS + " AND c.team_id = ?", TeamSubmissions::link, batch, team)
                .stream().findFirst().orElse(null);
    }

    private static Link link(ResultSet rs, int row) throws SQLException {
        String state = rs.getString("state");
        UUID team = rs.getObject("team_id", UUID.class);
        ReviewJobs.Reference job = ReviewJobs.reference(rs);
        if (state.equals("blocked") || state.equals("empty")) return new Link(team, state, null, null, null, job);
        UUID id = rs.getObject("id", UUID.class);
        return new Link(team, state, id, rs.getInt("version"), "/api/submissions/" + id, job);
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    Snapshot get(String login, UUID id) {
        return db.query("""
                SELECT s.team_id, t.event_id, s.version, s.confirmed_by, s.confirmed_at,
                       coalesce(c.state, 'superseded') AS state, j.review_job_id, j.state AS job_state, j.verdict
                FROM team_submission s JOIN award_team t ON t.id = s.team_id
                JOIN event_staff a ON a.event_id = t.event_id
                LEFT JOIN intake_team_confirmation c ON c.team_id = s.team_id AND c.submission_id = s.id
                    AND c.state <> 'superseded'
                LEFT JOIN review_job_status j ON j.submission_id = s.id
                WHERE s.id = ? AND a.login = ?
                """, (rs, n) -> new Snapshot(id, rs.getObject("event_id", UUID.class), rs.getObject("team_id", UUID.class),
                rs.getInt("version"), rs.getString("state"), rs.getString("confirmed_by"),
                rs.getObject("confirmed_at", OffsetDateTime.class),
                originals(id, (batch, item) -> "/api/intake-batches/" + batch + "/files/" + item + "/original"),
                ReviewJobs.reference(rs)), id, login).stream().findFirst()
                .orElseThrow(() -> ApiErrors.error(404, "팀 제출본을 찾을 수 없습니다."));
    }

    List<Original> originals(UUID submission, BiFunction<UUID, UUID, String> originalUrl) {
        return db.query("""
                SELECT f.id, f.batch_id, sf.position, f.name, f.size_bytes, f.sha256
                FROM team_submission_file sf JOIN intake_file f ON f.id = sf.file_id
                WHERE sf.submission_id = ? ORDER BY sf.position
                """, (rs, n) -> {
            UUID batch = rs.getObject("batch_id", UUID.class);
            UUID item = rs.getObject("id", UUID.class);
            return new Original(item, batch, rs.getInt("position"), rs.getString("name"), rs.getInt("size_bytes"),
                    rs.getString("sha256"), originalUrl.apply(batch, item));
        }, submission);
    }

    private static RuntimeException newerReceipt() {
        return ApiErrors.error(409, "이 팀은 다른 접수에서 확정됐습니다. 현재 접수의 원본을 확인해 주세요.");
    }
}
