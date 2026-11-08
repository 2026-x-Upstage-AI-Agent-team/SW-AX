package kr.swax.intake;

import java.security.Principal;
import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/events")
class CatalogController {
    private final AwardCatalog catalog;

    CatalogController(AwardCatalog catalog) { this.catalog = catalog; }

    @GetMapping
    List<AwardCatalog.Event> events(Principal staff) { return catalog.events(staff.getName()); }

    @PostMapping
    AwardCatalog.Event createEvent(Principal staff, @RequestBody AwardCatalog.NameInput body) {
        return catalog.createEvent(staff.getName(), body);
    }

    @GetMapping("/{event}/teams")
    List<AwardCatalog.Team> teams(Principal staff, @PathVariable UUID event) { return catalog.teams(staff.getName(), event); }

    @PostMapping("/{event}/teams")
    AwardCatalog.Team createTeam(Principal staff, @PathVariable UUID event, @RequestBody AwardCatalog.NameInput body) {
        return catalog.createTeam(staff.getName(), event, body);
    }
}
