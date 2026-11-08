ALTER TABLE award_event ADD COLUMN IF NOT EXISTS event_date text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS place text NOT NULL DEFAULT '';
ALTER TABLE award_team ADD COLUMN IF NOT EXISTS roster jsonb NOT NULL DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS email varchar(254) NOT NULL DEFAULT '';
ALTER TABLE intake_batch ADD COLUMN IF NOT EXISTS uploaded_by varchar(64) REFERENCES staff_account,
    ADD COLUMN IF NOT EXISTS base_submission uuid REFERENCES team_submission,
    ADD COLUMN IF NOT EXISTS replaced uuid[] NOT NULL DEFAULT '{}';

-- Existing receipts keep their manual assignments. New receipts enter preparation on upload.
CREATE TABLE IF NOT EXISTS intake_preparation (
    batch_id uuid PRIMARY KEY REFERENCES intake_batch, state text NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','ready','prepared')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS original_analysis (
    file_id uuid PRIMARY KEY REFERENCES intake_file, kind text NOT NULL DEFAULT '?',
    pages integer NOT NULL DEFAULT 0, signals jsonb NOT NULL DEFAULT '{}', candidates uuid[] NOT NULL DEFAULT '{}',
    reason text NOT NULL DEFAULT '', failed boolean NOT NULL DEFAULT false, pdf bytea
);
CREATE TABLE IF NOT EXISTS file_preparation_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    file_id uuid NOT NULL REFERENCES intake_file, at timestamptz NOT NULL DEFAULT clock_timestamp(),
    stage text NOT NULL, display_name text NOT NULL
);
CREATE INDEX IF NOT EXISTS file_preparation_item ON file_preparation_log(file_id,id);
INSERT INTO staff_account(login,password_hash) VALUES ('@workflow','!') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS workflow_health (
    role text PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT now(), configured boolean NOT NULL,
    config text NOT NULL DEFAULT '', mail_mode text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS studio_execution (
    job_id uuid PRIMARY KEY REFERENCES review_job, phase text NOT NULL DEFAULT 'queued',
    remote_id text, agent text, config text, config_id text, started_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(), due timestamptz NOT NULL DEFAULT now(),
    failures integer NOT NULL DEFAULT 0, error text NOT NULL DEFAULT '', occupies_slot boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS studio_distinct_id ON studio_execution(remote_id) WHERE remote_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS studio_one_remote ON studio_execution (occupies_slot) WHERE occupies_slot;
CREATE TABLE IF NOT EXISTS workflow_audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, submission_id uuid NOT NULL REFERENCES team_submission,
    at timestamptz NOT NULL DEFAULT clock_timestamp(), actor text NOT NULL, action text NOT NULL,
    remote_id text, stage text, attempts integer, due timestamptz
);
CREATE INDEX IF NOT EXISTS workflow_audit_submission ON workflow_audit (submission_id,id);
CREATE TABLE IF NOT EXISTS review_resolution (
    submission_id uuid PRIMARY KEY REFERENCES team_submission, revision integer NOT NULL DEFAULT 0,
    decision text CHECK (decision IN ('승인','보완 필요')), note text NOT NULL DEFAULT '',
    fields jsonb, issues jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS review_mail (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), submission_id uuid NOT NULL REFERENCES team_submission,
    kind text NOT NULL CHECK (kind IN ('담당자 알림','보완 요청','검토 완료')), state text NOT NULL DEFAULT 'waiting'
        CHECK (state IN ('waiting','sending','local','sent','uncertain','failed','obsolete')),
    sent_to text, subject text, body text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (submission_id,kind)
);
CREATE INDEX IF NOT EXISTS review_mail_queue ON review_mail (created_at) WHERE state='waiting';
CREATE TABLE IF NOT EXISTS award_report (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES award_event,
    version integer NOT NULL, created_by varchar(64) NOT NULL REFERENCES staff_account,
    selection uuid[] NOT NULL, snapshot jsonb NOT NULL, parent uuid REFERENCES award_report,
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','building','printing','verifying','preview','confirmed','failed')),
    error text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    hwpx bytea, pdf bytea, print_token uuid, print_until timestamptz, printer text,
    UNIQUE(event_id,version)
);

CREATE OR REPLACE VIEW ops_file AS
SELECT f.id,f.batch_id,f.position,f.team_id, jsonb_build_object('id',f.id,'name',f.name,'team',f.team_id,
    'kind',coalesce(a.kind,'?'),'state',CASE WHEN f.state='unassigned' AND a.failed THEN 'error'
        WHEN f.state='unassigned' AND p.state='pending' AND a.file_id IS NULL THEN 'waiting' ELSE f.state END,
    'reason',coalesce(f.reason,a.reason,''),'candidates',coalesce(a.candidates,'{}'::uuid[]),'excluded',f.excluded,
    'size',f.size_bytes,'pages',coalesce(a.pages,0),'page',coalesce((a.signals->>'page')::int,1),
    'url',CASE WHEN a.pages>0 THEN '/api/files/'||f.id||'/preview' ELSE '' END) AS info
FROM intake_file_state f LEFT JOIN original_analysis a ON a.file_id=f.id LEFT JOIN intake_preparation p ON p.batch_id=f.batch_id;

CREATE OR REPLACE VIEW ops_submission AS
SELECT s.id,s.team_id,t.event_id,s.version,j.review_job_id,j.state AS job_state,
    CASE WHEN j.state='done' AND ((coalesce(j.result#>>'{output,team_name}','') NOT IN ('',t.name))
         OR (t.representative<>'' AND coalesce(j.result#>>'{output,rep}','') NOT IN ('',t.representative))) THEN 'ownership'
         WHEN e.occupies_slot AND e.phase IN ('uncertain','paused','access','invalid') THEN e.phase
         WHEN j.state IN ('superseded','blocked') THEN j.state
         WHEN j.state IN ('queued','running','failed') AND e.phase IN ('creating','polling','uncertain','access','paused','invalid','failed') THEN e.phase
         ELSE coalesce(j.state,'queued') END AS state,
    j.studio_job_id,j.verdict,j.result,j.result->'output' AS output,r.decision,r.note,coalesce(r.revision,0) AS revision,
    coalesce(r.fields,jsonb_build_object('members',coalesce(j.result#>'{output,members}','[]'),
        'recipient',coalesce(j.result#>'{output,recipient}','{}'),'award_type','','support_amount','')) AS fields,
    coalesce(r.issues,'[]') AS issues,s.confirmed_at,
    greatest(s.confirmed_at,j.finished_at,r.updated_at,e.updated_at) AS updated_at,coalesce(e.failures,0) AS attempts,
    CASE WHEN j.state='failed' THEN coalesce(nullif(e.error,''),j.result->>'reason','처리 실패') ELSE coalesce(e.error,'') END AS error,
    (SELECT count(*) FROM team_submission_file sf WHERE sf.submission_id=s.id) AS file_count
FROM team_submission s JOIN award_team t ON t.id=s.team_id LEFT JOIN review_job_status j ON j.submission_id=s.id
LEFT JOIN studio_execution e ON e.job_id=j.review_job_id LEFT JOIN review_resolution r ON r.submission_id=s.id;

CREATE OR REPLACE VIEW ops_summary AS
SELECT s.*,jsonb_build_object('id',id,'team',team_id,'version',version,'state',state,'error',error,'job',coalesce(studio_job_id,(SELECT remote_id FROM studio_execution e WHERE e.job_id=review_job_id)),
    'created',extract(epoch FROM confirmed_at),'updated',extract(epoch FROM updated_at),'attempts',attempts,
    'decision',decision,'revision',revision,'verdict',verdict,'students',jsonb_array_length(coalesce(nullif(fields->'members','null'::jsonb),'[]')),
    'count',file_count,'award_type',fields->>'award_type','support_amount',fields->>'support_amount',
    'status_url','/api/operations/submissions/'||id) AS info FROM ops_submission s;

CREATE OR REPLACE VIEW ops_mail AS
SELECT m.id,m.submission_id,s.event_id,m.created_at,jsonb_build_object('id',m.id,'submission',m.submission_id,'kind',m.kind,
    'state',CASE WHEN s.job_state='superseded' AND m.state IN ('waiting','failed') THEN 'obsolete' ELSE m.state END,
    'sent_to',m.sent_to,'created',extract(epoch FROM m.created_at),'name',t.name,'version',s.version) AS info
FROM review_mail m JOIN ops_submission s ON s.id=m.submission_id JOIN award_team t ON t.id=s.team_id;

CREATE OR REPLACE FUNCTION ops_team_held(team uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS(SELECT FROM intake_team_confirmation WHERE team_id=team AND state IN ('blocked','empty'))
    OR EXISTS(SELECT FROM award_team t JOIN intake_batch b ON b.event_id=t.event_id
        JOIN intake_preparation p ON p.batch_id=b.id JOIN intake_file_state f ON f.batch_id=b.id
        LEFT JOIN original_analysis a ON a.file_id=f.id
        WHERE t.id=team AND f.state='unassigned' AND team<>ALL(f.excluded)
        AND (b.target_team_id IS NULL OR b.target_team_id=team OR team=ANY(a.candidates))
        AND (coalesce(cardinality(a.candidates),0)=0 OR team=ANY(a.candidates)))
$$;

CREATE OR REPLACE FUNCTION queue_review_notices() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_review ops_submission%ROWTYPE;
BEGIN
    SELECT * INTO current_review FROM ops_submission WHERE id=NEW.submission_id;
    IF current_review.state <> 'done' THEN RETURN NULL; END IF;
    IF current_review.verdict IN ('재제출요청','담당자확인') THEN
        INSERT INTO review_mail(submission_id,kind) VALUES (NEW.submission_id,'담당자 알림') ON CONFLICT DO NOTHING;
    END IF;
    IF current_review.verdict='재제출요청' OR (current_review.verdict='성공' AND EXISTS(
        SELECT FROM intake_team_confirmation c JOIN intake_batch b ON b.id=c.batch_id
        WHERE c.submission_id=NEW.submission_id AND b.base_submission<>NEW.submission_id)) THEN
        INSERT INTO review_mail(submission_id,kind) VALUES (NEW.submission_id,
            CASE WHEN current_review.verdict='재제출요청' THEN '보완 요청' ELSE '검토 완료' END) ON CONFLICT DO NOTHING;
    END IF;
    RETURN NULL;
END;
$$;
CREATE OR REPLACE TRIGGER review_notices AFTER UPDATE OF work_state ON review_job
    FOR EACH ROW WHEN (NEW.work_state='done' AND OLD.work_state<>'done') EXECUTE FUNCTION queue_review_notices();
