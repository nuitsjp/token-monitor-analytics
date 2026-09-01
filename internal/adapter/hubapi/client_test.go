package hubapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

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

func TestP1HubURLPolicyAndTLSValidation(t *testing.T) {
	t.Run("P1-HUB-03 URL policy and certificate validation are enforced", func(t *testing.T) {
		cases := []struct {
			name string
			raw  string
			want bool
		}{
			{name: "remote HTTPS", raw: "https://hub.example.test:17321/base", want: true},
			{name: "localhost HTTP", raw: "http://localhost:17321", want: true},
			{name: "IPv4 loopback HTTP", raw: "http://127.0.0.1:17321", want: true},
			{name: "IPv6 loopback HTTP", raw: "http://[::1]:17321", want: true},
			{name: "private IPv4 HTTP", raw: "http://192.168.0.16:17321", want: true},
			{name: "private IPv6 HTTP", raw: "http://[fd00::16]:17321", want: true},
			{name: "public HTTP", raw: "http://203.0.113.10:17321", want: false},
			{name: "userinfo", raw: "https://user:password@hub.example.test", want: false},
			{name: "query", raw: "https://hub.example.test?secret=x", want: false},
			{name: "fragment", raw: "https://hub.example.test/#part", want: false},
			{name: "relative", raw: "/hub", want: false},
			{name: "unsupported scheme", raw: "ftp://hub.example.test", want: false},
		}
		for _, test := range cases {
			t.Run(test.name, func(t *testing.T) {
				_, err := validateURL(test.raw)
				if (err == nil) != test.want {
					t.Fatalf("validateURL(%q) error=%v, want accepted=%v", test.raw, err, test.want)
				}
			})
		}

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
			t.Fatalf("untrusted certificate classification = %q, want tls", ClassificationOf(err))
		}
	})
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

func TestHealthHTTPStatusClassification(t *testing.T) {
	tests := []struct {
		name           string
		status         int
		classification Classification
	}{
		{name: "unauthorized", status: http.StatusUnauthorized, classification: ClassificationAuth},
		{name: "forbidden", status: http.StatusForbidden, classification: ClassificationAuth},
		{name: "internal server error", status: http.StatusInternalServerError, classification: ClassificationHTTP},
		{name: "service unavailable", status: http.StatusServiceUnavailable, classification: ClassificationHTTP},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writer.WriteHeader(test.status)
				_, _ = writer.Write([]byte("status body must not be exposed"))
			}))
			defer server.Close()
			client, err := NewClient(server.URL, testAllowlist())
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.Health(context.Background())
			if ClassificationOf(err) != test.classification {
				t.Fatalf("classification = %q, want %q", ClassificationOf(err), test.classification)
			}
			if strings.Contains(err.Error(), "status body must not be exposed") {
				t.Fatal("response body leaked into error")
			}
		})
	}
}

func TestFetchStatsHTTPStatusClassification(t *testing.T) {
	tests := []struct {
		name           string
		status         int
		classification Classification
	}{
		{name: "unauthorized", status: http.StatusUnauthorized, classification: ClassificationAuth},
		{name: "forbidden", status: http.StatusForbidden, classification: ClassificationAuth},
		{name: "internal server error", status: http.StatusInternalServerError, classification: ClassificationHTTP},
		{name: "service unavailable", status: http.StatusServiceUnavailable, classification: ClassificationHTTP},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				if request.URL.Path == "/api/health" {
					_, _ = writer.Write([]byte(testHealth()))
					return
				}
				writer.WriteHeader(test.status)
				_, _ = writer.Write([]byte("stats status body must not be exposed"))
			}))
			defer server.Close()
			client, err := NewClient(server.URL, testAllowlist())
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.FetchStats(context.Background(), "secret")
			if ClassificationOf(err) != test.classification {
				t.Fatalf("classification = %q, want %q", ClassificationOf(err), test.classification)
			}
			if strings.Contains(err.Error(), "stats status body must not be exposed") {
				t.Fatal("response body leaked into error")
			}
		})
	}
}

func TestResponseTimeoutIsClassifiedAsTimeout(t *testing.T) {
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		close(started)
		<-request.Context().Done()
	}))
	defer server.Close()
	client, err := NewClient(server.URL, testAllowlist())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err = client.Health(ctx)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("request did not reach httptest server")
	}
	if ClassificationOf(err) != ClassificationTimeout {
		t.Fatalf("classification = %q, want timeout", ClassificationOf(err))
	}
}

func TestClosedHubConnectionIsClassifiedAsUnreachable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {}))
	serverURL := server.URL
	server.Close()
	client, err := NewClient(serverURL, testAllowlist())
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Health(context.Background())
	if ClassificationOf(err) != ClassificationUnreachable {
		t.Fatalf("classification = %q, want unreachable", ClassificationOf(err))
	}
}

func testHealth() string {
	return `{"hubBuild":{"schemaVersion":1,"runtime":"test-hub","coreBuildId":"sha256:test-core","runtimeBuildId":"sha256:test-runtime","coreRevision":18}}`
}

func testAllowlist() Allowlist {
	return NewAllowlist(ContractPolicy{SchemaVersion: 1, Runtime: "test-hub", MinimumCoreRevision: 18, UsageUpdatedAt: true})
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
			_, _ = writer.Write([]byte(`{"devices":[{"deviceId":"device-1","updatedAt":"2026-08-25T11:36:00Z"}],"periods":{},"unknownFutureField":{"retained":true},"number":12345678901234567890}`))
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

func TestFetchStatsUsesMinimumCoreRevision(t *testing.T) {
	tests := []struct {
		name          string
		coreRevision  int
		wantSupported bool
	}{
		{name: "minimum revision", coreRevision: 18, wantSupported: true},
		{name: "newer revision", coreRevision: 19, wantSupported: true},
		{name: "older revision", coreRevision: 17, wantSupported: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var statsCalls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				switch request.URL.Path {
				case "/api/health":
					_, _ = writer.Write([]byte(`{"hubBuild":{"schemaVersion":1,"runtime":"test-hub","coreBuildId":"sha256:changed","runtimeBuildId":"sha256:changed-runtime","coreRevision":` + fmt.Sprint(test.coreRevision) + `}}`))
				case "/api/stats":
					statsCalls.Add(1)
					_, _ = writer.Write([]byte(`{"devices":[{"deviceId":"device-1","updatedAt":"2026-08-25T11:36:00Z"}]}`))
				default:
					http.NotFound(writer, request)
				}
			}))
			defer server.Close()
			client, err := NewClient(server.URL, testAllowlist())
			if err != nil {
				t.Fatal(err)
			}
			result, err := client.FetchStats(context.Background(), "secret")
			if test.wantSupported {
				if err != nil || statsCalls.Load() != 1 {
					t.Fatalf("error=%v stats calls=%d", err, statsCalls.Load())
				}
				if result.Contract.Build.CoreRevision != test.coreRevision || result.Contract.Build.CoreBuildID != "sha256:changed" {
					t.Fatalf("recorded build = %+v", result.Contract.Build)
				}
				return
			}
			if ClassificationOf(err) != ClassificationUnsupported || statsCalls.Load() != 0 {
				t.Fatalf("classification=%q stats calls=%d", ClassificationOf(err), statsCalls.Load())
			}
		})
	}
}

func TestTopLevelUpdatedAtDoesNotReplaceDeviceMarker(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/health" {
			_, _ = writer.Write([]byte(testHealth()))
			return
		}
		_, _ = writer.Write([]byte(`{"updatedAt":"2026-08-25T11:36:00Z","devices":[{"deviceId":"device-1"}]}`))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, testAllowlist())
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.FetchStats(context.Background(), "secret")
	t.Run("API-03 requires device updatedAt", func(t *testing.T) {
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
		_, _ = writer.Write([]byte(`{"updatedAt":"2026-08-25T11:36:00Z","devices":[]}`))
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

func TestDefaultAllowlistAcceptsCoreRevision18ForCollection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/health":
			_, _ = writer.Write([]byte(`{"hubBuild":{"schemaVersion":1,"runtime":"node-hub","coreBuildId":"sha256:4074b6e85c0cb32e3d8978fbdcfcbcba03a2c1e0b3d95bbc20177e141004a93e","runtimeBuildId":"sha256:dbdaa0b2aa2e8d627b939d6ab76a9029aa2807839fdbe4e7918edcab592fe749","coreRevision":18,"runtimeRevision":1}}`))
		case "/api/stats":
			_, _ = writer.Write([]byte(`{"devices":[{"deviceId":"device-1","updatedAt":"2026-08-25T11:36:00Z"}]}`))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()
	client, err := NewClient(server.URL, DefaultAllowlist)
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.FetchStats(context.Background(), "secret")
	if err != nil {
		t.Fatal(err)
	}
	if !result.Contract.UsageUpdatedAt {
		t.Fatal("supported node-hub contract was not estimation capable")
	}
}
