package hubapi

import (
	"strings"
	"testing"
)

func TestNormalizeStatsUsesContractPathsAndMetadata(t *testing.T) {
	raw := `{"devices":[{"deviceId":"device-1","usageUpdatedAt":"2026-08-25T11:36:00Z","periodWindows":{"timeZone":"Asia/Tokyo","today":{"key":"2026-08-25"}},"periods":{"allTime":{"clientCosts":{"codex":1.0}}},"syncUploadIntervalMs":0,"limits":{"refreshMs":300000,"providers":[{"provider":"codex","accountKey":"account","planLabel":"Plus","updatedAt":"2026-08-25T11:35:00Z","windows":[{"kind":" WEEKLY ","metric":"PER CENT","label":" Cafe\u0301 ","usedPercent":42,"resetsAt":"2026-09-01T00:00:00Z"}]}]}}]}`
	result, err := NormalizeStats([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Costs) != 1 || result.Costs[0].JSONPath != `$.devices[0].periods.allTime.clientCosts["codex"]` {
		t.Fatalf("unexpected cost: %+v", result.Costs)
	}
	if result.Costs[0].MetadataValid != true || result.Costs[0].SourceTimezone != "Asia/Tokyo" || result.Costs[0].SourceLocalDate != "2026-08-25" {
		t.Fatalf("cost metadata = %+v", result.Costs[0])
	}
	if len(result.Limits) != 1 {
		t.Fatalf("limit count = %d", len(result.Limits))
	}
	limit := result.Limits[0]
	if limit.NormalizedKind != "weekly" || limit.NormalizedMetric != "per cent" || limit.NormalizedLabel != "Café" || limit.PlanLabel != "Plus" || !limit.MetadataValid {
		t.Fatalf("limit normalization = %+v", limit)
	}
}

func TestNormalizeStatsMissingSyncMetadataCannotMatch(t *testing.T) {
	raw := `{"devices":[{"deviceId":"device-1","usageUpdatedAt":"2026-08-25T11:36:00Z","periods":{"allTime":{"clientCosts":{"codex":1}}},"limits":{"refreshMs":300000,"providers":[{"provider":"codex","updatedAt":"2026-08-25T11:35:00Z","windows":[{"kind":"weekly","usedPercent":42,"resetsAt":"2026-09-01T00:00:00Z"}]}]}}]}`
	result, err := NormalizeStats([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if result.Costs[0].MetadataValid || result.Limits[0].MetadataValid {
		t.Fatalf("missing sync metadata was accepted: %+v %+v", result.Costs[0], result.Limits[0])
	}
}

func TestNormalizeStatsRejectsMissingProviderTimestamp(t *testing.T) {
	raw := `{"devices":[{"deviceId":"device-1","limits":{"refreshMs":300000,"providers":[{"provider":"codex","windows":[]}]}}]}`
	_, err := NormalizeStats([]byte(raw))
	if err == nil || !strings.Contains(err.Error(), "updatedAt") {
		t.Fatalf("error = %v", err)
	}
}

func TestNormalizeStatsMarksDuplicateWindowKeyConflict(t *testing.T) {
	raw := `{"devices":[{"deviceId":"device-1","syncUploadIntervalMs":600000,"limits":{"refreshMs":300000,"providers":[{"provider":"codex","updatedAt":"2026-08-25T11:35:00Z","windows":[{"kind":"weekly","metric":"percent","label":"Plan","usedPercent":42,"resetsAt":"2026-09-01T00:00:00Z"},{"kind":"weekly","metric":"percent","label":"Plan","usedPercent":43,"resetsAt":"2026-09-01T00:00:00Z"}]}]}}]}`
	result, err := NormalizeStats([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Limits) != 2 || !result.Limits[0].WindowKeyConflict || !result.Limits[1].WindowKeyConflict || result.Limits[0].MetadataValid || result.Limits[1].MetadataValid {
		t.Fatalf("duplicate window state = %+v", result.Limits)
	}
}

func TestNormalizeStatsDoesNotCrossAccountWindowConflict(t *testing.T) {
	raw := `{"devices":[{"deviceId":"device-1","syncUploadIntervalMs":600000,"limits":{"refreshMs":300000,"providers":[{"provider":"codex","accountKey":"account-a","updatedAt":"2026-08-25T11:35:00Z","windows":[{"kind":"weekly","metric":"percent","label":"Plan","usedPercent":42,"resetsAt":"2026-09-01T00:00:00Z"}]},{"provider":"codex","accountKey":"account-b","updatedAt":"2026-08-25T11:35:00Z","windows":[{"kind":"weekly","metric":"percent","label":"Plan","usedPercent":43,"resetsAt":"2026-09-01T00:00:00Z"}]}]}}]}`
	result, err := NormalizeStats([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Limits) != 2 || result.Limits[0].WindowKeyConflict || result.Limits[1].WindowKeyConflict || !result.Limits[0].MetadataValid || !result.Limits[1].MetadataValid {
		t.Fatalf("cross-account conflict = %+v", result.Limits)
	}
	if result.Limits[0].DedupeKey == result.Limits[1].DedupeKey {
		t.Fatal("distinct accounts shared a dedupe key")
	}
}

func TestNormalizeStatsCostFingerprintUsesNumericValue(t *testing.T) {
	one, err := NormalizeStats([]byte(`{"devices":[{"deviceId":"d","usageUpdatedAt":"2026-08-25T00:00:00Z","syncUploadIntervalMs":0,"periods":{"allTime":{"clientCosts":{"codex":1}}}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	onePointZero, err := NormalizeStats([]byte(`{"devices":[{"deviceId":"d","usageUpdatedAt":"2026-08-25T00:00:00Z","syncUploadIntervalMs":0,"periods":{"allTime":{"clientCosts":{"codex":1.0}}}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if one.Costs[0].DedupeKey != onePointZero.Costs[0].DedupeKey || one.Costs[0].ValueFingerprint != onePointZero.Costs[0].ValueFingerprint {
		t.Fatalf("numeric equivalents differ: %+v %+v", one.Costs[0], onePointZero.Costs[0])
	}
}
