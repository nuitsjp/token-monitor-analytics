package traceability

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"
)

var requirementDeclarationPattern = regexp.MustCompile("^\\s*-\\s+(?:\\*\\*)?`?\\[([^\\]]+)\\]`?(?:\\*\\*)?(?:\\s|$)")
var requirementIDPattern = regexp.MustCompile(`^(?:API|DM|P[12]|QL)(?:-[A-Z0-9]+)*-[0-9]{2}$|^AC-P[12]-[0-9]{2}$`)
var bracketedIDPattern = regexp.MustCompile(`\[([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-[0-9]{2})\]`)

// These fixtures protect the shared gate's exact-token contract. The
// acceptance scanner deliberately excludes this package from evidence
// discovery so these examples cannot make an unfinished product appear
// accepted.
func TestTraceabilityFixtureRequiresCompleteIdentifiers(t *testing.T) {
	for _, test := range []struct {
		name  string
		input string
		want  bool
	}{
		{name: "normative", input: "[P1-HUB-01]", want: true},
		{name: "quality", input: "[QL-SEC-02]", want: true},
		{name: "acceptance", input: "[AC-P1-26]", want: true},
		{name: "phase two", input: "[P2-VALUE-01]", want: true},
		{name: "api short namespace", input: "[API-01]", want: true},
		{name: "partial prefix", input: "P1-HUB-*", want: false},
		{name: "missing number", input: "[P1-HUB]", want: false},
		{name: "hash is not a requirement", input: "SHA-256", want: false},
		{name: "short hash is not a requirement", input: "SHA-25", want: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := bracketedIDPattern.MatchString(test.input)
			if strings.HasPrefix(test.name, "hash") {
				got = regexp.MustCompile(`(?:API|DM|P[12]|QL)(?:-[A-Z0-9]+)*-[0-9]{2}|AC-P[12]-[0-9]{2}`).MatchString(test.input)
			}
			if got != test.want {
				t.Fatalf("exact identifier match for %q = %v, want %v", test.input, got, test.want)
			}
		})
	}
}

func TestRequirementDeclarationExtractionNormalFixture(t *testing.T) {
	requirements := readRepositoryFile(t, filepath.Join("docs", "requirements.md"))
	ids, err := extractRequirementDeclarationIDs(string(requirements))
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) == 0 {
		t.Fatal("requirements declaration fixture extracted no IDs")
	}
	for number := 1; number <= 6; number++ {
		id := fmt.Sprintf("API-%02d", number)
		if !contains(ids, id) {
			t.Fatalf("requirements declaration fixture omitted %s", id)
		}
	}
	for _, id := range ids {
		if strings.HasPrefix(id, "SHA-") {
			t.Fatalf("hash was extracted as a requirement ID: %s", id)
		}
	}
}

func TestRequirementDeclarationExtractionRejectsDuplicateFixture(t *testing.T) {
	_, err := extractRequirementDeclarationIDs("- `[API-01]` first\n- `[API-01]` duplicate\n")
	if err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("duplicate declaration error = %v, want duplicate error", err)
	}
}

func TestRequirementDeclarationExtractionRejectsUnknownReferenceFixture(t *testing.T) {
	_, err := extractRequirementDeclarationIDs("- `[API-01]` declared\nSee [API-99] for details.\n")
	if err == nil || !strings.Contains(err.Error(), "unknown") {
		t.Fatalf("unknown reference error = %v, want unknown error", err)
	}
}

func TestRequirementDeclarationExtractionRejectsPartialIDFixture(t *testing.T) {
	for _, input := range []string{
		"- `[P1-HUB-*]` partial\n",
		"- `[API]` missing number\n",
	} {
		if _, err := extractRequirementDeclarationIDs(input); err == nil || !strings.Contains(err.Error(), "format") {
			t.Fatalf("malformed declaration %q error = %v, want format error", input, err)
		}
	}
}

func TestRequirementDeclarationExtractionRejectsUnknownNamespaceFixture(t *testing.T) {
	_, err := extractRequirementDeclarationIDs("- `[UNKNOWN-01]` unknown namespace\n")
	if err == nil || !strings.Contains(err.Error(), "unknown") {
		t.Fatalf("unknown namespace error = %v, want unknown error", err)
	}
}

func TestTraceabilityScriptsDoNotDependOnPlan(t *testing.T) {
	for _, relativePath := range []string{
		filepath.Join("scripts", "check-requirements.ps1"),
		filepath.Join("scripts", "check-screens.ps1"),
		filepath.Join("scripts", "check-acceptance.ps1"),
		filepath.Join("scripts", "traceability-ids.ps1"),
	} {
		contents := string(readRepositoryFile(t, relativePath))
		if strings.Contains(contents, "PLAN.md") {
			t.Fatalf("%s still depends on PLAN.md", relativePath)
		}
	}

	if _, err := exec.LookPath("powershell.exe"); err != nil {
		t.Skip("powershell.exe is required for the PLAN independence fixture")
	}
	fixtureRoot := t.TempDir()
	if err := os.MkdirAll(filepath.Join(fixtureRoot, "scripts"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(fixtureRoot, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, script := range []string{"check-requirements.ps1", "traceability-ids.ps1"} {
		contents := readRepositoryFile(t, filepath.Join("scripts", script))
		if err := os.WriteFile(filepath.Join(fixtureRoot, "scripts", script), contents, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	fixtureRequirements := "- `[API-01]` first\n- `[API-02]` second\n- `[API-03]` third\n- `[API-04]` fourth\n- `[API-05]` fifth\n- `[API-06]` sixth\n- `[P1-HUB-01]` hub\n- `[AC-P1-01]` acceptance\nThis mentions SHA-256 and SHA-25 but they are not IDs.\n"
	if err := os.WriteFile(filepath.Join(fixtureRoot, "docs", "requirements.md"), []byte(fixtureRequirements), 0o644); err != nil {
		t.Fatal(err)
	}
	run := func() string {
		command := exec.CommandContext(context.Background(), "powershell.exe", "-NoLogo", "-NoProfile", "-File", filepath.Join(fixtureRoot, "scripts", "check-requirements.ps1"))
		command.Dir = fixtureRoot
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("requirements fixture failed: %v\n%s", err, output)
		}
		return string(output)
	}
	withoutPlan := run()
	if err := os.WriteFile(filepath.Join(fixtureRoot, "PLAN.md"), []byte("changed plan fixture"), 0o644); err != nil {
		t.Fatal(err)
	}
	withChangedPlan := run()
	if withoutPlan != withChangedPlan {
		t.Fatalf("PLAN fixture changed requirements result: without=%q with=%q", withoutPlan, withChangedPlan)
	}
}

func TestTraceabilityFixtureReportFieldsAreStable(t *testing.T) {
	contents := string(readRepositoryFile(t, filepath.Join("scripts", "check-acceptance.ps1")))
	for _, field := range []string{"id", "testName", "result", "evidencePath", "artifactSha256"} {
		if !regexp.MustCompile(`(?m)\b` + regexp.QuoteMeta(field) + `\b`).MatchString(contents) {
			t.Fatalf("acceptance gate does not emit report field %q", field)
		}
	}
	for _, fragment := range []string{"tests\\traceability", "pending", "blocked"} {
		if !strings.Contains(contents, fragment) {
			t.Fatalf("acceptance gate is missing fixture guard %q", fragment)
		}
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

func TestTraceabilityFixtureUsesIndividualMachineReadableTestResults(t *testing.T) {
	contents := string(readRepositoryFile(t, filepath.Join("scripts", "check-acceptance.ps1")))
	if strings.Contains(contents, "([ref]$errors)") {
		t.Fatal("acceptance parser passes a nested PSReference instead of the existing error reference")
	}
	for _, fragment := range []string{
		"go test", "-json", "--reporter=json", "--outputFile=",
		"Read-GoTestResults", "Read-VitestResults", "Read-PlaywrightResults",
		"automaticStatuses", "unknown traceability id in test result",
	} {
		if !strings.Contains(contents, fragment) {
			t.Fatalf("acceptance gate is missing machine-readable result contract %q", fragment)
		}
	}
	for _, fragment := range []string{"'skip'", "'pending'", "Convert-TestResultStatus"} {
		if !strings.Contains(contents, fragment) {
			t.Fatalf("acceptance gate does not preserve non-pass result %q", fragment)
		}
	}
}

func TestTraceabilityFixtureRetainsNativeDiagnostics(t *testing.T) {
	contents := string(readRepositoryFile(t, filepath.Join("scripts", "check-acceptance.ps1")))
	if strings.Contains(contents, "1> $null") || strings.Contains(contents, "2> $null") {
		t.Fatal("acceptance gate discards native command output")
	}
	for _, fragment := range []string{"Stdout", "Stderr", "Write-InvocationDiagnostics"} {
		if !strings.Contains(contents, fragment) {
			t.Fatalf("acceptance gate does not retain native diagnostics field %q", fragment)
		}
	}
}

func TestTraceabilityFixtureReleaseGateDoesNotRerunAutomatedTests(t *testing.T) {
	taskfile := string(readRepositoryFile(t, "Taskfile.yml"))
	acceptance := string(readRepositoryFile(t, filepath.Join("scripts", "check-acceptance.ps1")))
	for _, fragment := range []string{
		"acceptance:release:", "-ReuseVerifiedTests", "automatedTestsReused", "New-VerifiedResult",
	} {
		if !strings.Contains(taskfile+acceptance, fragment) {
			t.Fatalf("release acceptance reuse contract is missing %q", fragment)
		}
	}
	releaseIndex := strings.Index(taskfile, "\n  release:verify:")
	if releaseIndex < 0 {
		t.Fatal("Taskfile is missing release:verify")
	}
	releaseBody := taskfile[releaseIndex:]
	if strings.Contains(releaseBody, "- task: acceptance\n") {
		t.Fatal("release:verify invokes the duplicate standalone acceptance task")
	}
	for _, fragment := range []string{"task: acceptance:release", "task: test:wails"} {
		if !strings.Contains(releaseBody, fragment) {
			t.Fatalf("release:verify is missing %q", fragment)
		}
	}
}

func TestTraceabilityFixtureHasLocalWindowsPackageContract(t *testing.T) {
	taskfile := string(readRepositoryFile(t, "Taskfile.yml"))
	script := string(readRepositoryFile(t, filepath.Join("scripts", "check-windows-package.ps1")))
	for _, fragment := range []string{
		"test:windows:", "test:wails:", "requires Windows", "task: package",
	} {
		if !strings.Contains(taskfile, fragment) {
			t.Fatalf("local Windows test contract is missing %q", fragment)
		}
	}
	for _, fragment := range []string{
		"makensis.exe", "wails3.exe", "0x4d", "0x5a", "SHA-256", "local Windows package check passed",
	} {
		if !strings.Contains(script, fragment) {
			t.Fatalf("Windows package verifier is missing %q", fragment)
		}
	}
}

func extractRequirementDeclarationIDs(document string) ([]string, error) {
	document = strings.ReplaceAll(document, "\r\n", "\n")
	ids := make([]string, 0)
	declared := make(map[string]bool)
	for lineNumber, line := range strings.Split(document, "\n") {
		match := requirementDeclarationPattern.FindStringSubmatch(line)
		if len(match) == 0 {
			continue
		}
		id := match[1]
		if !requirementIDPattern.MatchString(id) {
			if regexp.MustCompile(`^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-[0-9]{2}$`).MatchString(id) {
				return nil, fmt.Errorf("unknown requirement namespace at line %d: %s", lineNumber+1, id)
			}
			return nil, fmt.Errorf("invalid requirement declaration format at line %d: %s", lineNumber+1, id)
		}
		if declared[id] {
			return nil, fmt.Errorf("duplicate requirement declaration: %s", id)
		}
		declared[id] = true
		ids = append(ids, id)
	}
	for _, match := range bracketedIDPattern.FindAllStringSubmatch(document, -1) {
		if !declared[match[1]] {
			return nil, fmt.Errorf("unknown requirement reference: %s", match[1])
		}
	}
	sort.Strings(ids)
	return ids, nil
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
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
