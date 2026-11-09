package kr.swax.intake;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

@Service
class IntakeStore {
    record Receipt(UUID batchId, String status, String statusUrl) {}
    record Summary(UUID batchId, UUID eventId, String eventName, UUID targetTeamId, String teamName,
                   String teamRep, OffsetDateTime createdAt, int fileCount, long totalBytes, String status, int revision,
                   UUID currentSubmission) {}
    record Item(UUID itemId, int position, String name, int size, String sha256, UUID team, String state, String reason,
                List<UUID> excluded, List<UUID> candidates) {
        boolean holds(UUID owner) {
            return state.equals("unassigned") && !excluded.contains(owner) && (candidates.isEmpty() || candidates.contains(owner));
        }
    }
    record Details(Summary batch, List<Item> files, int revision, List<TeamSubmissions.Link> teams) {}
    record Original(String name, byte[] bytes) {}
    private record Previous(UUID id, String fingerprint) {}

    private static final String SUMMARY = """
            SELECT b.id, b.event_id, e.name AS event_name, b.target_team_id, t.name AS team_name,
                   t.representative, b.created_at, b.assignment_revision, totals.file_count, totals.total_bytes,
                   CASE WHEN p.state IN ('conflict','conflict_reviewed') THEN p.state ELSE 'received' END AS status,
                   c.submission_id AS current_submission
            FROM intake_batch b JOIN award_event e ON e.id = b.event_id
            JOIN event_staff a ON a.event_id = b.event_id AND a.login = ?
            LEFT JOIN award_team t ON t.id = b.target_team_id
            LEFT JOIN intake_preparation p ON p.batch_id=b.id
            LEFT JOIN intake_team_confirmation c ON p.state='conflict' AND c.team_id=t.id AND c.state='confirmed'
            CROSS JOIN LATERAL (
                SELECT count(*) AS file_count, sum(size_bytes) AS total_bytes FROM intake_file WHERE batch_id = b.id
            ) totals
            """;
    private final JdbcTemplate db;
    private final AwardCatalog catalog;

    IntakeStore(JdbcTemplate db, AwardCatalog catalog) {
        this.db = db;
        this.catalog = catalog;
    }

    @Transactional
    Receipt receive(String login, String key, UUID event, UUID target, IntakeUpload upload, UUID base, List<UUID> replaced) {
        catalog.requireEvent(login, event);
        if (db.queryForObject("SELECT EXISTS(SELECT FROM withdrawn_intake_request WHERE event_id=? AND request_key=?)",
                Boolean.class, event, key)) {
            throw ApiErrors.error(409, "삭제한 자료가 있는 접수 요청입니다. 새로 접수하려면 새 요청 키를 사용하세요.");
        }
        if (target != null) catalog.requireTeam(event, target);
        UUID id = UUID.randomUUID();
        int inserted = db.update("""
                INSERT INTO intake_batch(id, event_id, target_team_id, request_key, fingerprint,uploaded_by)
                VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (request_key) DO NOTHING
                """, id, event, target, key, upload.fingerprint(), login);
        if (inserted == 0) {
            Previous previous = db.queryForObject("SELECT id, fingerprint FROM intake_batch WHERE request_key = ?",
                    (rs, n) -> new Previous(rs.getObject("id", UUID.class), rs.getString("fingerprint")), key);
            if (!previous.fingerprint().equals(upload.fingerprint())) {
                throw ApiErrors.error(409, "같은 요청 키로 다른 접수 내용이 전송되었습니다.");
            }
            boolean done = db.queryForObject("""
                    SELECT EXISTS(SELECT FROM intake_preparation WHERE batch_id=? AND state='prepared')
                       AND EXISTS(SELECT FROM intake_team_confirmation WHERE batch_id=?)
                       AND NOT EXISTS(SELECT FROM intake_team_confirmation c LEFT JOIN ops_submission s ON s.id=c.submission_id
                           WHERE c.batch_id=? AND (c.state<>'confirmed' OR s.state NOT IN ('done','failed')))
                       AND NOT EXISTS(SELECT FROM intake_file_state WHERE batch_id=? AND state='unassigned')
                    """, Boolean.class, previous.id(),previous.id(),previous.id(),previous.id());
            return done ? new Receipt(previous.id(),"done",receipt(previous.id()).statusUrl()) : receipt(previous.id());
        }
        if (base != null) {
            if (target == null || db.queryForList("""
                    SELECT t.id FROM award_team t JOIN intake_team_confirmation c ON c.team_id=t.id
                    WHERE t.event_id=? AND t.id=? AND c.submission_id=? AND c.state='confirmed' FOR NO KEY UPDATE OF t
                    """, UUID.class,event,target,base).isEmpty()) throw ApiErrors.error(409,"같은 대회 팀의 현재 확정본에서 보완 접수하세요.");
            List<UUID> originals=db.queryForList("SELECT file_id FROM team_submission_file WHERE submission_id=?",UUID.class,base);
            if (!originals.containsAll(replaced)) throw ApiErrors.error(422,"교체할 파일이 이전 제출본에 없습니다.");
            db.update("UPDATE intake_batch SET base_submission=?, replaced=?::uuid[] WHERE id=?",base,
                    "{"+String.join(",",replaced.stream().map(UUID::toString).toList())+"}",id);
        }
        int position = 0;
        for (IntakeUpload.Entry file : upload.entries()) {
            final int order = ++position;
            try (InputStream stream = file.part().getInputStream()) {
                db.update("""
                        INSERT INTO intake_file(id, batch_id, position, name, size_bytes, sha256, original)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """, ps -> {
                    ps.setObject(1, UUID.randomUUID());
                    ps.setObject(2, id);
                    ps.setInt(3, order);
                    ps.setString(4, file.name());
                    ps.setInt(5, file.size());
                    ps.setString(6, file.sha256());
                    ps.setBinaryStream(7, stream, file.size());
                });
            } catch (IOException ex) {
                throw new UncheckedIOException(ex);
            }
        }
        db.update("INSERT INTO intake_preparation(batch_id) VALUES (?)",id);
        return receipt(id);
    }

    @Transactional
    List<Summary> history(String login, UUID event) {
        catalog.requireEvent(login, event);
        return db.query(SUMMARY + " WHERE b.event_id = ? ORDER BY b.created_at DESC, b.id", IntakeStore::summary, login, event);
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    Details details(String login, UUID id) {
        Summary batch = db.query(SUMMARY + " WHERE b.id = ?", IntakeStore::summary, login, id).stream().findFirst()
                .orElseThrow(() -> ApiErrors.error(404, "접수번호를 찾을 수 없습니다."));
        return new Details(batch, files(id), batch.revision(), TeamSubmissions.links(db, id));
    }

    List<Item> files(UUID batch) {
        return db.query("""
                SELECT f.id, position, name, size_bytes, sha256, team_id, state, coalesce(f.reason,a.reason) AS reason, excluded,
                       coalesce(a.candidates,'{}'::uuid[]) AS candidates
                FROM intake_file_state f LEFT JOIN original_analysis a ON a.file_id=f.id WHERE batch_id = ? ORDER BY position
                """, (rs, n) -> new Item(rs.getObject("id", UUID.class), rs.getInt("position"), rs.getString("name"),
                rs.getInt("size_bytes"), rs.getString("sha256"), rs.getObject("team_id", UUID.class),
                rs.getString("state"), rs.getString("reason"), FileAssignments.excluded(rs), List.of((UUID[])rs.getArray("candidates").getArray())), batch);
    }

    Original original(String login, UUID batch, UUID file) {
        return db.query("""
                SELECT f.name, f.original FROM intake_file f
                JOIN intake_batch b ON b.id = f.batch_id
                JOIN event_staff a ON a.event_id = b.event_id
                WHERE a.login = ? AND b.id = ? AND f.id = ?
                """, (rs, n) -> new Original(rs.getString("name"), rs.getBytes("original")), login, batch, file)
                .stream().findFirst().orElseThrow(() -> ApiErrors.error(404, "해당 접수의 원본을 찾을 수 없습니다."));
    }

    private static Summary summary(ResultSet rs, int n) throws SQLException {
        return new Summary(rs.getObject("id", UUID.class), rs.getObject("event_id", UUID.class),
                rs.getString("event_name"), rs.getObject("target_team_id", UUID.class), rs.getString("team_name"),
                rs.getString("representative"), rs.getObject("created_at", OffsetDateTime.class),
                rs.getInt("file_count"), rs.getLong("total_bytes"), rs.getString("status"), rs.getInt("assignment_revision"),
                rs.getObject("current_submission",UUID.class));
    }

    private static Receipt receipt(UUID id) {
        return new Receipt(id, "received", "/api/intake-batches/" + id);
    }
}
