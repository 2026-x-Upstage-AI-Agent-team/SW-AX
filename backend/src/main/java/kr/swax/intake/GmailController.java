package kr.swax.intake;

import java.net.URI;
import java.security.Principal;
import java.time.Instant;
import java.util.Map;
import java.util.Properties;

import jakarta.mail.AuthenticationFailedException;
import jakarta.mail.MessagingException;
import jakarta.mail.Session;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.client.RestClientException;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.util.WebUtils;

import static kr.swax.intake.ApiErrors.error;

@RestController
@RequestMapping("/api/settings/gmail")
class GmailController {
    static final String CALLBACK = "/api/settings/gmail/callback";
    private static final String ATTEMPT = GmailController.class.getName() + ".attempt";
    private final GmailProfile profile;
    private final GoogleGmail google;
    private final URI redirect;

    GmailController(GmailProfile profile, GoogleGmail google, @Value("${awards.gmail.redirect-uri}") URI redirect) {
        this.profile = profile;
        this.google = google;
        this.redirect = redirect;
        boolean local = "127.0.0.1".equals(redirect.getHost()) || "localhost".equalsIgnoreCase(redirect.getHost())
                || "[::1]".equals(redirect.getHost());
        if (redirect.getHost() == null || !("https".equals(redirect.getScheme()) || local && "http".equals(redirect.getScheme()))
                || !CALLBACK.equals(redirect.getRawPath()) || redirect.getUserInfo() != null
                || redirect.getRawQuery() != null || redirect.getRawFragment() != null)
            throw new IllegalArgumentException("AWARDS_GMAIL_REDIRECT_URI에 공개 서비스의 Gmail 콜백 주소를 설정하세요.");
    }

    record Status(String gmailAccount, boolean gmailOauthConnected, boolean mailReady, String redirectUri) {}

    @GetMapping
    Status status() {
        var a = profile.current();
        return new Status(a.address(), !a.oauth().isEmpty(), !a.oauth().isEmpty() || !a.credential().isEmpty(), redirect.toString());
    }

    @PostMapping("/oauth/start")
    Map<String, String> start(HttpSession session, Principal staff) {
        var account = profile.requireAccount();
        var attempt = google.begin(staff.getName(), account.address(), profile.client(account), redirect.toString());
        synchronized (WebUtils.getSessionMutex(session)) { session.setAttribute(ATTEMPT, attempt); }
        return Map.of("url", google.authorize(attempt));
    }

    @GetMapping("/callback")
    ResponseEntity<Void> callback(HttpServletRequest request, Principal staff, @RequestParam(required = false) String state,
                                  @RequestParam(required = false) String code, @RequestParam(name = "error", required = false) String providerError) {
        HttpSession session = request.getSession(false);
        if (session == null || staff == null) return back("expired");
        GoogleGmail.Attempt attempt;
        synchronized (WebUtils.getSessionMutex(session)) {
            attempt = (GoogleGmail.Attempt) session.getAttribute(ATTEMPT);
            if (attempt == null || !attempt.staff().equals(staff.getName()) || !attempt.matches(state)) return back("expired");
            session.removeAttribute(ATTEMPT);
        }
        if (!Instant.now().isBefore(attempt.expires())) return back("expired");
        if ("access_denied".equals(providerError)) return back("cancelled");
        if (providerError != null || code == null || code.isBlank()) return back("failed");
        try {
            return back(google.exchange(attempt, code, profile));
        } catch (RestClientException | ResponseStatusException ex) {
            return back("failed");
        }
    }

    private static ResponseEntity<Void> back(String result) {
        return ResponseEntity.status(303).location(URI.create("/#/gmail?result=" + result))
                .cacheControl(CacheControl.noStore()).header("Referrer-Policy", "no-referrer").build();
    }

    record Password(String appPassword) {}

    @PostMapping("/connect")
    Map<String, Object> connect(@RequestBody Password input) {
        String address = profile.requireAccount().address();
        String password = input.appPassword() == null ? "" : input.appPassword().replace(" ", "").strip();
        if (!password.matches("[A-Za-z0-9]{16}")) throw error(422, "Google이 발급한 16자리 앱 비밀번호를 입력하세요.");
        var settings = new Properties();
        settings.setProperty("mail.smtps.ssl.checkserveridentity", "true");
        for (String timeout : new String[]{"connectiontimeout", "timeout", "writetimeout"})
            settings.setProperty("mail.smtps." + timeout, "15000");
        try (var smtp = Session.getInstance(settings).getTransport("smtps")) {
            smtp.connect("smtp.gmail.com", 465, address, password);
        } catch (AuthenticationFailedException ex) {
            throw error(422, "Google에서 인증을 거절했습니다. 담당자 계정과 앱 비밀번호를 확인하세요.");
        } catch (MessagingException ex) {
            throw error(503, "Gmail에 연결하지 못했습니다. 잠시 후 다시 시도하세요.");
        }
        profile.savePassword(address, password);
        return Map.of("connected", true, "address", address);
    }
}
