package kr.swax.intake;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

@Configuration(proxyBeanMethods=false)
class PcAgentAccess {
    @Bean @Order(0)
    SecurityFilterChain pcAgentApi(HttpSecurity http) throws Exception {
        // Every controller operation validates a single-use pairing code or a per-device bearer.
        return http.securityMatcher("/api/pc-agent/**")
            .sessionManagement(s->s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .csrf(csrf->csrf.disable()).requestCache(cache->cache.disable())
            .authorizeHttpRequests(auth->auth.anyRequest().permitAll()).build();
    }
}
