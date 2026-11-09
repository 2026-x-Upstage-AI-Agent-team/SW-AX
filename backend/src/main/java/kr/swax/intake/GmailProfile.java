package kr.swax.intake;

import java.io.IOException;
import java.nio.file.*;
import java.util.Base64;
import java.util.Map;
import java.util.function.Consumer;

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
    private final Path savedClient;
    private final String sender;
    private final String clientFile;
    private long generation;

    GmailProfile(ObjectMapper json, @Value("${awards.gmail.directory}") Path directory,
                 @Value("${awards.gmail.address}") String sender, @Value("${awards.gmail.client-file}") String clientFile) {
        this.json = json;
        this.file = directory.toAbsolutePath().resolve("gmail.json");
        this.savedClient = file.resolveSibling("gmail-oauth-client.dpapi");
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
                registration = json.readTree(Crypt32Util.cryptUnprotectData(Files.readAllBytes(savedClient)));
            }
        } catch (NoSuchFileException ex) {
            throw error(409, "운영 서버에 Google 웹 클라이언트 JSON 경로(AWARDS_GMAIL_CLIENT_FILE)를 설정하세요.");
        } catch (IOException | JacksonException | com.sun.jna.LastErrorException | IllegalArgumentException ex) {
            throw error(503, "Google 웹 클라이언트 파일과 Gmail을 연결한 Windows 계정을 확인하세요.");
        }
        return parseClient(registration);
    }

    private Client parseClient(JsonNode registration) {
        String id = registration.path("client_id").asString(""), secret = registration.path("client_secret").asString("");
        if (!id.endsWith(".apps.googleusercontent.com") || secret.isBlank())
            throw error(409, "Google Cloud의 웹 애플리케이션용 클라이언트 JSON을 설정하세요.");
        return new Client(id, secret);
    }

    synchronized long generation() { return generation; }

    synchronized void saveOAuth(long expectedGeneration, String address, Client client, String refreshToken) {
        if (generation != expectedGeneration) throw error(409, "Gmail 연결 상태가 바뀌었습니다. 다시 시작하세요.");
        save(address, true, json.writeValueAsBytes(Map.of("client_id", client.id(), "client_secret", client.secret(),
                "refresh_token", refreshToken)));
    }

    synchronized void savePassword(String address, String password) {
        save(address, false, password.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    synchronized void disconnectGoogle(Consumer<String> revoke) {
        Account before = current();
        if (before.oauth().isBlank()) return;
        requireAccount();
        String refresh;
        try {
            JsonNode grant = json.readTree(Crypt32Util.cryptUnprotectData(Base64.getDecoder().decode(before.oauth())));
            refresh = grant.path("refresh_token").asString("");
            if (refresh.isBlank()) throw error(503, "저장된 Google 발송 권한을 읽지 못했습니다.");
            Client client = parseClient(grant);
            // Older profiles keep the OAuth app registration only inside the mail worker's grant.
            byte[] app = json.writeValueAsBytes(Map.of("client_id", client.id(), "client_secret", client.secret()));
            replace(savedClient, Crypt32Util.cryptProtectData(app));
        } catch (IOException | JacksonException | com.sun.jna.LastErrorException | IllegalArgumentException ex) {
            throw error(503, "Google 연결 정보를 읽거나 재연결 설정을 저장하지 못했습니다.");
        }
        revoke.accept(refresh);
        generation++;
        Account now = current();
        if (now.oauth().isBlank()) return; // The mail worker may already have discarded the revoked token.
        if (!now.equals(before)) throw error(409, "발신 계정이 변경되었습니다. 새 연결 상태를 확인하세요.");
        writeAccount(before.address(), "", "");
    }

    private void save(String address, boolean oauth, byte[] secret) {
        if (!address.equalsIgnoreCase(requireAccount().address)) throw error(409, "담당자 발신 주소가 변경되었습니다. 다시 연결하세요.");
        try {
            String encrypted = Base64.getEncoder().encodeToString(Crypt32Util.cryptProtectData(secret));
            writeAccount(address, oauth ? "" : encrypted, oauth ? encrypted : "");
            generation++;
        } catch (com.sun.jna.LastErrorException ex) {
            throw error(503, "Gmail 인증 정보를 저장하지 못했습니다. 데이터 폴더와 Windows 계정을 확인하세요.");
        }
    }

    private void writeAccount(String address, String credential, String oauth) {
        try {
            replace(file, json.writeValueAsBytes(Map.of("address", address, "credential", credential, "oauth", oauth)));
        } catch (IOException ex) {
            throw error(503, "Gmail 인증 정보를 저장하지 못했습니다. 데이터 폴더를 확인하세요.");
        }
    }

    private void replace(Path target, byte[] bytes) throws IOException {
        Files.createDirectories(target.getParent());
        Path temp = Files.createTempFile(target.getParent(), "gmail-", ".tmp");
        try {
            Files.write(temp, bytes);
            Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally {
            Files.deleteIfExists(temp);
        }
    }
}
