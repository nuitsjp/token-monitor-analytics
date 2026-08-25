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
	for _, event := range events {
		switch event.Action {
		case "restore_succeeded":
			state = CredentialPostRestorePending
			restored = true
		case "credential_saved":
			if !restored {
				state = CredentialRegistered
			}
		case "credential_deleted":
			state = CredentialUnregistered
			restored = false
		case "credential_reconfirmed":
			if restored {
				state = CredentialRegistered
				restored = false
			}
		case "credential_save_started", "credential_delete_started":
			if !restored {
				state = CredentialUnregistered
			}
		}
	}
	return state
}
