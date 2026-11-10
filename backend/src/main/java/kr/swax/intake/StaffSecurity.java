package kr.swax.intake;

import jakarta.servlet.http.HttpServletResponse;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.HttpStatusEntryPoint;
import org.springframework.security.web.authentication.LoginUrlAuthenticationEntryPoint;
import org.springframework.security.web.servlet.util.matcher.PathPatternRequestMatcher;
import org.springframework.security.web.util.matcher.AndRequestMatcher;
import org.springframework.security.web.util.matcher.NegatedRequestMatcher;
import org.springframework.security.web.util.matcher.OrRequestMatcher;

@Configuration(proxyBeanMethods = false)
class StaffSecurity {
    @Bean
    BCryptPasswordEncoder passwordEncoder() { return new BCryptPasswordEncoder(12); }

    @Bean
    UserDetailsService staffUsers(JdbcTemplate db) {
        return login -> db.query("SELECT login, password_hash FROM staff_account WHERE login = ?",
                (rs, row) -> User.withUsername(rs.getString("login")).password(rs.getString("password_hash"))
                        .roles("STAFF").build(), login).stream().findFirst()
                .orElseThrow(() -> new UsernameNotFoundException("담당자 계정을 찾을 수 없습니다."));
    }

    @Bean
    SecurityFilterChain staffAccess(HttpSecurity http) throws Exception {
        var paths = PathPatternRequestMatcher.withDefaults();
        var api = paths.matcher("/api/**");
        // The output admin and device endpoints have their own session and bearer authentication.
        var staffApi = new AndRequestMatcher(api, new NegatedRequestMatcher(paths.matcher("/api/output/**")));
        var browserLogin = new LoginUrlAuthenticationEntryPoint("/login");
        var unauthorized = new HttpStatusEntryPoint(HttpStatus.UNAUTHORIZED);
        http.securityMatcher(new OrRequestMatcher(staffApi, paths.matcher("/"), paths.matcher("/index.html"),
                        paths.matcher("/login"), paths.matcher("/logout")))
                .authorizeHttpRequests(auth -> auth.requestMatchers("/api/auth/session", "/login", "/logout").permitAll()
                        .requestMatchers(org.springframework.http.HttpMethod.GET, GmailController.CALLBACK).permitAll()
                        .anyRequest().authenticated())
                // Browsers set this forbidden header themselves. Other clients must supply the session CSRF token.
                .csrf(csrf -> csrf.ignoringRequestMatchers(request -> staffApi.matches(request)
                        && "same-origin".equals(request.getHeader("Sec-Fetch-Site"))))
                .headers(headers -> headers.frameOptions(frame -> frame.sameOrigin()))
                .requestCache(cache -> cache.disable())
                .exceptionHandling(errors -> errors.defaultAuthenticationEntryPointFor(unauthorized, api)
                        .defaultAuthenticationEntryPointFor(browserLogin, new NegatedRequestMatcher(api)))
                .formLogin(form -> form.loginPage("/login").successHandler((req, res, auth) -> {
                    if ("application/json".equals(req.getHeader("Accept"))) res.setStatus(HttpServletResponse.SC_NO_CONTENT);
                    // An explicit fragment also clears a stale workspace hash when JavaScript is disabled.
                    else res.sendRedirect(req.getContextPath() + "/#/");
                }).failureHandler((req, res, ex) -> {
                    if ("application/json".equals(req.getHeader("Accept"))) res.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
                    else res.sendRedirect(req.getContextPath() + "/login?error#/");
                }).permitAll())
                .logout(logout -> logout.deleteCookies("JSESSIONID").logoutSuccessHandler((req, res, auth) -> {
                    if ("application/json".equals(req.getHeader("Accept"))) res.setStatus(HttpServletResponse.SC_NO_CONTENT);
                    else res.sendRedirect(req.getContextPath() + "/login?logout#/");
                }));
        return http.build();
    }
}
