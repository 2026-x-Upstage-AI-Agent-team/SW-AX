package kr.swax.intake;

import java.util.Map;

import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.multipart.MultipartException;
import org.springframework.web.server.ResponseStatusException;

@RestControllerAdvice
class ApiErrors {
    static ResponseStatusException error(int status, String message) {
        return new ResponseStatusException(HttpStatusCode.valueOf(status), message);
    }

    @ExceptionHandler(ResponseStatusException.class)
    ResponseEntity<?> rejected(ResponseStatusException ex) {
        return ResponseEntity.status(ex.getStatusCode()).body(Map.of("detail", ex.getReason()));
    }

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    ResponseEntity<?> tooLarge() {
        return ResponseEntity.status(413).body(Map.of("detail", "파일당 40 MiB, 한 번에 300 MiB까지 접수할 수 있습니다."));
    }

    @ExceptionHandler(MultipartException.class)
    ResponseEntity<?> interrupted() {
        return ResponseEntity.badRequest().body(Map.of("detail", "선택한 파일의 전송을 마치지 못했습니다. 다시 전송해 주세요."));
    }
}
