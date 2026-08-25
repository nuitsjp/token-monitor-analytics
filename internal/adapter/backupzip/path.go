package backupzip

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func validateDestination(destination, applicationDataDir string, protectedPaths []string) error {
	if destination == "" {
		return errors.New("backup destination is required")
	}
	dataDir, err := filepath.Abs(applicationDataDir)
	if err != nil {
		return errors.New("resolve application data directory")
	}
	destination, err = filepath.Abs(destination)
	if err != nil {
		return errors.New("resolve backup destination")
	}
	destination = filepath.Clean(destination)
	dataDir = filepath.Clean(dataDir)
	if pathWithin(destination, dataDir) {
		return errors.New("backup destination must be outside application data directory")
	}
	parent := filepath.Dir(destination)
	parentInfo, err := os.Stat(parent)
	if err != nil {
		return errors.New("backup destination directory is unavailable")
	}
	if !parentInfo.IsDir() {
		return errors.New("backup destination parent is not a directory")
	}
	if err := rejectReparsePath(parent); err != nil {
		return err
	}
	if err := rejectResolvedApplicationDataPath(destination, dataDir); err != nil {
		return err
	}
	if info, err := os.Lstat(destination); err == nil {
		if info.IsDir() {
			return errors.New("backup destination is a directory")
		}
		if err := rejectReparsePath(destination); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return errors.New("inspect backup destination")
	}
	for _, protected := range protectedPaths {
		if protected == "" {
			continue
		}
		protectedAbsolute, err := filepath.Abs(protected)
		if err != nil {
			return errors.New("resolve protected backup path")
		}
		if filepath.Clean(protectedAbsolute) == destination {
			return errors.New("backup destination is a protected application file")
		}
		if same, err := sameFileIdentity(destination, protectedAbsolute); err != nil {
			return errors.New("compare backup destination file identity")
		} else if same {
			return errors.New("backup destination aliases a protected application file")
		}
	}
	return nil
}

func pathWithin(path, parent string) bool {
	relative, err := filepath.Rel(parent, path)
	if err != nil {
		return false
	}
	return relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)))
}

func rejectResolvedApplicationDataPath(destination, applicationDataDir string) error {
	resolvedDataDir, err := filepath.EvalSymlinks(applicationDataDir)
	if err != nil {
		return errors.New("resolve application data directory identity")
	}
	resolvedParent, err := filepath.EvalSymlinks(filepath.Dir(destination))
	if err != nil {
		return errors.New("resolve backup destination directory identity")
	}
	resolvedDestination := filepath.Join(resolvedParent, filepath.Base(destination))
	if pathWithin(resolvedDestination, resolvedDataDir) {
		return errors.New("backup destination resolves inside application data directory")
	}
	return nil
}

func rejectReparsePath(path string) error {
	components := filepath.VolumeName(path)
	rest := path[len(components):]
	if len(rest) > 0 && rest[0:1] == string(filepath.Separator) {
		components += string(filepath.Separator)
		rest = rest[1:]
	}
	for len(rest) > 0 {
		separator := string(filepath.Separator)
		if rest[0:1] == separator {
			rest = rest[1:]
			continue
		}
		index := 0
		for index < len(rest) && rest[index:index+1] != separator {
			index++
		}
		components = filepath.Join(components, rest[:index])
		if reparse, err := isReparsePoint(components); err != nil {
			return errors.New("inspect backup destination path")
		} else if reparse {
			return fmt.Errorf("backup destination path contains a reparse point")
		}
		rest = rest[index:]
	}
	return nil
}

func sameFileIdentity(left, right string) (bool, error) {
	leftInfo, err := os.Stat(left)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	rightInfo, err := os.Stat(right)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return os.SameFile(leftInfo, rightInfo), nil
}
