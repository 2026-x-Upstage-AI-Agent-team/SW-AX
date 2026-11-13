package kr.swax.intake;

import java.security.Principal;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import tools.jackson.databind.node.ObjectNode;
import static kr.swax.intake.WorkflowData.Resource.MAIL;

@RestController
@Transactional
@RequestMapping("/api/mail/{id}")
class MailDrafts {
    record Edit(Integer revision, String subject, String body, String recipient, String senderAddress) {}
    private final WorkflowData data;
    private final GmailProfile gmail;
    private final boolean personalGmail;
    MailDrafts(WorkflowData data, GmailProfile gmail, @Value("${MAIL_MODE:local}") String mailMode) {
        this.data=data; this.gmail=gmail; this.personalGmail="gmail".equalsIgnoreCase(mailMode);
    }

    @GetMapping
    Object view(Principal staff, @PathVariable UUID id) {
        data.scope(staff.getName(),MAIL,id);
        return detail(staff.getName(),id);
    }

    private ObjectNode detail(String login, UUID id) {
        var row = data.one("""
            SELECT jsonb_build_object('info',o.info||jsonb_build_object('subject',m.subject,'body',m.body,'revision',m.revision,
                    'approved_by',m.approved_by,'approved_at',extract(epoch FROM m.approved_at),'sender_address',m.sender_address),
                'source',jsonb_build_object('name',coalesce(s.output->>'team_name',''),'kind',m.kind,'version',s.version,'verdict',s.verdict,
                    'decision',s.decision,'issues',s.issues,'output',s.output,
                    'files',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'name',f.name) ORDER BY sf.position),'[]')
                        FROM team_submission_file sf JOIN intake_file f ON f.id=sf.file_id WHERE sf.submission_id=s.id)),
                'recipient',t.email,
                'eligible',s.state='done' AND NOT ops_team_held(t.id) AND EXISTS(SELECT FROM intake_team_confirmation c
                    WHERE c.submission_id=s.id AND c.state='confirmed') AND NOT r.needs_confirmation AND
                    ((m.kind='보완 요청' AND (s.verdict IN ('재제출요청','보완필요') OR s.decision='보완 필요')) OR
                     (m.kind='검토 완료' AND (s.decision='승인' OR s.verdict='성공'))))
            FROM review_mail m JOIN ops_mail o ON o.id=m.id JOIN ops_submission s ON s.id=m.submission_id
            JOIN award_team t ON t.id=s.team_id JOIN ops_leader_recipient r ON r.submission_id=s.id WHERE m.id=?
            """,id);
        var info=(ObjectNode)row.path("info");
        boolean draft=Set.of("draft","recipient_check").contains(info.path("state").asString());
        String recipient=info.path("sent_to").asString("");
        if (draft) {
            if (info.path("body").isNull() || info.path("subject").isNull()) {
                var template=MailTemplate.from(row.path("source"));
                if (info.path("subject").isNull()) info.put("subject",template.subject());
                if (info.path("body").isNull()) info.put("body",template.body());
            }
            recipient=row.path("recipient").asString("");
        }
        info.put("recipient",recipient);
        boolean ready=true;
        if (personalGmail && draft) {
            var sender=gmail.current(login);
            info.put("sender_address",sender.address());
            ready=sender.ready();
        }
        info.put("can_approve",draft && ready && !recipient.isBlank() && row.path("eligible").asBoolean(false));
        return info;
    }

    private UUID lock(Principal staff, UUID id) {
        data.scope(staff.getName(),MAIL,id);
        UUID sid=data.db.queryForObject("SELECT submission_id FROM review_mail WHERE id=?",UUID.class,id);
        data.lockCurrent(sid);
        data.db.queryForObject("SELECT id FROM review_mail WHERE id=? FOR UPDATE",UUID.class,id);
        return sid;
    }

    @PutMapping("/draft")
    Object save(Principal staff, @PathVariable UUID id, @RequestBody Edit edit) {
        return edit(staff,id,edit,false);
    }
    @PostMapping("/approve")
    Object approve(Principal staff, @PathVariable UUID id, @RequestBody Edit edit) {
        return edit(staff,id,edit,true);
    }
    private Object edit(Principal staff, UUID id, Edit form, boolean approve) {
        UUID sid=lock(staff,id);
        var mail=detail(staff.getName(),id);
        if (!Set.of("draft","recipient_check").contains(mail.path("state").asString()) || form.revision()==null
                || form.revision()!=mail.path("revision").asInt()) throw ApiErrors.error(409,"초안이 변경되었습니다. 다시 열어 확인하세요.");
        String subject=Objects.toString(form.subject(),"");
        String body=Objects.toString(form.body(),"").replace("\r\n","\n");
        if (subject.isBlank() || subject.length()>255 || subject.chars().anyMatch(Character::isISOControl)
                || body.isBlank() || body.length()>50000 || body.indexOf('\0')>=0)
            throw ApiErrors.error(422,"한 줄 제목과 본문을 입력하세요. 제목은 255자, 본문은 50,000자까지 입력할 수 있습니다.");
        if (approve) {
            String sender=null;
            if (personalGmail) {
                var accounts=data.db.query("SELECT address FROM staff_gmail WHERE login=? AND (credential<>'' OR oauth<>'') FOR SHARE",
                        (rs,row) -> rs.getString(1),staff.getName());
                if (accounts.isEmpty()) throw ApiErrors.error(409,"먼저 내 Gmail 계정을 연결한 뒤 발송을 승인하세요.");
                sender=accounts.getFirst();
                if (!sender.equals(form.senderAddress())) throw ApiErrors.error(409,"발신 계정이 변경되었습니다. 초안을 다시 열어 확인하세요.");
            }
            if (!mail.path("can_approve").asBoolean() || !mail.path("recipient").asString().equals(form.recipient()))
                throw ApiErrors.error(409,"현재 제출본의 수신 주소를 다시 확인한 뒤 승인하세요.");
            data.db.update("""
                UPDATE review_mail SET subject=?,body=?,state='approved',sent_to=?,approved_by=?,sender_address=?,approved_at=clock_timestamp(),
                    revision=revision+1 WHERE id=?
                """,subject,body,form.recipient(),staff.getName(),sender,id);
            data.audit(sid,staff.getName(),mail.path("kind").asString()+" 메일 발송 승인");
        } else {
            data.db.update("UPDATE review_mail SET subject=?,body=?,revision=revision+1 WHERE id=?",subject,body,id);
        }
        return detail(staff.getName(),id);
    }

    @PostMapping("/retry")
    Object reopen(Principal staff, @PathVariable UUID id, @RequestBody ReviewDecisions.Recovery form) {
        UUID sid=lock(staff,id);
        String state=data.db.queryForObject("SELECT state FROM review_mail WHERE id=?",String.class,id);
        if ("uncertain".equals(state) && !Boolean.TRUE.equals(form.confirmedAbsent()))
            throw ApiErrors.error(409,"미발송을 확인한 뒤 초안을 다시 여세요.");
        if (data.db.update("""
            UPDATE review_mail SET state='draft',sent_to=NULL,approved_by=NULL,approved_at=NULL,revision=revision+1
            WHERE id=? AND state IN ('failed','uncertain')
            """,id)>0) data.audit(sid,staff.getName(),"메일 초안 다시 열기");
        return Map.of("saved",true);
    }
}
