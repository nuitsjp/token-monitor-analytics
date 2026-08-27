package policy_test

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var rawColour = regexp.MustCompile(`(?i)#[0-9a-f]{3,8}\b|rgba?\(`)

func TestFrontendRawColoursAreDefinedOnlyInDesignTokens(t *testing.T) {
	root := repositoryRoot(t)
	sourceRoot := filepath.Join(root, "frontend", "src")
	var violations []string
	err := filepath.WalkDir(sourceRoot, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || path == filepath.Join(sourceRoot, "components", "designTokens.ts") || strings.Contains(entry.Name(), ".test.") {
			return nil
		}
		extension := strings.ToLower(filepath.Ext(path))
		if extension != ".ts" && extension != ".tsx" && extension != ".css" {
			return nil
		}
		contents, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if rawColour.Match(contents) {
			violations = append(violations, relativePath(root, path))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(violations) > 0 {
		t.Fatalf("raw colours outside designTokens.ts: %s", strings.Join(violations, ", "))
	}
}

func TestDarkErrorCounterMatchesNormativeDesign(t *testing.T) {
	root := repositoryRoot(t)
	design, err := os.ReadFile(filepath.Join(root, "docs", "design-system.md"))
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := os.ReadFile(filepath.Join(root, "frontend", "src", "components", "designTokens.ts"))
	if err != nil {
		t.Fatal(err)
	}
	for _, fragment := range []string{"ダークエラーカウンター", "#d13438 / #ffffff"} {
		if !strings.Contains(string(design), fragment) {
			t.Fatalf("docs/design-system.md is missing %q", fragment)
		}
	}
	for _, fragment := range []string{`errorCounterBackground: "#d13438"`, `errorCounterForeground: "#ffffff"`} {
		if strings.Count(string(tokens), fragment) != 2 {
			t.Fatalf("designTokens.ts must define %q once per theme", fragment)
		}
	}
}
