//go:build windows

package credential

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"testing"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
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

func TestManagerReportsNativeAPIFailuresAndAcceptsMissingDelete(t *testing.T) {
	originalWrite := credentialWriteCall
	originalRead := credentialReadCall
	originalDelete := credentialDeleteCall
	t.Cleanup(func() {
		credentialWriteCall = originalWrite
		credentialReadCall = originalRead
		credentialDeleteCall = originalDelete
	})
	manager := Manager{}

	credentialWriteCall = func(...uintptr) (uintptr, uintptr, error) {
		return 0, 0, windows.ERROR_ACCESS_DENIED
	}
	if err := manager.Write("native-failure", "secret"); err == nil || !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatalf("write error = %v", err)
	}

	credentialReadCall = func(...uintptr) (uintptr, uintptr, error) {
		return 0, 0, windows.ERROR_ACCESS_DENIED
	}
	if _, found, err := manager.Read("native-failure"); err == nil || found || !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatalf("read found/error = %v/%v", found, err)
	}

	credentialDeleteCall = func(...uintptr) (uintptr, uintptr, error) {
		return 0, 0, windows.ERROR_ACCESS_DENIED
	}
	if err := manager.Delete("native-failure"); err == nil || !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatalf("delete error = %v", err)
	}
	credentialDeleteCall = func(...uintptr) (uintptr, uintptr, error) {
		return 0, 0, windows.ERROR_NOT_FOUND
	}
	if err := manager.Delete("native-failure"); err != nil {
		t.Fatalf("delete missing credential: %v", err)
	}
}

func TestManagerRejectsInvalidNativeBlobsAndAlwaysFreesThem(t *testing.T) {
	originalRead := credentialReadCall
	originalFree := credentialFreeCall
	t.Cleanup(func() {
		credentialReadCall = originalRead
		credentialFreeCall = originalFree
	})
	manager := Manager{}
	freed := 0
	credentialFreeCall = func(...uintptr) (uintptr, uintptr, error) {
		freed++
		return 1, 0, nil
	}

	tests := []struct {
		name   string
		native nativeCredential
	}{
		{name: "nil non-empty blob", native: nativeCredential{CredentialBlobSize: 2}},
		{name: "odd blob", native: nativeCredential{CredentialBlobSize: 1, CredentialBlob: new(byte)}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			credentialReadCall = func(arguments ...uintptr) (uintptr, uintptr, error) {
				// The fake receives the address of the native CredReadW output
				// parameter as uintptr, matching windows.LazyProc.Call.
				output := (**nativeCredential)(unsafe.Pointer(arguments[3])) //nolint:govet
				*output = &test.native
				return 1, 0, nil
			}
			before := freed
			if _, found, err := manager.Read("invalid-blob"); err == nil || found {
				t.Fatalf("invalid blob found/error = %v/%v", found, err)
			}
			if freed != before+1 {
				t.Fatalf("native credential free calls = %d, want %d", freed, before+1)
			}
		})
	}
}

func TestSecretEncodingRoundTripsUnicodeAndRejectsOddBytes(t *testing.T) {
	want := "sentinel-🔐-秘密"
	blob := encodeSecret(want)
	got, err := decodeSecret(blob)
	if err != nil || got != want {
		t.Fatalf("decoded secret = %q/%v", got, err)
	}
	wantUnits := utf16.Encode([]rune(want))
	if len(blob) != len(wantUnits)*2 {
		t.Fatalf("encoded byte length = %d", len(blob))
	}
	if _, err := decodeSecret([]byte{1}); err == nil {
		t.Fatal("odd UTF-16LE byte length was accepted")
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
