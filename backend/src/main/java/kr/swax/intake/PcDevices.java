package kr.swax.intake;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.Principal;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

@Service
@Transactional
class PcDevices {
    record Device(UUID id, String login) {}
    record Exchange(String code, String name, String version) {}
    record Credential(UUID deviceId, String token, String login) {}
    private final JdbcTemplate db;
    private final boolean enabled;
    private final Path installer;
    private final SecureRandom random = new SecureRandom();

    PcDevices(JdbcTemplate db, @Value("${awards.pc.enabled:false}") boolean enabled,
              @Value("${awards.pc.installer:}") String installer) {
        this.db=db; this.enabled=enabled;
        this.installer=installer.isBlank() ? null : Path.of(installer);
    }

    void requireEnabled() {
        if (!enabled) throw ApiErrors.error(409,"담당자 PC 연결 기능이 활성화되지 않았습니다.");
    }

    Path installerPath() {
        requireEnabled();
        if (installer==null || !Files.isRegularFile(installer)) throw ApiErrors.error(404,"설치 파일을 준비 중입니다.");
        return installer;
    }

    static byte[] hash(String value) {
        try { return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.US_ASCII)); }
        catch (NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }

    private String secret() {
        byte[] bytes=new byte[32]; random.nextBytes(bytes); return HexFormat.of().formatHex(bytes);
    }

    String pair(String login, UUID browser) {
        requireEnabled();
        if (browser==null) throw ApiErrors.error(422,"이 PC의 연결 정보를 확인하세요.");
        // Serialize pairing requests for one account, and bound unused codes.
        db.queryForList("SELECT login FROM staff_account WHERE login=? FOR UPDATE",String.class,login);
        db.update("DELETE FROM pc_pairing WHERE expires_at<=clock_timestamp() OR (login=? AND browser_id=?)",login,browser);
        if (db.queryForObject("SELECT count(*) FROM pc_pairing WHERE login=?",Integer.class,login)>=10)
            throw ApiErrors.error(429,"잠시 후 PC 연결을 다시 시도하세요.");
        String code=secret();
        db.update("INSERT INTO pc_pairing(code_hash,login,browser_id) VALUES(?,?,?)",hash(code),login,browser);
        return code;
    }

    Credential exchange(Exchange request) {
        requireEnabled();
        if (request.code()==null || !request.code().matches("[a-f0-9]{64}") || request.name()==null
                || request.name().isBlank() || request.name().length()>80 || request.version()==null || request.version().length()>32)
            throw ApiErrors.error(422,"PC 연결 정보를 확인하세요.");
        record Pair(String login, UUID browser) {}
        var pair=db.query("DELETE FROM pc_pairing WHERE code_hash=? AND expires_at>clock_timestamp() RETURNING login,browser_id",
            (rs,n)->new Pair(rs.getString(1),rs.getObject(2,UUID.class)),hash(request.code())).stream().findFirst()
            .orElseThrow(()->ApiErrors.error(401,"연결 코드가 만료됐습니다. 웹에서 다시 연결하세요."));
        db.update("UPDATE pc_device SET revoked=true WHERE login=? AND browser_id=?",pair.login(),pair.browser());
        String token=secret();
        UUID id=db.queryForObject("INSERT INTO pc_device(login,browser_id,token_hash,name,version) VALUES(?,?,?,?,?) RETURNING id",
            UUID.class,pair.login(),pair.browser(),hash(token),request.name().strip(),request.version());
        return new Credential(id,token,pair.login());
    }

    Device authenticate(String header) {
        requireEnabled();
        if (header==null || !header.matches("Bearer [a-f0-9]{64}")) throw ApiErrors.error(401,"PC 연결 인증이 필요합니다.");
        return db.query("SELECT id,login FROM pc_device WHERE token_hash=? AND NOT revoked FOR KEY SHARE",
            (rs,n)->new Device(rs.getObject(1,UUID.class),rs.getString(2)),hash(header.substring(7)))
            .stream().findFirst().orElseThrow(()->ApiErrors.error(401,"PC 연결을 다시 등록하세요."));
    }

    void heartbeat(Device device, boolean ready, String version) {
        if (version==null || version.length()>32) throw ApiErrors.error(422,"연결 프로그램 버전을 확인하세요.");
        db.update("UPDATE pc_device SET seen_at=clock_timestamp(),hancom_ready=?,version=? WHERE id=? AND NOT revoked",ready,version,device.id());
    }

    void revoke(String login, UUID id) {
        if (db.update("UPDATE pc_device SET revoked=true WHERE id=? AND login=?",id,login)==0)
            throw ApiErrors.error(404,"연결 정보를 찾을 수 없습니다.");
    }

    Map<String,Object> status(String login, UUID browser) {
        if (!enabled) return Map.of("enabled",false);
        var rows=db.query("""
            SELECT id,name,NOT revoked AS registered,seen_at>clock_timestamp()-interval '45 seconds' AS online,hancom_ready
            FROM pc_device WHERE login=? AND browser_id=? ORDER BY created_at DESC,id DESC LIMIT 1
            """,(rs,n)->Map.<String,Object>of("id",rs.getObject(1,UUID.class),"name",rs.getString(2),
                "registered",rs.getBoolean(3),"online",rs.getBoolean(4)&&rs.getBoolean(3),"hancom_ready",rs.getBoolean(5)),login,browser);
        int pending=db.queryForObject("""
            SELECT (SELECT count(*) FROM intake_file f JOIN intake_batch b ON b.id=f.batch_id
                JOIN event_staff s ON s.event_id=b.event_id AND s.login=?
                WHERE b.uploaded_by=? AND NOT EXISTS(SELECT FROM original_analysis a WHERE a.file_id=f.id))
                +(SELECT count(*) FROM award_report r JOIN event_staff s ON s.event_id=r.event_id AND s.login=?
                  WHERE r.created_by=? AND r.state='printing')
            """,Integer.class,login,login,login,login);
        return Map.of("enabled",true,"device",rows.isEmpty()?Map.of():rows.getFirst(),"pending",pending,
                      "download_available",installer!=null && Files.isRegularFile(installer));
    }
}

@RestController
@RequestMapping("/api/pc-connections")
class PcConnectionController {
    record PairRequest(UUID browserId) {}
    private final PcDevices devices;
    PcConnectionController(PcDevices devices) { this.devices=devices; }

    @GetMapping
    Map<String,Object> status(Principal staff,@RequestParam UUID browser) { return devices.status(staff.getName(),browser); }

    @PostMapping("/pair")
    Map<String,String> pair(Principal staff,@RequestBody PairRequest request) {
        String code=devices.pair(staff.getName(),request.browserId());
        return Map.of("uri","swax-pc://connect?code="+code,"code",code);
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void revoke(Principal staff,@PathVariable UUID id) {
        devices.revoke(staff.getName(),id);
    }

    @GetMapping("/installer")
    ResponseEntity<FileSystemResource> installer() {
        Path installer=devices.installerPath();
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .header(HttpHeaders.CONTENT_DISPOSITION,"attachment; filename=SWAX-PC-Setup.exe")
            .contentType(MediaType.APPLICATION_OCTET_STREAM).body(new FileSystemResource(installer));
    }
}
