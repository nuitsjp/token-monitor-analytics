//go:build !windows

package credential

import "errors"

type Manager struct {
	target string
}

func New() *Manager {
	return &Manager{target: DefaultTarget}
}

func NewForTarget(target string) *Manager {
	return &Manager{target: target}
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
