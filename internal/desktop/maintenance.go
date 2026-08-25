package desktop

import (
	"context"
	"errors"

	"token-monitor-analytics/internal/usecase"
)

func acquireEdit(ctx context.Context, gate *usecase.MaintenanceGate) (func(), error) {
	if gate == nil {
		return nil, errors.New("desktop maintenance gate is required")
	}
	lease, err := gate.Acquire(ctx, usecase.MaintenanceEdit)
	if err != nil {
		return nil, err
	}
	return lease.Release, nil
}
