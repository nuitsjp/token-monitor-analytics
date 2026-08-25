package domain

import "testing"

func TestValidateHubURL(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
		ok   bool
	}{
		{name: "HTTPS remote", raw: "https://hub.example.test:17321/base", want: "https://hub.example.test:17321/base", ok: true},
		{name: "localhost HTTP", raw: "http://localhost:17321", want: "http://localhost:17321", ok: true},
		{name: "IPv4 loopback HTTP", raw: "http://127.42.0.1:17321", want: "http://127.42.0.1:17321", ok: true},
		{name: "IPv6 loopback HTTP", raw: "http://[::1]:17321", want: "http://[::1]:17321", ok: true},
		{name: "remote HTTP", raw: "http://192.168.0.16:17321", ok: false},
		{name: "hostname that might resolve locally", raw: "http://hub.local:17321", ok: false},
		{name: "userinfo", raw: "https://user:password@hub.example.test", ok: false},
		{name: "query", raw: "https://hub.example.test?secret=x", ok: false},
		{name: "empty query", raw: "https://hub.example.test?", ok: false},
		{name: "fragment", raw: "https://hub.example.test/#part", ok: false},
		{name: "empty fragment", raw: "https://hub.example.test/#", ok: false},
		{name: "relative", raw: "/hub", ok: false},
		{name: "unsupported scheme", raw: "ftp://hub.example.test", ok: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := ValidateHubURL(test.raw)
			if test.ok && err != nil {
				t.Fatal(err)
			}
			if !test.ok && err == nil {
				t.Fatalf("ValidateHubURL(%q) succeeded with %q", test.raw, got)
			}
			if got != test.want {
				t.Fatalf("got %q, want %q", got, test.want)
			}
		})
	}
}
