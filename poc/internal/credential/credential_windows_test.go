//go:build windows

package credential

import "testing"

func TestSecretEncodingRoundTrip(t *testing.T) {
	const want = "secret-秘密-🔐"
	blob := encodeSecret(want)
	got, err := decodeSecret(blob)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestDecodeSecretRejectsOddBlob(t *testing.T) {
	if _, err := decodeSecret([]byte{1}); err == nil {
		t.Fatal("expected an error")
	}
}
