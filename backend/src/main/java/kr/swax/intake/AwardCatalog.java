package kr.swax.intake;

import java.util.List;
import java.util.UUID;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

@Repository
class AwardCatalog {
    record Event(UUID id, String name) {}
    record Team(UUID id, String name, String rep) {}
    record NameInput(String name, String rep) {}

    private final JdbcTemplate db;

    AwardCatalog(JdbcTemplate db) { this.db = db; }

    List<Event> events(String login) {
        return db.query("""
                SELECT e.id, e.name FROM award_event e JOIN event_staff a ON a.event_id = e.id
                WHERE a.login = ? ORDER BY e.created_at DESC, e.id
                """, (rs, n) -> new Event(rs.getObject("id", UUID.class), rs.getString("name")), login);
    }

    @Transactional
    Event createEvent(String login, NameInput input) {
        String name = label(input.name(), 160, true);
        UUID id = UUID.randomUUID();
        if (db.update("INSERT INTO award_event(id, name) VALUES (?, ?) ON CONFLICT (name) DO NOTHING", id, name) == 1) {
            db.update("INSERT INTO event_staff(event_id, login) VALUES (?, ?)", id, login);
            return new Event(id, name);
        }
        return db.query("""
                SELECT e.id FROM award_event e JOIN event_staff a ON a.event_id = e.id
                WHERE e.name = ? AND a.login = ?
                """, (rs, n) -> new Event(rs.getObject("id", UUID.class), name), name, login).stream().findFirst()
                .orElseThrow(() -> ApiErrors.error(409, "이 이름으로 대회를 등록할 수 없습니다."));
    }

    @Transactional
    List<Team> teams(String login, UUID event) {
        requireEvent(login, event);
        return db.query("SELECT id, name, representative FROM award_team WHERE event_id = ? ORDER BY name, representative, id",
                (rs, n) -> new Team(rs.getObject("id", UUID.class), rs.getString("name"), rs.getString("representative")), event);
    }

    @Transactional
    Team createTeam(String login, UUID event, NameInput input) {
        requireEvent(login, event);
        String name = label(input.name(), 160, true);
        String rep = label(input.rep(), 80, false);
        db.update("""
                INSERT INTO award_team(id, event_id, name, representative) VALUES (?, ?, ?, ?)
                ON CONFLICT (event_id, name, representative) DO NOTHING
                """, UUID.randomUUID(), event, name, rep);
        UUID id = db.queryForObject("SELECT id FROM award_team WHERE event_id = ? AND name = ? AND representative = ?",
                UUID.class, event, name, rep);
        return new Team(id, name, rep);
    }

    void requireEvent(String login, UUID event) {
        // Keep the grant in place until the caller finishes the event operation.
        if (db.queryForList("SELECT event_id FROM event_staff WHERE event_id = ? AND login = ? FOR KEY SHARE",
                UUID.class, event, login).isEmpty()) {
            throw ApiErrors.error(404, "대회를 찾을 수 없습니다.");
        }
    }

    private static String label(String value, int max, boolean required) {
        String text = value == null ? "" : value.strip();
        if ((required && text.isEmpty()) || text.length() > max || text.chars().anyMatch(Character::isISOControl)) {
            throw ApiErrors.error(422, "입력한 이름과 길이를 확인해 주세요.");
        }
        return text;
    }
}
