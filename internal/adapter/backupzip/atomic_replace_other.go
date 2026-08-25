//go:build !windows

package backupzip

import "errors"

func newAtomicReplacer() (AtomicReplacer, error) {
	return nil, errors.New("safe Windows atomic replacement is unavailable")
}
