import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.List;
import org.springframework.security.crypto.bcrypt.BCrypt;

/** One-off operator command for the Seoul cloud database; preserves event access. */
class ResetCloudStaff {
    public static void main(String[] args) {
        try {
            reset();
        } catch (Exception failure) {
            String detail = failure instanceof SQLException sql ? "SQLSTATE=" + sql.getSQLState()
                    : failure instanceof IllegalArgumentException ? failure.getMessage() : failure.getClass().getSimpleName();
            System.err.println("Staff reset failed: " + detail);
            System.exit(1);
        }
    }

    private static void reset() throws Exception {
        String expectedHost = required("SWAX_EXPECTED_RDS_HOST");
        String url = required("AWARDS_DB_URL");
        if (!url.startsWith("jdbc:postgresql://")) throw new IllegalArgumentException("Expected a PostgreSQL JDBC URL.");
        URI target = URI.create(url.substring("jdbc:".length()));
        if (!expectedHost.endsWith(".ap-northeast-2.rds.amazonaws.com")
                || !expectedHost.equalsIgnoreCase(target.getHost()) || target.getPort() != 5432
                || !"/swax_intake".equals(target.getPath()) || target.getUserInfo() != null
                || target.getRawQuery() == null
                || !List.of(target.getRawQuery().split("&")).stream().filter(part -> part.startsWith("sslmode="))
                        .toList().equals(List.of("sslmode=verify-full"))) {
            throw new IllegalArgumentException("Expected the specified Seoul RDS database with verify-full TLS.");
        }
        String password = required("SWAX_RESET_PASSWORD");
        if (password.isBlank() || password.getBytes(StandardCharsets.UTF_8).length > 72) {
            throw new IllegalArgumentException("Password must be nonblank and at most 72 UTF-8 bytes.");
        }
        try (var db = DriverManager.getConnection(url, required("AWARDS_DB_USER"), required("AWARDS_DB_PASSWORD"))) {
            db.setAutoCommit(false);
            try {
                try (var query = db.createStatement(); var row = query.executeQuery("SELECT current_database()")) {
                    if (!row.next() || !"swax_intake".equals(row.getString(1))) {
                        throw new IllegalArgumentException("Unexpected database.");
                    }
                }
                try (var save = db.prepareStatement("""
                        INSERT INTO staff_account(login,password_hash) VALUES (?,?)
                        ON CONFLICT(login) DO UPDATE SET password_hash=EXCLUDED.password_hash
                        """);
                     var verify = db.prepareStatement("SELECT password_hash FROM staff_account WHERE login=?")) {
                    for (String login : List.of("staff-a", "staff-b")) {
                        save.setString(1, login);
                        save.setString(2, BCrypt.hashpw(password, BCrypt.gensalt(12)));
                        if (save.executeUpdate() != 1) throw new IllegalStateException("Unexpected update count.");
                        verify.setString(1, login);
                        try (var row = verify.executeQuery()) {
                            if (!row.next() || !BCrypt.checkpw(password, row.getString(1))) {
                                throw new IllegalStateException("Password verification failed.");
                            }
                        }
                    }
                }
                db.commit();
            } catch (Exception failure) {
                db.rollback();
                throw failure;
            }
        }
        System.out.println("Updated staff-a and staff-b. Existing event permissions were preserved.");
    }

    private static String required(String name) {
        String value = System.getenv(name);
        if (value == null || value.isEmpty()) throw new IllegalArgumentException("Missing environment variable: " + name);
        return value;
    }
}
