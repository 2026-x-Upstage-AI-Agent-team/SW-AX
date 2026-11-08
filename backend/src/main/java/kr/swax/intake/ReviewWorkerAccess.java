package kr.swax.intake;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.security.authorization.AuthorizationDecision;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.HttpStatusEntryPoint;

@Configuration(proxyBeanMethods = false)
class ReviewWorkerAccess {
    @Bean
    @Order(1)
    SecurityFilterChain reviewWorkerApi(HttpSecurity http, @Value("${awards.review.worker-token}") String token) throws Exception {
        return bearer(http, ReviewWorkerController.PATH, token);
    }

    @Bean
    @Order(2)
    SecurityFilterChain outputWorkerApi(HttpSecurity http, @Value("${awards.output.worker-token}") String token) throws Exception {
        return bearer(http, OutputJobs.PATH, token);
    }

    private SecurityFilterChain bearer(HttpSecurity http, String path, String token) throws Exception {
        byte[] expected = token.getBytes(StandardCharsets.UTF_8);
        http.securityMatcher(path + "/**")
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(csrf -> csrf.disable())
                .requestCache(cache -> cache.disable())
                .authorizeHttpRequests(auth -> auth.anyRequest().access((ignored, context) -> {
                    String header = context.getRequest().getHeader(HttpHeaders.AUTHORIZATION);
                    boolean allowed = !token.isBlank() && header != null && header.regionMatches(true, 0, "Bearer ", 0, 7)
                            && MessageDigest.isEqual(expected, header.substring(7).getBytes(StandardCharsets.UTF_8));
                    return new AuthorizationDecision(allowed);
                }))
                .exceptionHandling(errors -> errors.authenticationEntryPoint(new HttpStatusEntryPoint(HttpStatus.UNAUTHORIZED)));
        return http.build();
    }
}
