package kr.swax.intake;

import java.security.Principal;
import java.util.UUID;

import org.springframework.web.bind.annotation.*;

@RestController
class SubmissionController {
    private final TeamSubmissions submissions;

    SubmissionController(TeamSubmissions submissions) { this.submissions = submissions; }

    @PutMapping("/api/intake-batches/{batch}/teams/{team}/submission")
    TeamSubmissions.Link confirm(Principal staff, @PathVariable UUID batch, @PathVariable UUID team,
                                 @RequestBody TeamSubmissions.Confirmation command) {
        return submissions.confirm(staff.getName(), batch, team, command);
    }

    @GetMapping("/api/submissions/{id}")
    TeamSubmissions.Snapshot get(Principal staff, @PathVariable UUID id) { return submissions.get(staff.getName(), id); }
}
