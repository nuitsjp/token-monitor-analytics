-- name: GetDisplaySettings :one
SELECT
    theme,
    display_timezone,
    timezone_confirmed,
    week_starts_on,
    compact_window_x,
    compact_window_y,
    compact_window_width,
    compact_window_height,
    compact_window_dpi,
    compact_window_monitor,
    main_window_x,
    main_window_y,
    main_window_width,
    main_window_height,
    main_window_dpi,
    main_window_monitor
FROM display_settings
WHERE singleton = 1;

-- name: UpdateTheme :exec
UPDATE display_settings
SET theme = sqlc.arg(theme)
WHERE singleton = 1;

-- name: UpdateDisplayTimezone :exec
UPDATE display_settings
SET
    display_timezone = sqlc.arg(display_timezone),
    timezone_confirmed = sqlc.arg(timezone_confirmed)
WHERE singleton = 1;
