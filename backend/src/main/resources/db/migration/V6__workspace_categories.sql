CREATE TABLE work_category (
    id varchar(64) PRIMARY KEY,
    name varchar(160) NOT NULL,
    description text NOT NULL
);

INSERT INTO work_category(id, name, description) VALUES
    ('awards', '시상금 서류 검토', '신청서와 동의서, 대표 증빙을 함께 검토하고 지급내역서를 만듭니다.');

-- Existing competitions become workspaces in the awards category.
ALTER TABLE award_event ADD COLUMN category_id varchar(64) NOT NULL DEFAULT 'awards'
    REFERENCES work_category(id);
ALTER TABLE award_event DROP CONSTRAINT award_event_name_key;
ALTER TABLE award_event ADD CONSTRAINT award_event_category_name UNIQUE(category_id, name);
CREATE INDEX award_event_category ON award_event(category_id, created_at DESC);
