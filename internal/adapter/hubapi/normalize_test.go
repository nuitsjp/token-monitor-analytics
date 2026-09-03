package hubapi

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestNormalizeStatsUsesContractPathsAndMetadata(t *testing.T) {
	raw := `{"devices":[{"deviceId":"device-1","updatedAt":"2026-08-25T11:36:00Z","periodWindows":{"timeZone":"Asia/Tokyo","today":{"key":"2026-08-25"}},"periods":{"allTime":{"clientCosts":{"codex":1.0}}},"syncUploadIntervalMs":0,"limits":{"refreshMs":300000,"providers":[{"provider":"codex","accountKey":"account","accountKeyKind":"oidc-subject-v1","accountLabel":"Personal","accountEmail":"person@example.test","planLabel":"Plus","updatedAt":"2026-08-25T11:35:00Z","windows":[{"kind":" WEEKLY ","metric":"PER CENT","label":" Cafe\u0301 ","usedPercent":42,"resetsAt":"2026-09-01T00:00:00Z"}]}]}}]}`
	result, err := NormalizeStats([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	t.Run("API-03 fixed contract paths", func(t *testing.T) {
		if len(result.Costs) != 1 || result.Costs[0].JSONPath != `$.devices[0].periods.allTime.clientCosts["codex"]` {
			t.Fatalf("unexpected cost: %+v", result.Costs)
		}
		if result.Costs[0].UsageUpdatedAt.IsZero() {
			t.Fatal("cost usageUpdatedAt was not retained")
		}
	})
	t.Run("API-COST-01 device and raw service identify cost source", func(t *testing.T) {
		if result.Costs[0].DeviceID != "device-1" || result.Costs[0].RawServiceIdentifier != "codex" {
			t.Fatalf("cost identity = %+v", result.Costs[0])
		}
	})
	t.Run("API-COST-02 uses allTime clientCosts", func(t *testing.T) {
		if !strings.Contains(result.Costs[0].JSONPath, ".periods.allTime.clientCosts") {
			t.Fatalf("cost path = %q", result.Costs[0].JSONPath)
		}
	})
	t.Run("API-COST-03 uses device updatedAt", func(t *testing.T) {
		if !result.Costs[0].UsageUpdatedAt.Equal(time.Date(2026, 8, 25, 11, 36, 0, 0, time.UTC)) {
			t.Fatalf("cost observed at = %s", result.Costs[0].UsageUpdatedAt)
		}
	})
	t.Run("API-COST-04 records device usage timestamp", func(t *testing.T) {
		if result.Costs[0].UsageUpdatedAt.IsZero() || result.Costs[0].MetadataValid != true {
			t.Fatalf("cost metadata = %+v", result.Costs[0])
		}
	})
	t.Run("API-COST-07 accepts live upload interval zero", func(t *testing.T) {
		if result.Costs[0].SyncUploadIntervalMS == nil || *result.Costs[0].SyncUploadIntervalMS != 0 {
			t.Fatalf("sync interval = %+v", result.Costs[0].SyncUploadIntervalMS)
		}
	})
	t.Run("API-LIMIT-01 source includes account and window", func(t *testing.T) {
		limit := result.Limits[0]
		if limit.DeviceID != "device-1" || limit.RawServiceIdentifier != "codex" || limit.AccountKey != "account" || limit.WindowKey == "" {
			t.Fatalf("limit source identity = %+v", limit)
		}
	})
	t.Run("API-LIMIT-02 uses provider identifier", func(t *testing.T) {
		if result.Limits[0].RawServiceIdentifier != "codex" {
			t.Fatalf("provider identifier = %q", result.Limits[0].RawServiceIdentifier)
		}
	})
	t.Run("API-LIMIT-09 preserves account identity metadata as evidence", func(t *testing.T) {
		limit := result.Limits[0]
		if limit.AccountKeyKind != "oidc-subject-v1" || limit.AccountLabel != "Personal" || limit.AccountEmail != "person@example.test" {
			t.Fatalf("account identity metadata = %+v", limit)
		}
	})
	t.Run("API-LIMIT-03 uses provider updatedAt", func(t *testing.T) {
		if !result.Limits[0].ProviderUpdatedAt.Equal(time.Date(2026, 8, 25, 11, 35, 0, 0, time.UTC)) {
			t.Fatalf("provider observed at = %s", result.Limits[0].ProviderUpdatedAt)
		}
	})
	t.Run("API-LIMIT-05 uses planLabel", func(t *testing.T) {
		if result.Limits[0].PlanLabel != "Plus" {
			t.Fatalf("plan label = %q", result.Limits[0].PlanLabel)
		}
	})
	t.Run("API-LIMIT-06 requires positive refresh and valid sync metadata", func(t *testing.T) {
		limit := result.Limits[0]
		if limit.LimitsRefreshMS == nil || *limit.LimitsRefreshMS != 300000 || limit.SyncUploadIntervalMS == nil || *limit.SyncUploadIntervalMS != 0 || !limit.MetadataValid {
			t.Fatalf("limit metadata = %+v", limit)
		}
	})
	t.Run("API-LIMIT-07 preserves bounded used percent", func(t *testing.T) {
		if result.Limits[0].UsedPercent == nil || *result.Limits[0].UsedPercent != 42 {
			t.Fatalf("used percent = %+v", result.Limits[0].UsedPercent)
		}
	})
	t.Run("API-NORM-01 preserves raw service and plan strings", func(t *testing.T) {
		if result.Costs[0].RawServiceIdentifier != "codex" || result.Limits[0].PlanLabel != "Plus" {
			t.Fatalf("raw strings changed: cost=%q plan=%q", result.Costs[0].RawServiceIdentifier, result.Limits[0].PlanLabel)
		}
	})
	t.Run("API-NORM-02 normalizes key parts and NFC label", func(t *testing.T) {
		limit := result.Limits[0]
		if limit.NormalizedKind != "weekly" || limit.NormalizedMetric != "per cent" || limit.NormalizedLabel != "Café" {
			t.Fatalf("limit normalization = %+v", limit)
		}
	})
	t.Run("API-NORM-04 stores UTC instants", func(t *testing.T) {
		if result.Limits[0].ProviderUpdatedAt.Location() != time.UTC || result.Costs[0].UsageUpdatedAt.Location() != time.UTC {
			t.Fatalf("timestamps are not UTC: cost=%v limit=%v", result.Costs[0].UsageUpdatedAt.Location(), result.Limits[0].ProviderUpdatedAt.Location())
		}
	})
}

func TestQLTime03PreservesSourceTimezoneAndDoesNotUseDisplayTimezone(t *testing.T) {
	validRaw := `{"devices":[{"deviceId":"device-1","updatedAt":"2026-08-25T11:36:00Z","periodWindows":{"timeZone":"Asia/Tokyo","today":{"key":"2026-08-25"}},"periods":{"allTime":{"clientCosts":{"codex":1.0}}},"syncUploadIntervalMs":0,"limits":{"refreshMs":300000,"providers":[{"provider":"codex","accountKey":"account","updatedAt":"2026-08-25T11:35:00Z","windows":[{"kind":"weekly","usedPercent":42,"resetsAt":"2026-09-01T00:00:00Z"}]}]}}]}`
	unknownRaw := `{"devices":[{"deviceId":"device-1","updatedAt":"2026-08-25T11:36:00Z","periodWindows":{"timeZone":"Unknown/Display-Replacement","today":{"key":"2026-08-25"}},"periods":{"allTime":{"clientCosts":{"codex":1.0}}},"syncUploadIntervalMs":0,"limits":{"refreshMs":300000,"providers":[{"provider":"codex","accountKey":"account","updatedAt":"2026-08-25T11:35:00Z","windows":[{"kind":"weekly","usedPercent":42,"resetsAt":"2026-09-01T00:00:00Z"}]}]}}]}`
	valid, err := NormalizeStats([]byte(validRaw))
	if err != nil {
		t.Fatal(err)
	}
	unknown, err := NormalizeStats([]byte(unknownRaw))
	if err != nil {
		t.Fatal(err)
	}
	t.Run("QL-TIME-03 source zone/date are retained and unknown zone stays unknown", func(t *testing.T) {
		if len(valid.Costs) != 1 || valid.Costs[0].SourceTimezone != "Asia/Tokyo" || valid.Costs[0].SourceLocalDate != "2026-08-25" {
			t.Fatalf("valid cost source metadata = %+v", valid.Costs)
		}
		if len(valid.Limits) != 1 || valid.Limits[0].SourceTimezone != "Asia/Tokyo" || valid.Limits[0].SourceLocalDate != "2026-08-25" {
			t.Fatalf("valid limit source metadata = %+v", valid.Limits)
		}
		if len(unknown.Costs) != 1 || unknown.Costs[0].SourceTimezone != "" || unknown.Costs[0].SourceLocalDate != "" {
			t.Fatalf("unknown cost source metadata was replaced: %+v", unknown.Costs)
		}
		if len(unknown.Limits) != 1 || unknown.Limits[0].SourceTimezone != "" || unknown.Limits[0].SourceLocalDate != "" {
			t.Fatalf("unknown limit source metadata was replaced: %+v", unknown.Limits)
		}
	})
}

func TestNormalizeStatsMissingSyncMetadataMeansLiveForSupportedLocalContract(t *testing.T) {
	raw := `{"devices":[{"deviceId":"device-1","updatedAt":"2026-08-25T11:36:00Z","periods":{"allTime":{"clientCosts":{"codex":1}}},"limits":{"refreshMs":300000,"providers":[{"provider":"codex","updatedAt":"2026-08-25T11:35:00Z","windows":[{"kind":"weekly","usedPercent":42,"resetsAt":"2026-09-01T00:00:00Z"}]}]}}]}`
	result, err := NormalizeStats([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	t.Run("API-COST-07 missing sync metadata is normalized to live zero", func(t *testing.T) {
		if !result.Costs[0].MetadataValid || !result.Limits[0].MetadataValid || result.Costs[0].SyncUploadIntervalMS == nil || *result.Costs[0].SyncUploadIntervalMS != 0 {
			t.Fatalf("missing sync metadata was not normalized: %+v %+v", result.Costs[0], result.Limits[0])
		}
	})
}

func TestNormalizeStatsRejectsMissingProviderTimestamp(t *testing.T) {
	raw := `{"devices":[{"deviceId":"device-1","limits":{"refreshMs":300000,"providers":[{"provider":"codex","windows":[]}]}}]}`
	_, err := NormalizeStats([]byte(raw))
	t.Run("API-LIMIT-03 rejects missing provider timestamp", func(t *testing.T) {
		if err == nil || !strings.Contains(err.Error(), "updatedAt") {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestNormalizeStatsMarksDuplicateWindowKeyConflict(t *testing.T) {
	raw := `{"devices":[{"deviceId":"device-1","syncUploadIntervalMs":600000,"limits":{"refreshMs":300000,"providers":[{"provider":"codex","updatedAt":"2026-08-25T11:35:00Z","windows":[{"kind":"weekly","metric":"percent","label":"Plan","usedPercent":42,"resetsAt":"2026-09-01T00:00:00Z"},{"kind":"weekly","metric":"percent","label":"Plan","usedPercent":43,"resetsAt":"2026-09-01T00:00:00Z"}]}]}}]}`
	result, err := NormalizeStats([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	t.Run("API-NORM-03 duplicate normalized window is uncomputable", func(t *testing.T) {
		if len(result.Limits) != 2 || !result.Limits[0].WindowKeyConflict || !result.Limits[1].WindowKeyConflict || result.Limits[0].MetadataValid || result.Limits[1].MetadataValid {
			t.Fatalf("duplicate window state = %+v", result.Limits)
		}
	})
}

func TestNormalizeStatsDoesNotCrossAccountWindowConflict(t *testing.T) {
	raw := `{"devices":[{"deviceId":"device-1","syncUploadIntervalMs":600000,"limits":{"refreshMs":300000,"providers":[{"provider":"codex","accountKey":"account-a","updatedAt":"2026-08-25T11:35:00Z","windows":[{"kind":"weekly","metric":"percent","label":"Plan","usedPercent":42,"resetsAt":"2026-09-01T00:00:00Z"}]},{"provider":"codex","accountKey":"account-b","updatedAt":"2026-08-25T11:35:00Z","windows":[{"kind":"weekly","metric":"percent","label":"Plan","usedPercent":43,"resetsAt":"2026-09-01T00:00:00Z"}]}]}}]}`
	result, err := NormalizeStats([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	t.Run("API-LIMIT-04 keeps account-key distinctions", func(t *testing.T) {
		if len(result.Limits) != 2 || result.Limits[0].WindowKeyConflict || result.Limits[1].WindowKeyConflict || !result.Limits[0].MetadataValid || !result.Limits[1].MetadataValid {
			t.Fatalf("cross-account conflict = %+v", result.Limits)
		}
		if result.Limits[0].DedupeKey == result.Limits[1].DedupeKey {
			t.Fatal("distinct accounts shared a dedupe key")
		}
	})
}

func TestNormalizeStatsCostFingerprintUsesNumericValue(t *testing.T) {
	one, err := NormalizeStats([]byte(`{"devices":[{"deviceId":"d","updatedAt":"2026-08-25T00:00:00Z","syncUploadIntervalMs":0,"periods":{"allTime":{"clientCosts":{"codex":1}}}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	onePointZero, err := NormalizeStats([]byte(`{"devices":[{"deviceId":"d","updatedAt":"2026-08-25T00:00:00Z","syncUploadIntervalMs":0,"periods":{"allTime":{"clientCosts":{"codex":1.0}}}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	t.Run("API-NORM-01 canonicalizes numeric value fingerprint only", func(t *testing.T) {
		if one.Costs[0].DedupeKey != onePointZero.Costs[0].DedupeKey || one.Costs[0].ValueFingerprint != onePointZero.Costs[0].ValueFingerprint {
			t.Fatalf("numeric equivalents differ: %+v %+v", one.Costs[0], onePointZero.Costs[0])
		}
	})
}

func TestNormalizeStatsUnknownFieldsDoNotChangeExtraction(t *testing.T) {
	baseRaw := `{"devices":[{"deviceId":"device-1","updatedAt":"2026-08-25T11:36:00Z","syncUploadIntervalMs":0,"periods":{"allTime":{"clientCosts":{"codex":1.5}}},"limits":{"refreshMs":300000,"providers":[{"provider":"codex","accountKey":"account","planLabel":"Plus","updatedAt":"2026-08-25T11:35:00Z","windows":[{"kind":"weekly","metric":"percent","label":"Weekly","usedPercent":42,"resetsAt":"2026-09-01T00:00:00Z"}]}]}}]}`
	withUnknownFields := `{"devices":[{"deviceId":"device-1","updatedAt":"2026-08-25T11:36:00Z","syncUploadIntervalMs":0,"periods":{"allTime":{"clientCosts":{"codex":1.5}},"futurePeriod":{"newMetric":99}},"limits":{"refreshMs":300000,"providers":[{"provider":"codex","accountKey":"account","planLabel":"Plus","updatedAt":"2026-08-25T11:35:00Z","windows":[{"kind":"weekly","metric":"percent","label":"Weekly","usedPercent":42,"resetsAt":"2026-09-01T00:00:00Z","futureField":{"nested":true}}],"futureProviderField":"ignored"}],"futureLimitField":true},"futureDeviceField":[1,2,3]}],"futureRootField":{"retained":true}}`
	base, err := NormalizeStats([]byte(baseRaw))
	if err != nil {
		t.Fatal(err)
	}
	withUnknown, err := NormalizeStats([]byte(withUnknownFields))
	if err != nil {
		t.Fatal(err)
	}
	t.Run("QL-REP-03 unknown fields preserve the existing extraction meaning", func(t *testing.T) {
		if !reflect.DeepEqual(base.Costs, withUnknown.Costs) || !reflect.DeepEqual(base.Usage, withUnknown.Usage) || !reflect.DeepEqual(base.Limits, withUnknown.Limits) {
			t.Fatalf("unknown fields changed normalized output: base=%+v extended=%+v", base, withUnknown)
		}
	})
}

func TestNormalizeStatsExtractsPhaseTwoUsageAndNativeAmounts(t *testing.T) {
	raw := `{"devices":[{"deviceId":"device-1","updatedAt":"2026-08-25T11:36:00Z","periodWindows":{"timeZone":"Asia/Tokyo","today":{"key":"2026-08-25"}},"periods":{"allTime":{"clients":{"codex":120},"clientCosts":{"codex":2.75},"clientModels":{"codex":{"gpt-5":100,"gpt-5-mini":20}},"clientModelCosts":{"codex":{"gpt-5":2.5,"gpt-5-mini":0.25}}}},"limits":{"providers":[{"provider":"codex","updatedAt":"2026-08-25T11:35:00Z","windows":[{"kind":"balance","metric":"credits","label":"Credits","used":58,"limit":100,"remaining":42,"currency":"CREDITS"}]}]}}]}`
	result, err := NormalizeStats([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	t.Run("P2-USAGE-01 extracts cumulative totals and model breakdown", func(t *testing.T) {
		if len(result.Usage) != 1 || result.Usage[0].TokenCount != 120 || result.Usage[0].APICostUSDText != "2.75" || result.Usage[0].ModelTokens["gpt-5"] != 100 || result.Usage[0].ModelCosts["gpt-5-mini"] != "0.25" {
			t.Fatalf("usage = %#v", result.Usage)
		}
	})
	t.Run("P2-USAGE-06 keeps native amount and currency", func(t *testing.T) {
		if len(result.Limits) != 1 || result.Limits[0].AbsoluteUsedText != "58" || result.Limits[0].AbsoluteLimitText != "100" || result.Limits[0].AbsoluteRemainingText != "42" || result.Limits[0].Currency != "CREDITS" {
			t.Fatalf("limit amount = %#v", result.Limits)
		}
	})
}

func TestNormalizeStatsExtractsSourcePeriodObservations(t *testing.T) {
	raw := `{"devices":[{"deviceId":"device-1","updatedAt":"2026-09-03T05:25:00Z","periodWindows":{"timeZone":"Asia/Tokyo","today":{"key":"2026-09-03","endsAt":"2026-09-03T15:00:00Z"},"month":{"key":"2026-09","endsAt":"2026-09-30T15:00:00Z"}},"periods":{"today":{"totalTokens":100,"costUsd":1.25,"clients":{"codex":80,"claude":20},"clientCosts":{"codex":1,"claude":0.25},"models":{"gpt-5":80,"opus":20},"modelCosts":{"gpt-5":1,"opus":0.25},"clientModels":{"codex":{"gpt-5":80}},"clientModelCosts":{"codex":{"gpt-5":1}}},"month":{"totalTokens":500,"costUsd":6.5},"allTime":{"clientCosts":{"codex":10}}},"limits":{"refreshMs":300000,"providers":[{"provider":"codex","accountKey":"account","updatedAt":"2026-09-03T05:25:00Z","windows":[{"kind":"weekly","metric":"percent","label":"Weekly","usedPercent":42,"resetsAt":"2026-09-10T00:00:00Z"}]}]}}]}`
	result, err := NormalizeStats([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Periods) != 2 {
		t.Fatalf("periods = %#v", result.Periods)
	}
	day, month := result.Periods[0], result.Periods[1]
	if day.PeriodKind != "day" || day.PeriodKey != "2026-09-03" || day.SourceTimezone != "Asia/Tokyo" || day.TokenCount != 100 || day.APICostUSDText != "1.25" || day.ToolTokens["codex"] != 80 || day.ModelTokens["opus"] != 20 || day.ToolModelTokens["codex"]["gpt-5"] != 80 || day.JSONPath != "$.devices[0].periods.today" {
		t.Fatalf("day period = %#v", day)
	}
	if month.PeriodKind != "month" || month.PeriodKey != "2026-09" || month.TokenCount != 500 || month.JSONPath != "$.devices[0].periods.month" {
		t.Fatalf("month period = %#v", month)
	}
	if !day.PeriodEndsAt.Equal(time.Date(2026, 9, 3, 15, 0, 0, 0, time.UTC)) {
		t.Fatalf("day endsAt = %s", day.PeriodEndsAt)
	}
}

func TestNormalizeStatsSkipsInvalidSourcePeriodsWithoutFailing(t *testing.T) {
	raw := `{"devices":[{"deviceId":"device-1","updatedAt":"2026-09-03T05:25:00Z","periodWindows":{"timeZone":"Not/AZone","today":{"key":"2026-09-03","endsAt":"2026-09-03T15:00:00Z"}},"periods":{"today":{"totalTokens":100,"costUsd":1},"allTime":{"clientCosts":{"codex":1}}},"limits":{"refreshMs":300000,"providers":[{"provider":"codex","accountKey":"account","updatedAt":"2026-09-03T05:25:00Z","windows":[{"kind":"weekly","metric":"percent","label":"Weekly","usedPercent":42,"resetsAt":"2026-09-10T00:00:00Z"}]}]}}]}`
	result, err := NormalizeStats([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Periods) != 0 || len(result.Costs) != 1 {
		t.Fatalf("invalid timezone should skip periods only: periods=%#v costs=%#v", result.Periods, result.Costs)
	}
	missingEnds := `{"devices":[{"deviceId":"device-1","updatedAt":"2026-09-03T05:25:00Z","periodWindows":{"timeZone":"Asia/Tokyo","today":{"key":"2026-09-03"},"month":{"key":"2026-09","endsAt":"2026-09-30T15:00:00Z"}},"periods":{"today":{"totalTokens":100,"costUsd":1},"month":{"totalTokens":500,"costUsd":6},"allTime":{"clientCosts":{"codex":1}}},"limits":{"refreshMs":300000,"providers":[{"provider":"codex","accountKey":"account","updatedAt":"2026-09-03T05:25:00Z","windows":[{"kind":"weekly","metric":"percent","label":"Weekly","usedPercent":42,"resetsAt":"2026-09-10T00:00:00Z"}]}]}}]}`
	result, err = NormalizeStats([]byte(missingEnds))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Periods) != 1 || result.Periods[0].PeriodKind != "month" {
		t.Fatalf("missing endsAt should skip only that period: %#v", result.Periods)
	}
	mismatchedEnds := `{"devices":[{"deviceId":"device-1","updatedAt":"2026-09-03T05:25:00Z","periodWindows":{"timeZone":"Asia/Tokyo","today":{"key":"2026-09-03","endsAt":"2026-09-04T15:00:00Z"},"month":{"key":"2026-09","endsAt":"2026-10-31T15:00:00Z"}},"periods":{"today":{"totalTokens":100,"costUsd":1},"month":{"totalTokens":500,"costUsd":6},"allTime":{"clientCosts":{"codex":1}}},"limits":{"refreshMs":300000,"providers":[{"provider":"codex","accountKey":"account","updatedAt":"2026-09-03T05:25:00Z","windows":[{"kind":"weekly","metric":"percent","label":"Weekly","usedPercent":42,"resetsAt":"2026-09-10T00:00:00Z"}]}]}}]}`
	result, err = NormalizeStats([]byte(mismatchedEnds))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Periods) != 0 {
		t.Fatalf("endsAt that does not match the source calendar key must be skipped: %#v", result.Periods)
	}
}

func TestNormalizeStatsAcceptsSourcePeriodEndAcrossDST(t *testing.T) {
	raw := `{"devices":[{"deviceId":"device-1","updatedAt":"2026-03-08T16:00:00Z","periodWindows":{"timeZone":"America/New_York","today":{"key":"2026-03-08","endsAt":"2026-03-09T04:00:00Z"}},"periods":{"today":{"totalTokens":100,"costUsd":1},"allTime":{}},"limits":{}}]}`

	result, err := NormalizeStats([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Periods) != 1 || result.Periods[0].PeriodKey != "2026-03-08" {
		t.Fatalf("DST source period was not preserved: %#v", result.Periods)
	}
}

func TestNormalizeStatsKeepsLimitsWithoutDeviceUpdatedAt(t *testing.T) {
	raw := `{"devices":[{"deviceId":"device-1","periods":{"allTime":{"clientCosts":{"codex":1.5}}},"limits":{"refreshMs":300000,"providers":[{"provider":"codex","accountKey":"account","updatedAt":"2026-08-25T11:35:00Z","windows":[{"kind":"weekly","metric":"percent","label":"Weekly","usedPercent":42,"resetsAt":"2026-09-01T00:00:00Z"}]}]}}]}`
	result, err := NormalizeStats([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Costs) != 0 {
		t.Fatalf("cost observations = %d, want 0", len(result.Costs))
	}
	if len(result.Limits) != 1 {
		t.Fatalf("limit observations = %d, want 1", len(result.Limits))
	}
}

func TestNormalizeStatsUsesWindowSemanticsAndProviderScopedPlanEvidence(t *testing.T) {
	raw := `{"devices":[{"deviceId":"device-1","updatedAt":"2026-09-02T00:00:00Z","limits":{"refreshMs":300000,"providers":[{"provider":"codex","accountKey":"codex-account","accountLabel":"Pro 5x","updatedAt":"2026-09-02T00:00:00Z","windows":[{"limitId":"weekly-spark","kind":"weekly","metric":"percent","label":"Weekly","usedPercent":10,"resetsAt":"2026-09-09T00:00:00Z"}]},{"provider":"cursor","accountKey":"cursor-account","accountLabel":"person@example.com","updatedAt":"2026-09-02T00:00:00Z","windows":[{"limitId":"weekly-models","kind":"weekly","metric":"percent","label":"Weekly","usedPercent":20,"resetsAt":"2026-09-09T00:00:00Z"}]}]}}]}`
	result, err := NormalizeStats([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Limits) != 2 {
		t.Fatalf("limits = %+v", result.Limits)
	}
	if result.Limits[0].WindowKey != "weekly\x1fpercent\x1fWeekly" || result.Limits[0].PlanLabel != "Pro 5x" {
		t.Fatalf("Codex evidence = %+v", result.Limits[0])
	}
	if result.Limits[1].WindowKey != "weekly\x1fpercent\x1fWeekly" || result.Limits[1].PlanLabel != "" {
		t.Fatalf("Cursor account label leaked into plan evidence: %+v", result.Limits[1])
	}
}

func TestNormalizeStatsDoesNotMergeDifferentWindowsThatShareLimitID(t *testing.T) {
	raw := `{"devices":[{"deviceId":"device-1","updatedAt":"2026-09-02T00:00:00Z","limits":{"refreshMs":300000,"providers":[{"provider":"codex","accountKey":"account","updatedAt":"2026-09-02T00:00:00Z","windows":[{"limitId":"shared","kind":"session","metric":"percent","label":"Spark","usedPercent":10,"resetsAt":"2026-09-02T05:00:00Z"},{"limitId":"shared","kind":"weekly","metric":"percent","label":"Spark","usedPercent":20,"resetsAt":"2026-09-09T00:00:00Z"}]}]}}]}`
	result, err := NormalizeStats([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Limits) != 2 || result.Limits[0].WindowKey == result.Limits[1].WindowKey {
		t.Fatalf("shared limitId merged distinct windows: %+v", result.Limits)
	}
	for _, item := range result.Limits {
		if item.WindowKeyConflict {
			t.Fatalf("semantic window key conflicted: %+v", item)
		}
	}
}
