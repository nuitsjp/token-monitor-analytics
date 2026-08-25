package sqlite

import (
	"errors"
	"path/filepath"
	"strings"
)

func rejectRestoreReparsePath(path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return errors.New("resolve isolated restore path")
	}
	volume := filepath.VolumeName(absolute)
	remainder := strings.TrimPrefix(absolute[len(volume):], string(filepath.Separator))
	current := volume + string(filepath.Separator)
	for _, component := range strings.Split(remainder, string(filepath.Separator)) {
		if component == "" {
			continue
		}
		current = filepath.Join(current, component)
		reparse, err := isRestoreReparsePoint(current)
		if err != nil {
			return errors.New("inspect isolated restore path")
		}
		if reparse {
			return errors.New("isolated restore path contains a reparse point")
		}
	}
	return nil
}
