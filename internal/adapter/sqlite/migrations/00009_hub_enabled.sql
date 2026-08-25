-- +goose Up
ALTER TABLE hubs ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1
    CHECK (enabled IN (0, 1));

UPDATE schema_metadata SET schema_version = 9 WHERE singleton = 1;

-- +goose Down
UPDATE schema_metadata SET schema_version = 8 WHERE singleton = 1;
ALTER TABLE hubs DROP COLUMN enabled;
