//go:build windows

package credential

import (
	"crypto/rand"
	"encoding/hex"
	"testing"
)

func TestManagerKeepsSecretsIsolatedByHub(t *testing.T) {
	manager := Manager{}
	hubA := "test-" + randomSuffix(t)
	hubB := "test-" + randomSuffix(t)
	t.Cleanup(func() {
		_ = manager.Delete(hubA)
		_ = manager.Delete(hubB)
	})

	if err := manager.Write(hubA, "sentinel-A-秘密"); err != nil {
		t.Fatal(err)
	}
	if err := manager.Write(hubB, "sentinel-B-秘密"); err != nil {
		t.Fatal(err)
	}

	secretA, found, err := manager.Read(hubA)
	if err != nil || !found || secretA != "sentinel-A-秘密" {
		t.Fatalf("read hub A: found=%v secret=%q err=%v", found, secretA, err)
	}
	secretB, found, err := manager.Read(hubB)
	if err != nil || !found || secretB != "sentinel-B-秘密" {
		t.Fatalf("read hub B: found=%v secret=%q err=%v", found, secretB, err)
	}

	if err := manager.Delete(hubA); err != nil {
		t.Fatal(err)
	}
	_, found, err = manager.Read(hubA)
	if err != nil || found {
		t.Fatalf("credential remained after delete: found=%v err=%v", found, err)
	}
	secretB, found, err = manager.Read(hubB)
	if err != nil || !found || secretB != "sentinel-B-秘密" {
		t.Fatalf("deleting hub A affected hub B: found=%v secret=%q err=%v", found, secretB, err)
	}
}

func TestTargetRejectsAmbiguousHubIDs(t *testing.T) {
	for _, hubID := range []string{"", "a/b", `a\b`} {
		if _, err := Target(hubID); err == nil {
			t.Fatalf("Target(%q) succeeded", hubID)
		}
	}
}

func randomSuffix(t *testing.T) string {
	t.Helper()
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(bytes)
}
