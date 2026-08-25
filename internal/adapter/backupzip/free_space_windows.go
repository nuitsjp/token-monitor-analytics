//go:build windows

package backupzip

import "golang.org/x/sys/windows"

func freeSpace(path string) (uint64, error) {
	pathUTF16, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var available uint64
	if err := windows.GetDiskFreeSpaceEx(pathUTF16, &available, nil, nil); err != nil {
		return 0, err
	}
	return available, nil
}
