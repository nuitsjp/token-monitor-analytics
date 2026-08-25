package hubapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

var testBuild = BuildIdentity{
	SchemaVersion:  1,
	Runtime:        "test-hub",
	CoreBuildID:    "sha256:test-core",
	RuntimeBuildID: "sha256:test-runtime",
}

func TestTLSErrorIsClassified(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(testHealth()))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, testAllowlist())
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Health(context.Background())
	if ClassificationOf(err) != ClassificationTLS {
		t.Fatalf("classification = %q, want tls", ClassificationOf(err))
	}
}

func TestExpiredContextIsClassifiedAsTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(testHealth()))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, testAllowlist())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	cancel()
	_, err = client.Health(ctx)
	if ClassificationOf(err) != ClassificationTimeout {
		t.Fatalf("classification = %q, want timeout", ClassificationOf(err))
	}
}

func testHealth() string {
	return `{"hubBuild":{"schemaVersion":1,"runtime":"test-hub","coreBuildId":"sha256:test-core","runtimeBuildId":"sha256:test-runtime"}}`
}

func testAllowlist() Allowlist {
	return NewAllowlist(Contract{Build: testBuild, UsageUpdatedAt: true})
}

func TestFetchStatsKeepsUnknownFieldsAndJSONNumbers(t *testing.T) {
	var statsCalls atomic.Int32
	var method, path, authorization string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		method, path, authorization = request.Method, request.URL.Path, request.Header.Get("Authorization")
		switch request.URL.Path {
		case "/api/health":
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(testHealth()))
		case "/api/stats":
			statsCalls.Add(1)
			_, _ = writer.Write([]byte(`{"devices":[{"deviceId":"device-1","usageUpdatedAt":"2026-08-25T11:36:00Z"}],"periods":{},"unknownFutureField":{"retained":true},"number":12345678901234567890}`))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()
	client, err := NewClient(server.URL, testAllowlist())
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.FetchStats(context.Background(), "sentinel-secret")
	if err != nil {
		t.Fatal(err)
	}
	t.Run("API-01 authenticated GET stats endpoint", func(t *testing.T) {
		if method != http.MethodGet || path != "/api/stats" || authorization != "Bearer sentinel-secret" {
			t.Fatalf("request = %s %s authorization=%q", method, path, authorization)
		}
		if statsCalls.Load() != 1 {
			t.Fatalf("stats calls = %d, want 1", statsCalls.Load())
		}
	})
	t.Run("API-04 retains complete raw response", func(t *testing.T) {
		if !strings.Contains(string(result.Stats.Raw), "unknownFutureField") {
			t.Fatal("unknown field was not retained in raw JSON")
		}
		object := result.Stats.Value.(map[string]any)
		if _, ok := object["number"].(json.Number); !ok {
			t.Fatalf("number type = %T, want json.Number", object["number"])
		}
	})
}

func TestUnsupportedBuildDoesNotCallStats(t *testing.T) {
	var healthCalls atomic.Int32
	var statsCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/health" {
			healthCalls.Add(1)
			_, _ = writer.Write([]byte(testHealth()))
			return
		}
		if request.URL.Path == "/api/stats" {
			statsCalls.Add(1)
		}
		http.NotFound(writer, request)
	}))
	defer server.Close()
	client, err := NewClient(server.URL, DefaultAllowlist)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.FetchStats(context.Background(), "secret-not-in-errors")
	t.Run("API-02 health build gates stats request", func(t *testing.T) {
		if healthCalls.Load() != 1 {
			t.Fatalf("health calls = %d, want 1", healthCalls.Load())
		}
		if statsCalls.Load() != 0 {
			t.Fatalf("stats calls = %d, want 0", statsCalls.Load())
		}
	})
	t.Run("API-06 unsupported build is not usage contract", func(t *testing.T) {
		if ClassificationOf(err) != ClassificationUnsupported {
			t.Fatalf("classification = %q, want unsupported", ClassificationOf(err))
		}
		if strings.Contains(err.Error(), "secret-not-in-errors") {
			t.Fatal("secret leaked into error")
		}
	})
}

func TestFetchStatsChecksExactAllowlistBuildIdentity(t *testing.T) {
	var statsCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/health" {
			_, _ = writer.Write([]byte(`{"hubBuild":{"schemaVersion":1,"runtime":"test-hub","coreBuildId":"sha256:changed","runtimeBuildId":"sha256:test-runtime"}}`))
			return
		}
		if request.URL.Path == "/api/stats" {
			statsCalls.Add(1)
		}
		http.NotFound(writer, request)
	}))
	defer server.Close()
	client, err := NewClient(server.URL, testAllowlist())
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.FetchStats(context.Background(), "secret")
	t.Run("API-02 exact changed build is rechecked", func(t *testing.T) {
		if ClassificationOf(err) != ClassificationUnsupported || statsCalls.Load() != 0 {
			t.Fatalf("classification=%q stats calls=%d", ClassificationOf(err), statsCalls.Load())
		}
	})
}

func TestTopLevelUsageUpdatedAtDoesNotReplaceDeviceMarker(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/health" {
			_, _ = writer.Write([]byte(testHealth()))
			return
		}
		_, _ = writer.Write([]byte(`{"usageUpdatedAt":"2026-08-25T11:36:00Z","devices":[{"deviceId":"device-1"}]}`))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, testAllowlist())
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.FetchStats(context.Background(), "secret")
	t.Run("API-03 requires device usage marker", func(t *testing.T) {
		if ClassificationOf(err) != ClassificationUnsupported {
			t.Fatalf("classification = %q, want unsupported", ClassificationOf(err))
		}
	})
	t.Run("API-COST-05 missing usageUpdatedAt is not estimation input", func(t *testing.T) {
		if ClassificationOf(err) != ClassificationUnsupported {
			t.Fatalf("classification = %q, want unsupported", ClassificationOf(err))
		}
	})
}

func TestEmptyDevicesIsUnsupportedWithoutDeviceUsageMarker(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/health" {
			_, _ = writer.Write([]byte(testHealth()))
			return
		}
		_, _ = writer.Write([]byte(`{"usageUpdatedAt":"2026-08-25T11:36:00Z","devices":[]}`))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, testAllowlist())
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.FetchStats(context.Background(), "secret")
	t.Run("API-03 rejects stats without a device row", func(t *testing.T) {
		if ClassificationOf(err) != ClassificationUnsupported {
			t.Fatalf("classification = %q, want unsupported", ClassificationOf(err))
		}
	})
}

func TestResponseBodyLimit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/health" {
			_, _ = writer.Write([]byte(testHealth()))
			return
		}
		_, _ = writer.Write([]byte(strings.Repeat("x", MaxResponseBytes+1)))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, testAllowlist())
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.FetchStats(context.Background(), "secret")
	t.Run("API-05 rejects oversized response", func(t *testing.T) {
		if ClassificationOf(err) != ClassificationBodyTooLarge {
			t.Fatalf("classification = %q, want body_too_large", ClassificationOf(err))
		}
	})
}

func TestRedirectStripsAuthorizationOnDifferentHost(t *testing.T) {
	var seen atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/stats" {
			seen.Store(request.Header.Get("Authorization") != "")
		}
		writer.WriteHeader(http.StatusUnauthorized)
	}))
	defer target.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/health" {
			_, _ = writer.Write([]byte(testHealth()))
			return
		}
		redirectURL := strings.Replace(target.URL, "127.0.0.1", "localhost", 1)
		http.Redirect(writer, request, redirectURL+"/api/stats", http.StatusFound)
	}))
	defer origin.Close()
	client, err := NewClient(origin.URL, testAllowlist())
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.FetchStats(context.Background(), "secret")
	t.Run("API-01 strips auth on cross-host redirect", func(t *testing.T) {
		if ClassificationOf(err) != ClassificationAuth {
			t.Fatalf("classification = %q, want auth", ClassificationOf(err))
		}
		if seen.Load() {
			t.Fatal("Authorization was transferred to a different host")
		}
	})
}

func TestInvalidJSONIsClassifiedWithoutBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/health" {
			_, _ = writer.Write([]byte(testHealth()))
			return
		}
		_, _ = writer.Write([]byte(`{"bad":` + "secret-response-body"))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, testAllowlist())
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.FetchStats(context.Background(), "secret")
	t.Run("API-05 rejects invalid JSON without echoing body", func(t *testing.T) {
		if ClassificationOf(err) != ClassificationInvalidJSON {
			t.Fatalf("classification = %q, want invalid_json", ClassificationOf(err))
		}
		if strings.Contains(err.Error(), "secret-response-body") || strings.Contains(err.Error(), "secret") {
			t.Fatal("untrusted data leaked into error")
		}
	})
}
