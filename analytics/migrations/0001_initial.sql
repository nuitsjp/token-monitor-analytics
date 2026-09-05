CREATE TABLE observations (
 hub_id TEXT NOT NULL, event_id TEXT NOT NULL, observed_at TEXT NOT NULL,
 received_at TEXT NOT NULL, stream_id TEXT NOT NULL, payload TEXT NOT NULL,
 PRIMARY KEY(hub_id,event_id)
);
CREATE INDEX observations_retention ON observations(observed_at);
CREATE TABLE hub_latest (hub_id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL, observed_at TEXT NOT NULL);
CREATE TABLE contract_state (contract_id TEXT PRIMARY KEY NOT NULL, state_json TEXT NOT NULL);
CREATE TABLE daily_estimates (
 contract_id TEXT NOT NULL, day TEXT NOT NULL, last_observed_at TEXT NOT NULL,
 status TEXT NOT NULL, reason TEXT NOT NULL, last_valid_at TEXT,
 window_capacity_usd REAL, monthly_capacity_usd REAL, estimate_json TEXT,
 PRIMARY KEY(contract_id,day)
);
