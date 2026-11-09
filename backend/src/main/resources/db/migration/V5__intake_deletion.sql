-- A retry of an upload must not restore documents the operator has removed.
CREATE TABLE withdrawn_intake_request (
    event_id uuid NOT NULL REFERENCES award_event ON DELETE CASCADE,
    request_key varchar(100) NOT NULL,
    PRIMARY KEY (event_id, request_key)
);

ALTER TABLE award_event ADD COLUMN deleted_report_version integer NOT NULL DEFAULT 0;
ALTER TABLE award_team ADD COLUMN deleted_submission_version integer NOT NULL DEFAULT 0;
-- Corrections can outlive their base version after replacing the deleted original.
ALTER TABLE intake_batch ADD COLUMN inherited_files uuid[];

-- Only server-generated identifiers survive until the processing host clears its cache.
CREATE TABLE intake_cache_cleanup (
    item_id uuid PRIMARY KEY,
    batch_id uuid, -- NULL for a local mail envelope, otherwise the original's directory
    due timestamptz NOT NULL DEFAULT now()
);
