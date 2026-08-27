package policy_test

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"unicode"
)

var markdownLink = regexp.MustCompile(`\[[^\]]*\]\(([^)]+)\)`)
var markdownHeading = regexp.MustCompile(`(?m)^#{1,6}\s+(.+?)\s*$`)

func TestMarkdownInternalLinksAndHeadings(t *testing.T) {
	root := repositoryRoot(t)
	paths := []string{"README.md", "CONTEXT.md"}
	documents, err := filepath.Glob(filepath.Join(root, "docs", "*.md"))
	if err != nil {
		t.Fatal(err)
	}
	paths = append(paths, documents...)
	for _, path := range paths {
		if !filepath.IsAbs(path) {
			path = filepath.Join(root, path)
		}
		checkMarkdownFile(t, root, path)
	}
}

func checkMarkdownFile(t *testing.T, root, path string) {
	t.Helper()
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(contents)
	anchors := map[string]struct{}{}
	for _, match := range markdownHeading.FindAllStringSubmatch(text, -1) {
		anchor := githubAnchor(match[1])
		if _, exists := anchors[anchor]; exists {
			t.Errorf("%s has duplicate heading anchor #%s", relativePath(root, path), anchor)
		}
		anchors[anchor] = struct{}{}
	}
	for _, match := range markdownLink.FindAllStringSubmatch(text, -1) {
		target := strings.TrimSpace(strings.Trim(match[1], "<>"))
		if target == "" || strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://") || strings.HasPrefix(target, "mailto:") {
			continue
		}
		parts := strings.SplitN(target, "#", 2)
		targetPath := path
		if parts[0] != "" {
			targetPath = filepath.Clean(filepath.Join(filepath.Dir(path), filepath.FromSlash(parts[0])))
			if _, err := os.Stat(targetPath); err != nil {
				t.Errorf("%s links to missing path %s", relativePath(root, path), target)
				continue
			}
		}
		if len(parts) == 2 && strings.HasSuffix(strings.ToLower(targetPath), ".md") {
			targetContents, err := os.ReadFile(targetPath)
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, heading := range markdownHeading.FindAllStringSubmatch(string(targetContents), -1) {
				if githubAnchor(heading[1]) == parts[1] {
					found = true
					break
				}
			}
			if !found {
				t.Errorf("%s links to missing anchor %s", relativePath(root, path), target)
			}
		}
	}
}

func githubAnchor(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var result strings.Builder
	for _, r := range value {
		switch {
		case unicode.IsLetter(r), unicode.IsDigit(r), r == '-', r == '_', r == ' ':
			if r == ' ' {
				result.WriteRune('-')
			} else {
				result.WriteRune(r)
			}
		}
	}
	return result.String()
}

func relativePath(root, path string) string {
	relative, err := filepath.Rel(root, path)
	if err != nil {
		return path
	}
	return filepath.ToSlash(relative)
}
