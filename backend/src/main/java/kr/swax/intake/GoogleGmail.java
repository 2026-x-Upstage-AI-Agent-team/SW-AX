package kr.swax.intake;

import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import java.util.Map;
import java.util.stream.Collectors;

import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;
import tools.jackson.databind.JsonNode;

import static java.nio.charset.StandardCharsets.US_ASCII;
import static java.nio.charset.StandardCharsets.UTF_8;

@Component
class GoogleGmail {
    static final String SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
    private static final SecureRandom RANDOM = new SecureRandom();
    private final RestClient http;

    GoogleGmail() {
        var factory = new JdkClientHttpRequestFactory(HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build());
        factory.setReadTimeout(Duration.ofSeconds(15));
        http = RestClient.builder().requestFactory(factory).build();
    }

    GoogleGmail(RestClient http) { this.http = http; }

    record Attempt(String state, String verifier, Instant expires, String staff, String address, GmailProfile.Client client, String redirect, long generation) {
        boolean matches(String returnedState) {
            return returnedState != null && MessageDigest.isEqual(state.getBytes(US_ASCII), returnedState.getBytes(UTF_8));
        }
    }

    Attempt begin(String staff, String address, GmailProfile.Client client, String redirect, long generation) {
        return new Attempt(random(), random(), Instant.now().plusSeconds(600), staff, address, client, redirect, generation);
    }

    String authorize(Attempt a) {
        byte[] hash;
        try { hash = MessageDigest.getInstance("SHA-256").digest(a.verifier().getBytes(US_ASCII)); }
        catch (NoSuchAlgorithmException ex) { throw new IllegalStateException(ex); }
        var params = Map.of("client_id", a.client().id(), "redirect_uri", a.redirect(), "response_type", "code",
                "scope", "openid email " + SEND_SCOPE, "access_type", "offline", "prompt", "select_account consent",
                "login_hint", a.address(), "state", a.state(), "code_challenge_method", "S256", "code_challenge", base64(hash));
        return "https://accounts.google.com/o/oauth2/v2/auth?" + params.entrySet().stream()
                .map(e -> e.getKey() + "=" + URLEncoder.encode(e.getValue(), UTF_8)).collect(Collectors.joining("&"));
    }

    String exchange(Attempt a, String code, GmailProfile profile) {
        var form = new LinkedMultiValueMap<String, String>();
        form.setAll(Map.of("grant_type", "authorization_code", "code", code, "client_id", a.client().id(),
                "client_secret", a.client().secret(), "code_verifier", a.verifier(), "redirect_uri", a.redirect()));
        JsonNode token = http.post().uri("https://oauth2.googleapis.com/token")
                .contentType(MediaType.APPLICATION_FORM_URLENCODED).body(form).retrieve().body(JsonNode.class);
        if (token == null || token.path("access_token").asString("").isBlank()) return "failed";
        String refresh = token.path("refresh_token").asString("");
        if (refresh.isBlank() || !Arrays.asList(token.path("scope").asString("").split(" ")).contains(SEND_SCOPE))
            return "permission";
        JsonNode identity = http.get().uri("https://openidconnect.googleapis.com/v1/userinfo")
                .headers(h -> h.setBearerAuth(token.path("access_token").asString())).retrieve().body(JsonNode.class);
        if (identity == null || !identity.path("email_verified").isBoolean() || !identity.path("email_verified").asBoolean()
                || identity.path("email").asString("").isBlank()) return "account";
        profile.saveOAuth(a.staff(), a.generation(), GmailProfile.address(identity.path("email").asString()), a.client(), refresh);
        return "connected";
    }

    void revoke(String refreshToken) {
        var form = new LinkedMultiValueMap<String, String>();
        form.add("token", refreshToken);
        try {
            boolean revoked = http.post().uri("https://oauth2.googleapis.com/revoke")
                    .contentType(MediaType.APPLICATION_FORM_URLENCODED).body(form).exchange((request, response) -> {
                        int status = response.getStatusCode().value();
                        if (status == 200) return true;
                        if (status != 400) return false;
                        JsonNode detail = response.bodyTo(JsonNode.class);
                        return detail != null && "invalid_token".equals(detail.path("error").asString(""));
                    });
            if (!revoked) throw ApiErrors.error(502, "Google에서 연결 해제를 확인하지 못했습니다. 다시 시도하세요.");
        } catch (RestClientException ex) {
            throw ApiErrors.error(503, "Google에 연결하지 못했습니다. 잠시 후 연결 해제를 다시 시도하세요.");
        }
    }

    private static String random() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return base64(bytes);
    }

    private static String base64(byte[] bytes) { return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes); }
}
