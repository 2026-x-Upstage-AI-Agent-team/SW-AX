package kr.swax.intake;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;

import org.springframework.core.env.Environment;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

@RestController
class WorkerStatus {
    private static final List<String> WORK = List.of("prepare", "studio", "mail", "report");
    private final WorkflowData data;
    private final Environment env;
    private final boolean remotePrinter;
    private volatile Process worker;
    private volatile Process printer;

    WorkerStatus(WorkflowData data, Environment env) {
        this.data = data;
        this.env = env;
        this.remotePrinter = env.getRequiredProperty("awards.worker.remote-printer", Boolean.class);
    }

    @GetMapping("/api/operations/worker-status")
    ObjectNode status() {
        // Slots 0–3 belong to operations.worker. Slot 4 covers a start request until the programs respond.
        ObjectNode result = data.one("""
            WITH roles(name,slot) AS (VALUES ('prepare',0),('studio',1),('mail',2),('report',3)),
            locks AS (SELECT objid FROM pg_locks WHERE locktype='advisory' AND classid=175703111
                AND objsubid=2 AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())),
            printer AS (SELECT max(updated_at) AS seen FROM workflow_health WHERE role='printer')
            SELECT jsonb_build_object('checked_at',clock_timestamp(),'printer_last_seen',seen,
                'state',CASE WHEN EXISTS(SELECT FROM locks WHERE objid=4) THEN 'starting' ELSE 'stopped' END,'online',ARRAY(
                SELECT roles.name FROM roles JOIN locks ON locks.objid=roles.slot::oid
                UNION ALL SELECT 'printer' WHERE seen >= clock_timestamp()-interval '45 seconds'
            )) FROM printer
            """);
        List<String> online = online(result);
        if (online.containsAll(WORK) && (remotePrinter || online.contains("printer"))) result.put("state", "running");
        return result;
    }

    @PostMapping("/api/operations/worker-start")
    @Transactional
    public ObjectNode start() {
        // Concurrent tabs or API instances share this transaction lock. A crash or rollback releases it.
        boolean owner = Boolean.TRUE.equals(data.db.queryForObject(
                "SELECT pg_try_advisory_xact_lock(175703111,4)", Boolean.class));
        ObjectNode snapshot = status();
        if (!owner || running(snapshot)) return snapshot;
        List<String> online = online(snapshot);
        if (!online.containsAll(WORK)) worker = launch("worker", worker);
        if (!remotePrinter && !online.contains("printer")) printer = launch("printer", printer);

        long deadline = System.nanoTime() + Duration.ofSeconds(15).toNanos();
        do {
            try { Thread.sleep(300); }
            catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw ApiErrors.error(503, "워커 실행 확인이 중단됐습니다. 다시 확인해 주세요.");
            }
            snapshot = status();
            if (running(snapshot)) return snapshot;
            online = online(snapshot);
            if ((!online.containsAll(WORK) && exited(worker)) || (!remotePrinter && !online.contains("printer") && exited(printer)))
                throw ApiErrors.error(503, "워커가 시작 중에 종료됐습니다. 서버의 워커 로그를 확인하세요.");
        } while (System.nanoTime() < deadline);
        throw ApiErrors.error(503, "워커의 연결을 확인하지 못했습니다. 잠시 후 다시 실행해 주세요.");
    }

    private static List<String> online(ObjectNode status) {
        return status.path("online").valueStream().map(JsonNode::asString).toList();
    }

    private static boolean running(ObjectNode status) { return "running".equals(status.path("state").asString()); }
    private static boolean exited(Process process) { return process != null && !process.isAlive(); }

    private Process launch(String module, Process prior) {
        if (prior != null && prior.isAlive()) return prior;
        Path home = Path.of(env.getRequiredProperty("awards.worker.directory")).toAbsolutePath().normalize();
        String python = env.getProperty("awards.worker.python", "");
        Path executable = python.isBlank() ? home.resolve(".venv/Scripts/pythonw.exe") : Path.of(python).toAbsolutePath();
        if (!Files.isRegularFile(executable) || !Files.isRegularFile(home.resolve("operations/" + module + ".py")))
            throw ApiErrors.error(503, "워커 실행 파일을 찾을 수 없습니다. 서버의 워커 설치 경로를 확인하세요.");
        Path dataDir = Path.of(env.getRequiredProperty("awards.gmail.directory")).toAbsolutePath().normalize();
        // The executable and both module names are server-owned. No command or path comes from the request.
        ProcessBuilder builder = new ProcessBuilder(executable.toString(), "-u", "-m", "operations." + module).directory(home.toFile());
        var child = builder.environment();
        child.put("AWARD_DATA_DIR", dataDir.toString());
        child.putIfAbsent("AWARDS_API_URL", "http://127.0.0.1:" + env.getProperty("local.server.port", env.getRequiredProperty("server.port")));
        if ("worker".equals(module)) {
            child.put("AWARDS_DB_URL", env.getRequiredProperty("spring.datasource.url"));
            child.put("AWARDS_DB_USER", env.getRequiredProperty("spring.datasource.username"));
            child.put("AWARDS_DB_PASSWORD", env.getRequiredProperty("spring.datasource.password"));
            child.put("AWARDS_REVIEW_WORKER_TOKEN", env.getRequiredProperty("awards.review.worker-token"));
        } else {
            child.keySet().removeIf(key -> key.startsWith("UPSTAGE_") || key.startsWith("GMAIL_") || key.startsWith("SMTP_")
                    || key.startsWith("AWARDS_DB_") || key.equals("AWARDS_REVIEW_WORKER_TOKEN"));
            child.put("AWARDS_OUTPUT_WORKER_TOKEN", env.getRequiredProperty("awards.output.worker-token"));
        }
        try {
            Path logs = Files.createDirectories(dataDir.resolve("operations"));
            builder.redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.appendTo(logs.resolve(module + ".log").toFile()));
            return builder.start();
        } catch (IOException e) {
            throw ApiErrors.error(503, "서버에서 워커를 실행할 수 없습니다. 설치와 실행 권한을 확인하세요.");
        }
    }
}
