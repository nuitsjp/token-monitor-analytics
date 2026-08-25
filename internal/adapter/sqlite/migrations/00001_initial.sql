-- +goose Up
CREATE TABLE schema_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version > 0)
) STRICT;

INSERT INTO schema_metadata (singleton, schema_version) VALUES (1, 1);

CREATE TABLE display_settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    theme TEXT NOT NULL CHECK (theme IN ('light', 'dark', 'system')),
    display_timezone TEXT,
    timezone_confirmed INTEGER NOT NULL CHECK (timezone_confirmed IN (0, 1)),
    week_starts_on INTEGER NOT NULL CHECK (week_starts_on = 1),
    compact_window_x INTEGER,
    compact_window_y INTEGER,
    compact_window_width INTEGER,
    compact_window_height INTEGER,
    compact_window_dpi INTEGER,
    compact_window_monitor TEXT,
    main_window_x INTEGER,
    main_window_y INTEGER,
    main_window_width INTEGER,
    main_window_height INTEGER,
    main_window_dpi INTEGER,
    main_window_monitor TEXT
) STRICT;

INSERT INTO display_settings (
    singleton,
    theme,
    display_timezone,
    timezone_confirmed,
    week_starts_on
) VALUES (1, 'system', NULL, 0, 1);

-- +goose Down
DROP TABLE display_settings;
DROP TABLE schema_metadata;
