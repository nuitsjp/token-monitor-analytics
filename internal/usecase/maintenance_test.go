package usecase

import (
	"context"
	"errors"
	"testing"
)

func TestMaintenanceGateExcludesAllMutatingOperations(t *testing.T) {
	gate := NewMaintenanceGate()
	operations := []MaintenanceOperation{MaintenanceCollection, MaintenanceEdit, MaintenancePurge, MaintenanceBackup, MaintenanceRestore}
	for _, held := range operations {
		lease, err := gate.Acquire(context.Background(), held)
		if err != nil {
			t.Fatalf("acquire %s: %v", held, err)
		}
		if gate.ActiveOperation() != held {
			t.Fatalf("active operation = %q, want %q", gate.ActiveOperation(), held)
		}
		for _, blocked := range operations {
			if _, err := gate.Acquire(context.Background(), blocked); !errors.Is(err, ErrMaintenanceBusy) {
				t.Fatalf("%s did not block %s: %v", held, blocked, err)
			}
		}
		lease.Release()
		lease.Release()
	}
}

func TestMaintenanceGateRejectsAnAlreadyCanceledOperation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := NewMaintenanceGate().Acquire(ctx, MaintenanceRestore); !errors.Is(err, context.Canceled) {
		t.Fatalf("acquire error = %v, want canceled", err)
	}
}
