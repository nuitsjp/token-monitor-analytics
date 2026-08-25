package domain

type CredentialState string

const (
	CredentialUnregistered       CredentialState = "unregistered"
	CredentialRegistered         CredentialState = "registered"
	CredentialPostRestorePending CredentialState = "post_restore_pending"
)

type CredentialEvent struct {
	Sequence int64
	Action   string
}

func DeriveCredentialState(events []CredentialEvent) CredentialState {
	state := CredentialUnregistered
	restored := false
	savedAfterRestore := false
	for _, event := range events {
		switch event.Action {
		case "restore_succeeded":
			state = CredentialPostRestorePending
			restored = true
			savedAfterRestore = false
		case "credential_saved":
			if restored {
				savedAfterRestore = true
			} else {
				state = CredentialRegistered
			}
		case "credential_deleted":
			state = CredentialUnregistered
			restored = false
			savedAfterRestore = false
		case "credential_reconfirmed":
			if restored && savedAfterRestore {
				state = CredentialRegistered
				restored = false
				savedAfterRestore = false
			}
		case "credential_save_started", "credential_delete_started":
			if !restored {
				state = CredentialUnregistered
			}
		}
	}
	return state
}

func CredentialReadyForConnection(events []CredentialEvent) bool {
	registered := false
	restored := false
	savedAfterRestore := false
	for _, event := range events {
		switch event.Action {
		case "restore_succeeded":
			restored = true
			savedAfterRestore = false
		case "credential_saved":
			registered = true
			if restored {
				savedAfterRestore = true
			}
		case "credential_deleted", "credential_save_started", "credential_delete_started":
			registered = false
			if event.Action == "credential_deleted" {
				restored = false
				savedAfterRestore = false
			}
		case "credential_reconfirmed":
			if restored && savedAfterRestore {
				restored = false
			}
		}
	}
	return registered && (!restored || savedAfterRestore)
}
