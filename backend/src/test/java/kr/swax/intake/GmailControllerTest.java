package kr.swax.intake;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;
import org.springframework.http.MediaType;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.mock.http.client.MockClientHttpRequest;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;
import org.springframework.web.server.ResponseStatusException;
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
        when(profile.current("staff")).thenReturn(new GmailProfile.Account(address, "", "", 7));
        when(profile.client()).thenReturn(client);
        google = new GoogleGmail(http.build());
        app = new GmailController(profile, google, callback);
    }

    private Map<String, String> fields(String query) {
        return Arrays.stream(query.split("&")).map(kv -> kv.split("=", 2))
                .collect(Collectors.toMap(kv -> kv[0], kv -> URLDecoder.decode(kv[1], UTF_8)));
    }

    private String finish(MockHttpSession browser, String staff, String state, String code, String error) {
        var request = new MockHttpServletRequest();
        request.setSession(browser);
        var response = app.callback(request, () -> staff, state, code, error);
        assertEquals(303, response.getStatusCode().value());
        return response.getHeaders().getLocation().toString();
    }

    private Map<String, String> start() {
        var url = URI.create(app.start(session, () -> "staff").get("url"));
        assertEquals("https://accounts.google.com/o/oauth2/v2/auth", url.getScheme() + "://" + url.getHost() + url.getPath());
        var q = fields(url.getRawQuery());
        assertEquals(callback.toString(), q.get("redirect_uri"));
        assertEquals("select_account consent", q.get("prompt"));
        assertEquals("S256", q.get("code_challenge_method"));
        assertFalse(url.toString().contains(client.secret()));
        return q;
    }

    @ParameterizedTest @ValueSource(booleans = {false, true})
    void verifiedSelectedAccountCanBeConnectedOrChangedWithPkceOnlyOnce(boolean firstConnection) {
        long generation = firstConnection ? 0 : 7;
        if (firstConnection) when(profile.current("staff")).thenReturn(new GmailProfile.Account("", "", "", 0));
        var q = start();
        assertEquals(firstConnection ? "" : address, q.get("login_hint"));
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
                        "{\"email_verified\":true,\"email\":\"new@example.org\"}", MediaType.APPLICATION_JSON));
        assertEquals("/#/gmail?result=connected", finish(session, "staff", q.get("state"), "only-once", null));
        assertEquals("/#/gmail?result=expired", finish(session, "staff", q.get("state"), "replay", null));
        verify(profile).saveOAuth("staff", generation, "new@example.org", client, "test-refresh");
        upstream.verify();
    }

    private String token(String scope) {
        return "{\"access_token\":\"test-access\",\"refresh_token\":\"test-refresh\",\"scope\":\"" + scope + "\"}";
    }

    @Test void cancellationAndOtherLoginsOrSessionsCannotChangeTheExistingAccount() {
        String state = start().get("state");
        assertEquals("/#/gmail?result=expired", finish(new MockHttpSession(), "staff", state, "code", null));
        assertEquals("/#/gmail?result=expired", finish(session, "other-staff", state, "code", null));
        assertEquals("/#/gmail?result=expired", finish(session, "staff", "foreign-state", "code", null));
        assertEquals("/#/gmail?result=cancelled", finish(session, "staff", state, null, "access_denied"));
        verify(profile, never()).saveOAuth(anyString(), anyLong(), anyString(), any(), anyString());
        upstream.verify();
    }

    @Test void changedConnectionGenerationRejectsAnOlderCallback() {
        String state = start().get("state");
        when(profile.current("staff")).thenReturn(new GmailProfile.Account(address, "", "", 8));
        assertEquals("/#/gmail?result=expired", finish(session, "staff", state, "stale-code", null));
        verify(profile, never()).saveOAuth(anyString(), anyLong(), anyString(), any(), anyString());
        upstream.verify();
    }

    @ParameterizedTest @ValueSource(strings = {"account", "permission", "failed"})
    void rejectedGrantPreservesExistingAccount(String reason) {
        var state = start().get("state");
        upstream.expect(requestTo("https://oauth2.googleapis.com/token")).andRespond(reason.equals("failed") ? withBadRequest() :
                withSuccess(token(reason.equals("permission") ? "openid" : GoogleGmail.SEND_SCOPE), MediaType.APPLICATION_JSON));
        if (reason.equals("account")) upstream.expect(requestTo("https://openidconnect.googleapis.com/v1/userinfo"))
                .andRespond(withSuccess("{\"email_verified\":false,\"email\":\"new@example.org\"}", MediaType.APPLICATION_JSON));
        assertEquals("/#/gmail?result=" + reason, finish(session, "staff", state, "code", null));
        verify(profile, never()).saveOAuth(anyString(), anyLong(), anyString(), any(), anyString());
        upstream.verify();
    }

    @Test void statusAndDisconnectUseOnlyTheLoggedInStaffAccount() {
        when(profile.current("other")).thenReturn(new GmailProfile.Account("other@example.org", "", "encrypted-other", 3));
        assertEquals(address, app.status(() -> "staff").gmailAccount());
        assertFalse(app.status(() -> "staff").mailReady());
        assertEquals("other@example.org", app.status(() -> "other").gmailAccount());
        assertTrue(app.status(() -> "other").mailReady());
        app.disconnect(session, () -> "staff");
        verify(profile).disconnect(eq("staff"), any());
        verify(profile, never()).disconnect(eq("other"), any());
    }

    @ParameterizedTest @ValueSource(strings = {"", "a@example.org,b@example.org", "Name <a@example.org>", "a\r\n@example.org"})
    void invalidSenderIsRejectedBeforeSmtpAuthentication(String address) {
        assertEquals(422, assertThrows(ResponseStatusException.class,
                () -> app.connect(() -> "staff", new GmailController.Password(address, "abcdefghijklmnop"))).getStatusCode().value());
        verify(profile, never()).savePassword(anyString(), anyLong(), anyString(), anyString());
    }

    @Test @EnabledOnOs(OS.WINDOWS)
    void tokenIsEncryptedAndSavedWithItsOwnerAndExpectedVersion(@TempDir Path dir) {
        var db = mock(JdbcTemplate.class);
        when(db.update(anyString(), any(Object[].class))).thenReturn(1);
        var storage = new GmailProfile(JsonMapper.builder().build(), db, dir, "");
        storage.saveOAuth("staff", 7, address, client, "test-refresh");
        var args = ArgumentCaptor.forClass(Object[].class);
        verify(db).update(contains("WHERE login=? AND generation=?"), args.capture());
        Object[] values = args.getValue();
        assertEquals(address, values[0]);
        assertEquals("staff", values[3]);
        assertEquals(7L, values[4]);
        String encrypted = (String)values[2];
        assertFalse(encrypted.contains("test-refresh") || encrypted.contains("test-secret"));
        var decrypted = JsonMapper.builder().build().readTree(
                com.sun.jna.platform.win32.Crypt32Util.cryptUnprotectData(Base64.getDecoder().decode(encrypted)));
        assertEquals("test-refresh", decrypted.path("refresh_token").asString());
    }

    @Test @EnabledOnOs(OS.WINDOWS)
    void staleWritesCannotOverwriteAnotherConnection(@TempDir Path dir) {
        var storage = new GmailProfile(JsonMapper.builder().build(), mock(JdbcTemplate.class), dir, "");
        assertEquals(409, assertThrows(ResponseStatusException.class,
                () -> storage.savePassword("staff", 7, address, "abcdefghijklmnop")).getStatusCode().value());
    }

    @Test @EnabledOnOs(OS.WINDOWS)
    @SuppressWarnings("unchecked")
    void appPasswordDisconnectClearsOnlyTheOwnerAndNeverCallsGoogle(@TempDir Path dir) {
        var db = mock(JdbcTemplate.class);
        when(db.query(anyString(), any(RowMapper.class), eq("staff")))
                .thenReturn(List.of(new GmailProfile.Account(address, "encrypted", "", 4)));
        when(db.update(anyString(), any(Object[].class))).thenReturn(1);
        var storage = new GmailProfile(JsonMapper.builder().build(), db, dir, "");
        storage.disconnect("staff", token -> fail("App passwords must not call the OAuth revoke API"));
        verify(db).update(anyString(), eq(address), eq(""), eq(""), eq("staff"), eq(4L));
    }

    @Test @EnabledOnOs(OS.WINDOWS)
    @SuppressWarnings("unchecked")
    void failedGoogleRevocationPreservesTheConnectionAndCanBeRetried(@TempDir Path dir) {
        var db = mock(JdbcTemplate.class);
        String grant = Base64.getEncoder().encodeToString(com.sun.jna.platform.win32.Crypt32Util.cryptProtectData(
                "{\"refresh_token\":\"test-refresh\"}".getBytes(UTF_8)));
        when(db.query(anyString(), any(RowMapper.class), eq("staff")))
                .thenReturn(List.of(new GmailProfile.Account(address, "", grant, 4)));
        when(db.update(anyString(), any(Object[].class))).thenReturn(1);
        var storage = new GmailProfile(JsonMapper.builder().build(), db, dir, "");
        upstream.expect(requestTo("https://oauth2.googleapis.com/revoke")).andRespond(withStatus(HttpStatus.SERVICE_UNAVAILABLE));
        assertThrows(ResponseStatusException.class, () -> storage.disconnect("staff", google::revoke));
        verify(db, never()).update(anyString(), any(Object[].class));
        upstream.verify();
        upstream.reset();
        upstream.expect(requestTo("https://oauth2.googleapis.com/revoke")).andExpect(req ->
                assertEquals(Map.of("token", "test-refresh"), fields(((MockClientHttpRequest)req).getBodyAsString())))
                .andRespond(withBadRequest().body("{\"error\":\"invalid_token\"}").contentType(MediaType.APPLICATION_JSON));
        storage.disconnect("staff", google::revoke);
        verify(db).update(anyString(), eq(address), eq(""), eq(""), eq("staff"), eq(4L));
        upstream.verify();
    }
}
