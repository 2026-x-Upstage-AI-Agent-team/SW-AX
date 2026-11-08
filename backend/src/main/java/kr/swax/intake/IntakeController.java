package kr.swax.intake;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.Principal;
import java.util.List;
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
            @RequestParam(required = false) List<MultipartFile> files) throws IOException {
        IntakeUpload upload = IntakeUpload.read(event, target, key, manifest, files, mapper);
        IntakeStore.Receipt receipt = store.receive(staff.getName(), key, event, target, upload);
        return ResponseEntity.accepted().location(URI.create(receipt.statusUrl())).body(receipt);
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
        IntakeStore.Original original = store.original(staff.getName(), batch, file);
        ContentDisposition attachment = ContentDisposition.attachment().filename(original.name(), StandardCharsets.UTF_8).build();
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(MediaType.APPLICATION_OCTET_STREAM)
                .header(HttpHeaders.CONTENT_DISPOSITION, attachment.toString())
                .header("X-Content-Type-Options", "nosniff").body(original.bytes());
    }
}
