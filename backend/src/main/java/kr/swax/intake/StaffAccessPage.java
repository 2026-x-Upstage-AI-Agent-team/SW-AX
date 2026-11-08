package kr.swax.intake;

import java.util.Map;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;

@Controller
class StaffAccessPage {
    @GetMapping("/login")
    String login(@RequestParam Map<String, String> params, Model model) {
        boolean loginError = params.containsKey("error");
        model.addAttribute("loginError", loginError);
        model.addAttribute("loggedOut", !loginError && params.containsKey("logout"));
        return "staff-access";
    }

    @GetMapping("/logout")
    String logout(Model model) {
        model.addAttribute("confirmLogout", true);
        return "staff-access";
    }
}
