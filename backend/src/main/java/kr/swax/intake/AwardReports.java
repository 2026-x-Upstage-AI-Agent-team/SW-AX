package kr.swax.intake;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.Principal;
import java.util.*;
import java.util.zip.ZipInputStream;

import org.springframework.http.*;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

@RestController
@Transactional
class AwardReports {
    record Order(UUID event,List<UUID> submissions) {}
    record Payment(Integer revision,String awardType,String supportAmount,String grossAmount,String taxAmount,String netAmount) {}
    private final WorkflowData data;
    AwardReports(WorkflowData data) {this.data=data;}

    private static boolean missing(JsonNode field) {
        String value=field.asString("").strip();
        return value.isEmpty() || value.equals("미확인");
    }
    private static List<String> missingPayouts(JsonNode fields) {
        var recipient=fields.path("recipient");
        var missing=new ArrayList<String>();
        if(missing(fields.path("award_type"))) missing.add("시상구분");
        if(missing(fields.path("support_amount"))) missing.add("지원액");
        if(missing(recipient.path("gross_amount"))) missing.add("지급총액");
        if(missing(recipient.path("tax_amount"))) missing.add("세액");
        if(missing(recipient.path("net_amount"))) missing.add("차인지급액");
        return missing;
    }
    private static List<String> pendingPayouts(JsonNode snapshot) {
        var pending=new ArrayList<String>();
        for(var team:snapshot.path("teams")){
            var missing=missingPayouts(team);
            if(!missing.isEmpty()) pending.add(team.path("team_name").asString()+" · "+String.join(", ",missing));
        }
        return pending;
    }
    private static void requirePayouts(JsonNode snapshot) {
        var pending=pendingPayouts(snapshot);
        if(!pending.isEmpty()) throw ApiErrors.error(409,"지급 정보 미입력 ("+String.join(" / ",pending)+").");
    }

    @GetMapping("/api/events/{event}/draft")
    Object draft(Principal staff,@PathVariable UUID event) {
        data.catalog.requireEvent(staff.getName(),event);
        var teams=data.list("""
            SELECT coalesce(s.fields,'{"members":[],"recipient":{},"award_type":"","support_amount":""}') ||
                jsonb_build_object('team',t.name,'rep',t.representative,'submission',s.id,'version',s.version,'revision',s.revision,'pending',
                array_remove(ARRAY[CASE WHEN s.id IS NULL OR ops_team_held(t.id) THEN '팀 배정 확인' END,
                  CASE WHEN s.decision IS DISTINCT FROM '승인' OR s.state<>'done' THEN '현재 제출본 승인' END],NULL))
            FROM award_team t LEFT JOIN intake_team_confirmation c ON c.team_id=t.id AND c.state<>'superseded'
            LEFT JOIN ops_submission s ON s.id=c.submission_id WHERE t.event_id=? ORDER BY t.name,t.id
            """,event);
        for(var team:teams) ((ObjectNode)team).set("missing_payouts",data.json.valueToTree(missingPayouts(team)));
        return Map.of("teams",teams);
    }
    @PutMapping("/api/submissions/{id}/payment")
    Object savePayment(Principal staff,@PathVariable UUID id,@RequestBody Payment form) {
        data.scope(staff.getName(),WorkflowData.Resource.SUBMISSION,id);
        data.lockCurrent(id);
        var sub=data.one("SELECT jsonb_build_object('revision',revision,'decision',decision,'state',state,'fields',fields) FROM ops_submission WHERE id=?",id);
        if(!"승인".equals(sub.path("decision").asString("")) || !"done".equals(sub.path("state").asString("")))
            throw ApiErrors.error(409,"현재 제출본의 서류를 먼저 승인하세요.");
        if(form.revision()==null || form.revision()!=sub.path("revision").asInt())
            throw ApiErrors.error(409,"지급 정보가 변경됐습니다. 보고서 화면을 새로 열어 확인하세요.");
        String award=Objects.toString(form.awardType(),"").strip();
        if(award.length()>60) throw ApiErrors.error(422,"시상구분은 60자 이내로 입력하세요.");
        var fields=(ObjectNode)sub.path("fields");
        fields.put("award_type",award).put("support_amount",amount(form.supportAmount()));
        fields.withObjectProperty("recipient").put("gross_amount",amount(form.grossAmount()))
                .put("tax_amount",amount(form.taxAmount())).put("net_amount",amount(form.netAmount()));
        data.db.update("UPDATE review_resolution SET fields=?::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE submission_id=?",fields.toString(),id);
        data.audit(id,staff.getName(),"지급 정보 저장");
        return Map.of("saved",true);
    }
    private static String amount(String input) {
        String value=Objects.toString(input,"").strip();
        if(!value.isEmpty()&&!value.matches("(?:[0-9]{1,13}|[0-9]{1,3}(?:,[0-9]{3}){1,4})"))
            throw ApiErrors.error(422,"금액은 0 이상의 원 단위 정수로 입력하세요.");
        return value;
    }
    private ObjectNode snapshot(UUID event,List<UUID> selection) {
        if(selection==null||selection.isEmpty()||selection.contains(null)||new HashSet<>(selection).size()!=selection.size())
            throw ApiErrors.error(422,"보고서에 포함할 제출본을 순서대로 한 번씩 지정하세요.");
        String items="{"+String.join(",",selection.stream().map(UUID::toString).toList())+"}";
        data.db.queryForList("""
            SELECT t.id FROM award_team t JOIN team_submission s ON s.team_id=t.id
            WHERE s.id=ANY(?::uuid[]) AND t.event_id=? ORDER BY t.id FOR NO KEY UPDATE OF t
            """,UUID.class,items,event);
        var report=data.json.createObjectNode();
        report.set("event",data.one("SELECT jsonb_build_object('name',name,'date',event_date,'place',place) FROM award_event WHERE id=?",event));
        var teams=report.putArray("teams");
        for(UUID sid:selection){
            var s=data.one("""
                SELECT jsonb_build_object('name',t.name,'fields',s.fields,'revision',s.revision,'documents',s.output->'documents')
                FROM ops_submission s JOIN award_team t ON t.id=s.team_id JOIN intake_team_confirmation c ON c.submission_id=s.id
                WHERE s.id=? AND t.event_id=? AND c.state='confirmed' AND s.state='done' AND s.decision='승인' AND NOT ops_team_held(t.id)
                """,sid,event);
            ObjectNode fields=(ObjectNode)s.path("fields").deepCopy();
            fields.put("team_name",s.path("name").asString()).put("submission",sid.toString()).put("revision",s.path("revision").asInt());
            var docs=s.path("documents");
            var ids=new ArrayList<UUID>();
            if(docs.path("?").size()>0) throw ApiErrors.error(409,"분류되지 않은 증빙을 확인하세요.");
            for(String kind:List.of("01","02","03")){
                if(docs.path(kind).size()!=1) throw ApiErrors.error(409,"팀별 01·02·03 원본을 한 부씩 확정하세요.");
                try {ids.add(UUID.fromString(docs.path(kind).get(0).path("id").asString("")));}
                catch(IllegalArgumentException ex) {throw ApiErrors.error(409,"원본 연결을 확인하세요.");}
            }
            List<UUID> actual=data.db.queryForList("SELECT file_id FROM team_submission_file WHERE submission_id=?",UUID.class,sid);
            if(actual.size()!=3 || !new HashSet<>(ids).equals(new HashSet<>(actual))) throw ApiErrors.error(409,"판정의 증빙 목록과 확정 원본이 다릅니다.");
            fields.set("file_ids",data.json.valueToTree(ids)); teams.add(fields);
        }
        return report;
    }
    @PostMapping("/api/reports")
    @ResponseStatus(HttpStatus.ACCEPTED)
    Object create(Principal staff,@RequestBody Order order) {
        data.catalog.requireEvent(staff.getName(),order.event());
        lockEvent(order.event());
        var snap=snapshot(order.event(),order.submissions());
        requirePayouts(snap);
        var existing=data.list("""
            SELECT jsonb_build_object('id',id,'version',version,'status_url','/api/reports/'||id) FROM award_report
            WHERE event_id=? AND created_by=? AND parent IS NULL AND state<>'failed' AND snapshot=?::jsonb ORDER BY version DESC LIMIT 1
            """,order.event(),staff.getName(),snap.toString());
        return existing.isEmpty()?insert(staff.getName(),order.event(),order.submissions(),snap,null,null):existing.getFirst();
    }
    private void lockEvent(UUID event) {data.db.queryForObject("SELECT id FROM award_event WHERE id=? FOR NO KEY UPDATE",UUID.class,event);}
    private ObjectNode insert(String login,UUID event,List<UUID> s,JsonNode snap,UUID parent,byte[] edited) {
        return data.one("""
            INSERT INTO award_report(event_id,version,created_by,selection,snapshot,parent,hwpx,state)
            VALUES(?,(SELECT greatest(e.deleted_report_version,(SELECT max(version) FROM award_report WHERE event_id=e.id))+1
                      FROM award_event e WHERE e.id=?),?,?::uuid[],?::jsonb,?,?,?)
            RETURNING jsonb_build_object('id',id,'version',version,'status_url','/api/reports/'||id)
            """,event,event,login,"{"+String.join(",",s.stream().map(UUID::toString).toList())+"}",snap.toString(),parent,edited,edited==null?"queued":"printing");
    }
    private ObjectNode report(String login,UUID id) {
        data.scope(login,WorkflowData.Resource.REPORT,id);
        return data.one("""
            SELECT jsonb_build_object('id',id,'event',event_id,'version',version,'state',state,'created',extract(epoch FROM created_at),
                'error',error,'parent',parent,'selection',selection,'snapshot',snapshot,
                'can_retry_print',state='failed' AND hwpx IS NOT NULL AND pdf IS NULL AND print_token IS NOT NULL)
            FROM award_report WHERE id=? AND created_by=?
            """,id,login);
    }
    private List<UUID> ids(JsonNode report) {return report.path("selection").valueStream().map(v->UUID.fromString(v.asString())).toList();}
    private boolean current(ObjectNode r) {
        UUID event=UUID.fromString(r.path("event").asString());
        data.db.queryForObject("SELECT id FROM award_event WHERE id=? FOR SHARE",UUID.class,event);
        try {return snapshot(event,ids(r)).equals(r.path("snapshot"));}
        catch(org.springframework.web.server.ResponseStatusException ex) {
            if(ex.getStatusCode().value()==404||ex.getStatusCode().value()==409) return false;
            throw ex;
        }
    }
    @GetMapping("/api/reports/{id}")
    Object view(Principal staff,@PathVariable UUID id) {
        var r=report(staff.getName(),id);
        r.put("stale",!current(r));
        r.set("missing_payouts",data.json.valueToTree(pendingPayouts(r.path("snapshot"))));
        r.set("teams",data.json.valueToTree(r.path("snapshot").path("teams").valueStream().map(t->t.path("team_name").asString()).toList()));
        r.remove(List.of("snapshot","selection")); return r;
    }
    @PostMapping("/api/reports/{id}/confirm")
    Object confirm(Principal staff,@PathVariable UUID id) {
        var r=report(staff.getName(),id);
        requirePayouts(r.path("snapshot"));
        if(!current(r) || data.db.update("UPDATE award_report SET state='confirmed' WHERE id=? AND state IN ('preview','confirmed')",id)!=1)
            throw ApiErrors.error(409,"최신 보고서 미리보기를 확인한 뒤 확정하세요.");
        return Map.of("saved",true);
    }
    @PostMapping("/api/reports/{id}/retry-print")
    @ResponseStatus(HttpStatus.ACCEPTED)
    Object retryPrint(Principal staff,@PathVariable UUID id) {
        var r=report(staff.getName(),id);
        requirePayouts(r.path("snapshot"));
        if (!current(r)) throw ApiErrors.error(409,"지급 정보나 증빙이 변경됐습니다. 새 보고서를 생성하세요.");
        int retried=data.db.update("""
            UPDATE award_report SET state='printing',error='',printer=NULL,print_token=NULL,print_until=NULL
            WHERE id=? AND state='failed' AND hwpx IS NOT NULL AND pdf IS NULL AND print_token IS NOT NULL
            """,id);
        if (retried==0 && !data.db.queryForObject("""
            SELECT EXISTS(SELECT FROM award_report WHERE id=? AND state IN ('printing','verifying','preview','confirmed'))
            """,Boolean.class,id)) throw ApiErrors.error(409,"한글 PC에서 출력에 실패한 보고서만 다시 출력할 수 있습니다.");
        return Map.of("id",id,"version",r.path("version").asInt());
    }
    @PostMapping("/api/reports/{id}/edited")
    @ResponseStatus(HttpStatus.ACCEPTED)
    Object edited(Principal staff,@PathVariable UUID id,@RequestParam MultipartFile file) throws IOException {
        var r=report(staff.getName(),id);
        requirePayouts(r.path("snapshot"));
        UUID event=UUID.fromString(r.path("event").asString()); lockEvent(event);
        if(!Set.of("preview","confirmed").contains(r.path("state").asString())||!current(r)) throw ApiErrors.error(409,"현재 출력된 보고서에서 편집본을 접수하세요.");
        if(file.isEmpty()||file.getSize()>40L*1024*1024) throw ApiErrors.error(413,"편집 HWPX는 40 MiB까지 접수합니다.");
        byte[] bytes=file.getBytes();
        if(!validHwpx(bytes)) throw ApiErrors.error(415,"열 수 있는 HWPX 편집본을 선택하세요.");
        return insert(staff.getName(),event,ids(r),r.path("snapshot"),id,bytes);
    }
    static boolean validHwpx(byte[] bytes) {
        var required=new HashSet<>(Set.of("mimetype","Contents/header.xml","Contents/content.hpf","Contents/section0.xml"));
        try(var zip=new ZipInputStream(new ByteArrayInputStream(bytes))){
            var buffer=new byte[8192]; long total=0; int count=0;
            for(var e=zip.getNextEntry();e!=null;e=zip.getNextEntry()){
                if(++count>10000||e.getName().contains("..")||e.getName().startsWith("/")) return false;
                if(e.getName().equals("mimetype") && !new String(zip.readNBytes(64),StandardCharsets.US_ASCII).equals("application/hwp+zip")) return false;
                for(int n;(n=zip.read(buffer))!=-1;){total+=n;if(total>384L*1024*1024) return false;}
                required.remove(e.getName());
            }
        } catch(IOException|IllegalArgumentException ex){return false;}
        return required.isEmpty();
    }
    @GetMapping("/api/reports/{id}/{kind:preview|hwpx|pdf}")
    ResponseEntity<byte[]> download(Principal staff,@PathVariable UUID id,@PathVariable String kind) {
        var r=report(staff.getName(),id);
        boolean preview=kind.equals("preview");
        if(!preview) requirePayouts(r.path("snapshot"));
        if(!current(r)||!(r.path("state").asString().equals("confirmed")||(preview&&r.path("state").asString().equals("preview"))))
            throw ApiErrors.error(409,"현재 보고서의 출력과 확정 상태를 확인하세요.");
        boolean hwpx=kind.equals("hwpx");
        byte[] bytes=data.db.queryForObject("SELECT "+(hwpx?"hwpx":"pdf")+" FROM award_report WHERE id=?",byte[].class,id);
        var disposition=(preview?ContentDisposition.inline():ContentDisposition.attachment()).filename("시상금_지급내역서_v"+
                r.path("version").asInt()+(hwpx?".hwpx":".pdf"),StandardCharsets.UTF_8).build();
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).header(HttpHeaders.CONTENT_DISPOSITION,disposition.toString())
                .contentType(hwpx?MediaType.APPLICATION_OCTET_STREAM:MediaType.APPLICATION_PDF).body(bytes);
    }
}
