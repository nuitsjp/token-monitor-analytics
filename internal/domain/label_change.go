package domain

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

type LabelChangeState string

const (
	LabelChangeUnconfirmed    LabelChangeState = "unconfirmed"
	LabelChangeSameLimit      LabelChangeState = "confirmed_same_limit"
	LabelChangeDifferentLimit LabelChangeState = "confirmed_different_limit"
	LabelChangeRejected       LabelChangeState = "rejected"
)

// LimitLabelChangeCandidate is evidence for a possible rename. The raw
// labels remain untouched; kind and metric are the already-normalized
// matching key produced by the observation normalizer.
type LimitLabelChangeCandidate struct {
	ID                        string
	HubID                     string
	DeviceRecordKey           string
	HubAccountKey             string
	RawLimitServiceIdentifier string
	NormalizedKind            string
	NormalizedMetric          string
	OldLabel                  string
	NewLabel                  string
	State                     LabelChangeState
	LimitDefinitionID         *string
	FirstObservedAt           *time.Time
	LastObservedAt            *time.Time
	CreatedAt                 time.Time
	UpdatedAt                 time.Time
}

type LimitLabelChangeWindow struct {
	ID          string
	CandidateID string
	WindowKey   string
	Label       string
	ObservedAt  time.Time
}

func (c LimitLabelChangeCandidate) Validate() error {
	for value, label := range map[string]string{
		c.ID: "label change candidate ID", c.HubID: "Hub ID", c.DeviceRecordKey: "device record key",
		c.RawLimitServiceIdentifier: "raw limit service identifier",
		c.NormalizedKind:            "normalized kind", c.NormalizedMetric: "normalized metric", c.OldLabel: "old label", c.NewLabel: "new label",
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", label)
		}
	}
	if c.OldLabel == c.NewLabel {
		return errors.New("label change candidate needs different labels")
	}
	if c.State == "" {
		c.State = LabelChangeUnconfirmed
	}
	if c.State != LabelChangeUnconfirmed && c.State != LabelChangeSameLimit && c.State != LabelChangeDifferentLimit && c.State != LabelChangeRejected {
		return fmt.Errorf("unknown label change state %q", c.State)
	}
	if c.State == LabelChangeSameLimit && (c.LimitDefinitionID == nil || strings.TrimSpace(*c.LimitDefinitionID) == "") {
		return errors.New("same-limit decision requires a limit definition")
	}
	if c.State != LabelChangeSameLimit && c.LimitDefinitionID != nil {
		return errors.New("only same-limit decision may reference a limit definition")
	}
	if c.FirstObservedAt != nil && c.LastObservedAt != nil && c.LastObservedAt.Before(*c.FirstObservedAt) {
		return errors.New("label change observation interval is reversed")
	}
	if c.CreatedAt.IsZero() || c.UpdatedAt.IsZero() {
		return errors.New("label change timestamps are required")
	}
	return nil
}

func (w LimitLabelChangeWindow) Validate() error {
	if strings.TrimSpace(w.ID) == "" || strings.TrimSpace(w.CandidateID) == "" || strings.TrimSpace(w.WindowKey) == "" || w.ObservedAt.IsZero() {
		return errors.New("label change window has an empty required field")
	}
	if w.Label == "" {
		return errors.New("label change window label is required")
	}
	return nil
}
