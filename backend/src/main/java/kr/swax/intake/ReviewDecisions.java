package kr.swax.intake;

import java.security.Principal;
import java.util.*;

import jakarta.mail.internet.AddressException;
import jakarta.mail.internet.InternetAddress;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import tools.jackson.databind.node.ObjectNode;
import static kr.swax.intake.WorkflowData.Resource.*;

@RestController
@Transactional
class ReviewDecisions {
    record Member(String role,String name,String studentId,String major,String school) {}
    record Review(Integer revision,String decision,String note,List<Member> members,Map<String,String> recipient,List<String> issues) {}
    record Address(String email,UUID submission) {}
    record Recovery(String job,Boolean confirmedAbsent) {}
    private final WorkflowData data;
    private static final Set<String> ISSUES=Set.of("application","consent","identity","account","signature","affiliation","duplicate","student_id","representative","other");
    ReviewDecisions(WorkflowData data) {this.data=data;}

    @PutMapping("/api/teams/{id}/email")
    Object email(Principal staff,@PathVariable UUID id,@RequestBody Address input) {
        data.scope(staff.getName(),TEAM,id);
        String address=Objects.toString(input.email(),"").strip();
        if (!address.isEmpty()) {
            try {
                InternetAddress[] parsed=InternetAddress.parse(address,true);
                if(address.length()>254 || parsed.length!=1 || !address.equals(parsed[0].getAddress()) || !address.contains("@")
                        || address.chars().anyMatch(Character::isISOControl)) throw new AddressException();
                parsed[0].validate();
            } catch(AddressException ex) {throw ApiErrors.error(422,"확인한 팀장 이메일 주소 한 개를 입력하세요.");}
        }
        String previous=data.db.queryForObject("SELECT email FROM award_team WHERE id=? FOR NO KEY UPDATE",String.class,id);
        if (input.submission()==null) {
            data.db.update("UPDATE award_team SET email=?,email_confirmed_submission=NULL WHERE id=? AND email<>?",address,id,address);
        } else {
            if (address.isEmpty()) throw ApiErrors.error(422,"원접수에서 확인한 수신 주소를 입력하세요.");
            if (!data.db.queryForObject("""
                    SELECT EXISTS(SELECT FROM intake_team_confirmation c JOIN ops_submission s ON s.id=c.submission_id
                        WHERE c.team_id=? AND c.submission_id=? AND c.state='confirmed' AND s.state='done' AND NOT ops_team_held(c.team_id))
                    """,Boolean.class,id,input.submission())) throw ApiErrors.error(409,"현재 팀의 판정이 끝난 제출본에서 주소를 확인하세요.");
            if (data.db.update("""
                    UPDATE award_team SET email=?,email_confirmed_submission=?
                    WHERE id=? AND (email<>? OR email_confirmed_submission IS DISTINCT FROM ?)
                    """,address,input.submission(),id,address,input.submission())>0)
                data.audit(input.submission(),staff.getName(),"원접수 대조 후 팀장 수신 주소 확인");
        }
        if (!address.equals(previous)) data.db.update("""
            UPDATE review_mail m SET state='draft',sent_to=NULL,approved_by=NULL,approved_at=NULL,revision=m.revision+1
            FROM team_submission s WHERE s.id=m.submission_id AND s.team_id=? AND m.kind IN ('보완 요청','검토 완료') AND m.state='approved'
            """,id);
        return Map.of("saved",true);
    }

    @PutMapping("/api/submissions/{id}/review")
    Object review(Principal staff,@PathVariable UUID id,@RequestBody Review form) {
        UUID event=data.scope(staff.getName(),SUBMISSION,id);
        data.lockCurrent(id);
        var sub=data.one("SELECT to_jsonb(s) FROM ops_submission s WHERE id=?",id);
        if(form.revision()==null||form.revision()!=sub.path("revision").asInt()||!sub.path("state").asString("").equals("done"))
            throw ApiErrors.error(409,"현재 검토 완료된 제출본을 다시 열어 주세요.");
        String choice=Objects.toString(form.decision(),"");
        String note=Objects.toString(form.note(),"").strip();
        List<String> issues=form.issues()==null?List.of():form.issues();
        if (!Set.of("승인","보완 필요","작성 중").contains(choice) || note.length()>1000
                || issues.stream().anyMatch(k->k==null||!ISSUES.contains(k)) || (choice.equals("보완 필요")&&issues.isEmpty()))
            throw ApiErrors.error(422,"검토 결론·근거와 보완 항목을 확인하세요.");
        if (!sub.path("decision").isNull() && !choice.equals(sub.path("decision").asString("")))
            throw ApiErrors.error(409,"이미 저장한 결론을 바꾸려면 보완본을 접수하세요.");
        List<Member> members=form.members();
        if(members==null||members.size()>150||members.stream().anyMatch(m->m==null || m.name()==null
                || m.name().length()>80 || !("대표".equals(m.role())||"팀원".equals(m.role()))
                || Objects.toString(m.studentId(),"").length()>60||Objects.toString(m.major(),"").length()>150||Objects.toString(m.school(),"").length()>100))
            throw ApiErrors.error(422,"확정할 팀원 명단을 확인하세요.");
        String verdict=sub.path("verdict").asString("");
        if(choice.equals("승인") && (verdict.equals("재제출요청") || members.stream().anyMatch(m->m.name().isBlank())
                || members.stream().filter(m->m.role().equals("대표")).count()!=1))
            throw ApiErrors.error(409,"보완된 원본과 대표 한 명을 포함한 명단을 확인하세요.");
        if (!choice.equals("작성 중") && note.isEmpty() && (verdict.equals("담당자확인") || (choice.equals("승인") &&
             !sub.path("output").path("program").asString("").equals(data.db.queryForObject("SELECT name FROM award_event WHERE id=?",String.class,event)))))
            throw ApiErrors.error(422,"원본과 대조한 근거를 기록하세요.");
        var recipient=new HashMap<String,String>();
        for(String key:List.of("bank_name","account_number","account_holder","rrn_display"))
            recipient.put(key,form.recipient()==null?"":Objects.toString(form.recipient().get(key),"").strip());
        if (!recipient.get("rrn_display").isEmpty()&&!maskedRrn(recipient.get("rrn_display")))
            throw ApiErrors.error(422,"원본에 표시된 마스킹 주민번호를 입력하세요.");
        var saved=form.revision()>0 ? sub.path("fields") : data.json.createObjectNode();
        for(String key:List.of("gross_amount","tax_amount","net_amount"))
            recipient.put(key,saved.path("recipient").path(key).asString(""));
        String fields=data.json.writeValueAsString(Map.of("members",members,"recipient",recipient,
                "award_type",saved.path("award_type").asString(""),"support_amount",saved.path("support_amount").asString("")));
        data.db.update("""
            INSERT INTO review_resolution(submission_id,revision,decision,note,fields,issues) VALUES(?,1,?,?,?::jsonb,?::jsonb)
            ON CONFLICT(submission_id) DO UPDATE SET revision=review_resolution.revision+1,decision=excluded.decision,
                note=excluded.note,fields=excluded.fields,issues=excluded.issues,updated_at=clock_timestamp()
            """,id,choice.equals("작성 중")?null:choice,note,fields,data.json.writeValueAsString(issues));
        data.audit(id,staff.getName(),"검토 저장 · "+choice);
        if(choice.equals("보완 필요")||(choice.equals("승인")&&verdict.equals("담당자확인")))
            data.db.update("INSERT INTO review_mail(submission_id,kind) VALUES(?,?) ON CONFLICT DO NOTHING",id,choice.equals("승인")?"검토 완료":"보완 요청");
        return Map.of("saved",true);
    }

    static boolean maskedRrn(String value) {
        return value.matches("\\s*\\d{6}\\s*[-‐‑–—]\\s*\\d?[\\s*＊xX●•#■_]+")
                && value.matches("(?s).*[*＊xX●•#■_].*");
    }

    @PostMapping("/api/submissions/{id}/retry")
    Object retry(Principal staff,@PathVariable UUID id,@RequestBody Recovery input) {
        data.scope(staff.getName(),SUBMISSION,id);
        data.lockTeam(id);
        var job=data.one("""
            SELECT jsonb_build_object('id',j.id,'state',j.work_state,'phase',e.phase,'job',coalesce(e.remote_id,j.studio_job_id),'slot',e.occupies_slot)
            FROM review_job j LEFT JOIN studio_execution e ON e.job_id=j.id WHERE j.submission_id=? FOR UPDATE OF j
            """,id);
        String phase=job.path("phase").asString(""), state=job.path("state").asString("");
        if (phase.equals("access")) {
            // Recheck the organisation credentials even when this submission was superseded.
            if (data.db.update("""
                    UPDATE studio_execution SET due=now(),rejected_create_key_hash=NULL
                    WHERE job_id=? AND phase='access' AND (due>now() OR rejected_create_key_hash IS NOT NULL)
                    """,
                    UUID.fromString(job.path("id").asString()))>0)
                data.audit(id,staff.getName(),"Studio 인증 재확인 요청");
            return Map.of("saved",true);
        }
        if(!state.equals("failed")&&!Set.of("uncertain","paused","invalid","failed").contains(phase))
            return Map.of("saved",true);
        // A lost creation response must be resolvable even if a correction superseded its version.
        if (!job.path("slot").asBoolean(false)) data.lockCurrent(id);
        String existing=job.path("job").asString(null), remote=existing;
        if(input.job()!=null&&!input.job().isBlank()){
            if(!input.job().matches("job_[A-Za-z0-9_-]{1,140}") || (existing!=null&&!existing.equals(input.job())))
                throw ApiErrors.error(422,"기존 제출본의 Studio 실행 번호를 확인하세요.");
            remote=input.job();
        } else if(phase.equals("uncertain") && !Boolean.TRUE.equals(input.confirmedAbsent())) throw ApiErrors.error(409,"기존 실행 번호 또는 미접수 확인이 필요합니다.");
        else if(phase.equals("failed")) remote=null;
        UUID jid=UUID.fromString(job.path("id").asString());
        data.db.update("""
            INSERT INTO workflow_audit(submission_id,actor,action,remote_id,stage) VALUES(?,?,'작업 재개',?,?)
            """,id,staff.getName(),existing,phase);
        data.db.update("""
            UPDATE review_job SET work_state='queued',result=NULL,finished_at=NULL,lease_until=NULL,claim_token=NULL,worker_id=NULL,studio_job_id=? WHERE id=?
            """,remote,jid);
        data.db.update("""
            INSERT INTO studio_execution(job_id,remote_id,phase) VALUES(?,?,?)
            ON CONFLICT(job_id) DO UPDATE SET phase=excluded.phase,remote_id=excluded.remote_id,failures=0,error='',
                last_polled_at=CASE WHEN studio_execution.remote_id=excluded.remote_id THEN studio_execution.last_polled_at END,
                updated_at=now(),due=now(),occupies_slot=(studio_execution.occupies_slot AND excluded.remote_id IS NOT NULL)
            """,jid,remote,remote==null?"queued":"polling");
        return Map.of("saved",true);
    }

    @ExceptionHandler(org.springframework.dao.DuplicateKeyException.class)
    org.springframework.http.ResponseEntity<?> duplicateRemote() {
        return org.springframework.http.ResponseEntity.status(409).body(Map.of("detail","다른 제출본에 연결된 Studio 실행입니다."));
    }

}
