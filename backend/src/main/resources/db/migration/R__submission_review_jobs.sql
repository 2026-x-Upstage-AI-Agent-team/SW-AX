CREATE TABLE IF NOT EXISTS review_job (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id uuid NOT NULL UNIQUE REFERENCES team_submission,
    registered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE review_job
    ADD COLUMN IF NOT EXISTS work_state text NOT NULL DEFAULT 'queued'
        CHECK (work_state IN ('queued', 'running', 'done', 'failed')),
    ADD COLUMN IF NOT EXISTS worker_id varchar(80),
    ADD COLUMN IF NOT EXISTS claim_token uuid,
    ADD COLUMN IF NOT EXISTS claim_attempt integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS lease_until timestamptz,
    ADD COLUMN IF NOT EXISTS studio_job_id varchar(160),
    ADD COLUMN IF NOT EXISTS finished_at timestamptz,
    ADD COLUMN IF NOT EXISTS result jsonb;

CREATE INDEX IF NOT EXISTS review_job_claim_order ON review_job (registered_at, id)
    WHERE work_state IN ('queued', 'running');
CREATE UNIQUE INDEX IF NOT EXISTS review_job_studio_id ON review_job (studio_job_id) WHERE studio_job_id IS NOT NULL;

-- Both first confirmation and assignment corrections pass through this table.
CREATE OR REPLACE FUNCTION enqueue_confirmed_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO review_job (submission_id) VALUES (NEW.submission_id) ON CONFLICT (submission_id) DO NOTHING;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER enqueue_review_job
AFTER INSERT OR UPDATE ON intake_team_confirmation
FOR EACH ROW WHEN (NEW.state = 'confirmed') EXECUTE FUNCTION enqueue_confirmed_submission();

INSERT INTO review_job (submission_id)
SELECT s.id FROM team_submission s JOIN intake_team_confirmation c ON c.submission_id = s.id
WHERE c.state = 'confirmed' ORDER BY s.confirmed_at, s.id
ON CONFLICT (submission_id) DO NOTHING;

-- A different receipt can confirm the same immutable version in this transaction.
-- Revoke an active claim only if the version has actually lost its confirmed source at commit.
CREATE OR REPLACE FUNCTION revoke_unconfirmed_review_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM intake_team_confirmation
                   WHERE submission_id = OLD.submission_id AND state = 'confirmed') THEN
        UPDATE review_job SET work_state = 'queued', worker_id = NULL, claim_token = NULL, lease_until = NULL
        WHERE submission_id = OLD.submission_id AND work_state = 'running';
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS revoke_review_claim ON intake_team_confirmation;
CREATE CONSTRAINT TRIGGER revoke_review_claim AFTER UPDATE ON intake_team_confirmation
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    WHEN (OLD.state = 'confirmed' AND (NEW.state <> 'confirmed' OR NEW.submission_id <> OLD.submission_id))
    EXECUTE FUNCTION revoke_unconfirmed_review_claim();

CREATE OR REPLACE VIEW review_job_status AS
SELECT j.id AS review_job_id, j.submission_id, j.registered_at, s.team_id, s.version, t.event_id,
       CASE WHEN c.state = 'confirmed' AND j.work_state = 'running' AND j.lease_until <= statement_timestamp() THEN 'queued'
            WHEN c.state = 'confirmed' THEN j.work_state
            WHEN c.state IN ('blocked', 'empty') THEN 'blocked'
            ELSE 'superseded' END AS state,
       j.worker_id, j.studio_job_id, j.finished_at, j.result, j.result ->> 'verdict' AS verdict
FROM review_job j JOIN team_submission s ON s.id = j.submission_id
JOIN award_team t ON t.id = s.team_id
LEFT JOIN intake_team_confirmation c ON c.team_id = s.team_id AND c.submission_id = s.id
    AND c.state <> 'superseded';
