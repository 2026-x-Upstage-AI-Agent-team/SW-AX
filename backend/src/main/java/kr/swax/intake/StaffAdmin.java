package kr.swax.intake;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.io.support.ResourcePropertySource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

/** Local operator command. It uses database credentials and is never exposed over HTTP. */
public final class StaffAdmin {
    public static void main(String[] args) throws Exception {
        var env = new StandardEnvironment();
        env.getPropertySources().addLast(new ResourcePropertySource("classpath:application.properties"));
        var db = new JdbcTemplate(new DriverManagerDataSource(env.getRequiredProperty("spring.datasource.url"),
                env.getRequiredProperty("spring.datasource.username"), env.getRequiredProperty("spring.datasource.password")));
        if (args.length == 1 && args[0].equals("events")) {
            db.query("""
                    SELECT e.id, e.name, coalesce(string_agg(a.login, ', ' ORDER BY a.login), '-') AS members
                    FROM award_event e LEFT JOIN event_staff a ON a.event_id = e.id
                    GROUP BY e.id ORDER BY e.created_at, e.id
                    """, rs -> { System.out.printf("%s\t%s\t%s%n", rs.getString(1), rs.getString(2), rs.getString(3)); });
            return;
        }
        if (args.length < 2 || !args[1].matches("[a-z0-9][a-z0-9._-]{0,63}")) {
            throw new IllegalArgumentException("담당자 ID는 1~64자의 영문 소문자·숫자·점·밑줄·붙임표를 사용하세요.");
        }
        String login = args[1];
        if (args.length == 2 && args[0].equals("create")) {
            String password = System.console() == null
                    ? new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8)).readLine()
                    : new String(System.console().readPassword("Password: "));
            if (password == null || password.isBlank() || password.length() < 12
                    || password.getBytes(StandardCharsets.UTF_8).length > 72) {
                throw new IllegalArgumentException("비밀번호는 12자 이상, UTF-8 72바이트 이하로 입력하세요.");
            }
            int inserted = db.update("INSERT INTO staff_account(login, password_hash) VALUES (?, ?) ON CONFLICT DO NOTHING",
                    login, new BCryptPasswordEncoder(12).encode(password));
            if (inserted == 0) throw new IllegalArgumentException("이미 등록된 담당자 ID입니다.");
            System.out.println("담당자 계정을 등록했습니다.");
            return;
        }
        if (args.length != 3) throw new IllegalArgumentException("사용법: create ID | events | grant/revoke ID EVENT_UUID");
        UUID event = UUID.fromString(args[2]);
        switch (args[0]) {
            case "grant" -> {
                db.update("INSERT INTO event_staff(event_id, login) VALUES (?, ?) ON CONFLICT DO NOTHING", event, login);
                System.out.println("대회 접근권을 부여했습니다.");
            }
            case "revoke" -> {
                db.update("DELETE FROM event_staff WHERE event_id = ? AND login = ?", event, login);
                System.out.println("이 담당자의 해당 대회 접근권이 해제된 상태입니다.");
            }
            default -> throw new IllegalArgumentException("알 수 없는 관리 명령입니다.");
        }
    }
}
