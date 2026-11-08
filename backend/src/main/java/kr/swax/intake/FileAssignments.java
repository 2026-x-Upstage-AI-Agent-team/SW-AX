package kr.swax.intake;

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
class FileAssignments {
    record Command(String action, UUID team, String reason, Integer revision) {}
    record Saved(boolean saved, int revision) {}
    record Change(UUID itemId, int revision, UUID beforeTeamId, UUID afterTeamId,
                  String actor, String reason, OffsetDateTime changedAt) {}
    private record Batch(UUID event, int revision) {}

    private static final String CHANGES = """
            SELECT file_id, revision, before_team_id, after_team_id, actor, reason, changed_at
            FROM intake_file_assignment WHERE file_id = ?
            """;
    private final JdbcTemplate db;
    private final AwardCatalog catalog;

    FileAssignments(JdbcTemplate db, AwardCatalog catalog) { this.db = db; this.catalog = catalog; }

    @Transactional
    Saved assign(String login, UUID batch, UUID file, Command command) {
        Batch current = batchForFile(login, batch, file, true);
        if (!"assign".equals(command.action()) || command.team() == null) {
            throw ApiErrors.error(422, "팀 배정과 대상 팀을 지정해 주세요.");
        }
        if (command.revision() == null || command.revision() < 0) {
            throw ApiErrors.error(422, "조회한 접수 목록의 버전을 보내 주세요.");
        }
        String reason = command.reason() == null ? "" : command.reason().strip();
        int length = reason.codePointCount(0, reason.length());
        if (length < 2 || length > 500 || reason.indexOf(0) >= 0) {
            throw ApiErrors.error(422, "배정 사유는 2~500자로 입력해 주세요.");
        }
        catalog.requireTeam(current.event(), command.team());
        Change previous = db.query(CHANGES + " ORDER BY revision DESC LIMIT 1", FileAssignments::change, file)
                .stream().findFirst().orElse(null);
        boolean sameTeam = previous != null && previous.afterTeamId().equals(command.team());
        boolean retry = sameTeam && previous.revision() - 1 == command.revision()
                && previous.actor().equals(login) && previous.reason().equals(reason);
        if (command.revision() != current.revision() && !retry) {
            throw ApiErrors.error(409, "접수 목록이 변경됐습니다. 새로 조회한 뒤 배정해 주세요.");
        }
        if (sameTeam) return new Saved(true, current.revision());

        int next = current.revision() + 1;
        db.update("""
                INSERT INTO intake_file_assignment(file_id, revision, before_team_id, after_team_id, actor, reason)
                VALUES (?, ?, ?, ?, ?, ?)
                """, file, next, previous == null ? null : previous.afterTeamId(), command.team(), login, reason);
        db.update("UPDATE intake_batch SET assignment_revision = ? WHERE id = ?", next, batch);
        return new Saved(true, next);
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    List<Change> history(String login, UUID batch, UUID file) {
        batchForFile(login, batch, file, false);
        return db.query(CHANGES + " ORDER BY revision", FileAssignments::change, file);
    }

    private Batch batchForFile(String login, UUID batch, UUID file, boolean lock) {
        String sql = """
                SELECT b.event_id, b.assignment_revision
                FROM intake_batch b JOIN intake_file f ON f.batch_id = b.id
                JOIN event_staff a ON a.event_id = b.event_id
                WHERE a.login = ? AND b.id = ? AND f.id = ?
                """;
        // The revision covers the whole receipt. Hold the grant and serialize edits before reading the last change.
        if (lock) sql += " FOR UPDATE OF b FOR KEY SHARE OF a";
        return db.query(sql, (rs, row) -> new Batch(rs.getObject("event_id", UUID.class),
                rs.getInt("assignment_revision")), login, batch, file).stream().findFirst()
                .orElseThrow(() -> ApiErrors.error(404, "해당 접수의 원본을 찾을 수 없습니다."));
    }

    private static Change change(ResultSet rs, int row) throws SQLException {
        return new Change(rs.getObject("file_id", UUID.class), rs.getInt("revision"),
                rs.getObject("before_team_id", UUID.class), rs.getObject("after_team_id", UUID.class),
                rs.getString("actor"), rs.getString("reason"), rs.getObject("changed_at", OffsetDateTime.class));
    }
}
