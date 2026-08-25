//go:build !windows

package credential

import (
	"errors"
	"strings"
)

type Manager struct{}

func Target(hubID string) (string, error) {
	if hubID == "" {
		return "", errors.New("hub ID is empty")
	}
	if strings.ContainsAny(hubID, "/\\\x00") {
		return "", errors.New("hub ID contains an invalid character")
	}
	return "TokenMonitorAnalytics/Hub/" + hubID, nil
}

func (Manager) Write(string, string) error {
	return errors.New("Windows Credential Manager is unavailable")
}
func (Manager) Read(string) (string, bool, error) {
	return "", false, errors.New("Windows Credential Manager is unavailable")
}
func (Manager) Delete(string) error { return errors.New("Windows Credential Manager is unavailable") }
