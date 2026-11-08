-- The preceding repeatable migration also runs on installations with existing assignment history.
ALTER TABLE intake_file_assignment
    DROP CONSTRAINT IF EXISTS intake_file_assignment_check,
    ALTER COLUMN after_team_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'assigned'
        CONSTRAINT intake_assignment_state_team
        CHECK (state IN ('assigned', 'unassigned', 'outside') AND (state = 'assigned') = (after_team_id IS NOT NULL));

CREATE TABLE IF NOT EXISTS intake_assignment_exclusion (
    file_id uuid NOT NULL,
    revision integer NOT NULL,
    team_id uuid NOT NULL REFERENCES award_team,
    PRIMARY KEY (file_id, revision, team_id),
    FOREIGN KEY (file_id, revision) REFERENCES intake_file_assignment
);

CREATE OR REPLACE VIEW intake_assignment_decision AS
SELECT a.file_id, a.revision, a.before_team_id, a.after_team_id, a.actor, a.reason, a.changed_at, a.state,
       ARRAY(SELECT x.team_id FROM intake_assignment_exclusion x
                  WHERE x.file_id = a.file_id AND x.revision = a.revision ORDER BY x.team_id) AS excluded
FROM intake_file_assignment a;

CREATE OR REPLACE VIEW intake_file_state AS
SELECT f.id, f.batch_id, f.position, f.name, f.size_bytes, f.sha256, d.after_team_id AS team_id,
       coalesce(d.state, 'unassigned') AS state, coalesce(d.excluded, '{}'::uuid[]) AS excluded, d.reason
FROM intake_file f LEFT JOIN LATERAL (
    SELECT after_team_id, state, excluded, reason FROM intake_assignment_decision
    WHERE file_id = f.id ORDER BY revision DESC LIMIT 1
) d ON true;

CREATE TABLE IF NOT EXISTS team_submission (
    id uuid PRIMARY KEY,
    team_id uuid NOT NULL REFERENCES award_team,
    version integer NOT NULL CHECK (version > 0),
    digest char(64) NOT NULL,
    confirmed_by varchar(64) NOT NULL REFERENCES staff_account,
    confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (team_id, version),
    UNIQUE (team_id, id)
);

CREATE TABLE IF NOT EXISTS team_submission_file (
    submission_id uuid NOT NULL REFERENCES team_submission,
    position integer NOT NULL CHECK (position > 0),
    file_id uuid NOT NULL REFERENCES intake_file,
    PRIMARY KEY (submission_id, position),
    UNIQUE (submission_id, file_id)
);

CREATE TABLE IF NOT EXISTS intake_team_confirmation (
    batch_id uuid NOT NULL REFERENCES intake_batch,
    team_id uuid NOT NULL,
    submission_id uuid NOT NULL,
    state text NOT NULL CHECK (state IN ('confirmed', 'blocked', 'empty', 'superseded')),
    PRIMARY KEY (batch_id, team_id),
    FOREIGN KEY (team_id, submission_id) REFERENCES team_submission (team_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS intake_team_current_source ON intake_team_confirmation (team_id)
    WHERE state <> 'superseded';
