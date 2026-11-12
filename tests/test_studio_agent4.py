"""The new Agent's structured verdict and representative-inclusive roster remain intact."""
import copy
import unittest

from service.studio import parse_result
from tests.test_studio_field_transfer import node


def finding(field, problem):
    return {"문서유형": "개인정보동의서", "대상자": "가상학생", "검사항목": field,
            "문제유형": problem, "근거": "Agent가 해당 항목을 확인했습니다."}


def run(branch, verdict, errors=None, warnings=None, *extracts):
    decision = {"최종판정": verdict, "판정근거": "Agent의 원래 판정 근거입니다.",
                "확정오류": errors or [], "확인필요": warnings or []}
    job = {"output": [node("Instruct - "+branch, decision), *extracts]}
    before = copy.deepcopy(job)
    parsed = parse_result(job, [])
    assert job == before
    return parsed, decision


class StudioAgent4(unittest.TestCase):
    def test_each_branch_keeps_the_actual_agent_verdict(self):
        for branch, verdict in (("판정_성공", "성공"), ("판정_담당자확인", "담당자확인"),
                                ("판정_보완필요", "보완필요"), ("판정_서류누락", "담당자확인")):
            with self.subTest(branch=branch):
                parsed, original = run(branch, verdict)
                self.assertEqual(parsed["verdict"], verdict)
                self.assertEqual(parsed["reason"], original["판정근거"])
                self.assertEqual(parsed["agent_decision"], original)
                self.assertEqual(parsed["checks"], [])

    def test_only_the_final_agent_findings_become_errors_and_warnings(self):
        error, warning = finding("제3자 제공 동의", "누락"), finding("참여자 연결", "연결 미확정")
        parsed, original = run("판정_보완필요", "보완필요", [error], [warning])
        self.assertEqual([check["passed"] for check in parsed["checks"]], [False, None])
        self.assertEqual(len(parsed["checks"]), 2)
        self.assertIn("제3자 제공 동의", parsed["checks"][0]["label"])
        self.assertEqual(parsed["agent_decision"], original)

    def test_missing_document_branch_does_not_invent_confirmed_student_errors(self):
        parsed, _ = run("판정_서류누락", "담당자확인", [], [finding("필수 제출 유형", "처리 정책 확인")])
        self.assertEqual(len(parsed["checks"]), 1)
        self.assertIsNone(parsed["checks"][0]["passed"])
        self.assertNotIn("미제출", parsed["checks"][0]["label"])

    def test_participants_include_the_representative_once_and_keep_incomplete_rows(self):
        participants = [{"role": "팀 대표", "name": "가상대표", "student_id": "00000001", "email": "leader@award.test", "affiliation": ""},
                        {"role": "팀원1", "name": "", "student_id": "00000002", "department": "가상학과", "email": "member@award.test"}]
        app = {"team_name": "Agent4 팀", "representative_name": "가상대표", "representative_affiliation": "대체 금지",
               "representative_email": "old-field@award.test", "members": [{"name": "추가 금지"}], "participants": participants}
        parsed, _ = run("판정_성공", "성공", [], [], node("Information Extract - 지급확인서", app))
        self.assertEqual([(m["role"], m["name"], m["student_id"]) for m in parsed["members"]],
                         [("대표", "가상대표", "00000001"), ("팀원", "", "00000002")])
        self.assertEqual(parsed["members"][0]["school"], "")
        self.assertEqual(parsed["representative_emails"], ["leader@award.test"])
        self.assertEqual(parsed["extracted"]["Information Extract - 지급확인서"], [app])

    def test_empty_participants_and_empty_email_are_not_filled_from_legacy_fields(self):
        for participants in ([], [{"name": "가상대표", "email": ""}]):
            app = {"representative_name": "가상대표", "representative_student_id": "00000001",
                   "representative_email": "old-field@award.test", "participants": participants}
            parsed, _ = run("판정_성공", "성공", [], [], node("Information Extract - 지급확인서", app))
            self.assertEqual(len(parsed["members"]), len(participants))
            self.assertEqual(parsed["representative_emails"], [])

    def test_inspection_record_is_preserved_as_the_staff_report(self):
        record = "1. 서류 구성: 세 유형 확인\n2. 참여자 명단: 원문 순서 유지"
        parsed, _ = run("판정_성공", "성공", [], [], node("Instruct - 검사기록", record))
        self.assertEqual(parsed["staff_report"], record)

    def test_ambiguous_or_absent_final_nodes_are_rejected(self):
        decision = {"최종판정": "성공", "판정근거": "Agent 근거", "확정오류": [], "확인필요": []}
        for output in ([], [node("Instruct - 판정_성공", decision), node("Instruct - 판정_담당자확인", dict(decision, 최종판정="담당자확인"))]):
            with self.assertRaises(ValueError):
                parse_result({"output": output}, [])

    def test_branch_name_does_not_supply_a_missing_verdict_or_reason(self):
        for decision in ({"확정오류": [], "확인필요": [], "판정근거": "근거"},
                         {"최종판정": "보완필요", "확정오류": [], "확인필요": [], "판정근거": ""}):
            with self.assertRaises(ValueError):
                parse_result({"output": [node("Instruct - 판정_보완필요", decision)]}, [])


if __name__ == '__main__':
    unittest.main()
