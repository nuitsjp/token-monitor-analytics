package backupzip

import "testing"

func FuzzValidateManifestKeySet(f *testing.F) {
	f.Add([]byte(`{"formatVersion":1,"schemaVersion":1,"appVersion":"test","createdAt":"2026-01-01T00:00:00Z","database":{"path":"data.sqlite3","sizeBytes":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}`))
	f.Add([]byte(`{"formatVersion":1,"formatVersion":1}`))
	f.Add([]byte{0xef, 0xbb, 0xbf, '{', '}'})
	f.Add([]byte(`{"database":{"path":"data.sqlite3","unknown":true}}`))

	f.Fuzz(func(t *testing.T, raw []byte) {
		_ = validateManifestKeySet(raw)
	})
}
