package kr.swax.intake;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

import org.springframework.web.multipart.MultipartFile;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;

record IntakeUpload(String fingerprint, List<Entry> entries) {
    record Selected(String name, Long size) {}
    record Entry(MultipartFile part, String name, int size, String sha256) {}
    static final int MIB = 1024 * 1024;

    static IntakeUpload read(UUID event, UUID target, String key, String manifest, List<MultipartFile> files,
                             ObjectMapper mapper) throws IOException {
        if (key == null || !key.matches("[A-Za-z0-9_-]{8,100}")) {
            throw ApiErrors.error(422, "유효한 접수 요청 키가 필요합니다.");
        }
        Selected[] selected;
        try {
            selected = mapper.readValue(manifest, Selected[].class);
        } catch (JacksonException ex) {
            throw ApiErrors.error(422, "선택한 파일 목록을 읽을 수 없습니다.");
        }
        if (selected == null || files == null || files.isEmpty() || files.size() > 100 || selected.length != files.size()) {
            throw ApiErrors.error(422, "선택 목록과 전송 파일 수를 확인해 주세요. 한 번에 최대 100개입니다.");
        }
        MessageDigest batch = sha256();
        field(batch, event.toString());
        field(batch, target == null ? "" : target.toString());
        List<Entry> entries = new ArrayList<>();
        long total = 0;
        for (int i = 0; i < files.size(); i++) {
            MultipartFile part = files.get(i);
            String name = part.getOriginalFilename();
            Selected expected = selected[i];
            if (name == null || name.length() > 255 || name.contains("/") || name.contains("\\")
                    || name.chars().anyMatch(Character::isISOControl) || expected == null
                    || !name.equals(expected.name()) || expected.size() == null || expected.size() != part.getSize()) {
                throw ApiErrors.error(422, "선택 목록과 전송한 파일의 이름 또는 크기가 다릅니다.");
            }
            String lower = name.toLowerCase(Locale.ROOT);
            if ((!lower.endsWith(".hwp") && !lower.endsWith(".hwpx")) || name.matches("^00(?:\\D.*|$)")) {
                throw ApiErrors.error(415, "01·02·03 한글 원본(HWP, HWPX)을 선택해 주세요. 00은 출력 양식입니다.");
            }
            total += part.getSize();
            if (part.isEmpty() || part.getSize() > 40L * MIB || total > 300L * MIB) {
                throw ApiErrors.error(413, "빈 파일은 접수할 수 없습니다. 파일당 40 MiB, 전체 300 MiB까지 선택해 주세요.");
            }
            MessageDigest digest = sha256();
            try (var in = new DigestInputStream(part.getInputStream(), digest)) {
                if (in.transferTo(OutputStream.nullOutputStream()) != part.getSize()) {
                    throw ApiErrors.error(422, "전송이 중단됐습니다. 같은 파일 목록을 다시 전송해 주세요.");
                }
            }
            String hash = HexFormat.of().formatHex(digest.digest());
            field(batch, name);
            field(batch, hash);
            entries.add(new Entry(part, name, Math.toIntExact(part.getSize()), hash));
        }
        return new IntakeUpload(HexFormat.of().formatHex(batch.digest()), entries);
    }

    private static void field(MessageDigest digest, String value) {
        digest.update(value.getBytes(StandardCharsets.UTF_8));
        digest.update((byte) 0);
    }

    static MessageDigest sha256() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException ex) { throw new IllegalStateException(ex); }
    }
}
