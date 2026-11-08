package kr.swax.intake;

import java.io.IOException;
import java.nio.file.*;
import java.util.Base64;
import java.util.Map;

import com.sun.jna.Platform;
import com.sun.jna.platform.win32.Crypt32Util;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import static kr.swax.intake.ApiErrors.error;

/** Read and replace the same per-Windows-user DPAPI profile used by service/mailing.py. */
@Component
class GmailProfile {
    record Account(String address, String credential, String oauth) {}
    record Client(String id, String secret) {}

    private final ObjectMapper json;
    private final Path file;
    private final String sender;
    private final String clientFile;

    GmailProfile(ObjectMapper json, @Value("${awards.gmail.directory}") Path directory,
                 @Value("${awards.gmail.address}") String sender, @Value("${awards.gmail.client-file}") String clientFile) {
        this.json = json;
        this.file = directory.toAbsolutePath().resolve("gmail.json");
        this.sender = sender.strip();
        this.clientFile = clientFile;
    }

    Account current() {
        try {
            JsonNode stored = json.readTree(Files.readAllBytes(file));
            String address = stored.path("address").asString("");
            if (address.isBlank()) throw error(503, "저장된 Gmail 발신 주소를 확인하세요.");
            if (!sender.isEmpty() && !sender.equalsIgnoreCase(address)) return new Account(sender, "", "");
            return new Account(address, stored.path("credential").asString(""), stored.path("oauth").asString(""));
        } catch (NoSuchFileException ex) {
            return new Account(sender, "", "");
        } catch (IOException | JacksonException ex) {
            throw error(503, "Gmail 발신 계정 설정을 읽지 못했습니다.");
        }
    }

    Account requireAccount() {
        Account account = current();
        if (account.address.isBlank()) throw error(409, "운영 서버에 담당자 발신 주소(GMAIL_ADDRESS)를 설정하세요.");
        if (!Platform.isWindows()) throw error(503, "기존 Gmail 자격 증명을 보호하는 Windows 계정에서 서비스를 실행하세요.");
        return account;
    }

    Client client(Account account) {
        JsonNode registration;
        try {
            if (!clientFile.isBlank()) {
                registration = json.readTree(Files.readAllBytes(Path.of(clientFile))).path("web");
            } else if (!account.oauth.isBlank()) {
                registration = json.readTree(Crypt32Util.cryptUnprotectData(Base64.getDecoder().decode(account.oauth)));
            } else {
                throw error(409, "운영 서버에 Google 웹 클라이언트 JSON 경로(AWARDS_GMAIL_CLIENT_FILE)를 설정하세요.");
            }
        } catch (IOException | JacksonException | com.sun.jna.LastErrorException | IllegalArgumentException ex) {
            throw error(503, "Google 웹 클라이언트 파일과 Gmail을 연결한 Windows 계정을 확인하세요.");
        }
        String id = registration.path("client_id").asString(""), secret = registration.path("client_secret").asString("");
        if (!id.endsWith(".apps.googleusercontent.com") || secret.isBlank())
            throw error(409, "Google Cloud의 웹 애플리케이션용 클라이언트 JSON을 설정하세요.");
        return new Client(id, secret);
    }

    void saveOAuth(String address, Client client, String refreshToken) {
        save(address, true, json.writeValueAsBytes(Map.of("client_id", client.id(), "client_secret", client.secret(),
                "refresh_token", refreshToken)));
    }

    void savePassword(String address, String password) {
        save(address, false, password.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private void save(String address, boolean oauth, byte[] secret) {
        if (!address.equalsIgnoreCase(requireAccount().address)) throw error(409, "담당자 발신 주소가 변경되었습니다. 다시 연결하세요.");
        try {
            String encrypted = Base64.getEncoder().encodeToString(Crypt32Util.cryptProtectData(secret));
            Files.createDirectories(file.getParent());
            Path temp = Files.createTempFile(file.getParent(), "gmail-", ".tmp");
            try {
                Files.write(temp, json.writeValueAsBytes(Map.of("address", address,
                        "credential", oauth ? "" : encrypted, "oauth", oauth ? encrypted : "")));
                Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } finally {
                Files.deleteIfExists(temp);
            }
        } catch (IOException | com.sun.jna.LastErrorException ex) {
            throw error(503, "Gmail 인증 정보를 저장하지 못했습니다. 데이터 폴더와 Windows 계정을 확인하세요.");
        }
    }
}
