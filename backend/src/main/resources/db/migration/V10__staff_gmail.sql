CREATE TABLE staff_gmail (
    login varchar(64) PRIMARY KEY REFERENCES staff_account ON DELETE CASCADE,
    address text NOT NULL,
    credential text NOT NULL DEFAULT '',
    oauth text NOT NULL DEFAULT '',
    generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (credential = '' OR oauth = '')
);
