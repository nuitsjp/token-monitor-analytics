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
	credTypeGeneric         = 1
	credTypeMaximum         = 7
	credPersistLocalMachine = 2
	credentialUsername      = "Token Monitor Hub"
)

var (
	advapi32                = windows.NewLazySystemDLL("advapi32.dll")
	procCredWriteW          = advapi32.NewProc("CredWriteW")
	procCredReadW           = advapi32.NewProc("CredReadW")
	procCredDeleteW         = advapi32.NewProc("CredDeleteW")
	procCredFree            = advapi32.NewProc("CredFree")
	procCredGetSessionTypes = advapi32.NewProc("CredGetSessionTypes")
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

type Manager struct {
	target string
}

func New() *Manager {
	return &Manager{target: DefaultTarget}
}

func (m *Manager) Read() (string, bool, error) {
	target, err := windows.UTF16PtrFromString(m.target)
	if err != nil {
		return "", false, fmt.Errorf("encode credential target: %w", err)
	}
	var native *nativeCredential
	ok, _, callErr := procCredReadW.Call(
		uintptr(unsafe.Pointer(target)),
		credTypeGeneric,
		0,
		uintptr(unsafe.Pointer(&native)),
	)
	if ok == 0 {
		if errors.Is(callErr, windows.ERROR_NOT_FOUND) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("read Windows credential %q: %w", m.target, callErr)
	}
	defer procCredFree.Call(uintptr(unsafe.Pointer(native)))
	if native.CredentialBlobSize == 0 {
		return "", true, nil
	}
	if native.CredentialBlob == nil || native.CredentialBlobSize%2 != 0 {
		return "", false, fmt.Errorf("Windows credential %q has an invalid blob", m.target)
	}
	blob := unsafe.Slice(native.CredentialBlob, int(native.CredentialBlobSize))
	defer clear(blob)
	secret, err := decodeSecret(blob)
	if err != nil {
		return "", false, fmt.Errorf("decode Windows credential %q: %w", m.target, err)
	}
	return secret, true, nil
}

func (m *Manager) Write(secret string) error {
	if secret == "" {
		return errors.New("credential secret is empty")
	}
	if err := supportsLocalMachinePersistence(); err != nil {
		return err
	}
	target, err := windows.UTF16PtrFromString(m.target)
	if err != nil {
		return fmt.Errorf("encode credential target: %w", err)
	}
	username, err := windows.UTF16PtrFromString(credentialUsername)
	if err != nil {
		return fmt.Errorf("encode credential username: %w", err)
	}
	blob := encodeSecret(secret)
	defer clear(blob)
	credential := nativeCredential{
		Type:               credTypeGeneric,
		TargetName:         target,
		CredentialBlobSize: uint32(len(blob)),
		CredentialBlob:     &blob[0],
		Persist:            credPersistLocalMachine,
		UserName:           username,
	}
	ok, _, callErr := procCredWriteW.Call(uintptr(unsafe.Pointer(&credential)), 0)
	if ok == 0 {
		return fmt.Errorf("write Windows credential %q: %w", m.target, callErr)
	}
	return nil
}

func (m *Manager) Delete() error {
	target, err := windows.UTF16PtrFromString(m.target)
	if err != nil {
		return fmt.Errorf("encode credential target: %w", err)
	}
	ok, _, callErr := procCredDeleteW.Call(uintptr(unsafe.Pointer(target)), credTypeGeneric, 0)
	if ok == 0 && !errors.Is(callErr, windows.ERROR_NOT_FOUND) {
		return fmt.Errorf("delete Windows credential %q: %w", m.target, callErr)
	}
	return nil
}

func supportsLocalMachinePersistence() error {
	maximumPersist := make([]uint32, credTypeMaximum)
	ok, _, callErr := procCredGetSessionTypes.Call(
		uintptr(len(maximumPersist)),
		uintptr(unsafe.Pointer(&maximumPersist[0])),
	)
	if ok == 0 {
		return fmt.Errorf("query Windows credential persistence: %w", callErr)
	}
	if maximumPersist[credTypeGeneric] < credPersistLocalMachine {
		return errors.New("Windows Credential Manager does not support local-machine persistence for Generic Credentials")
	}
	return nil
}

func encodeSecret(secret string) []byte {
	runes := []rune(secret)
	defer clear(runes)
	units := utf16.Encode(runes)
	defer clear(units)
	blob := make([]byte, len(units)*2)
	for index, unit := range units {
		binary.LittleEndian.PutUint16(blob[index*2:], unit)
	}
	return blob
}

func decodeSecret(blob []byte) (string, error) {
	if len(blob)%2 != 0 {
		return "", errors.New("UTF-16LE blob length is odd")
	}
	units := make([]uint16, len(blob)/2)
	defer clear(units)
	for index := range units {
		units[index] = binary.LittleEndian.Uint16(blob[index*2:])
	}
	return string(utf16.Decode(units)), nil
}
