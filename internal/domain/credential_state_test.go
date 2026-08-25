package domain

import "testing"

func TestDeriveCredentialState(t *testing.T) {
	tests := []struct {
		name    string
		actions []string
		want    CredentialState
	}{
		{name: "none", want: CredentialUnregistered},
		{name: "saved", actions: []string{"credential_save_started", "credential_saved"}, want: CredentialRegistered},
		{name: "failed save remains safe", actions: []string{"credential_save_started"}, want: CredentialUnregistered},
		{name: "deleted", actions: []string{"credential_saved", "credential_delete_started", "credential_deleted"}, want: CredentialUnregistered},
		{name: "restore blocks old secret", actions: []string{"credential_saved", "restore_succeeded"}, want: CredentialPostRestorePending},
		{name: "save after restore still waits", actions: []string{"credential_saved", "restore_succeeded", "credential_saved"}, want: CredentialPostRestorePending},
		{name: "failed connection keeps waiting", actions: []string{"credential_saved", "restore_succeeded", "credential_saved", "credential_connection_failed"}, want: CredentialPostRestorePending},
		{name: "successful reconfirmation releases", actions: []string{"credential_saved", "restore_succeeded", "credential_saved", "credential_reconfirmed"}, want: CredentialRegistered},
		{name: "delete after restore unregisters", actions: []string{"credential_saved", "restore_succeeded", "credential_deleted"}, want: CredentialUnregistered},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			events := make([]CredentialEvent, len(test.actions))
			for index, action := range test.actions {
				events[index] = CredentialEvent{Sequence: int64(index + 1), Action: action}
			}
			if got := DeriveCredentialState(events); got != test.want {
				t.Fatalf("state = %q, want %q", got, test.want)
			}
		})
	}
}
