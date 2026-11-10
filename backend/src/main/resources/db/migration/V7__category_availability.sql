ALTER TABLE work_category ADD COLUMN enabled boolean NOT NULL DEFAULT false;
ALTER TABLE work_category ADD COLUMN sort_order integer NOT NULL DEFAULT 100;

UPDATE work_category SET enabled = true, sort_order = 10 WHERE id = 'awards';

INSERT INTO work_category(id, name, description, enabled, sort_order) VALUES
    ('result-reports', '결과보고서 검토', '프로그램 운영 실적과 결과보고서, 첨부 자료를 확인하는 업무입니다.', false, 20),
    ('expense-evidence', '사업비 집행 증빙 검토', '사업비 사용 내역과 영수증, 지출 증빙을 확인하는 업무입니다.', false, 30),
    ('scholarships', '장학금 서류 검토', '장학금 신청서와 제출 서류의 누락·불일치를 확인하는 업무입니다.', false, 40),
    ('participation', '참여·활동 증빙 검토', '참여 명단과 활동 내역, 출석 증빙을 확인하는 업무입니다.', false, 50),
    ('agreements', '협약·계약 서류 검토', '협약서와 계약서의 기재 항목, 서명과 첨부 서류를 확인하는 업무입니다.', false, 60);
