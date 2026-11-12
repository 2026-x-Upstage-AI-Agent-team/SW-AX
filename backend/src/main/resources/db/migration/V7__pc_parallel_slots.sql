ALTER TABLE pc_file_conversion ADD COLUMN worker_slot smallint NOT NULL DEFAULT 0
    CHECK (worker_slot IN (0,1));
