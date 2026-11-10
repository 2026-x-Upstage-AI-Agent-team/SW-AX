package kr.swax.intake;

import java.util.List;
import java.util.UUID;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

@Repository
class AwardCatalog {
    record Category(String id, String name, String description, boolean enabled) {}
    record Event(UUID id, String name, String categoryId) {}
    record Team(UUID id, String name, String rep, Integer intakeNumber) {}
    record NameInput(String name, String rep, String categoryId) {}

    private final JdbcTemplate db;

    AwardCatalog(JdbcTemplate db) { this.db = db; }

    List<Category> categories() {
        return db.query("SELECT id, name, description, enabled FROM work_category ORDER BY sort_order, id",
                (rs, n) -> new Category(rs.getString("id"), rs.getString("name"), rs.getString("description"), rs.getBoolean("enabled")));
    }

    List<Event> events(String login, String category) {
        return db.query("""
                SELECT e.id, e.name, e.category_id FROM award_event e JOIN event_staff a ON a.event_id = e.id
                JOIN work_category c ON c.id = e.category_id
                WHERE a.login = ? AND c.enabled AND (CAST(? AS text) IS NULL OR e.category_id = ?)
                ORDER BY e.created_at DESC, e.id
                """, (rs, n) -> new Event(rs.getObject("id", UUID.class), rs.getString("name"), rs.getString("category_id")), login, category, category);
    }

    List<Event> events(String login) { return events(login, null); }

    @Transactional
    Event createEvent(String login, NameInput input) {
        String name = label(input.name(), 160, true);
        String category = input.categoryId() == null ? "awards" : input.categoryId();
        if (db.queryForList("SELECT id FROM work_category WHERE id = ? AND enabled", String.class, category).isEmpty()) {
            throw ApiErrors.error(422, "사용 가능한 업무 카테고리를 선택해 주세요. 준비 중인 업무는 아직 이용할 수 없습니다.");
        }
        UUID id = UUID.randomUUID();
        if (db.update("INSERT INTO award_event(id, name, category_id) VALUES (?, ?, ?) ON CONFLICT (category_id, name) DO NOTHING", id, name, category) == 1) {
            db.update("INSERT INTO event_staff(event_id, login) VALUES (?, ?)", id, login);
            return new Event(id, name, category);
        }
        return db.query("""
                SELECT e.id FROM award_event e JOIN event_staff a ON a.event_id = e.id
                WHERE e.name = ? AND a.login = ? AND e.category_id = ?
                """, (rs, n) -> new Event(rs.getObject("id", UUID.class), name, category), name, login, category).stream().findFirst()
                .orElseThrow(() -> ApiErrors.error(409, "이 이름으로 워크스페이스를 만들 수 없습니다."));
    }

    @Transactional
    List<Team> teams(String login, UUID event) {
        requireEvent(login, event);
        return db.query("SELECT id, name, representative, intake_number FROM award_team WHERE event_id = ? ORDER BY intake_number, name, representative, id",
                (rs, n) -> new Team(rs.getObject("id", UUID.class), rs.getString("name"), rs.getString("representative"),
                        rs.getObject("intake_number",Integer.class)), event);
    }

    @Transactional
    Team createTeam(String login, UUID event, NameInput input) {
        requireEvent(login, event);
        String name = label(input.name(), 160, true);
        String rep = label(input.rep(), 80, false);
        db.update("""
                INSERT INTO award_team(id, event_id, name, representative) VALUES (?, ?, ?, ?)
                ON CONFLICT (event_id, name, representative) WHERE intake_number IS NULL DO NOTHING
                """, UUID.randomUUID(), event, name, rep);
        UUID id = db.queryForObject("SELECT id FROM award_team WHERE event_id = ? AND name = ? AND representative = ? AND intake_number IS NULL",
                UUID.class, event, name, rep);
        return new Team(id, name, rep, null);
    }

    void requireEvent(String login, UUID event) {
        // Keep the grant in place until the caller finishes the event operation.
        if (db.queryForList("SELECT event_id FROM event_staff WHERE event_id = ? AND login = ? FOR KEY SHARE",
                UUID.class, event, login).isEmpty()) {
            throw ApiErrors.error(404, "대회를 찾을 수 없습니다.");
        }
    }

    void requireTeam(UUID event, UUID team) {
        if (db.queryForList("SELECT id FROM award_team WHERE event_id = ? AND id = ? FOR KEY SHARE",
                UUID.class, event, team).isEmpty()) {
            throw ApiErrors.error(422, "선택한 대회에 등록된 팀을 지정해 주세요.");
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
