CREATE TABLE pc_device (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    login varchar(64) NOT NULL REFERENCES staff_account,
    browser_id uuid NOT NULL,
    token_hash bytea NOT NULL UNIQUE,
    name varchar(80) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    seen_at timestamptz,
    hancom_ready boolean NOT NULL DEFAULT false,
    version varchar(32) NOT NULL DEFAULT '',
    revoked boolean NOT NULL DEFAULT false
);
CREATE INDEX pc_device_browser ON pc_device(login,browser_id,created_at DESC);
CREATE TABLE pc_pairing (
    code_hash bytea PRIMARY KEY,
    login varchar(64) NOT NULL REFERENCES staff_account,
    browser_id uuid NOT NULL,
    expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes'
);
CREATE TABLE pc_file_conversion (
    file_id uuid PRIMARY KEY REFERENCES intake_file ON DELETE CASCADE,
    device_id uuid NOT NULL REFERENCES pc_device,
    claim_token uuid NOT NULL DEFAULT gen_random_uuid(),
    lease_until timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('running','done','failed')),
    attempts integer NOT NULL DEFAULT 1,
    metadata jsonb
);
