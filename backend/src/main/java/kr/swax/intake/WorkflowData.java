package kr.swax.intake;

import java.util.List;
import java.util.UUID;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

@Component
class WorkflowData {
    final JdbcTemplate db;
    final ObjectMapper json;
    final AwardCatalog catalog;
    WorkflowData(JdbcTemplate db, ObjectMapper json, AwardCatalog catalog) {
        this.db=db; this.json=json; this.catalog=catalog;
    }
    List<JsonNode> list(String sql, Object... args) {
        return db.query(sql,(rs,n)->json.readTree(rs.getString(1)),args);
    }
    ObjectNode one(String sql, Object... args) {
        return (ObjectNode)list(sql,args).stream().findFirst().orElseThrow(()->ApiErrors.error(404,"기록을 찾을 수 없습니다."));
    }
    enum Resource {
        TEAM("SELECT event_id FROM award_team WHERE id=?"),
        BATCH("SELECT event_id FROM intake_batch WHERE id=?"),
        FILE("SELECT b.event_id FROM intake_file f JOIN intake_batch b ON b.id=f.batch_id WHERE f.id=?"),
        SUBMISSION("SELECT t.event_id FROM team_submission s JOIN award_team t ON t.id=s.team_id WHERE s.id=?"),
        MAIL("SELECT event_id FROM ops_mail WHERE id=?"),
        REPORT("SELECT event_id FROM award_report WHERE id=?");
        final String query;
        Resource(String query) { this.query=query; }
    }
    UUID scope(String login, Resource resource, UUID id) {
        return db.queryForList("SELECT a.event_id FROM event_staff a JOIN ("+resource.query
                +") r ON r.event_id=a.event_id WHERE a.login=? FOR KEY SHARE OF a",UUID.class,id,login)
                .stream().findFirst().orElseThrow(()->ApiErrors.error(404,"기록을 찾을 수 없습니다."));
    }
    void lockTeam(UUID sid) {
        if(db.queryForList("""
                SELECT t.id FROM team_submission s JOIN award_team t ON t.id=s.team_id
                WHERE s.id=? FOR NO KEY UPDATE OF t
                """,UUID.class,sid).isEmpty()) throw ApiErrors.error(404,"팀을 찾을 수 없습니다.");
    }
    void lockCurrent(UUID sid) {
        lockTeam(sid);
        if (!db.queryForObject("""
                SELECT EXISTS(SELECT FROM intake_team_confirmation c WHERE c.submission_id=? AND c.state='confirmed'
                    AND NOT ops_team_held(c.team_id))
                """,Boolean.class,sid)) throw ApiErrors.error(409,"현재 제출본과 미배정 원본을 먼저 확인하세요.");
    }
    void audit(UUID sid,String actor,String action) {
        db.update("INSERT INTO workflow_audit(submission_id,actor,action) VALUES(?,?,?)",sid,actor,action);
    }
}
