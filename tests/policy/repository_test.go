package policy_test

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestESLintSuppressionsHaveExpiringOwnership(t *testing.T) {
	root := repositoryRoot(t)
	frontendRoot := filepath.Join(root, "frontend")
	err := filepath.WalkDir(frontendRoot, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() && (entry.Name() == "node_modules" || entry.Name() == "dist" || entry.Name() == "bindings") {
			return filepath.SkipDir
		}
		if entry.IsDir() || (filepath.Ext(path) != ".ts" && filepath.Ext(path) != ".tsx") {
			return nil
		}

		file, err := os.Open(path)
		if err != nil {
			return err
		}

		var recent []string
		scanner := bufio.NewScanner(file)
		for lineNumber := 1; scanner.Scan(); lineNumber++ {
			line := scanner.Text()
			if strings.Contains(line, "eslint-disable") {
				metadata := strings.Join(recent, " ")
				for _, field := range []string{"Exception:", "Rule=", "Reason=", "Scope=", "Owner=", "Expires="} {
					if !strings.Contains(metadata, field) {
						t.Errorf("%s:%d suppression lacks %s", filepath.ToSlash(path), lineNumber, field)
					}
				}
			}
			recent = append(recent, line)
			if len(recent) > 3 {
				recent = recent[1:]
			}
		}
		scanErr := scanner.Err()
		closeErr := file.Close()
		return errors.Join(scanErr, closeErr)
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestPLANIsExcludedFromPolicyInputs(t *testing.T) {
	root := repositoryRoot(t)
	paths := []string{
		"Taskfile.yml",
		"scripts/check-requirements.ps1",
		"scripts/check-screens.ps1",
		"scripts/check-acceptance.ps1",
	}
	for _, path := range paths {
		contents, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(path)))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(contents), "PLAN.md") {
			t.Errorf("%s uses PLAN.md as a policy input", path)
		}
	}
}

func TestPackageVersionsAreExact(t *testing.T) {
	root := repositoryRoot(t)
	contents, err := os.ReadFile(filepath.Join(root, "frontend", "package.json"))
	if err != nil {
		t.Fatal(err)
	}
	var packageFile struct {
		Dependencies    map[string]string `json:"dependencies"`
		DevDependencies map[string]string `json:"devDependencies"`
	}
	if err := json.Unmarshal(contents, &packageFile); err != nil {
		t.Fatal(err)
	}
	for section, dependencies := range map[string]map[string]string{"dependencies": packageFile.Dependencies, "devDependencies": packageFile.DevDependencies} {
		for name, version := range dependencies {
			if strings.HasPrefix(version, "^") || strings.HasPrefix(version, "~") {
				t.Errorf("%s.%s is not exact: %s", section, name, version)
			}
		}
	}
}
