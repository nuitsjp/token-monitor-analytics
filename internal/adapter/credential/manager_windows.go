//go:build windows

package credential

import (
	"encoding/binary"
	"errors"
	"fmt"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	credentialTypeGeneric         = 1
	credentialPersistLocalMachine = 2
	credentialUsername            = "Token Monitor Analytics Hub"
	targetPrefix                  = "TokenMonitorAnalytics/Hub/"
)

var (
	advapi32   = windows.NewLazySystemDLL("advapi32.dll")
	credWrite  = advapi32.NewProc("CredWriteW")
	credRead   = advapi32.NewProc("CredReadW")
	credDelete = advapi32.NewProc("CredDeleteW")
	credFree   = advapi32.NewProc("CredFree")
)

type nativeCredential struct {
	Flags              uint32
	Type               uint32
	TargetName         *uint16
	Comment            *uint16
	LastWritten        windows.Filetime
	CredentialBlobSize uint32
	CredentialBlob     *byte
	Persist            uint32
	AttributeCount     uint32
	Attributes         uintptr
	TargetAlias        *uint16
	UserName           *uint16
}

type Manager struct{}

func Target(hubID string) (string, error) {
	if hubID == "" {
		return "", errors.New("hub ID is empty")
	}
	for _, char := range hubID {
		if char == '\\' || char == '/' || char == 0 {
			return "", errors.New("hub ID contains an invalid character")
		}
	}
	return targetPrefix + hubID, nil
}

func (Manager) Write(hubID, secret string) error {
	if secret == "" {
		return errors.New("credential secret is empty")
	}
	targetName, err := Target(hubID)
	if err != nil {
		return err
	}
	target, err := windows.UTF16PtrFromString(targetName)
	if err != nil {
		return fmt.Errorf("encode credential target: %w", err)
	}
	username, err := windows.UTF16PtrFromString(credentialUsername)
	if err != nil {
		return fmt.Errorf("encode credential username: %w", err)
	}
	blob := encodeSecret(secret)
	defer clear(blob)
	native := nativeCredential{
		Type:               credentialTypeGeneric,
		TargetName:         target,
		CredentialBlobSize: uint32(len(blob)),
		CredentialBlob:     &blob[0],
		Persist:            credentialPersistLocalMachine,
		UserName:           username,
	}
	ok, _, callErr := credWrite.Call(uintptr(unsafe.Pointer(&native)), 0)
	if ok == 0 {
		return fmt.Errorf("write Windows credential: %w", callErr)
	}
	return nil
}

func (Manager) Read(hubID string) (string, bool, error) {
	targetName, err := Target(hubID)
	if err != nil {
		return "", false, err
	}
	target, err := windows.UTF16PtrFromString(targetName)
	if err != nil {
		return "", false, fmt.Errorf("encode credential target: %w", err)
	}
	var native *nativeCredential
	ok, _, callErr := credRead.Call(uintptr(unsafe.Pointer(target)), credentialTypeGeneric, 0, uintptr(unsafe.Pointer(&native)))
	if ok == 0 {
		if errors.Is(callErr, windows.ERROR_NOT_FOUND) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("read Windows credential: %w", callErr)
	}
	defer credFree.Call(uintptr(unsafe.Pointer(native)))
	if native.CredentialBlobSize == 0 {
		return "", true, nil
	}
	if native.CredentialBlob == nil || native.CredentialBlobSize%2 != 0 {
		return "", false, errors.New("windows credential has an invalid blob")
	}
	blob := unsafe.Slice(native.CredentialBlob, int(native.CredentialBlobSize))
	secret, err := decodeSecret(blob)
	if err != nil {
		return "", false, err
	}
	return secret, true, nil
}

func (Manager) Delete(hubID string) error {
	targetName, err := Target(hubID)
	if err != nil {
		return err
	}
	target, err := windows.UTF16PtrFromString(targetName)
	if err != nil {
		return fmt.Errorf("encode credential target: %w", err)
	}
	ok, _, callErr := credDelete.Call(uintptr(unsafe.Pointer(target)), credentialTypeGeneric, 0)
	if ok == 0 && !errors.Is(callErr, windows.ERROR_NOT_FOUND) {
		return fmt.Errorf("delete Windows credential: %w", callErr)
	}
	return nil
}

func encodeSecret(secret string) []byte {
	units := utf16.Encode([]rune(secret))
	defer clear(units)
	blob := make([]byte, len(units)*2)
	for index, unit := range units {
		binary.LittleEndian.PutUint16(blob[index*2:], unit)
	}
	return blob
}

func decodeSecret(blob []byte) (string, error) {
	if len(blob)%2 != 0 {
		return "", errors.New("credential blob has an invalid UTF-16LE length")
	}
	units := make([]uint16, len(blob)/2)
	defer clear(units)
	for index := range units {
		units[index] = binary.LittleEndian.Uint16(blob[index*2:])
	}
	return string(utf16.Decode(units)), nil
}
