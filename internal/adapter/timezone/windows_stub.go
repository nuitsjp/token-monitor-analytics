//go:build !windows

package timezone

import "errors"

var ErrWindowsOnly = errors.New("Windows timezone identification is only available on Windows")

// CurrentWindowsID is unavailable on non-Windows systems. Tests and callers
// can pass a Windows ID directly to WindowsIDToIANA.
func CurrentWindowsID() (string, error) { return "", ErrWindowsOnly }
