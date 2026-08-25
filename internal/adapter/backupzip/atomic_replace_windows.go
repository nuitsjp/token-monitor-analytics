//go:build windows

package backupzip

import (
	"errors"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

type windowsAtomicReplacer struct{}

var kernel32 = windows.NewLazySystemDLL("kernel32.dll")
var replaceFile = kernel32.NewProc("ReplaceFileW")

func newAtomicReplacer() (AtomicReplacer, error) {
	return windowsAtomicReplacer{}, nil
}

func (windowsAtomicReplacer) Replace(sourcePath, destinationPath string) error {
	source, err := windows.UTF16PtrFromString(sourcePath)
	if err != nil {
		return err
	}
	destination, err := windows.UTF16PtrFromString(destinationPath)
	if err != nil {
		return err
	}
	_, statErr := os.Stat(destinationPath)
	if statErr == nil {
		const replaceFileWriteThrough = 1
		result, _, callErr := replaceFile.Call(
			uintptr(unsafe.Pointer(destination)),
			uintptr(unsafe.Pointer(source)),
			0,
			replaceFileWriteThrough,
			0,
			0,
		)
		if result == 0 {
			return callErr
		}
		return nil
	}
	if !errors.Is(statErr, os.ErrNotExist) {
		return statErr
	}
	return windows.MoveFileEx(source, destination, windows.MOVEFILE_WRITE_THROUGH)
}
