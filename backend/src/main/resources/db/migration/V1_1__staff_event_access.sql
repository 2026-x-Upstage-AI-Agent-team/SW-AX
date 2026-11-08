CREATE TABLE staff_account (
    login varchar(64) PRIMARY KEY,
    password_hash varchar(60) NOT NULL
);

CREATE TABLE event_staff (
    event_id uuid NOT NULL REFERENCES award_event ON DELETE CASCADE,
    login varchar(64) NOT NULL REFERENCES staff_account ON DELETE CASCADE,
    PRIMARY KEY (event_id, login)
);
CREATE INDEX event_staff_login ON event_staff (login, event_id);
