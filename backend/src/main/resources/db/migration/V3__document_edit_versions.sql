CREATE TABLE IF NOT EXISTS document_edit_version (
    file_id uuid NOT NULL REFERENCES intake_file,
    version integer NOT NULL CHECK (version > 0),
    parent_version integer NOT NULL CHECK (parent_version = version - 1),
    editor varchar(64) NOT NULL REFERENCES staff_account(login),
    saved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    sha256 char(64) NOT NULL,
    hwpx bytea NOT NULL CHECK (octet_length(hwpx) BETWEEN 1 AND 41943040),
    PRIMARY KEY (file_id, version)
);
