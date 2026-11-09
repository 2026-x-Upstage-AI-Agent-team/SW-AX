package kr.swax.intake;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Base64;
import java.util.Map;
import java.util.stream.Collectors;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.mock.http.client.MockClientHttpRequest;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.json.JsonMapper;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.*;
import static org.springframework.test.web.client.response.MockRestResponseCreators.*;

class GmailControllerTest {
    final String address = "staff+award@example.org";
    final GmailProfile.Client client = new GmailProfile.Client("demo.apps.googleusercontent.com", "test-secret");
    final URI callback = URI.create("http://127.0.0.1:18765/api/settings/gmail/callback");
    final MockHttpSession session = new MockHttpSession();
    GmailProfile profile = mock(GmailProfile.class);
    GmailController app;
    GoogleGmail google;
    MockRestServiceServer upstream;

    @BeforeEach void startApp() {
        var http = RestClient.builder();
        upstream = MockRestServiceServer.bindTo(http).build();
        var account = new GmailProfile.Account(address, "", "");
        when(profile.requireAccount()).thenReturn(account);
        when(profile.client(account)).thenReturn(client);
        google = new GoogleGmail(http.build());
        app = new GmailController(profile, google, callback);
    }

    private Map<String, String> fields(String query) {
        return Arrays.stream(query.split("&")).map(kv -> kv.split("=", 2))
                .collect(Collectors.toMap(kv -> kv[0], kv -> URLDecoder.decode(kv[1], UTF_8)));
    }

    private String finish(MockHttpSession browser, String state, String code, String error) {
        var request = new MockHttpServletRequest();
        request.setSession(browser);
        var response = app.callback(request, () -> "staff", state, code, error);
        assertEquals(303, response.getStatusCode().value());
        return response.getHeaders().getLocation().toString();
    }

    private Map<String, String> start() {
        var url = URI.create(app.start(session, () -> "staff").get("url"));
        assertEquals("https://accounts.google.com/o/oauth2/v2/auth", url.getScheme() + "://" + url.getHost() + url.getPath());
        var q = fields(url.getRawQuery());
        assertEquals(callback.toString(), q.get("redirect_uri"));
        assertEquals(address, q.get("login_hint"));
        assertEquals("S256", q.get("code_challenge_method"));
        assertFalse(url.toString().contains(client.secret()));
        return q;
    }

    @Test void verifiedConsentUsesOriginalCallbackAndPkceThenReturnsToGmailOnlyOnce() {
        var q = start();
        upstream.expect(requestTo("https://oauth2.googleapis.com/token")).andExpect(req -> {
            var body = fields(((MockClientHttpRequest) req).getBodyAsString());
            assertEquals(callback.toString(), body.get("redirect_uri"));
            assertEquals("only-once", body.get("code"));
            assertEquals(client.secret(), body.get("client_secret"));
            try {
                String challenge = Base64.getUrlEncoder().withoutPadding().encodeToString(
                        MessageDigest.getInstance("SHA-256").digest(body.get("code_verifier").getBytes(UTF_8)));
                assertEquals(q.get("code_challenge"), challenge);
            } catch (java.security.NoSuchAlgorithmException ex) { throw new AssertionError(ex); }
        }).andRespond(withSuccess(token(GoogleGmail.SEND_SCOPE), MediaType.APPLICATION_JSON));
        upstream.expect(requestTo("https://openidconnect.googleapis.com/v1/userinfo"))
                .andExpect(header("Authorization", "Bearer test-access")).andRespond(withSuccess(
                        "{\"email_verified\":true,\"email\":\"" + address + "\"}", MediaType.APPLICATION_JSON));
        assertEquals("/#/gmail?result=connected", finish(session, q.get("state"), "only-once", null));
        assertEquals("/#/gmail?result=expired", finish(session, q.get("state"), "replay", null));
        verify(profile).saveOAuth(0L, address, client, "test-refresh");
        upstream.verify();
    }

    private String token(String scope) {
        return "{\"access_token\":\"test-access\",\"refresh_token\":\"test-refresh\",\"scope\":\"" + scope + "\"}";
    }

    @Test void cancellationDoesNotChangeAccountAndOtherSessionsCannotConsumeAnAttempt() {
        String state = start().get("state");
        assertEquals("/#/gmail?result=expired", finish(new MockHttpSession(), state, "code", null));
        assertEquals("/#/gmail?result=expired", finish(session, "foreign-state", "code", null));
        assertEquals("/#/gmail?result=cancelled", finish(session, state, null, "access_denied"));
        assertEquals("/#/gmail?result=expired", finish(session, state, "code", null));
        verify(profile, never()).saveOAuth(anyLong(), anyString(), any(), anyString());
        upstream.verify();
    }

    @ParameterizedTest @ValueSource(strings = {"account", "permission", "failed"})
    void rejectedGrantPreservesExistingAccount(String reason) {
        var state = start().get("state");
        upstream.expect(requestTo("https://oauth2.googleapis.com/token")).andRespond(reason.equals("failed") ? withBadRequest() :
                withSuccess(token(reason.equals("permission") ? "openid" : GoogleGmail.SEND_SCOPE), MediaType.APPLICATION_JSON));
        if (reason.equals("account")) upstream.expect(requestTo("https://openidconnect.googleapis.com/v1/userinfo"))
                .andRespond(withSuccess("{\"email_verified\":true,\"email\":\"other@example.org\"}", MediaType.APPLICATION_JSON));
        assertEquals("/#/gmail?result=" + reason, finish(session, state, "code", null));
        verify(profile, never()).saveOAuth(anyLong(), anyString(), any(), anyString());
        upstream.verify();
    }

    @Test @EnabledOnOs(OS.WINDOWS)
    void credentialsCanBeReopenedFromTheWorkersEncryptedProfile(@TempDir Path dir) throws Exception {
        var json = JsonMapper.builder().build();
        var first = new GmailProfile(json, dir, address, "");
        first.savePassword(address, "test-app-password");
        first.saveOAuth(first.generation(), address, client, "test-refresh");
        var reopened = new GmailProfile(json, dir, "", "");
        assertEquals(address, reopened.current().address());
        assertEquals(client, reopened.client(reopened.requireAccount()));
        assertTrue(reopened.current().credential().isEmpty());
        var disk = Files.readString(dir.resolve("gmail.json"));
        assertFalse(disk.contains("test-secret") || disk.contains("test-refresh"));
        var encrypted = json.readTree(disk).get("oauth").asString();
        var stored = json.readTree(com.sun.jna.platform.win32.Crypt32Util.cryptUnprotectData(Base64.getDecoder().decode(encrypted)));
        assertEquals("test-refresh", stored.get("refresh_token").asString());
    }

    @ParameterizedTest @ValueSource(booleans = {false, true}) @EnabledOnOs(OS.WINDOWS)
    void disconnectRevokesOnceAndCanReconnectAfterRestart(boolean alreadyRevoked, @TempDir Path dir) throws Exception {
        var json = JsonMapper.builder().build();
        profile = new GmailProfile(json, dir, address, "");
        profile.saveOAuth(profile.generation(), address, client, "test-refresh");
        app = new GmailController(profile, google, callback);
        String previousState = start().get("state");
        upstream.expect(requestTo("https://oauth2.googleapis.com/revoke")).andExpect(method(HttpMethod.POST))
                .andExpect(req -> assertEquals(Map.of("token", "test-refresh"), fields(((MockClientHttpRequest) req).getBodyAsString())))
                .andRespond(alreadyRevoked ? withBadRequest().body("{\"error\":\"invalid_token\"}").contentType(MediaType.APPLICATION_JSON) : withSuccess());

        var state = app.disconnect(new MockHttpSession());
        assertFalse(state.gmailOauthConnected());
        assertFalse(state.mailReady());
        assertEquals(address, state.gmailAccount());
        assertEquals("/#/gmail?result=expired", finish(session, previousState, "stale-code", null));
        assertEquals(state, app.disconnect(session));
        var workerProfile = json.readTree(Files.readAllBytes(dir.resolve("gmail.json")));
        assertEquals("", workerProfile.get("oauth").asString());
        assertEquals("", workerProfile.get("credential").asString());
        var appBytes = Files.readAllBytes(dir.resolve("gmail-oauth-client.dpapi"));
        var registration = json.readTree(com.sun.jna.platform.win32.Crypt32Util.cryptUnprotectData(appBytes));
        assertEquals(2, registration.size());
        assertFalse(registration.has("refresh_token"));
        var reopened = new GmailProfile(json, dir, "", "");
        app = new GmailController(reopened, google, callback);
        assertEquals(client.id(), start().get("client_id"));
        upstream.verify();
    }

    @Test @EnabledOnOs(OS.WINDOWS)
    void failedRevocationCanBeRetriedAndAnAppPasswordIsNeverRevoked(@TempDir Path dir) {
        profile = new GmailProfile(JsonMapper.builder().build(), dir, address, "");
        profile.saveOAuth(profile.generation(), address, client, "test-refresh");
        app = new GmailController(profile, google, callback);
        var before = profile.current();
        upstream.expect(requestTo("https://oauth2.googleapis.com/revoke")).andRespond(withStatus(HttpStatus.SERVICE_UNAVAILABLE));
        assertThrows(org.springframework.web.server.ResponseStatusException.class, () -> app.disconnect(session));
        assertEquals(before, profile.current());
        assertTrue(app.status().gmailOauthConnected());
        profile.savePassword(address, "test-password");
        var passwordState = profile.current();
        assertTrue(app.disconnect(session).mailReady());
        assertEquals(passwordState, profile.current());
        upstream.verify();
    }
}
