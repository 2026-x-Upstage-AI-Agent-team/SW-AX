CREATE TABLE award_event (
    id uuid PRIMARY KEY,
    name varchar(160) NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE award_team (
    id uuid PRIMARY KEY,
    event_id uuid NOT NULL REFERENCES award_event,
    name varchar(160) NOT NULL,
    representative varchar(80) NOT NULL DEFAULT '',
    UNIQUE (event_id, name, representative),
    UNIQUE (event_id, id)
);

CREATE TABLE intake_batch (
    id uuid PRIMARY KEY,
    event_id uuid NOT NULL REFERENCES award_event,
    target_team_id uuid,
    request_key varchar(100) NOT NULL UNIQUE,
    fingerprint char(64) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (event_id, target_team_id) REFERENCES award_team (event_id, id)
);
CREATE INDEX intake_event_time ON intake_batch (event_id, created_at DESC, id);

CREATE TABLE intake_file (
    id uuid PRIMARY KEY,
    batch_id uuid NOT NULL REFERENCES intake_batch,
    position integer NOT NULL CHECK (position >= 1),
    name varchar(255) NOT NULL,
    size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 41943040),
    sha256 char(64) NOT NULL,
    original bytea NOT NULL CHECK (octet_length(original) = size_bytes),
    UNIQUE (batch_id, position)
);
