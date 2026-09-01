package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"token-monitor-analytics/internal/domain"
	"token-monitor-analytics/internal/usecase"
)

type CredentialStore interface {
	Write(hubID, secret string) error
	Read(hubID string) (secret string, found bool, err error)
	Delete(hubID string) error
}

type HubService struct {
	repository  HubRepository
	credentials CredentialStore
	clock       usecase.Clock
	ids         usecase.IDGenerator
	client      HubClientFactory
	gate        *usecase.MaintenanceGate
}

type HubRepository interface {
	ListHubRows(context.Context) ([]domain.HubRow, error)
	GetHubRow(context.Context, string) (domain.HubRow, error)
	ListCredentialAuditEvents(context.Context, string) ([]domain.CredentialAuditEvent, error)
	CreateHub(context.Context, domain.Hub) error
	UpdateHub(context.Context, string, string, string, int64, time.Time) error
	SetHubCollectionEnabled(context.Context, string, bool, time.Time) error
	SetHubEnabled(context.Context, string, bool, time.Time) error
	RecordHubConnectionAttempt(context.Context, domain.HubConnectionAttempt) error
	AppendCredentialAudit(context.Context, domain.CredentialAudit) error
}

type HubClient interface {
	FetchStats(context.Context, string) (HubFetchResult, error)
}

type HubClientFactory func(string) (HubClient, error)

type HubFetchResult struct {
	Contract HubContract
}

type HubContract struct {
	Build HubBuildIdentity
}

type HubBuildIdentity struct {
	SchemaVersion   int
	Runtime         string
	CoreBuildID     string
	RuntimeBuildID  string
	CoreRevision    int
	RuntimeRevision int
}

type UUIDGenerator struct{}

func (UUIDGenerator) New() string { return uuid.NewString() }

type HubSnapshot struct {
	ID                        string `json:"id"`
	DisplayName               string `json:"displayName"`
	URL                       string `json:"url"`
	Enabled                   bool   `json:"enabled"`
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

func NewHubService(repository HubRepository, credentials CredentialStore, gate *usecase.MaintenanceGate) *HubService {
	return NewHubServiceWithDependencies(repository, credentials, usecase.SystemClock{}, UUIDGenerator{}, gate)
}

func NewHubServiceWithDependencies(repository HubRepository, credentials CredentialStore, clock usecase.Clock, ids usecase.IDGenerator, gate *usecase.MaintenanceGate) *HubService {
	return newHubService(repository, credentials, clock, ids, nil, gate)
}

func NewHubServiceWithClient(repository HubRepository, credentials CredentialStore, clock usecase.Clock, ids usecase.IDGenerator, client HubClientFactory, gate *usecase.MaintenanceGate) *HubService {
	return newHubService(repository, credentials, clock, ids, client, gate)
}

func newHubService(repository HubRepository, credentials CredentialStore, clock usecase.Clock, ids usecase.IDGenerator, client HubClientFactory, gate *usecase.MaintenanceGate) *HubService {
	if clock == nil {
		clock = usecase.SystemClock{}
	}
	if ids == nil {
		ids = UUIDGenerator{}
	}
	return &HubService{repository: repository, credentials: credentials, clock: clock, ids: ids, client: client, gate: gate}
}

func (s *HubService) GetHubs(ctx context.Context) ([]HubSnapshot, error) {
	rows, err := s.repository.ListHubRows(ctx)
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
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return HubSnapshot{}, err
	}
	defer release()
	id, err := s.newUUID()
	if err != nil {
		return HubSnapshot{}, err
	}
	now := s.now()
	if err := s.repository.CreateHub(ctx, domain.Hub{
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
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return HubSnapshot{}, err
	}
	defer release()
	if err := s.repository.UpdateHub(ctx, input.ID, input.DisplayName, input.URL, input.CollectionIntervalSeconds, s.now()); err != nil {
		return HubSnapshot{}, err
	}
	return s.GetHub(ctx, input.ID)
}

func (s *HubService) SetHubCollectionEnabled(ctx context.Context, hubID string, enabled bool) (HubSnapshot, error) {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return HubSnapshot{}, err
	}
	defer release()
	if err := s.repository.SetHubCollectionEnabled(ctx, hubID, enabled, s.now()); err != nil {
		return HubSnapshot{}, err
	}
	return s.GetHub(ctx, hubID)
}

func (s *HubService) SetHubEnabled(ctx context.Context, hubID string, enabled bool) (HubSnapshot, error) {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return HubSnapshot{}, err
	}
	defer release()
	if err := s.repository.SetHubEnabled(ctx, hubID, enabled, s.now()); err != nil {
		return HubSnapshot{}, err
	}
	return s.GetHub(ctx, hubID)
}

func (s *HubService) SaveCredential(ctx context.Context, hubID, secret string) (HubSnapshot, error) {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return HubSnapshot{}, err
	}
	defer release()
	if secret == "" {
		return HubSnapshot{}, errors.New("credential secret is empty")
	}
	if _, err := s.repository.GetHubRow(ctx, hubID); err != nil {
		return HubSnapshot{}, err
	}
	if err := s.saveCredential(ctx, hubID, secret); err != nil {
		return HubSnapshot{}, err
	}
	return s.GetHub(ctx, hubID)
}

func (s *HubService) DeleteCredential(ctx context.Context, hubID string) (HubSnapshot, error) {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return HubSnapshot{}, err
	}
	defer release()
	if _, err := s.repository.GetHubRow(ctx, hubID); err != nil {
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
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return HubSnapshot{}, err
	}
	defer release()
	row, err := s.repository.GetHubRow(ctx, hubID)
	if err != nil {
		return HubSnapshot{}, err
	}
	if !row.Hub.Enabled {
		return HubSnapshot{}, errors.New("disabled hub cannot be checked")
	}
	events, err := s.repository.ListCredentialAuditEvents(ctx, hubID)
	if err != nil {
		return HubSnapshot{}, err
	}
	if !domain.CredentialReadyForConnection(toDomainEvents(events)) {
		return HubSnapshot{}, errors.New("hub credential is not ready for connection")
	}
	if s.client == nil {
		return HubSnapshot{}, errors.New("hub client is unavailable")
	}
	client, err := s.client(row.Hub.URL)
	if err != nil {
		return HubSnapshot{}, err
	}
	secret, found, err := s.credentials.Read(hubID)
	if err != nil {
		return HubSnapshot{}, err
	}
	if !found {
		now := s.now()
		if err := s.repository.RecordHubConnectionAttempt(ctx, domain.HubConnectionAttempt{
			AttemptID: s.mustUUID(), HubID: hubID, CheckedAt: now,
			State: "authentication_failed", FailureDetail: "共有秘密が登録されていません",
		}); err != nil {
			return HubSnapshot{}, err
		}
		return s.GetHub(ctx, hubID)
	}
	result, fetchErr := client.FetchStats(ctx, secret)
	state, detail := connectionOutcome(fetchErr)
	contract := ""
	if result.Contract.Build.SchemaVersion > 0 {
		contract = formatContract(result.Contract.Build)
	}
	if err := s.repository.RecordHubConnectionAttempt(ctx, domain.HubConnectionAttempt{
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
	row, err := s.repository.GetHubRow(ctx, hubID)
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
	classification := ""
	var classified interface{ HubClassification() string }
	if errors.As(err, &classified) {
		classification = classified.HubClassification()
	}
	switch classification {
	case "auth":
		return "authentication_failed", "認証に失敗しました"
	case "tls":
		return "tls_error", "TLS 証明書を検証できません"
	case "timeout":
		return "timeout", "Hub への接続がタイムアウトしました"
	case "unsupported":
		return "unsupported_contract", "対応する API 契約ではありません"
	case "invalid_json", "body_too_large":
		return "invalid_json", "応答を安全に読み取れません"
	default:
		return "unreachable", "Hub に接続できません"
	}
}

func formatContract(build HubBuildIdentity) string {
	return fmt.Sprintf("schema=%d;runtime=%s;core_revision=%d;runtime_revision=%d;core=%s;runtime_build=%s", build.SchemaVersion, build.Runtime, build.CoreRevision, build.RuntimeRevision, build.CoreBuildID, build.RuntimeBuildID)
}

func (s *HubService) appendCredentialEvent(ctx context.Context, hubID, action string) error {
	events, err := s.repository.ListCredentialAuditEvents(ctx, hubID)
	if err != nil {
		return err
	}
	before := domain.DeriveCredentialState(toDomainEvents(events))
	afterEvents := append(append([]domain.CredentialAuditEvent(nil), events...), domain.CredentialAuditEvent{Action: action})
	after := domain.DeriveCredentialState(toDomainEvents(afterEvents))
	beforeJSON, _ := json.Marshal(struct {
		CredentialState string `json:"credentialState"`
	}{string(before)})
	afterJSON, _ := json.Marshal(struct {
		CredentialState string `json:"credentialState"`
	}{string(after)})
	return s.repository.AppendCredentialAudit(ctx, domain.CredentialAudit{
		AuditID: s.mustUUID(), OccurredAt: s.now(), Action: action, HubID: hubID,
		BeforeJSON: string(beforeJSON), AfterJSON: string(afterJSON),
	})
}

func toDomainEvents(events []domain.CredentialAuditEvent) []domain.CredentialEvent {
	result := make([]domain.CredentialEvent, len(events))
	for i, event := range events {
		result[i] = domain.CredentialEvent(event)
	}
	return result
}

func (s *HubService) snapshot(ctx context.Context, row domain.HubRow) (HubSnapshot, error) {
	events, err := s.repository.ListCredentialAuditEvents(ctx, row.Hub.ID)
	if err != nil {
		return HubSnapshot{}, err
	}
	result := HubSnapshot{
		ID: row.Hub.ID, DisplayName: row.Hub.DisplayName, URL: row.Hub.URL,
		Enabled:                   row.Hub.Enabled,
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
