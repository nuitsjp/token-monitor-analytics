package traceability

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

// These fixtures protect the gate's exact-token contract. The acceptance
// scanner deliberately excludes this package from evidence discovery so these
// examples cannot make an unfinished product appear accepted.
func TestTraceabilityFixtureRequiresCompleteIdentifiers(t *testing.T) {
	pattern := regexp.MustCompile(`\[(?:P1|P2|QL)-[A-Z0-9]+-[0-9]{2}\]|\[AC-P[12]-[0-9]{2}\]`)
	for _, test := range []struct {
		name  string
		input string
		want  bool
	}{
		{name: "normative", input: "[P1-HUB-01]", want: true},
		{name: "quality", input: "[QL-SEC-02]", want: true},
		{name: "acceptance", input: "[AC-P1-26]", want: true},
		{name: "partial prefix", input: "P1-HUB-*", want: false},
		{name: "missing number", input: "[P1-HUB]", want: false},
		{name: "phase two", input: "[P2-VALUE-01]", want: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := pattern.MatchString(test.input); got != test.want {
				t.Fatalf("exact identifier match for %q = %v, want %v", test.input, got, test.want)
			}
		})
	}
}

func TestTraceabilityFixtureReportFieldsAreStable(t *testing.T) {
	script := readRepositoryFile(t, filepath.Join("scripts", "check-acceptance.ps1"))
	contents := string(script)
	for _, field := range []string{"id", "testName", "result", "evidencePath", "artifactSha256"} {
		if !regexp.MustCompile(`(?m)\b` + regexp.QuoteMeta(field) + `\b`).MatchString(contents) {
			t.Fatalf("acceptance gate does not emit report field %q", field)
		}
	}
	for _, fragment := range []string{"tests\\traceability", "pending", "blocked"} {
		if !regexp.MustCompile(regexp.QuoteMeta(fragment)).MatchString(contents) {
			t.Fatalf("acceptance gate is missing fixture guard %q", fragment)
		}
	}
}

func TestTraceabilityFixtureExtractsPhaseOneAndPhaseTwoNamespaces(t *testing.T) {
	pattern := regexp.MustCompile(`[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+-[0-9]{2}`)
	input := "[API-COST-01] [DM-ID-01] [CALC-RULE-01] [P1-HUB-01] [QL-SEC-01] [AC-P1-01] [P2-VALUE-01] [API-P2-01]"
	got := make(map[string]bool)
	for _, id := range pattern.FindAllString(input, -1) {
		got[id] = true
	}
	for _, id := range []string{"API-COST-01", "DM-ID-01", "CALC-RULE-01", "P1-HUB-01", "QL-SEC-01", "AC-P1-01", "P2-VALUE-01", "API-P2-01"} {
		if !got[id] {
			t.Fatalf("identifier %q was not extracted", id)
		}
	}

	requirements := readRepositoryFile(t, filepath.Join("docs", "requirements.md"))
	ids := make(map[string]bool)
	for _, id := range pattern.FindAllString(string(requirements), -1) {
		ids[id] = true
	}
	if len(ids) != 224 {
		t.Fatalf("requirements ID count = %d, want 224", len(ids))
	}
}

func TestTraceabilityFixtureSearchesSupportedTestFilesAndExcludesFixtures(t *testing.T) {
	contents := string(readRepositoryFile(t, filepath.Join("scripts", "check-acceptance.ps1")))
	for _, fragment := range []string{"*_test.go", "*.test.tsx", "*.spec.ts", "frontend\\node_modules", "frontend\\bindings", "tests\\traceability"} {
		if !strings.Contains(contents, fragment) {
			t.Fatalf("acceptance gate file search contract missing %q", fragment)
		}
	}
	for _, fragment := range []string{"t\\.Run", "(?:it|test|describe)"} {
		if !strings.Contains(contents, fragment) {
			t.Fatalf("acceptance gate test-name contract missing %q", fragment)
		}
	}
}

func readRepositoryFile(t *testing.T, relativePath string) []byte {
	t.Helper()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate traceability fixture")
	}
	contents, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "..", "..", relativePath))
	if err != nil {
		t.Fatalf("read repository file %s: %v", relativePath, err)
	}
	return contents
}
