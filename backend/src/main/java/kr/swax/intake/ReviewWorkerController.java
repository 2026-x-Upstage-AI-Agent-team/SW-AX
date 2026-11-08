package kr.swax.intake;

import java.util.Map;
import java.util.UUID;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(ReviewWorkerController.PATH)
class ReviewWorkerController {
    static final String PATH = "/api/worker/review-jobs";
    private static final String TOKEN = "X-Claim-Token";
    private final ReviewWorkerJobs jobs;
    private final TeamSubmissions submissions;

    ReviewWorkerController(ReviewWorkerJobs jobs, TeamSubmissions submissions) { this.jobs = jobs; this.submissions = submissions; }

    @PutMapping("/preparations/{id}/confirm")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void confirmPrepared(@PathVariable UUID id) { submissions.confirmPrepared(id); }

    @PostMapping("/claim")
    ResponseEntity<ReviewWorkerJobs.Claim> claim(@RequestBody ReviewWorkerJobs.ClaimRequest request) {
        return jobs.claim(request).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.noContent().build());
    }

    @GetMapping("/{id}/files/{file}/original")
    ResponseEntity<byte[]> original(@PathVariable UUID id, @PathVariable UUID file, @RequestHeader(TOKEN) UUID token) {
        return IntakeController.attachment(jobs.original(id, token, file));
    }

    @PutMapping("/{id}/lease")
    ReviewWorkerJobs.Lease renew(@PathVariable UUID id, @RequestHeader(TOKEN) UUID token,
                                @RequestBody ReviewWorkerJobs.Checkpoint checkpoint) {
        return jobs.renew(id, token, checkpoint);
    }

    @PutMapping("/{id}/result")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void finish(@PathVariable UUID id, @RequestHeader(TOKEN) UUID token, @RequestBody ReviewWorkerJobs.Result result) {
        jobs.finish(id, token, result);
    }

    @ExceptionHandler(DuplicateKeyException.class)
    ResponseEntity<?> duplicateStudioJob() {
        return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("detail", "해당 Studio 실행은 다른 제출본에 연결돼 있습니다."));
    }
}
