package kr.swax.intake;

import java.io.IOException;
import java.time.OffsetDateTime;
import java.util.UUID;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(OutputJobs.PATH)
@Transactional
class OutputJobs {
    static final String PATH = "/api/worker/output";
    private static final String TOKEN = "X-Claim-Token";
    private static final int MAX_PDF = 120 * 1024 * 1024;
    record Printer(String workerId) {}
    record Claim(UUID id, int version, UUID claimToken, String sha256, OffsetDateTime leaseUntil) {}
    private final JdbcTemplate db;
    private final int lease;

    OutputJobs(JdbcTemplate db, @Value("${awards.output.lease-seconds}") int lease) {
        if (lease < 1) throw new IllegalArgumentException("출력 임대는 1초 이상이어야 합니다.");
        this.db = db;
        this.lease = lease;
    }

    @PostMapping("/claim")
    ResponseEntity<Claim> claim(@RequestBody Printer printer) {
        return claimFor(printer,null);
    }

    ResponseEntity<Claim> claimFor(Printer printer,String owner) {
        if (printer.workerId() == null || printer.workerId().isBlank() || printer.workerId().length() > 80)
            throw ApiErrors.error(422, "출력 PC의 식별자를 입력하세요.");
        var rows = db.query("""
            WITH available AS (SELECT id FROM award_report WHERE state='printing' AND hwpx IS NOT NULL
                AND (print_until IS NULL OR print_until<=now())
                AND (?::text IS NULL OR (created_by=? AND EXISTS(SELECT FROM event_staff s WHERE s.event_id=award_report.event_id AND s.login=?)))
                ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
            UPDATE award_report r SET printer=?,print_token=gen_random_uuid(),print_until=clock_timestamp()+?*interval '1 second'
            FROM available a WHERE r.id=a.id RETURNING r.id,version,print_token,encode(sha256(hwpx),'hex'),print_until
            """, (rs,n) -> new Claim(rs.getObject(1,UUID.class),rs.getInt(2),rs.getObject(3,UUID.class),
                    rs.getString(4),rs.getObject(5,OffsetDateTime.class)),owner,owner,owner,printer.workerId().strip(),lease);
        recordPrinterContact();
        return rows.stream().findFirst().map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.noContent().build());
    }

    @GetMapping("/{id}/hwpx")
    ResponseEntity<byte[]> input(@PathVariable UUID id,@RequestHeader(TOKEN) UUID token) {
        byte[] bytes = db.query("SELECT hwpx FROM award_report WHERE id=? AND print_token=? AND print_until>now() AND state='printing'",
                (rs,n)->rs.getBytes(1),id,token).stream().findFirst().orElseThrow(OutputJobs::lost);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(MediaType.APPLICATION_OCTET_STREAM).body(bytes);
    }

    @PutMapping("/{id}/lease")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void renew(@PathVariable UUID id,@RequestHeader(TOKEN) UUID token) {
        if (db.update("""
                UPDATE award_report SET print_until=clock_timestamp()+?*interval '1 second'
                WHERE id=? AND print_token=? AND state='printing' AND print_until>now()
                """,lease,id,token)!=1) throw lost();
        recordPrinterContact();
    }

    private void recordPrinterContact() {
        db.update("""
            INSERT INTO workflow_health AS h(role,configured) VALUES ('printer',true)
            ON CONFLICT(role) DO UPDATE SET updated_at=excluded.updated_at
            WHERE h.updated_at < excluded.updated_at-interval '10 seconds'
            """);
    }

    @PutMapping(value="/{id}/pdf",consumes="application/pdf")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void complete(@PathVariable UUID id,@RequestHeader(TOKEN) UUID token,@RequestHeader("X-Hwpx-Sha256") String digest,
                  HttpServletRequest request) throws IOException {
        byte[] pdf=readPdf(request);
        completePdf(id,token,digest,pdf);
    }

    static byte[] readPdf(HttpServletRequest request) throws IOException {
        if (request.getContentLengthLong()>MAX_PDF) throw ApiErrors.error(413,"PDF가 출력 한도를 초과했습니다.");
        byte[] pdf = request.getInputStream().readNBytes(MAX_PDF+1);
        if (pdf.length>MAX_PDF) throw ApiErrors.error(413,"PDF가 출력 한도를 초과했습니다.");
        if (pdf.length<5 || !new String(pdf,0,5,java.nio.charset.StandardCharsets.US_ASCII).equals("%PDF-"))
            throw ApiErrors.error(422,"PDF 출력을 확인하세요.");
        return pdf;
    }

    void completePdf(UUID id,UUID token,String digest,byte[] pdf) {
        int updated = db.update("""
            UPDATE award_report SET state='verifying',pdf=?,print_until=NULL WHERE id=? AND print_token=?
                AND state='printing' AND print_until>now() AND encode(sha256(hwpx),'hex')=?
            """,pdf,id,token,digest);
        if (updated==0 && !db.queryForObject("""
            SELECT EXISTS(SELECT FROM award_report WHERE id=? AND print_token=? AND encode(sha256(hwpx),'hex')=?
                AND state IN ('verifying','preview','confirmed') AND pdf=?)
            """,Boolean.class,id,token,digest,pdf)) throw lost();
    }

    @PutMapping("/{id}/failure")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void failure(@PathVariable UUID id,@RequestHeader(TOKEN) UUID token) {
        if (db.update("""
            UPDATE award_report SET state='failed',print_until=NULL,error='전용 PC의 한글 설정과 입력 HWPX를 확인하고 다시 출력하세요.'
            WHERE id=? AND print_token=? AND state='printing' AND print_until>now()
            """,id,token)!=1) throw lost();
    }

    private static RuntimeException lost() { return ApiErrors.error(409,"출력 배정이 만료됐거나 다른 버전입니다."); }
}
