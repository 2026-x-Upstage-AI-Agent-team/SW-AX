CREATE TABLE IF NOT EXISTS review_job (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id uuid NOT NULL UNIQUE REFERENCES team_submission,
    registered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

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

-- Eligibility follows the current source. Releasing a hold makes the same job available again.
CREATE OR REPLACE VIEW review_job_status AS
SELECT j.id AS review_job_id, j.submission_id, j.registered_at, s.team_id, s.version, t.event_id,
       CASE WHEN c.state = 'confirmed' THEN 'queued'
            WHEN c.state IN ('blocked', 'empty') THEN 'blocked'
            ELSE 'superseded' END AS state
FROM review_job j JOIN team_submission s ON s.id = j.submission_id
JOIN award_team t ON t.id = s.team_id
LEFT JOIN intake_team_confirmation c ON c.team_id = s.team_id AND c.submission_id = s.id
    AND c.state <> 'superseded';
