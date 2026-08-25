package domain

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

var (
	ErrPurgeSelectionHubs  = errors.New("purge selection must specify Hub IDs or all hubs")
	ErrPurgeSelectionRange = errors.New("purge selection period must be a non-empty half-open interval")
	ErrPurgeNoTargets      = errors.New("purge selection has no raw snapshots")
)

// PurgeSelection identifies complete raw snapshots by Hub and raw snapshot
// received completion time. AllHubs is explicit so an empty Hub ID slice cannot
// accidentally become an unrestricted delete.
type PurgeSelection struct {
	AllHubs bool       `json:"allHubs"`
	HubIDs  []string   `json:"hubIDs"`
	Start   *time.Time `json:"start"`
	End     *time.Time `json:"end"`
}

func (s PurgeSelection) Validate() error {
	if s.AllHubs {
		if len(s.HubIDs) != 0 {
			return ErrPurgeSelectionHubs
		}
	} else if len(s.HubIDs) == 0 {
		return ErrPurgeSelectionHubs
	}
	seen := make(map[string]struct{}, len(s.HubIDs))
	for _, id := range s.HubIDs {
		id = strings.TrimSpace(id)
		if id == "" {
			return ErrPurgeSelectionHubs
		}
		if _, ok := seen[id]; ok {
			return fmt.Errorf("purge selection contains duplicate Hub ID %q", id)
		}
		seen[id] = struct{}{}
	}
	if s.Start != nil && s.Start.IsZero() || s.End != nil && s.End.IsZero() {
		return ErrPurgeSelectionRange
	}
	if s.Start != nil && s.End != nil && !s.Start.UTC().Before(s.End.UTC()) {
		return ErrPurgeSelectionRange
	}
	return nil
}

func (s PurgeSelection) Normalized() (PurgeSelection, error) {
	if err := s.Validate(); err != nil {
		return PurgeSelection{}, err
	}
	result := s
	result.HubIDs = append([]string(nil), s.HubIDs...)
	for index := range result.HubIDs {
		result.HubIDs[index] = strings.TrimSpace(result.HubIDs[index])
	}
	sort.Strings(result.HubIDs)
	if result.Start != nil {
		value := result.Start.UTC()
		result.Start = &value
	}
	if result.End != nil {
		value := result.End.UTC()
		result.End = &value
	}
	return result, nil
}

type DataCapacity struct {
	DatabaseSizeBytes int64      `json:"databaseSizeBytes"`
	RawSnapshotCount  int64      `json:"rawSnapshotCount"`
	OldestCompletedAt *time.Time `json:"oldestCompletedAt,omitempty"`
	LatestCompletedAt *time.Time `json:"latestCompletedAt,omitempty"`
	RawJSONBytes      int64      `json:"rawJSONBytes"`
}

func (c DataCapacity) Validate() error {
	if c.DatabaseSizeBytes < 0 || c.RawSnapshotCount < 0 || c.RawJSONBytes < 0 {
		return errors.New("data capacity values must be non-negative")
	}
	if c.OldestCompletedAt != nil && c.LatestCompletedAt != nil && c.LatestCompletedAt.Before(*c.OldestCompletedAt) {
		return errors.New("data capacity completion range is invalid")
	}
	return nil
}

type PurgePreview struct {
	Selection PurgeSelection `json:"selection"`
	Capacity  DataCapacity   `json:"capacity"`
}

type PurgeResult struct {
	AuditID                  string    `json:"auditID"`
	ExecutedAt               time.Time `json:"executedAt"`
	RawSnapshotCount         int64     `json:"rawSnapshotCount"`
	CostObservationCount     int64     `json:"costObservationCount"`
	LimitObservationCount    int64     `json:"limitObservationCount"`
	MatchedObservationCount  int64     `json:"matchedObservationCount"`
	EstimationPointCount     int64     `json:"estimationPointCount"`
	EstimationResultCount    int64     `json:"estimationResultCount"`
	EstimationEvidenceCount  int64     `json:"estimationEvidenceCount"`
	CalculationIntervalCount int64     `json:"calculationIntervalCount"`
	CalculationBoundaryCount int64     `json:"calculationBoundaryCount"`
	RecalculatedResultCount  int64     `json:"recalculatedResultCount"`
}
