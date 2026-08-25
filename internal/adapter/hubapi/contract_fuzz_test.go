package hubapi

import "testing"

func FuzzHubJSONParsers(f *testing.F) {
	f.Add([]byte(`{"hubBuild":{"schemaVersion":1,"runtime":"node","coreBuildId":"core","runtimeBuildId":"runtime"}}`))
	f.Add([]byte(`{"devices":[],"unknown":{"nested":true}}`))
	f.Add([]byte{0xef, 0xbb, 0xbf, '{', '}'})
	f.Add([]byte(`{"value":1} trailing`))

	f.Fuzz(func(t *testing.T, raw []byte) {
		_, _ = parseHealth(raw)
		_, _ = parseStats(raw)
	})
}
