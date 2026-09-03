package hubapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
	_ "time/tzdata"
)

// These versions are persisted with every normalized observation. A change
// to an existing observation kind creates a new generation; it never rewrites
// an existing observation. Source-period observations are additive in the
// unreleased schema and therefore start in the current generation.
const (
	NormalizationGeneration   int64 = 3
	NormalizationRuleVersion        = "api-stats-v1-device-updated-at"
	NormalizationLogicVersion       = "t012-normalize-v3-window-key"
)

type NormalizedCostObservation struct {
	DeviceID             string
	RawServiceIdentifier string
	UsageUpdatedAt       time.Time
	CostUSDText          string
	SyncUploadIntervalMS *int64
	MetadataValid        bool
	SourceTimezone       string
	SourceLocalDate      string
	JSONPath             string
	DedupeKey            string
	ValueFingerprint     string
}

type NormalizedUsageObservation struct {
	DeviceID             string
	RawServiceIdentifier string
	UsageUpdatedAt       time.Time
	TokenCount           int64
	APICostUSDText       string
	ModelTokens          map[string]int64
	ModelCosts           map[string]string
	SourceTimezone       string
	SourceLocalDate      string
	JSONPath             string
	DedupeKey            string
	ValueFingerprint     string
}

type NormalizedLimitObservation struct {
	DeviceID              string
	RawServiceIdentifier  string
	AccountKey            string
	AccountKeyKind        string
	AccountLabel          string
	AccountEmail          string
	ProviderUpdatedAt     time.Time
	WindowKey             string
	NormalizedKind        string
	NormalizedMetric      string
	NormalizedLabel       string
	PlanLabel             string
	UsedPercent           *float64
	AbsoluteUsedText      string
	AbsoluteLimitText     string
	AbsoluteRemainingText string
	Currency              string
	ResetsAt              *time.Time
	SyncUploadIntervalMS  *int64
	LimitsRefreshMS       *int64
	MetadataValid         bool
	SourceTimezone        string
	SourceLocalDate       string
	JSONPath              string
	DedupeKey             string
	ValueFingerprint      string
	WindowKeyConflict     bool
}

type NormalizedPeriodObservation struct {
	DeviceID         string
	PeriodKind       string
	PeriodKey        string
	PeriodEndsAt     time.Time
	UsageUpdatedAt   time.Time
	SourceTimezone   string
	TokenCount       int64
	APICostUSDText   string
	ToolTokens       map[string]int64
	ToolCosts        map[string]string
	ModelTokens      map[string]int64
	ModelCosts       map[string]string
	ToolModelTokens  map[string]map[string]int64
	ToolModelCosts   map[string]map[string]string
	JSONPath         string
	DedupeKey        string
	ValueFingerprint string
}

type NormalizedStats struct {
	Costs   []NormalizedCostObservation
	Usage   []NormalizedUsageObservation
	Limits  []NormalizedLimitObservation
	Periods []NormalizedPeriodObservation
}

// NormalizeStats extracts only fields defined by the authenticated stats
// contract. Unknown fields remain available in the raw snapshot and are not
// interpreted here.
func NormalizeStats(raw []byte) (NormalizedStats, error) {
	value, err := decodeJSON(raw)
	if err != nil {
		return NormalizedStats{}, errors.New("stats JSON is invalid")
	}
	root, ok := value.(map[string]any)
	if !ok {
		return NormalizedStats{}, errors.New("stats JSON must be an object")
	}
	devicesValue, ok := root["devices"]
	if !ok {
		return NormalizedStats{}, errors.New("stats devices is missing")
	}
	devices, ok := devicesValue.([]any)
	if !ok {
		return NormalizedStats{}, errors.New("stats devices is invalid")
	}
	result := NormalizedStats{}
	for deviceIndex, item := range devices {
		device, ok := item.(map[string]any)
		if !ok {
			return NormalizedStats{}, errors.New("stats device is invalid")
		}
		deviceID, ok := stringValue(device["deviceId"])
		if !ok || deviceID == "" {
			return NormalizedStats{}, errors.New("stats deviceId is missing")
		}
		usage, usagePresent, usageValid := timestampValue(device["updatedAt"])
		if usagePresent && !usageValid {
			return NormalizedStats{}, errors.New("stats device updatedAt is invalid")
		}
		syncMS, syncPresent, syncValid := nonNegativeInteger(device["syncUploadIntervalMs"])
		if !syncPresent {
			zero := int64(0)
			syncMS, syncPresent, syncValid = &zero, true, true
		}
		if syncPresent && !syncValid {
			// The device remains usable as a raw observation, but cannot be a
			// matched observation without this metadata.
			syncMS = nil
		}
		sourceTZ, sourceDate := sourceLocalMetadata(device, usage)

		periods := map[string]any{}
		if value, present := device["periods"]; present {
			var valid bool
			periods, valid = objectValue(value)
			if !valid {
				return NormalizedStats{}, errors.New("stats device periods is invalid")
			}
		}
		allTime := map[string]any{}
		if value, present := periods["allTime"]; present {
			var valid bool
			allTime, valid = objectValue(value)
			if !valid {
				return NormalizedStats{}, errors.New("stats allTime is invalid")
			}
		}
		clientCosts := map[string]any{}
		if value, present := allTime["clientCosts"]; present {
			var valid bool
			clientCosts, valid = objectValue(value)
			if !valid {
				return NormalizedStats{}, errors.New("stats clientCosts is invalid")
			}
		}
		for serviceID, amount := range clientCosts {
			// Collection-only contracts retain raw costs but do not create cost
			// observations without the dedicated observation timestamp.
			if !usagePresent || !usageValid {
				continue
			}
			cost, ok := numberValue(amount)
			if !ok || cost == "" {
				return NormalizedStats{}, errors.New("stats clientCosts value is invalid")
			}
			result.Costs = append(result.Costs, NormalizedCostObservation{
				DeviceID: deviceID, RawServiceIdentifier: serviceID, UsageUpdatedAt: usage,
				CostUSDText: cost, SyncUploadIntervalMS: cloneInt64(syncMS),
				MetadataValid:  usagePresent && usageValid && syncPresent && syncValid,
				SourceTimezone: sourceTZ, SourceLocalDate: sourceDate,
				JSONPath:         fmt.Sprintf("$.devices[%d].periods.allTime.clientCosts[%s]", deviceIndex, quotePath(serviceID)),
				DedupeKey:        fmt.Sprintf("%s\x1f%s\x1f%s", deviceID, usage.UTC().Format(time.RFC3339Nano), serviceID),
				ValueFingerprint: fingerprintCost(cost),
			})
		}
		clients, err := optionalObject(allTime, "clients")
		if err != nil {
			return NormalizedStats{}, errors.New("stats allTime clients is invalid")
		}
		clientModels, err := optionalObject(allTime, "clientModels")
		if err != nil {
			return NormalizedStats{}, errors.New("stats allTime clientModels is invalid")
		}
		clientModelCosts, err := optionalObject(allTime, "clientModelCosts")
		if err != nil {
			return NormalizedStats{}, errors.New("stats allTime clientModelCosts is invalid")
		}
		if usagePresent && usageValid {
			for _, serviceID := range sortedUnionKeys(clients, clientCosts, clientModels, clientModelCosts) {
				tokens, err := optionalNonNegativeInt64(clients[serviceID])
				if err != nil {
					return NormalizedStats{}, errors.New("stats clients value is invalid")
				}
				cost, err := optionalNumberText(clientCosts[serviceID])
				if err != nil {
					return NormalizedStats{}, errors.New("stats clientCosts value is invalid")
				}
				models, err := modelTokenValues(clientModels[serviceID])
				if err != nil {
					return NormalizedStats{}, errors.New("stats clientModels value is invalid")
				}
				modelCosts, err := modelCostValues(clientModelCosts[serviceID])
				if err != nil {
					return NormalizedStats{}, errors.New("stats clientModelCosts value is invalid")
				}
				usageObservation := NormalizedUsageObservation{
					DeviceID: deviceID, RawServiceIdentifier: serviceID, UsageUpdatedAt: usage,
					TokenCount: tokens, APICostUSDText: cost, ModelTokens: models, ModelCosts: modelCosts,
					SourceTimezone: sourceTZ, SourceLocalDate: sourceDate,
					JSONPath:  fmt.Sprintf("$.devices[%d].periods.allTime", deviceIndex),
					DedupeKey: fmt.Sprintf("%s\x1f%s\x1f%s", deviceID, usage.UTC().Format(time.RFC3339Nano), serviceID),
				}
				usageObservation.ValueFingerprint = fingerprintUsage(usageObservation)
				result.Usage = append(result.Usage, usageObservation)
			}
		}
		if usagePresent && usageValid {
			result.Periods = append(result.Periods, normalizePeriodObservations(device, deviceIndex, deviceID, usage)...)
		}

		limits := map[string]any{}
		if value, present := device["limits"]; present {
			var valid bool
			limits, valid = objectValue(value)
			if !valid {
				return NormalizedStats{}, errors.New("stats device limits is invalid")
			}
		}
		refreshMS, refreshPresent, refreshValid := positiveInteger(limits["refreshMs"])
		if refreshPresent && !refreshValid {
			refreshMS = nil
		}
		providers, hasProviders := limits["providers"].([]any)
		if !hasProviders {
			if limits["providers"] != nil {
				return NormalizedStats{}, errors.New("stats limits.providers is invalid")
			}
			continue
		}
		for providerIndex, providerItem := range providers {
			provider, ok := providerItem.(map[string]any)
			if !ok {
				return NormalizedStats{}, errors.New("stats provider is invalid")
			}
			providerID, ok := stringValue(provider["provider"])
			if !ok || providerID == "" {
				return NormalizedStats{}, errors.New("stats provider is missing")
			}
			accountKey, _ := stringValue(provider["accountKey"])
			accountKeyKind, _ := stringValue(provider["accountKeyKind"])
			accountLabel, _ := stringValue(provider["accountLabel"])
			accountEmail, _ := stringValue(provider["accountEmail"])
			providerUpdated, updatedPresent, updatedValid := timestampValue(provider["updatedAt"])
			if !updatedPresent || !updatedValid {
				return NormalizedStats{}, errors.New("stats provider updatedAt is required")
			}
			limitSourceDate := sourceDate
			if limitSourceDate == "" && sourceTZ != "" {
				if location, err := time.LoadLocation(sourceTZ); err == nil {
					limitSourceDate = providerUpdated.In(location).Format("2006-01-02")
				}
			}
			windows, hasWindows := provider["windows"].([]any)
			if !hasWindows {
				if provider["windows"] != nil {
					return NormalizedStats{}, errors.New("stats provider windows is invalid")
				}
				continue
			}
			providerStartIndex := len(result.Limits)
			windowKeys := make(map[string]int)
			for windowIndex, windowItem := range windows {
				window, ok := windowItem.(map[string]any)
				if !ok {
					return NormalizedStats{}, errors.New("stats window is invalid")
				}
				kind, _ := stringValue(window["kind"])
				metric, _ := stringValue(window["metric"])
				label, _ := stringValue(window["label"])
				normalizedKind := normalizeKeyPart(kind, true)
				normalizedMetric := normalizeKeyPart(metric, true)
				normalizedLabel := normalizeKeyPart(label, false)
				used, usedPresent, usedValid := percentValue(window["usedPercent"])
				absoluteUsed, absoluteUsedErr := optionalNumberText(window["used"])
				absoluteLimit, absoluteLimitErr := optionalNumberText(window["limit"])
				absoluteRemaining, absoluteRemainingErr := optionalNumberText(window["remaining"])
				currency, currencyPresent := stringValue(window["currency"])
				if absoluteUsedErr != nil || absoluteLimitErr != nil || absoluteRemainingErr != nil {
					return NormalizedStats{}, errors.New("stats window absolute amount is invalid")
				}
				if currencyPresent && (len(currency) == 0 || len(currency) > 8 || currency != strings.ToUpper(currency)) {
					return NormalizedStats{}, errors.New("stats window currency is invalid")
				}
				reset, resetPresent, resetValid := timestampValue(window["resetsAt"])
				if usedPresent && !usedValid {
					used = nil
				}
				if resetPresent && !resetValid {
					reset = time.Time{}
				}
				metadataValid := updatedValid && refreshPresent && refreshValid && syncPresent && syncValid &&
					kind != "" && (usedPresent && usedValid) && (resetPresent && resetValid)
				windowKey := normalizedKind + "\x1f" + normalizedMetric + "\x1f" + normalizedLabel
				windowKeys[windowKey]++
				path := fmt.Sprintf("$.devices[%d].limits.providers[%d].windows[%d]", deviceIndex, providerIndex, windowIndex)
				result.Limits = append(result.Limits, NormalizedLimitObservation{
					DeviceID: deviceID, RawServiceIdentifier: providerID, AccountKey: accountKey,
					AccountKeyKind: accountKeyKind, AccountLabel: accountLabel, AccountEmail: accountEmail,
					ProviderUpdatedAt: providerUpdated, WindowKey: windowKey,
					NormalizedKind: normalizedKind, NormalizedMetric: normalizedMetric, NormalizedLabel: normalizedLabel,
					PlanLabel: planLabel(providerID, provider), AbsoluteUsedText: absoluteUsed, AbsoluteLimitText: absoluteLimit,
					AbsoluteRemainingText: absoluteRemaining, Currency: currency,
					UsedPercent: used, ResetsAt: cloneTime(reset, resetPresent && resetValid),
					SyncUploadIntervalMS: cloneInt64(syncMS), LimitsRefreshMS: cloneInt64(refreshMS),
					MetadataValid: metadataValid, SourceTimezone: sourceTZ, SourceLocalDate: limitSourceDate,
					JSONPath:  path,
					DedupeKey: fmt.Sprintf("%s\x1f%s\x1f%s\x1f%s\x1f%s", deviceID, providerID, accountKey, providerUpdated.UTC().Format(time.RFC3339Nano), windowKey),
				})
				result.Limits[len(result.Limits)-1].ValueFingerprint = fingerprintLimit(result.Limits[len(result.Limits)-1])
			}
			for index := providerStartIndex; index < len(result.Limits); index++ {
				item := &result.Limits[index]
				if item.DeviceID == deviceID && item.RawServiceIdentifier == providerID && item.AccountKey == accountKey && item.ProviderUpdatedAt.Equal(providerUpdated) && windowKeys[item.WindowKey] > 1 {
					item.MetadataValid = false
					item.WindowKeyConflict = true
				}
			}
		}
	}
	return result, nil
}

func objectValue(value any) (map[string]any, bool) {
	if value == nil {
		return nil, false
	}
	object, ok := value.(map[string]any)
	return object, ok
}

func optionalObject(parent map[string]any, key string) (map[string]any, error) {
	value, present := parent[key]
	if !present || value == nil {
		return map[string]any{}, nil
	}
	result, ok := objectValue(value)
	if !ok {
		return nil, errors.New("value is not an object")
	}
	return result, nil
}

func sortedUnionKeys(objects ...map[string]any) []string {
	keys := make(map[string]struct{})
	for _, object := range objects {
		for key := range object {
			if key != "" {
				keys[key] = struct{}{}
			}
		}
	}
	result := make([]string, 0, len(keys))
	for key := range keys {
		result = append(result, key)
	}
	sort.Strings(result)
	return result
}

func optionalNonNegativeInt64(value any) (int64, error) {
	if value == nil {
		return 0, nil
	}
	text, ok := numberValue(value)
	if !ok {
		return 0, errors.New("value is not numeric")
	}
	var result int64
	if _, err := fmt.Sscan(text, &result); err != nil || result < 0 || fmt.Sprint(result) != text {
		return 0, errors.New("value is not a non-negative integer")
	}
	return result, nil
}

func optionalNumberText(value any) (string, error) {
	if value == nil {
		return "", nil
	}
	text, ok := numberValue(value)
	if !ok {
		return "", errors.New("value is not numeric")
	}
	if number, ok := new(big.Rat).SetString(text); !ok || number.Sign() < 0 {
		return "", errors.New("value is not a non-negative finite number")
	}
	return text, nil
}

func modelTokenValues(value any) (map[string]int64, error) {
	if value == nil {
		return map[string]int64{}, nil
	}
	object, ok := objectValue(value)
	if !ok {
		return nil, errors.New("model tokens is not an object")
	}
	result := make(map[string]int64, len(object))
	for model, raw := range object {
		if model == "" {
			return nil, errors.New("model identifier is empty")
		}
		count, err := optionalNonNegativeInt64(raw)
		if err != nil {
			return nil, err
		}
		result[model] = count
	}
	return result, nil
}

func modelCostValues(value any) (map[string]string, error) {
	if value == nil {
		return map[string]string{}, nil
	}
	object, ok := objectValue(value)
	if !ok {
		return nil, errors.New("model costs is not an object")
	}
	result := make(map[string]string, len(object))
	for model, raw := range object {
		if model == "" {
			return nil, errors.New("model identifier is empty")
		}
		cost, err := optionalNumberText(raw)
		if err != nil {
			return nil, err
		}
		result[model] = cost
	}
	return result, nil
}

func stringValue(value any) (string, bool) {
	text, ok := value.(string)
	return text, ok
}

func numberValue(value any) (string, bool) {
	number, ok := value.(json.Number)
	if !ok || number.String() == "" {
		return "", false
	}
	return number.String(), true
}

func timestampValue(value any) (time.Time, bool, bool) {
	text, present := stringValue(value)
	if !present {
		return time.Time{}, false, false
	}
	parsed, err := time.Parse(time.RFC3339Nano, text)
	return parsed.UTC(), true, err == nil
}

func nonNegativeInteger(value any) (*int64, bool, bool) {
	if value == nil {
		return nil, false, true
	}
	text, ok := numberValue(value)
	if !ok {
		return nil, true, false
	}
	var parsed int64
	if _, err := fmt.Sscan(text, &parsed); err != nil || parsed < 0 || fmt.Sprint(parsed) != text {
		return nil, true, false
	}
	return &parsed, true, true
}

func positiveInteger(value any) (*int64, bool, bool) {
	parsed, present, valid := nonNegativeInteger(value)
	return parsed, present, valid && parsed != nil && *parsed > 0
}

func percentValue(value any) (*float64, bool, bool) {
	if value == nil {
		return nil, false, false
	}
	text, ok := numberValue(value)
	if !ok {
		return nil, true, false
	}
	var parsed float64
	if _, err := fmt.Sscan(text, &parsed); err != nil || parsed < 0 || parsed > 100 {
		return nil, true, false
	}
	return &parsed, true, true
}

func cloneInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneTime(value time.Time, present bool) *time.Time {
	if !present {
		return nil
	}
	copy := value.UTC()
	return &copy
}

func normalizeKeyPart(value string, lower bool) string {
	if !utf8.ValidString(value) {
		return ""
	}
	value = strings.TrimSpace(norm.NFC.String(value))
	if lower {
		value = asciiLower(value)
	}
	return value
}

func asciiLower(value string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + ('a' - 'A')
		}
		return r
	}, value)
}

func planLabel(providerID string, provider map[string]any) string {
	value, _ := stringValue(provider["planLabel"])
	if value == "" && asciiLower(strings.TrimSpace(providerID)) == "codex" {
		value, _ = stringValue(provider["accountLabel"])
	}
	return value
}

func fingerprintCost(cost string) string {
	canonical := cost
	if number, ok := new(big.Rat).SetString(cost); ok {
		canonical = number.RatString()
	}
	hash := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(hash[:])
}

func sourceLocalMetadata(device map[string]any, observed time.Time) (string, string) {
	windows, _ := objectValue(device["periodWindows"])
	zone, _ := stringValue(windows["timeZone"])
	if zone == "" {
		return "", ""
	}
	location, err := time.LoadLocation(zone)
	if err != nil {
		return "", ""
	}
	if today, ok := objectValue(windows["today"]); ok {
		if key, valid := stringValue(today["key"]); valid && key != "" {
			if _, err := time.Parse("2006-01-02", key); err == nil {
				return zone, key
			}
		}
	}
	if !observed.IsZero() {
		return zone, observed.In(location).Format("2006-01-02")
	}
	return zone, ""
}

func quotePath(value string) string {
	// JSON object keys are escaped in the recorded path; this keeps a path
	// unambiguous without storing any value from an untrusted response in an
	// error message.
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func fingerprintLimit(value NormalizedLimitObservation) string {
	payload := struct {
		Used       *float64
		Reset      *time.Time
		Kind       string
		Metric     string
		Label      string
		PlanLabel  string
		UsedText   string
		LimitText  string
		RemainText string
		Currency   string
		RefreshMS  *int64
		SyncMS     *int64
	}{value.UsedPercent, value.ResetsAt, value.NormalizedKind, value.NormalizedMetric, value.NormalizedLabel, value.PlanLabel, value.AbsoluteUsedText, value.AbsoluteLimitText, value.AbsoluteRemainingText, value.Currency, value.LimitsRefreshMS, value.SyncUploadIntervalMS}
	encoded, _ := json.Marshal(payload)
	hash := sha256.Sum256(encoded)
	return hex.EncodeToString(hash[:])
}

func normalizePeriodObservations(device map[string]any, deviceIndex int, deviceID string, usage time.Time) []NormalizedPeriodObservation {
	windows, ok := objectValue(device["periodWindows"])
	if !ok {
		return nil
	}
	zone, _ := stringValue(windows["timeZone"])
	if zone == "" {
		return nil
	}
	if _, err := time.LoadLocation(zone); err != nil {
		return nil
	}
	periods, ok := objectValue(device["periods"])
	if !ok {
		return nil
	}
	result := make([]NormalizedPeriodObservation, 0, 2)
	if observation, ok := normalizeOnePeriod(windows, periods, "today", "day", "2006-01-02", deviceIndex, deviceID, usage, zone); ok {
		result = append(result, observation)
	}
	if observation, ok := normalizeOnePeriod(windows, periods, "month", "month", "2006-01", deviceIndex, deviceID, usage, zone); ok {
		result = append(result, observation)
	}
	return result
}

func normalizeOnePeriod(windows, periods map[string]any, windowKey, periodKind, keyLayout string, deviceIndex int, deviceID string, usage time.Time, zone string) (NormalizedPeriodObservation, bool) {
	location, err := time.LoadLocation(zone)
	if err != nil {
		return NormalizedPeriodObservation{}, false
	}
	window, ok := objectValue(windows[windowKey])
	if !ok {
		return NormalizedPeriodObservation{}, false
	}
	key, keyOK := stringValue(window["key"])
	if !keyOK || key == "" {
		return NormalizedPeriodObservation{}, false
	}
	periodStart, err := time.ParseInLocation(keyLayout, key, location)
	if err != nil {
		return NormalizedPeriodObservation{}, false
	}
	endsAt, present, valid := timestampValue(window["endsAt"])
	if !present || !valid {
		return NormalizedPeriodObservation{}, false
	}
	expectedEndsAt := periodStart.AddDate(0, 0, 1)
	if periodKind == "month" {
		expectedEndsAt = periodStart.AddDate(0, 1, 0)
	}
	if !endsAt.Equal(expectedEndsAt.UTC()) {
		return NormalizedPeriodObservation{}, false
	}
	period, ok := objectValue(periods[windowKey])
	if !ok {
		return NormalizedPeriodObservation{}, false
	}
	if _, present := period["totalTokens"]; !present {
		return NormalizedPeriodObservation{}, false
	}
	if _, present := period["costUsd"]; !present {
		return NormalizedPeriodObservation{}, false
	}
	tokens, err := optionalNonNegativeInt64(period["totalTokens"])
	if err != nil {
		return NormalizedPeriodObservation{}, false
	}
	cost, err := optionalNumberText(period["costUsd"])
	if err != nil {
		return NormalizedPeriodObservation{}, false
	}
	toolTokens, ok := optionalPeriodObject(period, "clients")
	if !ok {
		return NormalizedPeriodObservation{}, false
	}
	toolCosts, ok := optionalPeriodObject(period, "clientCosts")
	if !ok {
		return NormalizedPeriodObservation{}, false
	}
	modelTokens, ok := optionalPeriodObject(period, "models")
	if !ok {
		return NormalizedPeriodObservation{}, false
	}
	modelCosts, ok := optionalPeriodObject(period, "modelCosts")
	if !ok {
		return NormalizedPeriodObservation{}, false
	}
	clientModels, ok := optionalPeriodObject(period, "clientModels")
	if !ok {
		return NormalizedPeriodObservation{}, false
	}
	clientModelCosts, ok := optionalPeriodObject(period, "clientModelCosts")
	if !ok {
		return NormalizedPeriodObservation{}, false
	}
	tools, err := modelTokenValues(toolTokens)
	if err != nil {
		return NormalizedPeriodObservation{}, false
	}
	toolCostValues, err := modelCostValues(toolCosts)
	if err != nil {
		return NormalizedPeriodObservation{}, false
	}
	models, err := modelTokenValues(modelTokens)
	if err != nil {
		return NormalizedPeriodObservation{}, false
	}
	modelCostValues, err := modelCostValues(modelCosts)
	if err != nil {
		return NormalizedPeriodObservation{}, false
	}
	toolModels, err := nestedTokenValues(clientModels)
	if err != nil {
		return NormalizedPeriodObservation{}, false
	}
	toolModelCosts, err := nestedCostValues(clientModelCosts)
	if err != nil {
		return NormalizedPeriodObservation{}, false
	}
	observation := NormalizedPeriodObservation{
		DeviceID: deviceID, PeriodKind: periodKind, PeriodKey: key, PeriodEndsAt: endsAt, UsageUpdatedAt: usage,
		SourceTimezone: zone, TokenCount: tokens, APICostUSDText: cost,
		ToolTokens: tools, ToolCosts: toolCostValues, ModelTokens: models, ModelCosts: modelCostValues,
		ToolModelTokens: toolModels, ToolModelCosts: toolModelCosts,
		JSONPath:  fmt.Sprintf("$.devices[%d].periods.%s", deviceIndex, windowKey),
		DedupeKey: fmt.Sprintf("%s\x1f%s\x1f%s\x1f%s", deviceID, periodKind, key, usage.UTC().Format(time.RFC3339Nano)),
	}
	observation.ValueFingerprint = fingerprintPeriod(observation)
	return observation, true
}

func optionalPeriodObject(parent map[string]any, key string) (map[string]any, bool) {
	value, present := parent[key]
	if !present || value == nil {
		return map[string]any{}, true
	}
	result, ok := objectValue(value)
	return result, ok
}

func nestedTokenValues(value any) (map[string]map[string]int64, error) {
	object, ok := objectValue(value)
	if !ok {
		object = map[string]any{}
	}
	result := make(map[string]map[string]int64, len(object))
	for tool, raw := range object {
		if tool == "" {
			return nil, errors.New("tool identifier is empty")
		}
		inner, err := modelTokenValues(raw)
		if err != nil {
			return nil, err
		}
		result[tool] = inner
	}
	return result, nil
}

func nestedCostValues(value any) (map[string]map[string]string, error) {
	object, ok := objectValue(value)
	if !ok {
		object = map[string]any{}
	}
	result := make(map[string]map[string]string, len(object))
	for tool, raw := range object {
		if tool == "" {
			return nil, errors.New("tool identifier is empty")
		}
		inner, err := modelCostValues(raw)
		if err != nil {
			return nil, err
		}
		result[tool] = inner
	}
	return result, nil
}

func fingerprintPeriod(value NormalizedPeriodObservation) string {
	payload := struct {
		Kind            string
		Key             string
		EndsAt          time.Time
		Timezone        string
		Tokens          int64
		Cost            string
		ToolTokens      map[string]int64
		ToolCosts       map[string]string
		ModelTokens     map[string]int64
		ModelCosts      map[string]string
		ToolModelTokens map[string]map[string]int64
		ToolModelCosts  map[string]map[string]string
	}{value.PeriodKind, value.PeriodKey, value.PeriodEndsAt, value.SourceTimezone, value.TokenCount, value.APICostUSDText, value.ToolTokens, value.ToolCosts, value.ModelTokens, value.ModelCosts, value.ToolModelTokens, value.ToolModelCosts}
	encoded, _ := json.Marshal(payload)
	hash := sha256.Sum256(encoded)
	return hex.EncodeToString(hash[:])
}

func fingerprintUsage(value NormalizedUsageObservation) string {
	payload := struct {
		Tokens      int64
		Cost        string
		ModelTokens map[string]int64
		ModelCosts  map[string]string
	}{value.TokenCount, value.APICostUSDText, value.ModelTokens, value.ModelCosts}
	encoded, _ := json.Marshal(payload)
	hash := sha256.Sum256(encoded)
	return hex.EncodeToString(hash[:])
}
