package kr.swax.intake;

import java.io.IOException;
import java.security.Principal;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;

import org.springframework.http.ResponseEntity;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api/files/{file}/versions")
@Transactional
class DocumentVersions {
    private final WorkflowData data;

    DocumentVersions(WorkflowData data) { this.data = data; }

    record Version(int version, String editor, Instant savedAt) {}
    record History(String name, List<Version> versions) {}

    @GetMapping
    History history(Principal staff, @PathVariable UUID file) {
        data.scope(staff.getName(), WorkflowData.Resource.FILE, file);
        String name = data.db.queryForObject("SELECT name FROM intake_file WHERE id=?", String.class, file);
        List<Version> versions = data.db.query("""
                SELECT version, editor, saved_at FROM document_edit_version WHERE file_id=? ORDER BY version DESC
                """, (rows, n) -> new Version(rows.getInt(1), rows.getString(2), rows.getTimestamp(3).toInstant()), file);
        return new History(name, versions);
    }

    @GetMapping("/{version}/content")
    ResponseEntity<byte[]> content(Principal staff, @PathVariable UUID file, @PathVariable int version) {
        data.scope(staff.getName(), WorkflowData.Resource.FILE, file);
        var stored = version == 0
                ? data.db.query("SELECT name, original FROM intake_file WHERE id=?",
                        (rows, n) -> new IntakeStore.Original(rows.getString(1), rows.getBytes(2)), file)
                : data.db.query("""
                        SELECT f.name, v.hwpx FROM document_edit_version v JOIN intake_file f ON f.id=v.file_id
                        WHERE v.file_id=? AND v.version=?
                        """, (rows, n) -> new IntakeStore.Original(
                        rows.getString(1).replaceFirst("(?i)\\.hwpx?$", "") + "-v" + version + ".hwpx", rows.getBytes(2)), file, version);
        return IntakeController.attachment(stored.stream().findFirst()
                .orElseThrow(() -> ApiErrors.error(404, "문서 버전을 찾을 수 없습니다.")));
    }

    @PostMapping
    Version save(Principal staff, @PathVariable UUID file, @RequestParam int baseVersion,
                 @RequestParam MultipartFile document) throws IOException {
        String login = staff.getName();
        data.scope(login, WorkflowData.Resource.FILE, file);
        if (baseVersion < 0 || baseVersion == Integer.MAX_VALUE) throw ApiErrors.error(422, "편집을 시작한 버전을 확인하세요.");
        if (document.isEmpty() || document.getSize() > 40L * IntakeUpload.MIB)
            throw ApiErrors.error(413, "수정본은 1바이트 이상 40 MiB까지 저장할 수 있습니다.");
        byte[] bytes = document.getBytes();
        if (!AwardReports.validHwpx(bytes)) throw ApiErrors.error(415, "열 수 있는 HWPX 수정본이 필요합니다.");
        String hash = HexFormat.of().formatHex(IntakeUpload.sha256().digest(bytes));
        data.db.queryForObject("SELECT id FROM intake_file WHERE id=? FOR NO KEY UPDATE", UUID.class, file);
        int latest = data.db.queryForObject("SELECT coalesce(max(version),0) FROM document_edit_version WHERE file_id=?", Integer.class, file);
        int next = baseVersion + 1;
        if (baseVersion != latest) {
            var replay = data.db.query("""
                    SELECT saved_at FROM document_edit_version WHERE file_id=? AND version=? AND editor=? AND sha256=?
                    """, (rows, n) -> new Version(next, login, rows.getTimestamp(1).toInstant()), file, next, login, hash);
            if (!replay.isEmpty()) return replay.getFirst();
            throw ApiErrors.error(409, "그 사이 새 버전이 저장되었습니다. 최신 수정본을 다시 열어 주세요.");
        }
        return data.db.queryForObject("""
                INSERT INTO document_edit_version(file_id,version,parent_version,editor,sha256,hwpx)
                VALUES(?,?,?,?,?,?) RETURNING saved_at
                """, (rows, n) -> new Version(next, login, rows.getTimestamp(1).toInstant()), file, next, baseVersion, login, hash, bytes);
    }
}
