package policy_test

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestArchitecturePolicyRejectsKnownViolations(t *testing.T) {
	tests := []struct {
		path   string
		source string
		want   string
	}{
		{"internal/domain/bad.go", `package domain; import _ "net/http"`, "domain must not import net/http"},
		{"internal/usecase/bad.go", `package usecase; import _ "token-monitor-analytics/internal/adapter/sqlite"`, "usecase must not import token-monitor-analytics/internal/adapter/sqlite"},
		{"internal/adapter/sqlite/bad.go", `package sqlite; import _ "token-monitor-analytics/internal/adapter/hubapi"`, "output adapters must not depend on each other"},
		{"internal/desktop/bad.go", `package desktop; import "database/sql"; var _ *sql.DB`, "desktop must not import database/sql"},
		{"internal/desktop/bad.go", `package desktop; func f(x interface{ Exec(string, ...any) }) { _, _ = x.Exec("DELETE") }`, "desktop must not execute SQL directly"},
	}
	for _, test := range tests {
		t.Run(test.want, func(t *testing.T) {
			violations := inspectGoSource(test.path, []byte(test.source))
			if !containsViolation(violations, test.want) {
				t.Fatalf("violations %q do not contain %q", violations, test.want)
			}
		})
	}
}

func TestRepositorySatisfiesArchitecturePolicy(t *testing.T) {
	root := repositoryRoot(t)
	var violations []string
	err := filepath.WalkDir(filepath.Join(root, "internal"), func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") || strings.Contains(path, string(filepath.Separator)+"sqlcgen"+string(filepath.Separator)) {
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		contents, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		violations = append(violations, inspectGoSource(filepath.ToSlash(relative), contents)...)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(violations) > 0 {
		t.Fatalf("architecture policy violations:\n%s", strings.Join(violations, "\n"))
	}
}

func TestConcreteCompositionLivesInMainGo(t *testing.T) {
	root := repositoryRoot(t)
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || entry.Name() == "main.go" || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		contents, err := os.ReadFile(filepath.Join(root, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), entry.Name(), contents, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, spec := range parsed.Imports {
			importPath, err := strconv.Unquote(spec.Path.Value)
			if err == nil && (strings.HasPrefix(importPath, "token-monitor-analytics/internal/adapter/") || importPath == "token-monitor-analytics/internal/desktop") {
				t.Errorf("%s composes concrete package %s; composition belongs in main.go", entry.Name(), importPath)
			}
		}
	}
}

func inspectGoSource(path string, source []byte) []string {
	parsed, err := parser.ParseFile(token.NewFileSet(), path, source, 0)
	if err != nil {
		return []string{fmt.Sprintf("%s: cannot parse: %v", path, err)}
	}
	var violations []string
	directory := filepath.ToSlash(filepath.Dir(path))
	for _, spec := range parsed.Imports {
		importPath, err := strconv.Unquote(spec.Path.Value)
		if err != nil {
			continue
		}
		switch {
		case directory == "internal/domain" && (importPath == "net/http" || importPath == "database/sql" || strings.HasPrefix(importPath, "github.com/wailsapp/wails/") || strings.HasPrefix(importPath, "modernc.org/sqlite") || strings.HasPrefix(importPath, "token-monitor-analytics/internal/adapter") || importPath == "token-monitor-analytics/internal/desktop"):
			violations = append(violations, fmt.Sprintf("%s: domain must not import %s", path, importPath))
		case directory == "internal/usecase" && (strings.HasPrefix(importPath, "token-monitor-analytics/internal/adapter") || importPath == "token-monitor-analytics/internal/desktop"):
			violations = append(violations, fmt.Sprintf("%s: usecase must not import %s", path, importPath))
		case strings.HasPrefix(directory, "internal/adapter/") && directory != "internal/adapter/scheduler" && strings.HasPrefix(importPath, "token-monitor-analytics/internal/adapter/") && adapterName(directory) != adapterName(strings.TrimPrefix(importPath, "token-monitor-analytics/")):
			violations = append(violations, fmt.Sprintf("%s: output adapters must not depend on each other (%s)", path, importPath))
		case directory == "internal/desktop" && strings.HasPrefix(importPath, "token-monitor-analytics/internal/adapter/"):
			violations = append(violations, fmt.Sprintf("%s: desktop must not import output adapter %s", path, importPath))
		case directory == "internal/desktop" && importPath == "database/sql":
			violations = append(violations, fmt.Sprintf("%s: desktop must not import database/sql", path))
		}
	}
	if directory == "internal/desktop" {
		ast.Inspect(parsed, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if ok && (selector.Sel.Name == "Exec" || selector.Sel.Name == "ExecContext" || selector.Sel.Name == "Query" || selector.Sel.Name == "QueryContext" || selector.Sel.Name == "QueryRow" || selector.Sel.Name == "QueryRowContext") {
				violations = append(violations, fmt.Sprintf("%s: desktop must not execute SQL directly (%s)", path, selector.Sel.Name))
			}
			return true
		})
	}
	return violations
}

func adapterName(path string) string {
	remainder := strings.TrimPrefix(filepath.ToSlash(path), "internal/adapter/")
	return strings.SplitN(remainder, "/", 2)[0]
}

func containsViolation(violations []string, fragment string) bool {
	for _, violation := range violations {
		if strings.Contains(violation, fragment) {
			return true
		}
	}
	return false
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, current, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate policy test")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(current), "..", ".."))
}
