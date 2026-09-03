package domain

import (
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strings"
	"time"
)

// UsageObservation is one canonical cumulative usage reading. Account IDs are
// populated only from explicit associations that are active at ObservedAt.
type UsageObservation struct {
	ID, SnapshotID, SourceID                     string
	HubID, HubName, DeviceID, CollectionDeviceID string
	RawServiceIdentifier, ServiceID, ServiceName string
	ObservedAt                                   time.Time
	TokenCount                                   int64
	APICostUSDText                               string
	ModelTokens                                  map[string]int64
	ModelCosts                                   map[string]string
	AccountIDs, AccountNames                     []string
	PlanVersionIDs, PlanVersionNames             []string
	LimitDefinitionIDs                           []string
	CompletenessConfirmed                        bool
	JSONPath                                     string
}

const (
	UsagePeriodKindDay   = "day"
	UsagePeriodKindMonth = "month"
)

// UsagePeriodObservation is one canonical source-reported calendar period
// reading for a Hub device. It is not an allTime cumulative delta.
type UsagePeriodObservation struct {
	ID, SnapshotID, HubID, HubName, DeviceID string
	PeriodKind, PeriodKey                    string
	PeriodEndsAt, UsageUpdatedAt             time.Time
	SourceTimezone                           string
	TokenCount                               int64
	APICostUSDText                           string
	ToolTokens                               map[string]int64
	ToolCosts                                map[string]string
	ModelTokens                              map[string]int64
	ModelCosts                               map[string]string
	ToolModelTokens                          map[string]map[string]int64
	ToolModelCosts                           map[string]map[string]string
	JSONPath, DedupeState                    string
}

type UsageDelta struct {
	StartObservationID, EndObservationID string
	StartSnapshotID, EndSnapshotID       string
	SourceID                             string
	HubID, HubName, DeviceID             string
	CollectionDeviceID                   string
	RawServiceIdentifier                 string
	ServiceID, ServiceName               string
	AccountIDs, AccountNames             []string
	PlanVersionIDs, PlanVersionNames     []string
	LimitDefinitionIDs                   []string
	Shared                               bool
	StartAt, EndAt                       time.Time
	Tokens                               int64
	APICostUSDText                       string
	ModelTokens                          map[string]int64
	ModelCosts                           map[string]string
	JSONPath                             string
}

// DeriveUsageDeltas uses adjacent observations only. A cumulative decrease,
// attribution change, or service mapping change starts a new series and is
// never bridged by a derived row.
func DeriveUsageDeltas(input []UsageObservation) ([]UsageDelta, error) {
	items := append([]UsageObservation(nil), input...)
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].SourceID != items[j].SourceID {
			return items[i].SourceID < items[j].SourceID
		}
		if !items[i].ObservedAt.Equal(items[j].ObservedAt) {
			return items[i].ObservedAt.Before(items[j].ObservedAt)
		}
		return items[i].ID < items[j].ID
	})
	result := make([]UsageDelta, 0, len(items))
	for index := 1; index < len(items); index++ {
		previous, current := items[index-1], items[index]
		if previous.SourceID == "" || current.SourceID != previous.SourceID || !current.ObservedAt.After(previous.ObservedAt) {
			continue
		}
		if current.TokenCount < previous.TokenCount || current.ServiceID != previous.ServiceID || attributionKey(current) != attributionKey(previous) {
			continue
		}
		cost, ok, err := decimalDifference(current.APICostUSDText, previous.APICostUSDText)
		if err != nil {
			return nil, fmt.Errorf("derive API cost delta for %s: %w", current.ID, err)
		}
		if !ok {
			continue
		}
		modelTokens := make(map[string]int64)
		for model, end := range current.ModelTokens {
			start, exists := previous.ModelTokens[model]
			if exists && end >= start {
				modelTokens[model] = end - start
			}
		}
		modelCosts := make(map[string]string)
		for model, end := range current.ModelCosts {
			start, exists := previous.ModelCosts[model]
			if !exists {
				continue
			}
			delta, valid, deltaErr := decimalDifference(end, start)
			if deltaErr != nil {
				return nil, fmt.Errorf("derive model cost delta for %s/%s: %w", current.ID, model, deltaErr)
			}
			if valid {
				modelCosts[model] = delta
			}
		}
		result = append(result, UsageDelta{
			StartObservationID: previous.ID, EndObservationID: current.ID,
			StartSnapshotID: previous.SnapshotID, EndSnapshotID: current.SnapshotID,
			SourceID: current.SourceID, HubID: current.HubID, HubName: current.HubName, DeviceID: current.DeviceID, CollectionDeviceID: current.CollectionDeviceID,
			RawServiceIdentifier: current.RawServiceIdentifier, ServiceID: current.ServiceID, ServiceName: current.ServiceName,
			AccountIDs: append([]string(nil), current.AccountIDs...), AccountNames: append([]string(nil), current.AccountNames...),
			PlanVersionIDs: append([]string(nil), current.PlanVersionIDs...), PlanVersionNames: append([]string(nil), current.PlanVersionNames...), LimitDefinitionIDs: append([]string(nil), current.LimitDefinitionIDs...),
			Shared:  !current.CompletenessConfirmed || len(current.AccountIDs) != 1,
			StartAt: previous.ObservedAt, EndAt: current.ObservedAt, Tokens: current.TokenCount - previous.TokenCount,
			APICostUSDText: cost, ModelTokens: modelTokens, ModelCosts: modelCosts, JSONPath: current.JSONPath,
		})
	}
	return result, nil
}

func attributionKey(value UsageObservation) string {
	accountIDs := append([]string(nil), value.AccountIDs...)
	planVersionIDs := append([]string(nil), value.PlanVersionIDs...)
	limitDefinitionIDs := append([]string(nil), value.LimitDefinitionIDs...)
	sort.Strings(accountIDs)
	sort.Strings(planVersionIDs)
	sort.Strings(limitDefinitionIDs)
	return fmt.Sprintf("%t:%s:%s:%s", value.CompletenessConfirmed, strings.Join(accountIDs, "\x00"), strings.Join(planVersionIDs, "\x00"), strings.Join(limitDefinitionIDs, "\x00"))
}

func decimalDifference(end, start string) (string, bool, error) {
	if strings.TrimSpace(end) == "" && strings.TrimSpace(start) == "" {
		return "", true, nil
	}
	if strings.TrimSpace(end) == "" || strings.TrimSpace(start) == "" {
		return "", false, nil
	}
	endValue, ok := new(big.Rat).SetString(end)
	if !ok {
		return "", false, errors.New("invalid ending decimal")
	}
	startValue, ok := new(big.Rat).SetString(start)
	if !ok {
		return "", false, errors.New("invalid starting decimal")
	}
	delta := new(big.Rat).Sub(endValue, startValue)
	if delta.Sign() < 0 {
		return "", false, nil
	}
	return finiteDecimal(delta), true, nil
}

func finiteDecimal(value *big.Rat) string {
	for precision := 0; precision <= 18; precision++ {
		text := value.FloatString(precision)
		parsed, ok := new(big.Rat).SetString(text)
		if ok && parsed.Cmp(value) == 0 {
			if strings.Contains(text, ".") {
				text = strings.TrimRight(strings.TrimRight(text, "0"), ".")
			}
			return text
		}
	}
	return value.FloatString(18)
}
