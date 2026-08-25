//go:build !windows

package sqlite

import (
	"os"
	"syscall"
)

func replaceRestoreJournal(source, destination string) error {
	return os.Rename(source, destination)
}

func moveRestoreFilePlatform(source, destination string) error {
	return os.Rename(source, destination)
}

func syncRestoreDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func sameRestoreVolume(left, right string) bool {
	leftInfo, leftErr := os.Stat(left)
	rightInfo, rightErr := os.Stat(right)
	if leftErr != nil || rightErr != nil {
		return false
	}
	leftStat, leftOK := leftInfo.Sys().(*syscall.Stat_t)
	rightStat, rightOK := rightInfo.Sys().(*syscall.Stat_t)
	return leftOK && rightOK && leftStat.Dev == rightStat.Dev
}
