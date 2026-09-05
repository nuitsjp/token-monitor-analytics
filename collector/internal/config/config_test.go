package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestURLs(t *testing.T) {
	for _, u := range []string{"https://a.workers.dev", "http://127.0.0.1:8765", "http://[::1]:8080"} {
		if e := ValidateBaseURL(u); e != nil {
			t.Errorf("%s: %v", u, e)
		}
	}
	for _, u := range []string{"http://example.com", "https://secret@example.com", "https://a/api/stats", "https://a?secret=x", "file:///etc/passwd"} {
		if ValidateBaseURL(u) == nil {
			t.Errorf("accepted %s", u)
		}
	}
}
func TestLoadAndSecret(t *testing.T) {
	t.Setenv("HUB", "secret")
	t.Setenv("INGEST", "12345678901234567890")
	dir := t.TempDir()
	p := filepath.Join(dir, "config.json")
	os.WriteFile(p, []byte(`{"version":1,"hubs":[{"id":"a","url":"https://a.workers.dev","secret_env":"HUB"}],"analytics_url":"https://analytics.workers.dev","ingest_token_env":"INGEST"}`), 0600)
	c, e := Load(p)
	if e != nil {
		t.Fatal(e)
	}
	if c.BatchSize != 2 || c.FlushSeconds != 2 || !filepath.IsAbs(c.SpoolDir) {
		t.Fatalf("bad defaults: %+v", c)
	}
	t.Setenv("HUB", "")
	if _, e = Load(p); e == nil {
		t.Fatal("accepted missing secret")
	}
}
func TestRejectTrailingJSON(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.json")
	os.WriteFile(p, []byte(`{} {}`), 0600)
	if _, e := Load(p); e == nil {
		t.Fatal("trailing JSON accepted")
	}
}
func TestSecretNewline(t *testing.T) {
	t.Setenv("S", "abc\ndef")
	if _, e := Secret("S"); e == nil {
		t.Fatal("header injection")
	}
}
