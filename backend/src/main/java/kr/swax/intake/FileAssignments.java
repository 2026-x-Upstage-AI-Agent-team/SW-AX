package kr.swax.intake;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.UUID;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

@Service
class FileAssignments {
    record Command(String action, UUID team, String reason, Integer revision, List<UUID> exclude) {}
    record Saved(boolean saved, int revision) {}
    record Change(UUID itemId, int revision, UUID beforeTeamId, UUID afterTeamId,
                  String actor, String reason, OffsetDateTime changedAt, String state, List<UUID> excluded) {}
    private record Batch(UUID event, int revision) {}

    private static final String CHANGES = """
            SELECT file_id, revision, before_team_id, after_team_id, actor, reason, changed_at, state, excluded
            FROM intake_assignment_decision WHERE file_id = ?
            """;
    private final JdbcTemplate db;
    private final AwardCatalog catalog;
    private final TeamSubmissions submissions;

    FileAssignments(JdbcTemplate db, AwardCatalog catalog, TeamSubmissions submissions) {
        this.db = db;
        this.catalog = catalog;
        this.submissions = submissions;
    }

    @Transactional
    Saved assign(String login, UUID batch, UUID file, Command command) {
        Batch current = batchForFile(login, batch, file, true);
        if (db.queryForObject("SELECT EXISTS(SELECT FROM intake_preparation WHERE batch_id=? AND state IN ('conflict','conflict_reviewed'))",
                Boolean.class,batch)) throw TeamSubmissions.correctionConflict();
        if (command.revision() == null || command.revision() < 0) {
            throw ApiErrors.error(422, "조회한 접수 목록의 버전을 보내 주세요.");
        }
        String reason = command.reason() == null ? "" : command.reason().strip();
        int length = reason.codePointCount(0, reason.length());
        if (length < 2 || length > 500 || reason.indexOf(0) >= 0) {
            throw ApiErrors.error(422, "배정 사유는 2~500자로 입력해 주세요.");
        }
        String state = switch (Objects.toString(command.action(), "")) {
            case "assign" -> "assigned";
            case "hold" -> "unassigned";
            case "outside" -> "outside";
            default -> throw ApiErrors.error(422, "배정, 후보 제외 또는 대상 외 결정을 지정해 주세요.");
        };
        List<UUID> exclude = command.exclude() == null ? List.of() : command.exclude();
        if (state.equals("assigned") != (command.team() != null) || (!state.equals("unassigned") && !exclude.isEmpty())
                || exclude.stream().anyMatch(Objects::isNull)) {
            throw ApiErrors.error(422, "배정에는 대상 팀을, 보류에는 제외할 팀 목록을 지정해 주세요.");
        }
        if (command.team() != null) {
            catalog.requireTeam(current.event(), command.team());
            if (db.queryForObject("SELECT EXISTS(SELECT FROM original_analysis WHERE file_id=? AND (failed OR signals->>'mixed'='true'))",
                    Boolean.class,file)) throw ApiErrors.error(409, "손상 또는 혼합 파일은 원접수와 대조해 분리된 원본으로 교체하세요.");
        }
        List<UUID> excluded = exclude.stream().distinct().sorted(Comparator.comparing(UUID::toString)).toList();
        for (UUID team : excluded) catalog.requireTeam(current.event(), team);
        Change previous = db.query(CHANGES + " ORDER BY revision DESC LIMIT 1", FileAssignments::change, file)
                .stream().findFirst().orElse(null);
        boolean sameDecision = previous != null && previous.state().equals(state)
                && Objects.equals(previous.afterTeamId(), command.team()) && previous.excluded().equals(excluded);
        boolean retry = sameDecision && previous.revision() - 1 == command.revision()
                && previous.actor().equals(login) && previous.reason().equals(reason);
        if (command.revision() != current.revision() && !retry) {
            throw ApiErrors.error(409, "접수 목록이 변경됐습니다. 새로 조회한 뒤 배정해 주세요.");
        }
        if (sameDecision) return new Saved(true, current.revision());

        int next = current.revision() + 1;
        UUID before = previous == null ? null : previous.afterTeamId();
        db.update("""
                INSERT INTO intake_file_assignment(file_id, revision, before_team_id, after_team_id, actor, reason, state, evidence_reviewed)
                VALUES (?, ?, ?, ?, ?, ?, ?, EXISTS(SELECT FROM intake_preparation WHERE batch_id=? AND state IN ('ready','prepared')))
                """, file, next, before, command.team(), login, reason, state,batch);
        db.batchUpdate("INSERT INTO intake_assignment_exclusion(file_id, revision, team_id) VALUES (?, ?, ?)",
                excluded.stream().map(team -> new Object[] {file, next, team}).toList());
        db.update("UPDATE intake_batch SET assignment_revision = ? WHERE id = ?", next, batch);
        submissions.refresh(login, batch, before, command.team());
        submissions.confirmPrepared(batch);
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
                rs.getString("actor"), rs.getString("reason"), rs.getObject("changed_at", OffsetDateTime.class),
                rs.getString("state"), excluded(rs));
    }

    static List<UUID> excluded(ResultSet rs) throws SQLException {
        return List.of((UUID[]) rs.getArray("excluded").getArray());
    }
}
