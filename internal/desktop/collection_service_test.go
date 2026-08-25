package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
)

type collectionServiceSchedulerStub struct {
	starts, stops, collects []string
	err                     error
}

func (s *collectionServiceSchedulerStub) Start(_ context.Context, hubID string) error {
	s.starts = append(s.starts, hubID)
	return s.err
}

func (s *collectionServiceSchedulerStub) Stop(_ context.Context, hubID string) error {
	s.stops = append(s.stops, hubID)
	return s.err
}

func (s *collectionServiceSchedulerStub) CollectNow(_ context.Context, hubID string) error {
	s.collects = append(s.collects, hubID)
	return s.err
}

type collectionServiceReaderStub struct {
	attempts     []sqliteadapter.CollectionAttempt
	snapshots    []sqliteadapter.RawSnapshot
	costs        []sqliteadapter.CostObservation
	limits       []sqliteadapter.LimitObservation
	snapshotByID sqliteadapter.RawSnapshot
	err          error
}

func (r *collectionServiceReaderStub) ListCollectionAttempts(context.Context, string) ([]sqliteadapter.CollectionAttempt, error) {
	return r.attempts, r.err
}

func (r *collectionServiceReaderStub) ListRawSnapshots(context.Context, string) ([]sqliteadapter.RawSnapshot, error) {
	return r.snapshots, r.err
}

func (r *collectionServiceReaderStub) GetRawSnapshot(context.Context, string) (sqliteadapter.RawSnapshot, error) {
	return r.snapshotByID, r.err
}

func (r *collectionServiceReaderStub) ListCostObservations(context.Context, string) ([]sqliteadapter.CostObservation, error) {
	return r.costs, r.err
}

func (r *collectionServiceReaderStub) ListLimitObservations(context.Context, string) ([]sqliteadapter.LimitObservation, error) {
	return r.limits, r.err
}

func TestCollectionServiceDelegatesStartStopAndManualCollection(t *testing.T) {
	scheduler := &collectionServiceSchedulerStub{}
	service, err := NewCollectionServiceWithDependencies(&collectionServiceReaderStub{}, scheduler)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := service.StartCollection(ctx, "hub-1"); err != nil {
		t.Fatal(err)
	}
	if err := service.StopCollection(ctx, "hub-1"); err != nil {
		t.Fatal(err)
	}
	if err := service.CollectNow(ctx, "hub-1"); err != nil {
		t.Fatal(err)
	}
	if strings.Join(scheduler.starts, ",") != "hub-1" || strings.Join(scheduler.stops, ",") != "hub-1" || strings.Join(scheduler.collects, ",") != "hub-1" {
		t.Fatalf("delegation = starts %v, stops %v, collects %v", scheduler.starts, scheduler.stops, scheduler.collects)
	}
}

func TestCollectionServiceDoesNotExposeRawBodyInListAndMasksDetail(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 34, 56, 123456789, time.FixedZone("JST", 9*60*60))
	secret := "collection-service-secret-sentinel"
	unknown := "collection-service-unknown-sentinel"
	body := []byte(`{"devices":[{"deviceId":"device-1","usageUpdatedAt":"2026-08-25T03:34:56.123456789Z","syncUploadIntervalMs":500,"periods":{"allTime":{"clientCosts":{"codex":1.25}},"unknownNested":"` + unknown + `"},"accessToken":"` + secret + `"}],"unknown":"` + unknown + `"}`)
	reader := &collectionServiceReaderStub{snapshotByID: sqliteadapter.RawSnapshot{
		SnapshotID: "snapshot-1", AttemptID: "attempt-1", HubID: "hub-1", ResponseKind: "stats",
		ReceivedStartedAt: now, ReceivedCompletedAt: now.Add(time.Second), HTTPStatus: 200,
		APIContract: "schema=1;runtime=test", Body: body,
	}, snapshots: []sqliteadapter.RawSnapshot{{
		SnapshotID: "snapshot-1", AttemptID: "attempt-1", HubID: "hub-1", ResponseKind: "stats",
		ReceivedStartedAt: now, ReceivedCompletedAt: now.Add(time.Second), HTTPStatus: 200,
		APIContract: "schema=1;runtime=test", Body: body,
	}}}
	service, err := NewCollectionServiceWithDependencies(reader, &collectionServiceSchedulerStub{})
	if err != nil {
		t.Fatal(err)
	}
	list, err := service.GetRawSnapshots(context.Background(), "hub-1")
	if err != nil {
		t.Fatal(err)
	}
	encodedList, err := json.Marshal(list)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encodedList), secret) || strings.Contains(string(encodedList), unknown) {
		t.Fatalf("raw values leaked from list: %s", encodedList)
	}
	detail, err := service.GetRawSnapshot(context.Background(), "snapshot-1")
	if err != nil {
		t.Fatal(err)
	}
	if detail.Body == string(body) || strings.Contains(detail.Body, secret) || strings.Contains(detail.Body, unknown) {
		t.Fatalf("raw values leaked from detail: %s", detail.Body)
	}
	if !strings.Contains(detail.Body, "device-1") || !strings.Contains(detail.Body, "1.25") {
		t.Fatalf("known fields were not retained: %s", detail.Body)
	}
	if got := detail.ReceivedStartedAt; got != "2026-08-25T03:34:56.123456789Z" {
		t.Fatalf("startedAt = %q", got)
	}
}

func TestCollectionServiceMapsObservationDTOsAndRedactsErrors(t *testing.T) {
	updated := time.Date(2026, 8, 25, 0, 0, 0, 0, time.FixedZone("JST", 9*60*60))
	used := 25.5
	reader := &collectionServiceReaderStub{
		attempts: []sqliteadapter.CollectionAttempt{{AttemptID: "a", HubID: "h", Trigger: "manual", State: "failed", StartedAt: updated, FailureCode: "not-a-secret-code", FailureDetail: "credential-service-secret"}},
		costs:    []sqliteadapter.CostObservation{{ObservationID: "c", SnapshotID: "s", HubID: "h", DeviceID: "d", RawServiceIdentifier: "codex", UsageUpdatedAt: updated, CostUSDText: "1.25", AnalyticsIntervalSeconds: 300, JSONPath: "$.devices[0]", DedupeKey: "key", ValueFingerprint: "fingerprint"}},
		limits:   []sqliteadapter.LimitObservation{{ObservationID: "l", SnapshotID: "s", HubID: "h", DeviceID: "d", RawServiceIdentifier: "codex", ProviderUpdatedAt: updated, UsedPercent: &used, AnalyticsIntervalSeconds: 300, JSONPath: "$.devices[0]", DedupeKey: "key", ValueFingerprint: "fingerprint"}},
	}
	service, err := NewCollectionServiceWithDependencies(reader, &collectionServiceSchedulerStub{})
	if err != nil {
		t.Fatal(err)
	}
	attempts, err := service.GetCollectionAttempts(context.Background(), "h")
	if err != nil {
		t.Fatal(err)
	}
	if attempts[0].FailureDetail != "collection failed" || attempts[0].FailureCode != "collection" || attempts[0].StartedAt != "2026-08-24T15:00:00Z" {
		t.Fatalf("attempt DTO = %+v", attempts[0])
	}
	costs, err := service.GetCostObservations(context.Background(), "h")
	if err != nil || len(costs) != 1 || costs[0].UsageUpdatedAt != "2026-08-24T15:00:00Z" {
		t.Fatalf("cost DTO = %+v, err = %v", costs, err)
	}
	limits, err := service.GetLimitObservations(context.Background(), "h")
	if err != nil || len(limits) != 1 || limits[0].RemainingPercent == nil || *limits[0].RemainingPercent != 74.5 {
		t.Fatalf("limit DTO = %+v, err = %v", limits, err)
	}

	scheduler := &collectionServiceSchedulerStub{err: errors.New("Bearer collection-service-secret-sentinel")}
	service, err = NewCollectionServiceWithDependencies(reader, scheduler)
	if err != nil {
		t.Fatal(err)
	}
	err = service.CollectNow(context.Background(), "h")
	if err == nil || strings.Contains(err.Error(), "collection-service-secret-sentinel") {
		t.Fatalf("scheduler error = %v", err)
	}
}
