package kr.swax.intake;

import java.security.Principal;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
class StaffSessionController {
    record Session(String login, String csrfToken) {}

    @GetMapping("/api/auth/session")
    Session session(Principal principal, CsrfToken csrf) {
        return new Session(principal == null ? null : principal.getName(), csrf.getToken());
    }
}
