//go:build !windows

package credential

import "errors"

type Manager struct{}

func New() *Manager {
	return &Manager{}
}

func (m *Manager) Read() (string, bool, error) {
	return "", false, errors.New("Windows Credential Manager is only available on Windows")
}

func (m *Manager) Write(string) error {
	return errors.New("Windows Credential Manager is only available on Windows")
}

func (m *Manager) Delete() error {
	return errors.New("Windows Credential Manager is only available on Windows")
}
