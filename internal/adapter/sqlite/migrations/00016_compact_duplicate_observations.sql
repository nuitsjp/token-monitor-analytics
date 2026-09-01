-- +goose Up
ALTER TABLE usage_cost_observations ADD COLUMN seen_count INTEGER NOT NULL DEFAULT 1 CHECK (seen_count > 0);
ALTER TABLE usage_cost_observations ADD COLUMN first_seen_at TEXT;
ALTER TABLE usage_cost_observations ADD COLUMN last_seen_at TEXT;
ALTER TABLE usage_cost_observations ADD COLUMN representative_snapshot_id TEXT;
ALTER TABLE usage_cost_observations ADD COLUMN latest_snapshot_id TEXT;

ALTER TABLE usage_analysis_observations ADD COLUMN seen_count INTEGER NOT NULL DEFAULT 1 CHECK (seen_count > 0);
ALTER TABLE usage_analysis_observations ADD COLUMN first_seen_at TEXT;
ALTER TABLE usage_analysis_observations ADD COLUMN last_seen_at TEXT;
ALTER TABLE usage_analysis_observations ADD COLUMN representative_snapshot_id TEXT;
ALTER TABLE usage_analysis_observations ADD COLUMN latest_snapshot_id TEXT;

ALTER TABLE usage_limit_observations ADD COLUMN seen_count INTEGER NOT NULL DEFAULT 1 CHECK (seen_count > 0);
ALTER TABLE usage_limit_observations ADD COLUMN first_seen_at TEXT;
ALTER TABLE usage_limit_observations ADD COLUMN last_seen_at TEXT;
ALTER TABLE usage_limit_observations ADD COLUMN representative_snapshot_id TEXT;
ALTER TABLE usage_limit_observations ADD COLUMN latest_snapshot_id TEXT;

CREATE TABLE usage_cost_observation_occurrences (
    observation_id TEXT NOT NULL REFERENCES usage_cost_observations(observation_id) ON DELETE CASCADE,
    snapshot_id TEXT NOT NULL REFERENCES raw_snapshots(snapshot_id) ON DELETE CASCADE,
    json_path TEXT NOT NULL,
    PRIMARY KEY (observation_id, snapshot_id, json_path)
) STRICT;

CREATE INDEX usage_cost_observation_occurrences_snapshot
    ON usage_cost_observation_occurrences (snapshot_id, observation_id);

CREATE TABLE usage_analysis_observation_occurrences (
    usage_observation_id TEXT NOT NULL REFERENCES usage_analysis_observations(usage_observation_id) ON DELETE CASCADE,
    snapshot_id TEXT NOT NULL REFERENCES raw_snapshots(snapshot_id) ON DELETE CASCADE,
    json_path TEXT NOT NULL,
    PRIMARY KEY (usage_observation_id, snapshot_id, json_path)
) STRICT;

CREATE INDEX usage_analysis_observation_occurrences_snapshot
    ON usage_analysis_observation_occurrences (snapshot_id, usage_observation_id);

CREATE TABLE usage_limit_observation_occurrences (
    observation_id TEXT NOT NULL REFERENCES usage_limit_observations(observation_id) ON DELETE CASCADE,
    snapshot_id TEXT NOT NULL REFERENCES raw_snapshots(snapshot_id) ON DELETE CASCADE,
    json_path TEXT NOT NULL,
    PRIMARY KEY (observation_id, snapshot_id, json_path)
) STRICT;

CREATE INDEX usage_limit_observation_occurrences_snapshot
    ON usage_limit_observation_occurrences (snapshot_id, observation_id);

CREATE TEMP TABLE cost_observation_compaction AS
SELECT observation_id AS old_id,
       FIRST_VALUE(observation_id) OVER (
           PARTITION BY o.hub_id, o.dedupe_key, o.normalization_generation, o.value_fingerprint
           ORDER BY rs.received_completed_at, o.observation_id
       ) AS keeper_id
FROM usage_cost_observations o
JOIN raw_snapshots rs ON rs.snapshot_id = o.snapshot_id;

INSERT INTO usage_cost_observation_occurrences (observation_id, snapshot_id, json_path)
SELECT DISTINCT m.keeper_id, o.snapshot_id, o.json_path
FROM usage_cost_observations o
JOIN cost_observation_compaction m ON m.old_id = o.observation_id;

UPDATE OR IGNORE matched_observations
SET observation_id = (
    SELECT keeper_id FROM cost_observation_compaction WHERE old_id = matched_observations.observation_id
)
WHERE observation_role = 'cost'
  AND observation_id IN (SELECT old_id FROM cost_observation_compaction WHERE old_id <> keeper_id);

DELETE FROM matched_observations
WHERE observation_role = 'cost'
  AND observation_id IN (SELECT old_id FROM cost_observation_compaction WHERE old_id <> keeper_id);

UPDATE estimation_result_evidence
SET observation_id = (
    SELECT keeper_id FROM cost_observation_compaction WHERE old_id = estimation_result_evidence.observation_id
)
WHERE observation_id IN (SELECT old_id FROM cost_observation_compaction WHERE old_id <> keeper_id);

DELETE FROM usage_cost_observations
WHERE observation_id IN (SELECT old_id FROM cost_observation_compaction WHERE old_id <> keeper_id);

UPDATE usage_cost_observations AS o
SET dedupe_state = CASE WHEN (
    SELECT COUNT(DISTINCT other.value_fingerprint)
    FROM usage_cost_observations other
    WHERE other.hub_id = o.hub_id
      AND other.dedupe_key = o.dedupe_key
      AND other.normalization_generation = o.normalization_generation
) > 1 THEN 'conflict' ELSE 'canonical' END,
    seen_count = (SELECT COUNT(*) FROM usage_cost_observation_occurrences oc WHERE oc.observation_id = o.observation_id),
    first_seen_at = (SELECT MIN(rs.received_completed_at) FROM usage_cost_observation_occurrences oc JOIN raw_snapshots rs ON rs.snapshot_id = oc.snapshot_id WHERE oc.observation_id = o.observation_id),
    last_seen_at = (SELECT MAX(rs.received_completed_at) FROM usage_cost_observation_occurrences oc JOIN raw_snapshots rs ON rs.snapshot_id = oc.snapshot_id WHERE oc.observation_id = o.observation_id),
    representative_snapshot_id = o.snapshot_id,
    latest_snapshot_id = (SELECT oc.snapshot_id FROM usage_cost_observation_occurrences oc JOIN raw_snapshots rs ON rs.snapshot_id = oc.snapshot_id WHERE oc.observation_id = o.observation_id ORDER BY rs.received_completed_at DESC, oc.snapshot_id DESC LIMIT 1);

DROP TABLE cost_observation_compaction;

CREATE TEMP TABLE usage_observation_compaction AS
SELECT usage_observation_id AS old_id,
       FIRST_VALUE(usage_observation_id) OVER (
           PARTITION BY o.hub_id, o.dedupe_key, o.normalization_generation, o.value_fingerprint
           ORDER BY rs.received_completed_at, o.usage_observation_id
       ) AS keeper_id
FROM usage_analysis_observations o
JOIN raw_snapshots rs ON rs.snapshot_id = o.snapshot_id;

INSERT INTO usage_analysis_observation_occurrences (usage_observation_id, snapshot_id, json_path)
SELECT DISTINCT m.keeper_id, o.snapshot_id, o.json_path
FROM usage_analysis_observations o
JOIN usage_observation_compaction m ON m.old_id = o.usage_observation_id;

DELETE FROM usage_analysis_observations
WHERE usage_observation_id IN (SELECT old_id FROM usage_observation_compaction WHERE old_id <> keeper_id);

UPDATE usage_analysis_observations AS o
SET dedupe_state = CASE WHEN (
    SELECT COUNT(DISTINCT other.value_fingerprint)
    FROM usage_analysis_observations other
    WHERE other.hub_id = o.hub_id
      AND other.dedupe_key = o.dedupe_key
      AND other.normalization_generation = o.normalization_generation
) > 1 THEN 'conflict' ELSE 'canonical' END,
    seen_count = (SELECT COUNT(*) FROM usage_analysis_observation_occurrences oc WHERE oc.usage_observation_id = o.usage_observation_id),
    first_seen_at = (SELECT MIN(rs.received_completed_at) FROM usage_analysis_observation_occurrences oc JOIN raw_snapshots rs ON rs.snapshot_id = oc.snapshot_id WHERE oc.usage_observation_id = o.usage_observation_id),
    last_seen_at = (SELECT MAX(rs.received_completed_at) FROM usage_analysis_observation_occurrences oc JOIN raw_snapshots rs ON rs.snapshot_id = oc.snapshot_id WHERE oc.usage_observation_id = o.usage_observation_id),
    representative_snapshot_id = o.snapshot_id,
    latest_snapshot_id = (SELECT oc.snapshot_id FROM usage_analysis_observation_occurrences oc JOIN raw_snapshots rs ON rs.snapshot_id = oc.snapshot_id WHERE oc.usage_observation_id = o.usage_observation_id ORDER BY rs.received_completed_at DESC, oc.snapshot_id DESC LIMIT 1);

DROP TABLE usage_observation_compaction;

CREATE TEMP TABLE limit_observation_compaction AS
SELECT observation_id AS old_id,
       FIRST_VALUE(observation_id) OVER (
           PARTITION BY o.hub_id, o.dedupe_key, o.normalization_generation, o.value_fingerprint
           ORDER BY rs.received_completed_at, o.observation_id
       ) AS keeper_id
FROM usage_limit_observations o
JOIN raw_snapshots rs ON rs.snapshot_id = o.snapshot_id;

INSERT INTO usage_limit_observation_occurrences (observation_id, snapshot_id, json_path)
SELECT DISTINCT m.keeper_id, o.snapshot_id, o.json_path
FROM usage_limit_observations o
JOIN limit_observation_compaction m ON m.old_id = o.observation_id;

UPDATE OR IGNORE matched_observations
SET observation_id = (
    SELECT keeper_id FROM limit_observation_compaction WHERE old_id = matched_observations.observation_id
)
WHERE observation_role = 'limit'
  AND observation_id IN (SELECT old_id FROM limit_observation_compaction WHERE old_id <> keeper_id);

DELETE FROM matched_observations
WHERE observation_role = 'limit'
  AND observation_id IN (SELECT old_id FROM limit_observation_compaction WHERE old_id <> keeper_id);

UPDATE estimation_result_evidence
SET observation_id = (
    SELECT keeper_id FROM limit_observation_compaction WHERE old_id = estimation_result_evidence.observation_id
)
WHERE observation_id IN (SELECT old_id FROM limit_observation_compaction WHERE old_id <> keeper_id);

UPDATE OR IGNORE identification_candidate_observations
SET observation_id = (
    SELECT keeper_id FROM limit_observation_compaction WHERE old_id = identification_candidate_observations.observation_id
)
WHERE observation_id IN (SELECT old_id FROM limit_observation_compaction WHERE old_id <> keeper_id);

DELETE FROM identification_candidate_observations
WHERE observation_id IN (SELECT old_id FROM limit_observation_compaction WHERE old_id <> keeper_id);

DELETE FROM usage_limit_observations
WHERE observation_id IN (SELECT old_id FROM limit_observation_compaction WHERE old_id <> keeper_id);

UPDATE usage_limit_observations AS o
SET dedupe_state = CASE WHEN (
    SELECT COUNT(DISTINCT other.value_fingerprint)
    FROM usage_limit_observations other
    WHERE other.hub_id = o.hub_id
      AND other.dedupe_key = o.dedupe_key
      AND other.normalization_generation = o.normalization_generation
) > 1 THEN 'conflict' ELSE 'canonical' END,
    seen_count = (SELECT COUNT(*) FROM usage_limit_observation_occurrences oc WHERE oc.observation_id = o.observation_id),
    first_seen_at = (SELECT MIN(rs.received_completed_at) FROM usage_limit_observation_occurrences oc JOIN raw_snapshots rs ON rs.snapshot_id = oc.snapshot_id WHERE oc.observation_id = o.observation_id),
    last_seen_at = (SELECT MAX(rs.received_completed_at) FROM usage_limit_observation_occurrences oc JOIN raw_snapshots rs ON rs.snapshot_id = oc.snapshot_id WHERE oc.observation_id = o.observation_id),
    representative_snapshot_id = o.snapshot_id,
    latest_snapshot_id = (SELECT oc.snapshot_id FROM usage_limit_observation_occurrences oc JOIN raw_snapshots rs ON rs.snapshot_id = oc.snapshot_id WHERE oc.observation_id = o.observation_id ORDER BY rs.received_completed_at DESC, oc.snapshot_id DESC LIMIT 1);

DROP TABLE limit_observation_compaction;

CREATE UNIQUE INDEX usage_cost_observations_exact_value
    ON usage_cost_observations (hub_id, dedupe_key, normalization_generation, value_fingerprint);

CREATE UNIQUE INDEX usage_analysis_observations_exact_value
    ON usage_analysis_observations (hub_id, dedupe_key, normalization_generation, value_fingerprint);

CREATE UNIQUE INDEX usage_limit_observations_exact_value
    ON usage_limit_observations (hub_id, dedupe_key, normalization_generation, value_fingerprint);

UPDATE schema_metadata SET schema_version = 16 WHERE singleton = 1;

-- +goose Down
UPDATE schema_metadata SET schema_version = 15 WHERE singleton = 1;
DROP INDEX usage_limit_observations_exact_value;
DROP INDEX usage_analysis_observations_exact_value;
DROP INDEX usage_cost_observations_exact_value;
DROP INDEX usage_limit_observation_occurrences_snapshot;
DROP TABLE usage_limit_observation_occurrences;
DROP INDEX usage_analysis_observation_occurrences_snapshot;
DROP TABLE usage_analysis_observation_occurrences;
DROP INDEX usage_cost_observation_occurrences_snapshot;
DROP TABLE usage_cost_observation_occurrences;
