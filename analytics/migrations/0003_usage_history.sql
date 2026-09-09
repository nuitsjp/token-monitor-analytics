-- Hub History is a replacement snapshot keyed by Hub/device/period.  It is
-- intentionally separate from observations and daily_estimates: a retained
-- upstream row is not a live observation and cannot advance an estimate.
CREATE TABLE usage_periods (
 hub_id TEXT NOT NULL,
 device_id TEXT NOT NULL,
 granularity TEXT NOT NULL CHECK (granularity IN ('daily','monthly')),
 period_key TEXT NOT NULL,
 total_tokens REAL,
 cost_usd REAL,
 messages REAL,
 active_time_ms REAL,
 cache_read_tokens REAL,
 cache_write_tokens REAL,
 output_tokens REAL,
 unclassified_tokens REAL,
 token_components_available INTEGER,
 per_client_json TEXT NOT NULL,
 per_model_json TEXT NOT NULL,
 source_time_zone TEXT,
 confirmed_fetch_id INTEGER NOT NULL,
 confirmed_at TEXT NOT NULL,
 PRIMARY KEY (hub_id, device_id, granularity, period_key)
);
CREATE INDEX usage_periods_lookup ON usage_periods(hub_id, device_id, granularity, period_key);

CREATE TABLE usage_sources (
 hub_id TEXT NOT NULL,
 device_id TEXT NOT NULL,
 presence TEXT NOT NULL CHECK (presence IN ('present','deleted')),
 history_state TEXT NOT NULL CHECK (history_state IN ('available','disabled','unavailable','missing','missing_capability','deleted')),
 history_available INTEGER,
 time_zone TEXT,
 today_key TEXT,
 today_ends_at TEXT,
 month_key TEXT,
 month_ends_at TEXT,
 daily_from TEXT,
 daily_to TEXT,
 monthly_from TEXT,
 monthly_to TEXT,
 upstream_updated_at TEXT,
 last_fetch_id INTEGER NOT NULL,
 last_confirmed_at TEXT NOT NULL,
 PRIMARY KEY (hub_id, device_id)
);

-- This table records fetch bookkeeping only.  It is not a queue or an event
-- log.  request IDs are local and are never compared with Hub revisions.
CREATE TABLE usage_fetches (
 hub_id TEXT PRIMARY KEY NOT NULL,
 next_fetch_id INTEGER NOT NULL DEFAULT 0,
 latest_success_fetch_id INTEGER,
 latest_success_at TEXT,
 last_attempt_fetch_id INTEGER,
 last_attempt_at TEXT,
 last_status TEXT NOT NULL DEFAULT 'never',
 last_error TEXT
);
