package kr.swax.intake;

import java.io.IOException;
import java.nio.file.*;
import java.util.Base64;
import java.util.Map;
import java.util.function.Consumer;

import jakarta.mail.internet.AddressException;
import jakarta.mail.internet.InternetAddress;

import com.sun.jna.Platform;
import com.sun.jna.platform.win32.Crypt32Util;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import static kr.swax.intake.ApiErrors.error;

/** Credentials belong to the authenticated staff login; secrets remain Windows DPAPI encrypted. */
@Component
class GmailProfile {
    record Account(String address, String credential, String oauth, long generation) {
        boolean ready() { return !oauth.isBlank() || !credential.isBlank(); }
    }
    record Client(String id, String secret) {}

    private final ObjectMapper json;
    private final JdbcTemplate db;
    private final Path savedClient;
    private final String clientFile;

    GmailProfile(ObjectMapper json, JdbcTemplate db, @Value("${awards.gmail.directory}") Path directory,
                 @Value("${awards.gmail.client-file}") String clientFile) {
        this.json = json;
        this.db = db;
        this.savedClient = directory.toAbsolutePath().resolve("gmail-oauth-client.dpapi");
        this.clientFile = clientFile;
    }

    Account current(String staff) {
        return db.query("SELECT address,credential,oauth,generation FROM staff_gmail WHERE login=?",
                (rs, row) -> new Account(rs.getString("address"), rs.getString("credential"), rs.getString("oauth"),
                        rs.getLong("generation")), staff).stream().findFirst().orElse(new Account("", "", "", 0));
    }

    static String address(String value) {
        String address = value == null ? "" : value.strip().toLowerCase(java.util.Locale.ROOT);
        try {
            InternetAddress[] parsed = InternetAddress.parse(address, true);
            if (address.length() > 254 || parsed.length != 1 || !address.equals(parsed[0].getAddress())
                    || !address.contains("@") || address.chars().anyMatch(Character::isISOControl)) throw new AddressException();
            parsed[0].validate();
            return address;
        } catch (AddressException ex) {
            throw error(422, "연결할 Google 계정의 이메일 주소 한 개를 입력하세요.");
        }
    }

    Client client() {
        JsonNode registration;
        try {
            registration = !clientFile.isBlank()
                    ? json.readTree(Files.readAllBytes(Path.of(clientFile))).path("web")
                    : json.readTree(Crypt32Util.cryptUnprotectData(Files.readAllBytes(savedClient)));
        } catch (NoSuchFileException ex) {
            throw error(409, "운영 서버에 Google 웹 클라이언트 설정이 필요합니다. 관리자에게 문의하세요.");
        } catch (IOException | JacksonException | com.sun.jna.LastErrorException | IllegalArgumentException ex) {
            throw error(503, "Google 웹 클라이언트 설정을 읽지 못했습니다. 관리자에게 문의하세요.");
        }
        String id = registration.path("client_id").asString(""), secret = registration.path("client_secret").asString("");
        if (!id.endsWith(".apps.googleusercontent.com") || secret.isBlank())
            throw error(409, "Google Cloud의 웹 애플리케이션용 클라이언트를 설정하세요.");
        return new Client(id, secret);
    }

    void saveOAuth(String staff, long expectedGeneration, String address, Client client, String refreshToken) {
        save(staff, expectedGeneration, address, "", protect(json.writeValueAsBytes(Map.of("client_id", client.id(),
                "client_secret", client.secret(), "refresh_token", refreshToken))));
    }

    void savePassword(String staff, long expectedGeneration, String address, String password) {
        save(staff, expectedGeneration, address, protect(password.getBytes(java.nio.charset.StandardCharsets.UTF_8)), "");
    }

    void disconnect(String staff, Consumer<String> revoke) {
        Account before = current(staff);
        if (!before.ready()) return;
        if (!before.oauth().isBlank()) {
            try {
                JsonNode grant = json.readTree(Crypt32Util.cryptUnprotectData(Base64.getDecoder().decode(before.oauth())));
                String refresh = grant.path("refresh_token").asString("");
                if (refresh.isBlank()) throw error(503, "저장된 Google 발송 권한을 읽지 못했습니다.");
                revoke.accept(refresh);
            } catch (JacksonException | com.sun.jna.LastErrorException | IllegalArgumentException ex) {
                throw error(503, "Google 연결 정보를 읽지 못했습니다. 관리자에게 문의하세요.");
            }
        }
        save(staff, before.generation(), before.address(), "", "");
    }

    private String protect(byte[] secret) {
        if (!Platform.isWindows()) throw error(503, "Gmail 인증 정보는 Windows 발송 서버에서 저장해야 합니다.");
        try {
            return Base64.getEncoder().encodeToString(Crypt32Util.cryptProtectData(secret));
        } catch (com.sun.jna.LastErrorException ex) {
            throw error(503, "Gmail 인증 정보를 암호화하지 못했습니다. 관리자에게 문의하세요.");
        }
    }

    private void save(String staff, long expectedGeneration, String address, String credential, String oauth) {
        int changed = expectedGeneration == 0
                ? db.update("""
                    INSERT INTO staff_gmail(login,address,credential,oauth) VALUES(?,?,?,?)
                    ON CONFLICT(login) DO NOTHING
                    """, staff, address, credential, oauth)
                : db.update("""
                    UPDATE staff_gmail SET address=?,credential=?,oauth=?,generation=generation+1,updated_at=clock_timestamp()
                    WHERE login=? AND generation=?
                    """, address, credential, oauth, staff, expectedGeneration);
        if (changed != 1) throw error(409, "Gmail 연결 상태가 변경되었습니다. 현재 상태를 확인한 뒤 다시 연결하세요.");
    }
}
