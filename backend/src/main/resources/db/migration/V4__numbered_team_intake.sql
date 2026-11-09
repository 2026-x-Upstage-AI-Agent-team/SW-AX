ALTER TABLE award_event ADD COLUMN last_intake_number integer NOT NULL DEFAULT 0;
ALTER TABLE award_team ADD COLUMN intake_number integer CHECK (intake_number > 0),
    ADD UNIQUE (event_id, intake_number);

-- A named registry entry can be reused. Independently received bundles, including
-- those whose applications later give the same name and representative, cannot.
ALTER TABLE award_team DROP CONSTRAINT award_team_event_id_name_representative_key;
CREATE UNIQUE INDEX award_team_registered_name_rep
    ON award_team(event_id, name, representative) WHERE intake_number IS NULL;
