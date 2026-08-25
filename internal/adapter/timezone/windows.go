//go:build windows

package timezone

import (
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	kernel32                      = windows.NewLazySystemDLL("kernel32.dll")
	getDynamicTimeZoneInformation = kernel32.NewProc("GetDynamicTimeZoneInformation")
)

type dynamicTimezoneInformation struct {
	Bias                        int32
	StandardName                [32]uint16
	StandardDate                windows.Systemtime
	StandardBias                int32
	DaylightName                [32]uint16
	DaylightDate                windows.Systemtime
	DaylightBias                int32
	TimeZoneKeyName             [128]uint16
	DynamicDaylightTimeDisabled byte
}

// CurrentWindowsID reads the stable Windows registry key name rather than a
// localized display name. The key is looked up in the fixed CLDR table by the
// caller.
func CurrentWindowsID() (string, error) {
	var info dynamicTimezoneInformation
	result, _, callErr := getDynamicTimeZoneInformation.Call(uintptr(unsafe.Pointer(&info)))
	if result == ^uintptr(0) {
		if callErr == nil {
			callErr = errors.New("get dynamic timezone information failed")
		}
		return "", fmt.Errorf("get Windows timezone ID: %w", callErr)
	}
	id := windows.UTF16ToString(info.TimeZoneKeyName[:])
	if id == "" {
		return "", errors.New("windows returned an empty timezone ID")
	}
	return id, nil
}
