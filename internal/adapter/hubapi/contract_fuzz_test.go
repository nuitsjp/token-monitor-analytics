package hubapi

import "testing"

func TestAPI05StatsValidationRejectsMalformedValues(t *testing.T) {
	for _, raw := range []string{
		`[]`,
		`{"devices":[{"usageUpdatedAt":1}]}`,
		`{"devices":[{"usageUpdatedAt":"2026-08-25T00:00:00Z"}],"value":1e999}`,
		`{"devices":[{"usageUpdatedAt":"2026-08-25T00:00:00Z"}]} trailing`,
	} {
		t.Run("API-05 validates JSON shape types dates and finite numbers", func(t *testing.T) {
			stats, err := parseStats([]byte(raw))
			if err == nil && requireUsageUpdatedAt(stats.Value) == nil {
				t.Fatalf("malformed stats was accepted: %q", raw)
			}
		})
	}
}

func FuzzHubJSONParsers(f *testing.F) {
	f.Add([]byte(`{"hubBuild":{"schemaVersion":1,"runtime":"node","coreBuildId":"core","runtimeBuildId":"runtime","coreRevision":1}}`))
	f.Add([]byte(`{"devices":[],"unknown":{"nested":true}}`))
	f.Add([]byte{0xef, 0xbb, 0xbf, '{', '}'})
	f.Add([]byte(`{"value":1} trailing`))

	f.Fuzz(func(t *testing.T, raw []byte) {
		_, _ = parseHealth(raw)
		_, _ = parseStats(raw)
	})
}
