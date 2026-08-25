package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	credentialadapter "token-monitor-analytics/internal/adapter/credential"
	"token-monitor-analytics/internal/adapter/hubapi"
	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	"token-monitor-analytics/internal/domain"
	"token-monitor-analytics/internal/usecase"
)

type CredentialStore interface {
	Write(hubID, secret string) error
	Read(hubID string) (secret string, found bool, err error)
	Delete(hubID string) error
}

type HubService struct {
	lifecycle   *sqliteadapter.Lifecycle
	credentials CredentialStore
	clock       usecase.Clock
	ids         usecase.IDGenerator
	allowlist   hubapi.Allowlist
}

type UUIDGenerator struct{}

func (UUIDGenerator) New() string { return uuid.NewString() }

type HubSnapshot struct {
	ID                        string `json:"id"`
	DisplayName               string `json:"displayName"`
	URL                       string `json:"url"`
	CollectionEnabled         bool   `json:"collectionEnabled"`
	CollectionIntervalSeconds int64  `json:"collectionIntervalSeconds"`
	APIContract               string `json:"apiContract"`
	CredentialState           string `json:"credentialState"`
	CredentialReady           bool   `json:"credentialReady"`
	ConnectionState           string `json:"connectionState"`
	ConnectionCheckedAt       string `json:"connectionCheckedAt"`
	ConnectionFailureNote     string `json:"connectionFailureNote"`
}

type CreateHubInput struct {
	DisplayName               string `json:"displayName"`
	URL                       string `json:"url"`
	CollectionIntervalSeconds int64  `json:"collectionIntervalSeconds"`
	CollectionEnabled         bool   `json:"collectionEnabled"`
	Secret                    string `json:"secret"`
}

type UpdateHubInput struct {
	ID                        string `json:"id"`
	DisplayName               string `json:"displayName"`
	URL                       string `json:"url"`
	CollectionIntervalSeconds int64  `json:"collectionIntervalSeconds"`
}

func NewHubService(lifecycle *sqliteadapter.Lifecycle, credentials credentialadapter.Manager) *HubService {
	return NewHubServiceWithDependencies(lifecycle, credentials, usecase.SystemClock{}, UUIDGenerator{})
}

func NewHubServiceWithDependencies(lifecycle *sqliteadapter.Lifecycle, credentials CredentialStore, clock usecase.Clock, ids usecase.IDGenerator) *HubService {
	if clock == nil {
		clock = usecase.SystemClock{}
	}
	if ids == nil {
		ids = UUIDGenerator{}
	}
	return &HubService{lifecycle: lifecycle, credentials: credentials, clock: clock, ids: ids, allowlist: hubapi.DefaultAllowlist}
}

func (s *HubService) GetHubs(ctx context.Context) ([]HubSnapshot, error) {
	rows, err := s.lifecycle.ListHubRows(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]HubSnapshot, 0, len(rows))
	for _, row := range rows {
		view, err := s.snapshot(ctx, row)
		if err != nil {
			return nil, err
		}
		result = append(result, view)
	}
	return result, nil
}

func (s *HubService) CreateHub(ctx context.Context, input CreateHubInput) (HubSnapshot, error) {
	id, err := s.newUUID()
	if err != nil {
		return HubSnapshot{}, err
	}
	now := s.now()
	if err := s.lifecycle.CreateHub(ctx, sqliteadapter.Hub{
		ID: id, DisplayName: input.DisplayName, URL: input.URL,
		CollectionEnabled:         input.CollectionEnabled,
		CollectionIntervalSeconds: input.CollectionIntervalSeconds,
		CreatedAt:                 now, UpdatedAt: now,
	}); err != nil {
		return HubSnapshot{}, err
	}
	if input.Secret != "" {
		if err := s.saveCredential(ctx, id, input.Secret); err != nil {
			return HubSnapshot{}, err
		}
	}
	return s.GetHub(ctx, id)
}

func (s *HubService) UpdateHub(ctx context.Context, input UpdateHubInput) (HubSnapshot, error) {
	if err := s.lifecycle.UpdateHub(ctx, input.ID, input.DisplayName, input.URL, input.CollectionIntervalSeconds, s.now()); err != nil {
		return HubSnapshot{}, err
	}
	return s.GetHub(ctx, input.ID)
}

func (s *HubService) SetHubCollectionEnabled(ctx context.Context, hubID string, enabled bool) (HubSnapshot, error) {
	if err := s.lifecycle.SetHubCollectionEnabled(ctx, hubID, enabled, s.now()); err != nil {
		return HubSnapshot{}, err
	}
	return s.GetHub(ctx, hubID)
}

func (s *HubService) SaveCredential(ctx context.Context, hubID, secret string) (HubSnapshot, error) {
	if secret == "" {
		return HubSnapshot{}, errors.New("credential secret is empty")
	}
	if _, err := s.lifecycle.GetHubRow(ctx, hubID); err != nil {
		return HubSnapshot{}, err
	}
	if err := s.saveCredential(ctx, hubID, secret); err != nil {
		return HubSnapshot{}, err
	}
	return s.GetHub(ctx, hubID)
}

func (s *HubService) DeleteCredential(ctx context.Context, hubID string) (HubSnapshot, error) {
	if _, err := s.lifecycle.GetHubRow(ctx, hubID); err != nil {
		return HubSnapshot{}, err
	}
	if err := s.appendCredentialEvent(ctx, hubID, "credential_delete_started"); err != nil {
		return HubSnapshot{}, err
	}
	if err := s.credentials.Delete(hubID); err != nil {
		return HubSnapshot{}, err
	}
	if err := s.appendCredentialEvent(ctx, hubID, "credential_deleted"); err != nil {
		return HubSnapshot{}, err
	}
	return s.GetHub(ctx, hubID)
}

func (s *HubService) CheckHubConnection(ctx context.Context, hubID string) (HubSnapshot, error) {
	row, err := s.lifecycle.GetHubRow(ctx, hubID)
	if err != nil {
		return HubSnapshot{}, err
	}
	if !row.Hub.CollectionEnabled {
		return HubSnapshot{}, errors.New("disabled hub cannot be checked")
	}
	events, err := s.lifecycle.ListCredentialAuditEvents(ctx, hubID)
	if err != nil {
		return HubSnapshot{}, err
	}
	if !domain.CredentialReadyForConnection(toDomainEvents(events)) {
		return HubSnapshot{}, errors.New("hub credential is not ready for connection")
	}
	client, err := hubapi.NewClient(row.Hub.URL, s.allowlist)
	if err != nil {
		return HubSnapshot{}, err
	}
	secret, found, err := s.credentials.Read(hubID)
	if err != nil {
		return HubSnapshot{}, err
	}
	if !found {
		now := s.now()
		if err := s.lifecycle.RecordHubConnectionAttempt(ctx, sqliteadapter.HubConnectionAttempt{
			AttemptID: s.mustUUID(), HubID: hubID, CheckedAt: now,
			State: "authentication_failed", FailureDetail: "共有秘密が登録されていません",
		}); err != nil {
			return HubSnapshot{}, err
		}
		return s.GetHub(ctx, hubID)
	}
	result, fetchErr := client.FetchStats(ctx, secret)
	secret = ""
	state, detail := connectionOutcome(fetchErr)
	contract := ""
	if result.Contract.UsageUpdatedAt {
		contract = formatContract(result.Contract.Build)
	}
	if err := s.lifecycle.RecordHubConnectionAttempt(ctx, sqliteadapter.HubConnectionAttempt{
		AttemptID: s.mustUUID(), HubID: hubID, CheckedAt: s.now(), State: state,
		APIContract: contract, FailureDetail: detail,
	}); err != nil {
		return HubSnapshot{}, err
	}
	if fetchErr == nil {
		if err := s.appendCredentialEvent(ctx, hubID, "credential_reconfirmed"); err != nil {
			return HubSnapshot{}, err
		}
	}
	return s.GetHub(ctx, hubID)
}

func (s *HubService) GetHub(ctx context.Context, hubID string) (HubSnapshot, error) {
	row, err := s.lifecycle.GetHubRow(ctx, hubID)
	if err != nil {
		return HubSnapshot{}, err
	}
	return s.snapshot(ctx, row)
}

func (s *HubService) saveCredential(ctx context.Context, hubID, secret string) error {
	if s.credentials == nil {
		return errors.New("credential manager is unavailable")
	}
	if err := s.appendCredentialEvent(ctx, hubID, "credential_save_started"); err != nil {
		return err
	}
	if err := s.credentials.Write(hubID, secret); err != nil {
		return err
	}
	return s.appendCredentialEvent(ctx, hubID, "credential_saved")
}

func connectionOutcome(err error) (string, string) {
	if err == nil {
		return "connected", ""
	}
	switch hubapi.ClassificationOf(err) {
	case hubapi.ClassificationAuth:
		return "authentication_failed", "認証に失敗しました"
	case hubapi.ClassificationTLS:
		return "tls_error", "TLS 証明書を検証できません"
	case hubapi.ClassificationTimeout:
		return "timeout", "Hub への接続がタイムアウトしました"
	case hubapi.ClassificationUnsupported:
		return "unsupported_contract", "対応する API 契約ではありません"
	case hubapi.ClassificationInvalidJSON, hubapi.ClassificationBodyTooLarge:
		return "invalid_json", "応答を安全に読み取れません"
	default:
		return "unreachable", "Hub に接続できません"
	}
}

func formatContract(build hubapi.BuildIdentity) string {
	return fmt.Sprintf("%d/%s/%s/%s", build.SchemaVersion, build.Runtime, build.CoreBuildID, build.RuntimeBuildID)
}

func (s *HubService) appendCredentialEvent(ctx context.Context, hubID, action string) error {
	events, err := s.lifecycle.ListCredentialAuditEvents(ctx, hubID)
	if err != nil {
		return err
	}
	before := domain.DeriveCredentialState(toDomainEvents(events))
	afterEvents := append(append([]sqliteadapter.CredentialAuditEvent(nil), events...), sqliteadapter.CredentialAuditEvent{Action: action})
	after := domain.DeriveCredentialState(toDomainEvents(afterEvents))
	beforeJSON, _ := json.Marshal(struct {
		CredentialState string `json:"credentialState"`
	}{string(before)})
	afterJSON, _ := json.Marshal(struct {
		CredentialState string `json:"credentialState"`
	}{string(after)})
	return s.lifecycle.AppendCredentialAudit(ctx, sqliteadapter.CredentialAudit{
		AuditID: s.mustUUID(), OccurredAt: s.now(), Action: action, HubID: hubID,
		BeforeJSON: string(beforeJSON), AfterJSON: string(afterJSON),
	})
}

func toDomainEvents(events []sqliteadapter.CredentialAuditEvent) []domain.CredentialEvent {
	result := make([]domain.CredentialEvent, len(events))
	for i, event := range events {
		result[i] = domain.CredentialEvent{Sequence: event.Sequence, Action: event.Action}
	}
	return result
}

func (s *HubService) snapshot(ctx context.Context, row sqliteadapter.HubRow) (HubSnapshot, error) {
	events, err := s.lifecycle.ListCredentialAuditEvents(ctx, row.Hub.ID)
	if err != nil {
		return HubSnapshot{}, err
	}
	result := HubSnapshot{
		ID: row.Hub.ID, DisplayName: row.Hub.DisplayName, URL: row.Hub.URL,
		CollectionEnabled:         row.Hub.CollectionEnabled,
		CollectionIntervalSeconds: row.Hub.CollectionIntervalSeconds,
		CredentialState:           string(domain.DeriveCredentialState(toDomainEvents(events))),
		CredentialReady:           domain.CredentialReadyForConnection(toDomainEvents(events)),
		ConnectionState:           row.ConnectionState, ConnectionFailureNote: row.ConnectionFailureNote,
	}
	if row.Hub.APIContract != nil {
		result.APIContract = *row.Hub.APIContract
	}
	if row.ConnectionCheckedAt != nil {
		result.ConnectionCheckedAt = row.ConnectionCheckedAt.UTC().Format(time.RFC3339Nano)
	}
	return result, nil
}

func (s *HubService) now() time.Time { return s.clock.Now().UTC() }

func (s *HubService) newUUID() (string, error) {
	id := s.ids.New()
	parsed, err := uuid.Parse(id)
	if err != nil || parsed.Version() != 4 {
		return "", fmt.Errorf("generated Hub ID is not UUID v4")
	}
	return parsed.String(), nil
}

func (s *HubService) mustUUID() string {
	id, err := s.newUUID()
	if err != nil {
		return uuid.NewString()
	}
	return id
}
