package sqlite

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	RestoreDatabaseName         = "analytics.sqlite3"
	RestoreOriginalDatabaseName = "restore-original.sqlite3"
	RestoreIncomingDatabaseName = "restore-incoming.sqlite3"
	RestoreJournalName          = "restore-journal.json"
	restoreJournalTemporaryName = "restore-journal.tmp"
)

type restorePaths struct {
	root             string
	current          string
	original         string
	incoming         string
	journal          string
	journalTemporary string
}

func newRestorePaths(dataDirectory string) (restorePaths, error) {
	root, err := filepath.Abs(dataDirectory)
	if err != nil {
		return restorePaths{}, errors.New("resolve restore data directory")
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return restorePaths{}, errors.New("restore data directory is unavailable")
	}
	if err := rejectRestoreReparsePath(root); err != nil {
		return restorePaths{}, errors.New("restore data directory contains a reparse point")
	}
	return restorePaths{
		root:             root,
		current:          filepath.Join(root, RestoreDatabaseName),
		original:         filepath.Join(root, RestoreOriginalDatabaseName),
		incoming:         filepath.Join(root, RestoreIncomingDatabaseName),
		journal:          filepath.Join(root, RestoreJournalName),
		journalTemporary: filepath.Join(root, restoreJournalTemporaryName),
	}, nil
}

func validateRestoreCandidatePath(paths restorePaths, candidate string) (string, error) {
	absolute, err := filepath.Abs(candidate)
	if err != nil {
		return "", errors.New("resolve validated restore candidate")
	}
	relative, err := filepath.Rel(paths.root, absolute)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("validated restore candidate is outside application data")
	}
	if filepath.Base(absolute) != "data.sqlite3" || filepath.Dir(filepath.Dir(absolute)) != paths.root || !strings.HasPrefix(filepath.Base(filepath.Dir(absolute)), "restore-validated-") {
		return "", errors.New("validated restore candidate does not use the fixed naming convention")
	}
	if err := validateRestoreRegularFile(absolute); err != nil {
		return "", err
	}
	if err := rejectRestoreReparsePath(absolute); err != nil {
		return "", err
	}
	for _, sidecar := range []string{absolute + "-wal", absolute + "-shm"} {
		if exists, err := restoreFileExists(sidecar); err != nil {
			return "", err
		} else if exists {
			return "", errors.New("validated restore candidate contains a sidecar")
		}
	}
	if !sameRestoreVolume(paths.current, absolute) {
		return "", errors.New("validated restore candidate is not on the operational database volume")
	}
	if err := ensureDistinctRestoreFiles(paths.current, absolute); err != nil {
		return "", err
	}
	return absolute, nil
}

func ensureRestoreWorkspaceClean(paths restorePaths) error {
	for _, path := range []string{
		paths.original, paths.original + "-wal", paths.original + "-shm",
		paths.incoming, paths.incoming + "-wal", paths.incoming + "-shm",
		paths.journal, paths.journalTemporary,
	} {
		if exists, err := restoreFileExists(path); err != nil {
			return err
		} else if exists {
			return errors.New("restore workspace contains a previous fixed-name artifact")
		}
	}
	return nil
}

func validateRestoreRegularFile(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return errors.New("restore file is unavailable")
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("restore path is not a regular file")
	}
	if reparse, err := isRestoreReparsePoint(path); err != nil {
		return errors.New("inspect restore file identity")
	} else if reparse {
		return errors.New("restore file is a reparse point")
	}
	return nil
}

func ensureDistinctRestoreFiles(left, right string) error {
	leftInfo, leftErr := os.Stat(left)
	rightInfo, rightErr := os.Stat(right)
	if leftErr != nil || rightErr != nil {
		return errors.New("inspect restore file identity")
	}
	if os.SameFile(leftInfo, rightInfo) {
		return errors.New("restore files have the same identity")
	}
	return nil
}

func restoreFileExists(path string) (bool, error) {
	_, err := os.Lstat(path)
	if err == nil {
		return true, nil
	}
	if os.IsNotExist(err) {
		return false, nil
	}
	return false, errors.New("inspect fixed restore file")
}

func moveRestoreFile(root, source, destination string) error {
	if err := validateRestoreRegularFile(source); err != nil {
		return err
	}
	if exists, err := restoreFileExists(destination); err != nil {
		return err
	} else if exists {
		return errors.New("restore move destination already exists")
	}
	if !sameRestoreVolume(source, root) {
		return errors.New("restore move crosses volumes")
	}
	if err := moveRestoreFilePlatform(source, destination); err != nil {
		return errors.New("move fixed restore file")
	}
	return syncRestoreDirectory(root)
}

func removeRestoreFileIfPresent(root, path string) error {
	exists, err := restoreFileExists(path)
	if err != nil || !exists {
		return err
	}
	if err := validateRestoreRegularFile(path); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		return errors.New("remove fixed restore file")
	}
	return syncRestoreDirectory(root)
}

func syncRestoreFile(path string) error {
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	syncErr := file.Sync()
	closeErr := file.Close()
	return errors.Join(syncErr, closeErr)
}

func restorePresence(paths restorePaths) (current, original, incoming bool, err error) {
	current, err = restoreFileExists(paths.current)
	if err != nil {
		return false, false, false, err
	}
	original, err = restoreFileExists(paths.original)
	if err != nil {
		return false, false, false, err
	}
	incoming, err = restoreFileExists(paths.incoming)
	return current, original, incoming, err
}

func validateExistingFixedRestoreFiles(paths restorePaths) error {
	for _, path := range []string{
		paths.current, paths.current + "-wal", paths.current + "-shm",
		paths.original, paths.original + "-wal", paths.original + "-shm",
		paths.incoming, paths.incoming + "-wal", paths.incoming + "-shm",
		paths.journal, paths.journalTemporary,
	} {
		exists, err := restoreFileExists(path)
		if err != nil {
			return err
		}
		if !exists {
			continue
		}
		if err := validateRestoreRegularFile(path); err != nil {
			return fmt.Errorf("unsafe fixed restore file: %w", err)
		}
		if err := rejectRestoreReparsePath(path); err != nil {
			return errors.New("fixed restore file path contains a reparse point")
		}
	}
	return nil
}
