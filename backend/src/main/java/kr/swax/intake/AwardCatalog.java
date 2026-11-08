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

    List<Event> events() {
        return db.query("SELECT id, name FROM award_event ORDER BY created_at DESC, id",
                (rs, n) -> new Event(rs.getObject("id", UUID.class), rs.getString("name")));
    }

    @Transactional
    Event createEvent(NameInput input) {
        String name = label(input.name(), 160, true);
        db.update("INSERT INTO award_event(id, name) VALUES (?, ?) ON CONFLICT (name) DO NOTHING",
                UUID.randomUUID(), name);
        UUID id = db.queryForObject("SELECT id FROM award_event WHERE name = ?", UUID.class, name);
        return new Event(id, name);
    }

    List<Team> teams(UUID event) {
        requireEvent(event);
        return db.query("SELECT id, name, representative FROM award_team WHERE event_id = ? ORDER BY name, representative, id",
                (rs, n) -> new Team(rs.getObject("id", UUID.class), rs.getString("name"), rs.getString("representative")), event);
    }

    @Transactional
    Team createTeam(UUID event, NameInput input) {
        requireEvent(event);
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

    void requireEvent(UUID event) {
        if (!Boolean.TRUE.equals(db.queryForObject("SELECT EXISTS (SELECT 1 FROM award_event WHERE id = ?)", Boolean.class, event))) {
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
