package kr.swax.intake;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.Principal;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import tools.jackson.databind.ObjectMapper;

@RestController
@RequestMapping("/api/intake-batches")
class IntakeController {
    private final IntakeStore store;
    private final FileAssignments assignments;
    private final ObjectMapper mapper;

    IntakeController(IntakeStore store, FileAssignments assignments, ObjectMapper mapper) {
        this.store = store;
        this.assignments = assignments;
        this.mapper = mapper;
    }

    @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    ResponseEntity<IntakeStore.Receipt> upload(
            Principal staff,
            @RequestHeader(value = "Idempotency-Key", required = false) String key,
            @RequestParam UUID event, @RequestParam(required = false) UUID target, @RequestParam String manifest,
            @RequestParam(defaultValue = "existing") String mode,
            @RequestParam(required = false) UUID base, @RequestParam(defaultValue = "[]") String removed,
            @RequestParam(required = false) List<MultipartFile> files) throws IOException {
        List<UUID> replaced;
        try { replaced = List.of(mapper.readValue(removed, UUID[].class)); }
        catch (RuntimeException ex) { throw ApiErrors.error(422, "교체할 원본 목록을 확인하세요."); }
        if (replaced.size() > 100 || Set.copyOf(replaced).size() != replaced.size() || (base == null && !replaced.isEmpty())) {
            throw ApiErrors.error(422, "이전 제출본에서 교체할 원본을 한 번씩 지정하세요.");
        }
        boolean bundle = mode.equals("bundle");
        if ((!bundle && !mode.equals("existing")) || (bundle && (target != null || base != null))) {
            throw ApiErrors.error(422, "새 팀 묶음은 팀 지정이나 보완본 접수와 함께 사용할 수 없습니다.");
        }
        IntakeUpload upload = IntakeUpload.read(event, target, key, manifest, files, mapper, base, replaced, bundle);
        IntakeStore.Receipt receipt = store.receive(staff.getName(), key, event, target, upload, base, replaced, bundle);
        return ResponseEntity.status(receipt.status().equals("done") ? 200 : 202).location(URI.create(receipt.statusUrl())).body(receipt);
    }

    @GetMapping
    List<IntakeStore.Summary> history(Principal staff, @RequestParam UUID event) { return store.history(staff.getName(), event); }

    @GetMapping("/{id}")
    IntakeStore.Details details(Principal staff, @PathVariable UUID id) { return store.details(staff.getName(), id); }

    @PutMapping("/{batch}/files/{file}/assignment")
    FileAssignments.Saved assign(Principal staff, @PathVariable UUID batch, @PathVariable UUID file,
                                 @RequestBody FileAssignments.Command command) {
        return assignments.assign(staff.getName(), batch, file, command);
    }

    @GetMapping("/{batch}/files/{file}/assignment/history")
    List<FileAssignments.Change> assignmentHistory(Principal staff, @PathVariable UUID batch, @PathVariable UUID file) {
        return assignments.history(staff.getName(), batch, file);
    }

    @GetMapping("/{batch}/files/{file}/original")
    ResponseEntity<byte[]> original(Principal staff, @PathVariable UUID batch, @PathVariable UUID file) {
        return attachment(store.original(staff.getName(), batch, file));
    }

    static ResponseEntity<byte[]> attachment(IntakeStore.Original original) {
        ContentDisposition attachment = ContentDisposition.attachment().filename(original.name(), StandardCharsets.UTF_8).build();
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(MediaType.APPLICATION_OCTET_STREAM)
                .header(HttpHeaders.CONTENT_DISPOSITION, attachment.toString())
                .header("X-Content-Type-Options", "nosniff").body(original.bytes());
    }
}
