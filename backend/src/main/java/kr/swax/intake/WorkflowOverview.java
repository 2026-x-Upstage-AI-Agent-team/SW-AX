package kr.swax.intake;

import java.security.Principal;
import java.util.*;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;
import static kr.swax.intake.WorkflowData.Resource.*;

@RestController
@Transactional
class WorkflowOverview {
    private final WorkflowData data;
    private final GmailProfile gmail;
    private final String mailMode,config;
    WorkflowOverview(WorkflowData data,GmailProfile gmail,@Value("${MAIL_MODE:local}") String mailMode,
                     @Value("${UPSTAGE_CONFIG_ID:23}") String config) {
        this.data=data; this.gmail=gmail; this.mailMode=mailMode; this.config=config;
    }
    record EventInfo(String date,String place) {}
    @PutMapping("/api/events/{event}/overview")
    Object overview(Principal staff,@PathVariable UUID event,@RequestBody EventInfo input) {
        data.catalog.requireEvent(staff.getName(),event);
        String date=Objects.toString(input.date(),"").strip(), place=Objects.toString(input.place(),"").strip();
        if (date.length()>120 || place.length()>160) throw ApiErrors.error(422,"행사 일시와 장소의 길이를 확인하세요.");
        data.db.update("UPDATE award_event SET event_date=?,place=? WHERE id=?",date,place,event);
        return Map.of("saved",true);
    }
    @GetMapping("/api/dashboard")
    Object dashboard(Principal staff,@RequestParam UUID event) {
        String login=staff.getName();
        data.catalog.requireEvent(login,event);
        var result=new LinkedHashMap<String,Object>();
        result.put("event",event);
        result.put("overview",data.one("SELECT jsonb_build_object('date',event_date,'place',place) FROM award_event WHERE id=?",event));
        result.put("events",data.catalog.events(login));
        result.put("teams",data.list("""
            SELECT jsonb_build_object('id',t.id,'name',t.name,'rep',t.representative,'email',t.email,
                'current',c.submission_id,'held',ops_team_held(t.id),'submission',s.info)
            FROM award_team t LEFT JOIN intake_team_confirmation c ON c.team_id=t.id AND c.state<>'superseded'
            LEFT JOIN ops_summary s ON s.id=c.submission_id WHERE t.event_id=? ORDER BY t.name,t.representative,t.id
            """,event));
        result.put("batches",data.list("""
            SELECT jsonb_build_object('id',b.id,'created',extract(epoch FROM b.created_at),'count',count(*),
                'pending',count(*) FILTER(WHERE coalesce(p.state,'') NOT IN ('conflict','conflict_reviewed') AND f.info->>'state' IN ('unassigned','error','waiting')),
                'state',CASE WHEN p.state IN ('conflict','conflict_reviewed') THEN p.state WHEN p.state IN ('ready','pending') THEN 'preparing'
                    WHEN bool_or(f.info->>'state' IN ('unassigned','error')) THEN 'review' ELSE 'assigned' END)
            FROM intake_batch b JOIN ops_file f ON f.batch_id=b.id LEFT JOIN intake_preparation p ON p.batch_id=b.id
            WHERE b.event_id=? GROUP BY b.id,p.state ORDER BY b.created_at DESC
            """,event));
        result.put("mail",data.list("SELECT info FROM ops_mail WHERE event_id=? ORDER BY created_at DESC,id",event));
        result.put("reports",data.list("""
            SELECT jsonb_build_object('id',id,'version',version,'state',state,'error',error,'created',extract(epoch FROM created_at))
            FROM award_report WHERE event_id=? AND created_by=? ORDER BY version DESC
            """,event,login));
        var account=gmail.current();
        result.put("gmail_account",account.address());
        result.put("gmail_oauth_connected",!account.oauth().isBlank());
        result.put("smtp","smtp".equalsIgnoreCase(mailMode)||"gmail".equalsIgnoreCase(mailMode));
        result.put("mail_ready",!"gmail".equalsIgnoreCase(mailMode)||!account.oauth().isBlank()||!account.credential().isBlank());
        var health = data.list("SELECT to_jsonb(h) FROM workflow_health h WHERE updated_at>now()-interval '2 minutes'");
        boolean connected=false;
        result.put("config",config);
        for (var row : health) {
            if (row.path("role").asString().equals("studio")) {
                connected=row.path("configured").asBoolean();
                result.put("config",row.path("config").asString());
            } else if (row.path("role").asString().equals("mail")) {
                result.put("smtp",row.path("mail_mode").asString().equals("smtp"));
                result.put("mail_ready",row.path("configured").asBoolean());
            }
        }
        result.put("connected",connected);
        return result;
    }

    @GetMapping("/api/operations/batches/{id}")
    Object batch(Principal staff,@PathVariable UUID id) {
        data.scope(staff.getName(),BATCH,id);
        var node=data.one("""
            SELECT jsonb_build_object('id',b.id,'event',b.event_id,'revision',b.assignment_revision,'created',extract(epoch FROM b.created_at),
                'target',target_team_id,'base',base_submission,'reviewed_by',p.reviewed_by,'reviewed_at',extract(epoch FROM p.reviewed_at),
                'state',CASE WHEN p.state IN ('conflict','conflict_reviewed') THEN p.state WHEN p.state IN ('pending','ready') THEN 'preparing'
                WHEN EXISTS(SELECT FROM intake_file_state WHERE batch_id=b.id AND state='unassigned') THEN 'review' ELSE 'assigned' END)
            FROM intake_batch b LEFT JOIN intake_preparation p ON p.batch_id=b.id WHERE b.id=?
            """,id);
        node.set("files",data.json.valueToTree(data.list("SELECT info FROM ops_file WHERE batch_id=? ORDER BY position",id)));
        node.set("preparation_log",data.json.valueToTree(data.list("""
            SELECT jsonb_build_object('ts',extract(epoch FROM l.at),'stage',l.stage,'item_id',l.file_id,'file',l.display_name)
            FROM file_preparation_log l JOIN intake_file f ON f.id=l.file_id WHERE f.batch_id=? ORDER BY l.id
            """,id)));
        node.set("teams",data.json.valueToTree(TeamSubmissions.links(data.db,id).stream().filter(l->l.submissionId()!=null).toList()));
        return node;
    }
    @PutMapping("/api/intake-batches/{id}/conflict-review")
    Object reviewConflict(Principal staff,@PathVariable UUID id) {
        data.scope(staff.getName(),BATCH,id);
        int saved=data.db.update("""
            UPDATE intake_preparation SET state='conflict_reviewed',reviewed_by=?,reviewed_at=clock_timestamp()
            WHERE batch_id=? AND state='conflict'
            """,staff.getName(),id);
        if (saved==0 && !data.db.queryForObject("SELECT EXISTS(SELECT FROM intake_preparation WHERE batch_id=? AND state='conflict_reviewed')",
                Boolean.class,id)) throw ApiErrors.error(409,"보완본이 충돌한 접수만 확인 처리할 수 있습니다.");
        return Map.of("saved",true);
    }
    @GetMapping("/api/operations/submissions/{id}")
    Object submission(Principal staff,@PathVariable UUID id) {
        data.scope(staff.getName(),SUBMISSION,id);
        var node=data.one("""
            SELECT s.info||jsonb_build_object('team_name',t.name,'rep',t.representative,'email',t.email,'held',ops_team_held(t.id),
                'application_emails',r.emails,'email_needs_confirmation',r.needs_confirmation,
                'last_polled_at',extract(epoch FROM e.last_polled_at),
                'polling_delayed',coalesce(e.phase IN ('polling','paused','access') AND coalesce(e.remote_id,s.studio_job_id) IS NOT NULL
                    AND e.started_at<=now()-interval '15 minutes',false),
                'current',c.submission_id,'note',coalesce(s.note,''),'fields',s.fields,'result',
                CASE WHEN s.result IS NULL THEN NULL ELSE jsonb_build_object('documents','{"01":[],"02":[],"03":[],"?":[]}'::jsonb,
                 'checks','[]'::jsonb,'issues','[]'::jsonb,'members','[]'::jsonb,'recipient','{}'::jsonb,'consent_names','[]'::jsonb,
                 'staff_report','','program','','team_name',t.name,'rep',t.representative)||coalesce(nullif(s.output,'null'),'{}')
                 ||jsonb_build_object('verdict',s.verdict,'reason',s.result->>'reason') END)
            FROM ops_summary s JOIN award_team t ON t.id=s.team_id JOIN ops_leader_recipient r ON r.submission_id=s.id
            LEFT JOIN studio_execution e ON e.job_id=s.review_job_id
            LEFT JOIN intake_team_confirmation c
            ON c.team_id=t.id AND c.state<>'superseded' WHERE s.id=?
            """,id);
        node.set("files",data.json.valueToTree(data.list("""
            SELECT f.info FROM team_submission_file sf JOIN ops_file f ON f.id=sf.file_id WHERE sf.submission_id=? ORDER BY sf.position
            """,id)));
        node.set("history",data.json.valueToTree(data.list("SELECT info FROM ops_summary WHERE team_id=(SELECT team_id FROM team_submission WHERE id=?) ORDER BY version DESC",id)));
        node.set("mail",data.json.valueToTree(data.list("SELECT info FROM ops_mail WHERE submission_id=? ORDER BY created_at DESC",id)));
        node.set("audit",data.json.valueToTree(data.list("""
            SELECT jsonb_build_object('ts',extract(epoch FROM at),'action',action,'actor',actor,'stage',stage,'job',remote_id,
                'attempts',attempts,'due',extract(epoch FROM due),'http_status',http_status,'error_code',error_code)
            FROM workflow_audit WHERE submission_id=? ORDER BY id DESC
            """,id)));
        return node;
    }
    @GetMapping("/api/files/{id}/preview")
    ResponseEntity<byte[]> preview(Principal staff,@PathVariable UUID id) {
        data.scope(staff.getName(),FILE,id);
        byte[] pdf=data.db.queryForList("SELECT pdf FROM original_analysis WHERE file_id=? AND pdf IS NOT NULL",byte[].class,id)
                .stream().findFirst().orElseThrow(()->ApiErrors.error(404,"원본 미리보기를 준비 중입니다."));
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(MediaType.APPLICATION_PDF).body(pdf);
    }
    @PostMapping("/api/intake-batches/{batch}/files/{file}/retry")
    Object retryFile(Principal staff,@PathVariable UUID batch,@PathVariable UUID file) {
        data.scope(staff.getName(),BATCH,batch);
        data.db.queryForObject("SELECT id FROM intake_batch WHERE id=? FOR UPDATE",UUID.class,batch);
        if (data.db.queryForObject("SELECT EXISTS(SELECT FROM intake_preparation WHERE batch_id=? AND state IN ('conflict','conflict_reviewed'))",
                Boolean.class,batch)) throw TeamSubmissions.correctionConflict();
        if (data.db.update("DELETE FROM original_analysis a USING intake_file f WHERE a.file_id=f.id AND f.id=? AND f.batch_id=? AND a.failed",file,batch)==0)
            throw ApiErrors.error(409,"이 접수에서 판독에 실패한 파일만 재시도할 수 있습니다.");
        data.db.update("UPDATE intake_preparation SET state='pending' WHERE batch_id=?",batch);
        return Map.of("saved",true);
    }
}
