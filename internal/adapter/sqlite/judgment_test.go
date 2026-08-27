package sqlite

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

type failAt string

func (failure failAt) Check(point string) error {
	if string(failure) == point {
		return errors.New("test failure")
	}
	return nil
}

func TestSaveJudgmentCommitsChangeAuditAndRequestTogether(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	change := testJudgmentChange("1")
	if err := lifecycle.SaveJudgment(context.Background(), change, nil); err != nil {
		t.Fatal(err)
	}
	database, _ := lifecycle.DB()
	for _, table := range []string{"judgments", "configuration_audits", "recalculation_requests"} {
		var count int
		if err := database.QueryRowContext(t.Context(), "SELECT count(*) FROM "+table).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("%s count = %d", table, count)
		}
	}

	updated := testJudgmentChange("2")
	updated.State = "confirmed"
	if err := lifecycle.SaveJudgment(context.Background(), updated, nil); err != nil {
		t.Fatal(err)
	}
	rows, err := database.QueryContext(context.Background(), `SELECT sequence, before_json, after_json FROM configuration_audits ORDER BY sequence`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var sequences []int
	for rows.Next() {
		var sequence int
		var before any
		var after string
		if err := rows.Scan(&sequence, &before, &after); err != nil {
			t.Fatal(err)
		}
		sequences = append(sequences, sequence)
		if after == "" {
			t.Fatal("after JSON is empty")
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(sequences) != "[1 2]" {
		t.Fatalf("audit sequences = %v", sequences)
	}
}

func TestSaveJudgmentRollsBackAtEveryFailurePoint(t *testing.T) {
	for _, point := range []string{"after-change", "after-audit", "after-recalculation-request"} {
		t.Run(point, func(t *testing.T) {
			lifecycle := openTestLifecycle(t)
			err := lifecycle.SaveJudgment(context.Background(), testJudgmentChange(point), failAt(point))
			if err == nil {
				t.Fatal("SaveJudgment succeeded")
			}
			database, _ := lifecycle.DB()
			for _, table := range []string{"judgments", "configuration_audits", "recalculation_requests"} {
				var count int
				if err := database.QueryRowContext(t.Context(), "SELECT count(*) FROM "+table).Scan(&count); err != nil {
					t.Fatal(err)
				}
				if count != 0 {
					t.Fatalf("%s count = %d after rollback", table, count)
				}
			}
		})
	}
}

func openTestLifecycle(t *testing.T) *Lifecycle {
	t.Helper()
	lifecycle := &Lifecycle{}
	if err := lifecycle.Open(context.Background(), filepath.Join(t.TempDir(), "data.db")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := lifecycle.Close(); err != nil {
			t.Error(err)
		}
	})
	return lifecycle
}

func testJudgmentChange(suffix string) JudgmentChange {
	start := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	return JudgmentChange{
		AuditID:       "audit-" + suffix,
		RequestID:     "request-" + suffix,
		Actor:         "user",
		Action:        "confirm",
		EntityType:    "source-completeness",
		EntityID:      "source-1",
		State:         "unconfirmed",
		Reason:        "initial review",
		OccurredAt:    start.Add(time.Hour),
		IntervalStart: start,
		IntervalEnd:   start.AddDate(0, 1, 0),
	}
}
