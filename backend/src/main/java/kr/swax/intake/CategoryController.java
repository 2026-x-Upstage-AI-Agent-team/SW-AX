package kr.swax.intake;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
class CategoryController {
    private final AwardCatalog catalog;
    CategoryController(AwardCatalog catalog) { this.catalog = catalog; }

    @GetMapping("/api/categories")
    List<AwardCatalog.Category> categories() { return catalog.categories(); }
}
