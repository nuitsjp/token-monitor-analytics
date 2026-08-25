//go:build windows

package sqlite

import (
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

func replaceRestoreJournal(source, destination string) error {
	return moveRestoreFileEx(source, destination, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}

func moveRestoreFilePlatform(source, destination string) error {
	return moveRestoreFileEx(source, destination, windows.MOVEFILE_WRITE_THROUGH)
}

func moveRestoreFileEx(source, destination string, flags uint32) error {
	from, err := windows.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(destination)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(from, to, flags)
}

func syncRestoreDirectory(string) error { return nil }

func sameRestoreVolume(left, right string) bool {
	return strings.EqualFold(filepath.VolumeName(left), filepath.VolumeName(right))
}
