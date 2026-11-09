CREATE TABLE output_pair_code (
    digest char(64) PRIMARY KEY,
    expires_at timestamptz NOT NULL
);
CREATE TABLE output_pc (
    id uuid PRIMARY KEY,
    name varchar(64) NOT NULL,
    token_digest char(64) NOT NULL UNIQUE,
    last_seen timestamptz NOT NULL DEFAULT now(),
    tested_at timestamptz,
    revoked boolean NOT NULL DEFAULT false
);
CREATE TABLE output_test (
    id uuid PRIMARY KEY,
    pc_id uuid NOT NULL REFERENCES output_pc,
    state varchar(12) NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','done','failed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    lease uuid,
    lease_until timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    detail varchar(180) NOT NULL DEFAULT '',
    hwpx bytea,
    pdf bytea,
    CHECK ((state = 'done') = (hwpx IS NOT NULL AND pdf IS NOT NULL))
);
CREATE UNIQUE INDEX output_one_active ON output_test(pc_id) WHERE state IN ('queued','running');
CREATE INDEX output_recent_tests ON output_test(pc_id, created_at DESC);
