package kr.swax.intake;

import java.security.Principal;
import java.util.UUID;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

@RestController
@Transactional
class IntakeDeletion {
    private final WorkflowData data;
    private final TeamSubmissions submissions;

    IntakeDeletion(WorkflowData data, TeamSubmissions submissions) {
        this.data = data;
        this.submissions = submissions;
    }

    @GetMapping("/api/events/{event}/deletion-preview")
    ResponseEntity<JsonNode> previewEvent(Principal staff, @PathVariable UUID event) {
        data.catalog.requireEvent(staff.getName(), event);
        return preview(event, null, null);
    }

    @GetMapping("/api/intake-batches/{batch}/deletion-preview")
    ResponseEntity<JsonNode> previewBatch(Principal staff, @PathVariable UUID batch) {
        return preview(data.scope(staff.getName(), WorkflowData.Resource.BATCH, batch), batch, null);
    }

    @GetMapping("/api/intake-batches/{batch}/files/{file}/deletion-preview")
    ResponseEntity<JsonNode> previewFile(Principal staff, @PathVariable UUID batch, @PathVariable UUID file) {
        return preview(data.scope(staff.getName(), WorkflowData.Resource.BATCH, batch), batch, file);
    }

    private ResponseEntity<JsonNode> preview(UUID event, UUID batch, UUID file) {
        var impact = data.one("SELECT * FROM intake_deletion_preview(?,?,?)", event, batch, file);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(impact);
    }

    @DeleteMapping("/api/events/{event}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void event(Principal staff, @PathVariable UUID event, @RequestHeader(name=HttpHeaders.IF_MATCH, required=false) String expected) {
        data.catalog.requireEvent(staff.getName(), event);
        remove(event, null, null, expected);
    }

    @DeleteMapping("/api/intake-batches/{batch}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void batch(Principal staff, @PathVariable UUID batch, @RequestHeader(name=HttpHeaders.IF_MATCH, required=false) String expected) {
        remove(data.scope(staff.getName(), WorkflowData.Resource.BATCH, batch), batch, null, expected);
    }

    @DeleteMapping("/api/intake-batches/{batch}/files/{file}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void file(Principal staff, @PathVariable UUID batch, @PathVariable UUID file,
              @RequestHeader(name=HttpHeaders.IF_MATCH, required=false) String expected) {
        remove(data.scope(staff.getName(), WorkflowData.Resource.BATCH, batch), batch, file, expected);
        if (data.db.queryForObject("""
                SELECT EXISTS(SELECT FROM intake_team_confirmation c JOIN intake_preparation p ON p.batch_id=c.batch_id
                    WHERE c.batch_id=? AND c.state='blocked' AND p.state IN ('ready','prepared'))
                """, Boolean.class, batch)) {
            submissions.refresh(staff.getName(), batch, null, null);
        }
    }

    private void remove(UUID event, UUID batch, UUID file, String expected) {
        int status;
        try {
            status = data.db.queryForObject("SELECT delete_intake_data(?,?,?,?)", Integer.class, event, batch, file, expected);
        } catch (PessimisticLockingFailureException ex) {
            throw ApiErrors.error(409, "다른 요청이 자료를 처리 중입니다. 잠시 후 삭제를 다시 시도하세요.");
        }
        if (status == 404) throw ApiErrors.error(404, "삭제할 접수 또는 원본을 찾을 수 없습니다.");
        if (status == 412) throw ApiErrors.error(412, "삭제 대상이나 처리 상태가 바뀌었습니다. 최신 목록을 다시 확인해 주세요.");
        if (status == 409) throw ApiErrors.error(409, "판정·메일 발송·보고서 출력이 진행 중입니다. 처리 종료 후 삭제하세요.");
    }
}
