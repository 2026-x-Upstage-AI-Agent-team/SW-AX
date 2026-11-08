package kr.swax.intake;

import java.security.Principal;
import java.util.List;
import java.util.UUID;

import org.springframework.web.bind.annotation.*;

@RestController
class ReviewJobController {
    private final ReviewJobs jobs;

    ReviewJobController(ReviewJobs jobs) { this.jobs = jobs; }

    @PutMapping("/api/submissions/{id}/review-job")
    ReviewJobs.Job register(Principal staff, @PathVariable UUID id) { return jobs.register(staff.getName(), id); }

    @GetMapping("/api/review-jobs/{id}")
    ReviewJobs.Job get(Principal staff, @PathVariable UUID id) { return jobs.get(staff.getName(), id); }

    @GetMapping("/api/events/{event}/review-jobs")
    List<ReviewJobs.Job> list(Principal staff, @PathVariable UUID event, @RequestParam(required = false) String state) {
        return jobs.list(staff.getName(), event, state);
    }
}
