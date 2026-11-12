package kr.swax.intake;

import java.io.IOException;
import java.util.UUID;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import tools.jackson.databind.ObjectMapper;

@RestController
@RequestMapping("/api/pc-agent")
class PcAgentController {
    record Heartbeat(boolean hancomReady,String version) {}
    private final PcDevices devices;
    private final PcTasks tasks;
    private final ObjectMapper json;
    PcAgentController(PcDevices devices,PcTasks tasks,ObjectMapper json) { this.devices=devices;this.tasks=tasks;this.json=json; }

    @PostMapping("/exchange")
    PcDevices.Credential exchange(@RequestBody PcDevices.Exchange request) { return devices.exchange(request); }

    @DeleteMapping("/connection") @ResponseStatus(HttpStatus.NO_CONTENT)
    void disconnect(@RequestHeader(value="Authorization",required=false) String auth) {
        var device=devices.authenticate(auth);devices.revoke(device.login(),device.id());
    }

    @PutMapping("/heartbeat") @ResponseStatus(HttpStatus.NO_CONTENT)
    void heartbeat(@RequestHeader(value="Authorization",required=false) String auth,@RequestBody Heartbeat body) {
        devices.heartbeat(devices.authenticate(auth),body.hancomReady(),body.version());
    }

    @PostMapping("/claim")
    ResponseEntity<PcTasks.Task> claim(@RequestHeader(value="Authorization",required=false) String auth) {
        var task=tasks.claim(devices.authenticate(auth));
        return task==null ? ResponseEntity.noContent().build() : ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(task);
    }

    @GetMapping("/{kind}/{id}/input")
    ResponseEntity<byte[]> input(@RequestHeader(value="Authorization",required=false) String auth,@PathVariable String kind,
                                @PathVariable UUID id,@RequestHeader("X-Claim-Token") UUID token) {
        return tasks.input(devices.authenticate(auth),kind,id,token);
    }

    @PutMapping("/{kind}/{id}/lease") @ResponseStatus(HttpStatus.NO_CONTENT)
    void renew(@RequestHeader(value="Authorization",required=false) String auth,@PathVariable String kind,
               @PathVariable UUID id,@RequestHeader("X-Claim-Token") UUID token) {
        tasks.renew(devices.authenticate(auth),kind,id,token);
    }

    @PutMapping("/file/{id}/metadata") @ResponseStatus(HttpStatus.NO_CONTENT)
    void metadata(@RequestHeader(value="Authorization",required=false) String auth,@PathVariable UUID id,
                  @RequestHeader("X-Claim-Token") UUID token,HttpServletRequest request) throws IOException {
        var device=devices.authenticate(auth);
        byte[] bytes=request.getInputStream().readNBytes(1024*1024+1);
        if (bytes.length>1024*1024) throw ApiErrors.error(413,"판독 결과가 한도를 초과했습니다.");
        tasks.metadata(device,id,token,json.readTree(bytes));
    }

    @PutMapping(value="/{kind}/{id}/pdf",consumes="application/pdf") @ResponseStatus(HttpStatus.NO_CONTENT)
    void complete(@RequestHeader(value="Authorization",required=false) String auth,@PathVariable String kind,
                  @PathVariable UUID id,@RequestHeader("X-Claim-Token") UUID token,
                  @RequestHeader("X-Source-Sha256") String digest,HttpServletRequest request) throws IOException {
        var device=devices.authenticate(auth);
        tasks.complete(device,kind,id,token,digest,OutputJobs.readPdf(request));
    }

    @PutMapping("/{kind}/{id}/failure") @ResponseStatus(HttpStatus.NO_CONTENT)
    void failure(@RequestHeader(value="Authorization",required=false) String auth,@PathVariable String kind,
                 @PathVariable UUID id,@RequestHeader("X-Claim-Token") UUID token) {
        tasks.failure(devices.authenticate(auth),kind,id,token);
    }
}
