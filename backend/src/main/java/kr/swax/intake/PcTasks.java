package kr.swax.intake;

import java.util.List;
import java.util.UUID;

import org.springframework.http.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Service
@Transactional
class PcTasks {
    record Task(String kind, UUID id, UUID claimToken, String sha256, String extension) {}
    private final JdbcTemplate db;
    private final ObjectMapper json;
    private final OutputJobs output;
    PcTasks(JdbcTemplate db,ObjectMapper json,OutputJobs output) { this.db=db;this.json=json;this.output=output; }
    private static RuntimeException lost() { return ApiErrors.error(409,"문서 배정이 만료됐습니다. 다시 연결해 주세요."); }

    Task claim(PcDevices.Device device,int slot) {
        if (db.queryForList("SELECT id FROM pc_device WHERE id=? AND NOT revoked AND hancom_ready AND seen_at>clock_timestamp()-interval '45 seconds' FOR UPDATE",
                UUID.class,device.id()).isEmpty()) return null;
        var resume=db.query("""
            SELECT f.id,c.claim_token,encode(sha256(f.original),'hex'),lower(substring(f.name from '\\.[^.]+$'))
            FROM pc_file_conversion c JOIN intake_file f ON f.id=c.file_id JOIN intake_batch b ON b.id=f.batch_id
            JOIN event_staff s ON s.event_id=b.event_id AND s.login=?
            WHERE c.device_id=? AND c.worker_slot=? AND b.uploaded_by=? AND c.state='running' AND c.lease_until>clock_timestamp()
            ORDER BY c.lease_until LIMIT 1
            """,(rs,n)->new Task("file",rs.getObject(1,UUID.class),rs.getObject(2,UUID.class),rs.getString(3),rs.getString(4)),device.login(),device.id(),slot,device.login());
        if (!resume.isEmpty()) return resume.getFirst();
        var report=db.query("""
            SELECT r.id,r.print_token,encode(sha256(r.hwpx),'hex') FROM award_report r
            JOIN event_staff s ON s.event_id=r.event_id AND s.login=?
            WHERE r.created_by=? AND r.printer=? AND r.state='printing' AND r.print_until>clock_timestamp() LIMIT 1
            """,(rs,n)->new Task("report",rs.getObject(1,UUID.class),rs.getObject(2,UUID.class),rs.getString(3),".hwpx"),device.login(),device.login(),printer(device,slot));
        if (!report.isEmpty()) return report.getFirst();
        if(slot==1) {
            var printed=claimReport(device,slot);
            if(printed!=null) return printed;
        }
        var files=db.query("""
            SELECT f.id FROM intake_file f JOIN intake_batch b ON b.id=f.batch_id
            JOIN intake_preparation p ON p.batch_id=b.id
            JOIN event_staff s ON s.event_id=b.event_id AND s.login=?
            LEFT JOIN pc_file_conversion c ON c.file_id=f.id
            WHERE b.uploaded_by=? AND p.state='pending' AND NOT EXISTS(SELECT FROM original_analysis a WHERE a.file_id=f.id)
                AND (c.file_id IS NULL OR c.state='failed' OR (c.state='running' AND c.lease_until<=clock_timestamp()))
            ORDER BY b.created_at,b.id,f.position LIMIT 1 FOR UPDATE OF f SKIP LOCKED
            """,(rs,n)->rs.getObject(1,UUID.class),device.login(),device.login());
        if (!files.isEmpty()) {
            UUID id=files.getFirst();
            db.update("""
                INSERT INTO pc_file_conversion(file_id,device_id,worker_slot,lease_until,state) VALUES(?,?,?,clock_timestamp()+interval '300 seconds','running')
                ON CONFLICT(file_id) DO UPDATE SET device_id=excluded.device_id,claim_token=gen_random_uuid(),
                    worker_slot=excluded.worker_slot,lease_until=excluded.lease_until,state='running',attempts=pc_file_conversion.attempts+1,metadata=NULL
                """,id,device.id(),slot);
            db.update("INSERT INTO file_preparation_log(file_id,stage,display_name) VALUES(?,'담당자 PC에서 PDF 변환 중','접수 원본')",id);
            return db.query("SELECT c.file_id,c.claim_token,encode(sha256(f.original),'hex'),lower(substring(f.name from '\\.[^.]+$')) FROM pc_file_conversion c JOIN intake_file f ON f.id=c.file_id WHERE c.file_id=?",
                (rs,n)->new Task("file",rs.getObject(1,UUID.class),rs.getObject(2,UUID.class),rs.getString(3),rs.getString(4)),id).getFirst();
        }
        return slot==0 ? claimReport(device,slot) : null;
    }

    private Task claimReport(PcDevices.Device device,int slot) {
        var printed=output.claimFor(new OutputJobs.Printer(printer(device,slot)),device.login()).getBody();
        return printed==null ? null : new Task("report",printed.id(),printed.claimToken(),printed.sha256(),".hwpx");
    }

    private static String printer(PcDevices.Device device,int slot) { return "pc:"+device.id()+(slot==0 ? "" : ":1"); }

    private void scope(PcDevices.Device device,String kind,UUID id,UUID token,boolean completed) {
        if (db.queryForList("SELECT id FROM pc_device WHERE id=? AND NOT revoked FOR UPDATE",UUID.class,device.id()).isEmpty())
            throw ApiErrors.error(401,"PC 연결을 다시 등록하세요.");
        boolean allowed;
        if (kind.equals("file")) {
            allowed=!db.queryForList("""
                SELECT c.file_id FROM event_staff s JOIN intake_batch b ON b.event_id=s.event_id
                    JOIN intake_file f ON f.batch_id=b.id JOIN pc_file_conversion c ON c.file_id=f.id
                    JOIN pc_device d ON d.id=c.device_id AND NOT d.revoked
                    WHERE s.login=? AND c.file_id=? AND c.device_id=? AND c.claim_token=? AND b.uploaded_by=?
                    AND ((c.state='running' AND c.lease_until>clock_timestamp()) OR (? AND c.state IN ('done','failed')))
                FOR UPDATE OF c FOR SHARE OF d FOR KEY SHARE OF s,f,b
                """,UUID.class,device.login(),id,device.id(),token,device.login(),completed).isEmpty();
        } else if (kind.equals("report")) {
            allowed=!db.queryForList("""
                SELECT r.id FROM award_report r JOIN event_staff s ON s.event_id=r.event_id AND s.login=?
                    JOIN pc_device d ON d.id=? AND NOT d.revoked
                    WHERE r.id=? AND r.created_by=? AND r.printer IN (?,?) AND r.print_token=?
                FOR UPDATE OF r FOR SHARE OF d FOR KEY SHARE OF s
                """,UUID.class,device.login(),device.id(),id,device.login(),printer(device,0),printer(device,1),token).isEmpty();
        } else throw ApiErrors.error(404,"문서 배정을 찾을 수 없습니다.");
        if (!allowed) throw ApiErrors.error(404,"문서 배정을 찾을 수 없습니다.");
    }

    ResponseEntity<byte[]> input(PcDevices.Device device,String kind,UUID id,UUID token) {
        scope(device,kind,id,token,false);
        if (kind.equals("report")) return output.input(id,token);
        byte[] bytes=db.queryForObject("SELECT original FROM intake_file WHERE id=?",byte[].class,id);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(MediaType.APPLICATION_OCTET_STREAM).body(bytes);
    }

    void renew(PcDevices.Device device,String kind,UUID id,UUID token) {
        scope(device,kind,id,token,false);
        if (kind.equals("report")) output.renew(id,token);
        else if (db.update("UPDATE pc_file_conversion SET lease_until=clock_timestamp()+interval '300 seconds' WHERE file_id=? AND state='running' AND lease_until>clock_timestamp()",id)!=1) throw lost();
    }

    void metadata(PcDevices.Device device,UUID id,UUID token,JsonNode result) {
        scope(device,"file",id,token,false);
        var signals=result.path("signals");
        String kind=result.path("kind").asString("");
        int pages=result.path("pages").asInt(0);
        if (!List.of("00","01","02","03","?").contains(kind) || pages<1 || pages>10000 || !signals.isObject()
                || !signals.path("apps").isArray() || !signals.path("consent").isArray()
                || !signals.path("body").isString() || !signals.path("identity").isString())
            throw ApiErrors.error(422,"원본 판독 결과를 확인하세요.");
        for (var app:signals.path("apps")) {
            if (!app.path("name").isString() || !app.path("rep").isString() || !app.path("roster").isArray())
                throw ApiErrors.error(422,"신청서 판독 결과를 확인하세요.");
            for (var member:app.path("roster")) if (!member.path("name").isString() || !member.path("major").isString())
                throw ApiErrors.error(422,"신청서 인원 정보를 확인하세요.");
        }
        for (var person:signals.path("consent")) if (!person.path("name").isString() || !person.path("major").isString())
            throw ApiErrors.error(422,"동의서 판독 결과를 확인하세요.");
        db.update("UPDATE pc_file_conversion SET metadata=?::jsonb WHERE file_id=?",json.writeValueAsString(result),id);
    }

    void complete(PcDevices.Device device,String kind,UUID id,UUID token,String sha,byte[] pdf) {
        scope(device,kind,id,token,true);
        if (kind.equals("report")) { output.completePdf(id,token,sha,pdf); return; }
        var rows=db.queryForList("SELECT metadata::text,state FROM pc_file_conversion WHERE file_id=? FOR UPDATE",id);
        var row=rows.getFirst();
        boolean matches=db.queryForObject("SELECT encode(sha256(original),'hex')=? FROM intake_file WHERE id=?",Boolean.class,sha,id);
        if (!matches) throw lost();
        if (row.get("state").equals("done")) {
            if (!db.queryForObject("SELECT EXISTS(SELECT FROM original_analysis WHERE file_id=? AND pdf=?)",Boolean.class,id,pdf)) throw lost();
            return;
        }
        if (!row.get("state").equals("running") || row.get("metadata")==null) throw lost();
        JsonNode data=json.readTree((String)row.get("metadata"));
        db.update("INSERT INTO original_analysis(file_id,kind,pages,signals,pdf) VALUES(?,?,?,?::jsonb,?) ON CONFLICT DO NOTHING",
            id,data.path("kind").asString(),data.path("pages").asInt(),json.writeValueAsString(data.path("signals")),pdf);
        db.update("UPDATE pc_file_conversion SET state='done',metadata=NULL WHERE file_id=?",id);
        db.update("INSERT INTO file_preparation_log(file_id,stage,display_name) VALUES(?,'판독 완료','접수 원본')",id);
    }

    void failure(PcDevices.Device device,String kind,UUID id,UUID token) {
        scope(device,kind,id,token,false);
        if (kind.equals("report")) { output.failure(id,token); return; }
        db.update("INSERT INTO original_analysis(file_id,failed,reason) VALUES(?,true,'담당자 PC에서 원본을 열 수 없습니다. 한글 설정·손상·암호를 확인하세요.') ON CONFLICT DO NOTHING",id);
        db.update("UPDATE pc_file_conversion SET state='failed',metadata=NULL WHERE file_id=?",id);
        db.update("INSERT INTO file_preparation_log(file_id,stage,display_name) VALUES(?,'판독 실패','접수 원본')",id);
    }
}
