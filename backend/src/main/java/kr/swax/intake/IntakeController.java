package kr.swax.intake;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
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
    private final ObjectMapper mapper;

    IntakeController(IntakeStore store, ObjectMapper mapper) {
        this.store = store;
        this.mapper = mapper;
    }

    @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    ResponseEntity<IntakeStore.Receipt> upload(
            @RequestHeader(value = "Idempotency-Key", required = false) String key,
            @RequestParam UUID event, @RequestParam(required = false) UUID target, @RequestParam String manifest,
            @RequestParam(required = false) List<MultipartFile> files) throws IOException {
        IntakeUpload upload = IntakeUpload.read(event, target, key, manifest, files, mapper);
        IntakeStore.Receipt receipt = store.receive(key, event, target, upload);
        return ResponseEntity.accepted().location(URI.create(receipt.statusUrl())).body(receipt);
    }

    @GetMapping
    List<IntakeStore.Summary> history(@RequestParam UUID event) { return store.history(event); }

    @GetMapping("/{id}")
    IntakeStore.Details details(@PathVariable UUID id) { return store.details(id); }

    @GetMapping("/{batch}/files/{file}/original")
    ResponseEntity<byte[]> original(@PathVariable UUID batch, @PathVariable UUID file) {
        IntakeStore.Original original = store.original(batch, file);
        ContentDisposition attachment = ContentDisposition.attachment().filename(original.name(), StandardCharsets.UTF_8).build();
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(MediaType.APPLICATION_OCTET_STREAM)
                .header(HttpHeaders.CONTENT_DISPOSITION, attachment.toString())
                .header("X-Content-Type-Options", "nosniff").body(original.bytes());
    }
}
