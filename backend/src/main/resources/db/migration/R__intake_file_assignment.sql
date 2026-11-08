ALTER TABLE intake_batch ADD COLUMN IF NOT EXISTS assignment_revision integer NOT NULL DEFAULT 0
    CHECK (assignment_revision >= 0);

CREATE TABLE IF NOT EXISTS intake_file_assignment (
    file_id uuid NOT NULL REFERENCES intake_file,
    revision integer NOT NULL CHECK (revision > 0),
    before_team_id uuid REFERENCES award_team,
    after_team_id uuid NOT NULL REFERENCES award_team,
    actor varchar(64) NOT NULL REFERENCES staff_account,
    reason varchar(500) NOT NULL CHECK (char_length(trim(reason)) BETWEEN 2 AND 500),
    changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (file_id, revision),
    CHECK (before_team_id IS DISTINCT FROM after_team_id)
);
