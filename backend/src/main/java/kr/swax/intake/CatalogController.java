package kr.swax.intake;

import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/events")
class CatalogController {
    private final AwardCatalog catalog;

    CatalogController(AwardCatalog catalog) { this.catalog = catalog; }

    @GetMapping
    List<AwardCatalog.Event> events() { return catalog.events(); }

    @PostMapping
    AwardCatalog.Event createEvent(@RequestBody AwardCatalog.NameInput body) { return catalog.createEvent(body); }

    @GetMapping("/{event}/teams")
    List<AwardCatalog.Team> teams(@PathVariable UUID event) { return catalog.teams(event); }

    @PostMapping("/{event}/teams")
    AwardCatalog.Team createTeam(@PathVariable UUID event, @RequestBody AwardCatalog.NameInput body) {
        return catalog.createTeam(event, body);
    }
}
