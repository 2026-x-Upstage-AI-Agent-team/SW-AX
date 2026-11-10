"""Keep Studio extraction evidence and incomplete rows through report mapping."""
import copy
import json
import unittest

from service.studio import is_masked_rrn, parse_result


def node(name, *records):
    return {"model": name, "content": [{"text": record} for record in records]}


def result(*nodes):
    job = {"output": [node("Instruct - 최종판정", {"enum": "성공", "reason": "가상 증빙 확인"}), *nodes]}
    original = copy.deepcopy(job)
    parsed = parse_result(job, [])
    assert job == original
    return parsed


class StudioFieldTransfer(unittest.TestCase):
    def test_local_values_do_not_supply_missing_agent_fields_or_classification(self):
        local = {"apps": [{"name": "로컬 팀", "rep": "로컬 대표", "representative_emails": ["local@award.test"],
                           "roster": [{"name": "로컬 대표", "student_id": "00000001", "major": "로컬학과"}]}],
                 "identity": "로컬은행 예금주 로컬 대표"}
        job = {"output": [node("Instruct - 최종판정", {"enum": "담당자확인", "reason": "추출 확인 필요"})]}
        parsed = parse_result(job, [{"id": "original", "kind": "01", "signals": json.dumps(local)}])
        self.assertEqual((parsed["team_name"], parsed["rep"], parsed["program"]), ("", "", ""))
        self.assertEqual(parsed["members"], [])
        self.assertEqual(parsed["representative_emails"], [])
        self.assertTrue(all(value == "" for value in parsed["recipient"].values()))
        self.assertEqual(parsed["documents"]["01"], [])
        self.assertEqual(parsed["documents"]["?"], [{"id": "original", "page": 1}])
        self.assertEqual((parsed["verdict"], parsed["reason"]), ("담당자확인", "추출 확인 필요"))

    def test_api_classification_and_email_win_over_conflicting_local_values(self):
        app = {"team_name": "API 팀", "representative_name": "", "representative_email": "api@award.test",
               "representative_student_id": "00000001", "representative_affiliation": "", "members": []}
        parse = node("step_1_parse", {})
        parse["content"][0]["additional_values"] = {"source_file_boundaries": [{"file_id": "source", "file_index": 0}]}
        classify = node("step_2_classify", "시상금지급확인서")
        classify["content"][0]["additional_values"] = {"source_files": [{"file_id": "source"}]}
        job = {"output": [parse, classify, node("Information Extract - 지급확인서", app),
                          node("Instruct - 최종판정", {"enum": "성공", "reason": "API 판정"})]}
        files = [{"id": "original", "kind": "03", "signals": json.dumps({"apps": [
            {"name": "로컬 팀", "representative_emails": ["local@award.test"], "roster": [{"name": "로컬 대표"}]}]})}]
        parsed = parse_result(job, files)
        self.assertEqual(parsed["team_name"], "API 팀")
        self.assertEqual(parsed["representative_emails"], ["api@award.test"])
        self.assertEqual(parsed["documents"]["01"], [{"id": "original", "page": 1}])
        self.assertEqual(parsed["documents"]["03"], [])
        self.assertEqual(parsed["members"][0]["name"], "")
        self.assertEqual(parsed["members"][0]["school"], "")
        job["output"].remove(classify)
        self.assertEqual(parse_result(job, files)["representative_emails"], ["api@award.test"])

    def test_people_returned_by_studio_are_not_filtered_by_name_or_other_fields(self):
        app = {"representative_name": "", "representative_student_id": "00202601",
               "representative_department": "컴퓨터공학과", "representative_birth_date": "020101",
               "members": [{"name": "", "student_id": "00202602", "department": "인공지능학과"},
                           {"name": "", "student_id": "", "department": "", "role": "팀원"},
                           {"name": "가상학생", "student_id": "00202603"}]}
        parsed = result(node("Information Extract - 지급확인서", app))
        self.assertEqual([m["student_id"] for m in parsed["members"]], ["00202601", "00202602", "", "00202603"])
        self.assertEqual([m["name"] for m in parsed["members"]], ["", "", "", "가상학생"])
        self.assertEqual(parsed["members"][1]["major"], "인공지능학과")
        self.assertEqual(parsed["extracted"]["Information Extract - 지급확인서"], [app])
        self.assertEqual(len(parsed["extraction_warnings"]), 3)
        self.assertEqual(parsed["verdict"], "성공")

    def test_multiple_contents_and_repeated_nodes_keep_documents_independent(self):
        a = {"representative_name": "가상대표", "representative_student_id": "",
             "members": [{"name": "가상학생1", "student_id": "00000001"}]}
        b = {"representative_student_id": "00000002", "members": [{"name": "가상학생2", "student_id": "00000003"}]}
        c = {"members": [{"name": "가상학생3", "student_id": "00000004"}]}
        parsed = result(node("Information Extract - 지급확인서", a, b), node("Information Extract - 지급확인서", c),
                        node("Information Extract - 개인정보동의", {"beneficiaries": [{"name": "가상학생1"}]},
                             {"beneficiaries": [{"name": "가상학생2"}]}),
                        node("Information Extract - 신분증정보", {"bank_name": "", "account_number": "001-0001"},
                             {"bank_name": "가상은행", "account_holder": "가상대표"}))
        self.assertEqual([m["student_id"] for m in parsed["members"]], ["", "00000001"])
        self.assertEqual(parsed["consent_names"], ["가상학생1"])
        self.assertEqual(parsed["recipient"]["bank_name"], "")
        self.assertEqual(parsed["recipient"]["account_number"], "001-0001")
        self.assertEqual(parsed["extracted"]["Information Extract - 지급확인서"], [a, b, c])
        self.assertEqual(parsed["extracted"]["Information Extract - 개인정보동의"][1]["beneficiaries"], [{"name":"가상학생2"}])
        self.assertEqual(parsed["extracted"]["Information Extract - 신분증정보"][1]["bank_name"], "가상은행")
        self.assertEqual(len(parsed["extraction_warnings"]), 3)

    def test_config51_observations_and_signature_rows_are_retained(self):
        observation = {"field_key":"members.name", "row_index":0, "state":"실제공란", "evidence":"팀원 성명 칸"}
        signature = {"signature_position":"지급확인 팀원 1", "printed_name":"", "signature_state":"서명있음", "evidence":"서명 획 확인"}
        app = {"members":[{"name":"", "student_id":"00202601"}],
               "field_observations":[observation], "payment_signature_rows":[signature]}
        source = node("Information Extract - 지급확인서", app)
        metadata = {"source_files":[{"file_id":"app-source"}], "page_ranges":[[1,1]]}
        source["content"][0]["additional_values"] = metadata
        parsed = result(source)
        raw = parsed["extracted"]["Information Extract - 지급확인서"][0]
        self.assertEqual(raw["field_observations"], [observation])
        self.assertEqual(raw["payment_signature_rows"], [signature])
        self.assertEqual(parsed["members"][0]["student_id"], "00202601")
        self.assertEqual(parsed["extraction_sources"]["Information Extract - 지급확인서"], [metadata])

    def test_duplicate_application_does_not_double_the_student_count(self):
        app = {"representative_name":"가상대표", "members":[{"name":"가상학생", "student_id":"00202601"}]}
        parsed = result(node("Information Extract - 지급확인서", app, app))
        self.assertEqual(len(parsed["members"]), 2)
        self.assertEqual(len(parsed["extracted"]["Information Extract - 지급확인서"]), 2)
        self.assertTrue(parsed["extraction_warnings"])

    def test_conflicting_values_remain_available_with_a_warning(self):
        a = {"bank_name": "가상은행A", "account_number": "001-0001"}
        b = {"bank_name": "가상은행B", "account_number": "002-0002"}
        parsed = result(node("Information Extract - 신분증정보", a, b))
        self.assertEqual(parsed["recipient"]["bank_name"], "가상은행A")
        self.assertEqual(parsed["extracted"]["Information Extract - 신분증정보"], [a, b])
        self.assertEqual(len(parsed["extraction_warnings"]), 1)
        self.assertEqual(parsed["verdict"], "성공")

    def test_masked_extract_is_used_without_parse_or_classify_requirements(self):
        for value in ("020101-*******", "020101-3******", "020101 - XXXXXXX", "020101-●●●●●●●", "020101-********"):
            with self.subTest(value=value):
                parsed = result(node("Information Extract - 신분증정보", {"id_number_display": value}))
                self.assertEqual(parsed["recipient"]["rrn_display"], value)
                self.assertTrue(is_masked_rrn(value))

    def test_explicit_empty_extract_is_not_replaced_by_ocr(self):
        parsed = result(node("Information Extract - 신분증정보", {"id_number_display": ""}),
                        node("step_1_parse", {"elements": [{"page": 1, "content": {"text": "020101-*******"}}]}),
                        {"model": "step_2_classify", "content": [{"text": "신분증", "additional_values": {"page_ranges": [[1, 1]]}}]})
        self.assertEqual(parsed["recipient"]["rrn_display"], "")

    def test_unmasked_number_is_preserved_as_evidence_but_not_copied_to_the_report(self):
        parsed = result(node("Information Extract - 신분증정보", {"id_number_display": "020101-1234567"}))
        self.assertEqual(parsed["recipient"]["rrn_display"], "")
        self.assertEqual(parsed["extracted"]["Information Extract - 신분증정보"][0]["id_number_display"], "020101-1234567")
        self.assertTrue(parsed["extraction_warnings"])
        for value in ("020101-1234567", "020101-3 ", "020101-"):
            self.assertFalse(is_masked_rrn(value))


if __name__ == "__main__":
    unittest.main()
