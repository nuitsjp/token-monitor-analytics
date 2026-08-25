package usecase

import (
	"context"
	"errors"
	"sync"
)

var ErrMaintenanceBusy = errors.New("another maintenance operation is active")

type MaintenanceOperation string

const (
	MaintenanceCollection MaintenanceOperation = "collection"
	MaintenanceEdit       MaintenanceOperation = "edit"
	MaintenancePurge      MaintenanceOperation = "purge"
	MaintenanceBackup     MaintenanceOperation = "backup"
	MaintenanceRestore    MaintenanceOperation = "restore"
)

type MaintenanceGate struct {
	token chan struct{}
	mu    sync.Mutex
	owner MaintenanceOperation
}

type MaintenanceLease struct {
	gate *MaintenanceGate
	once sync.Once
}

func NewMaintenanceGate() *MaintenanceGate {
	gate := &MaintenanceGate{token: make(chan struct{}, 1)}
	gate.token <- struct{}{}
	return gate
}

func (g *MaintenanceGate) Acquire(ctx context.Context, operation MaintenanceOperation) (*MaintenanceLease, error) {
	if g == nil {
		return nil, errors.New("maintenance gate is required")
	}
	if !validMaintenanceOperation(operation) {
		return nil, errors.New("maintenance operation is invalid")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case <-g.token:
		g.mu.Lock()
		g.owner = operation
		g.mu.Unlock()
		return &MaintenanceLease{gate: g}, nil
	default:
		return nil, ErrMaintenanceBusy
	}
}

func (l *MaintenanceLease) Release() {
	if l == nil || l.gate == nil {
		return
	}
	l.once.Do(func() {
		l.gate.mu.Lock()
		l.gate.owner = ""
		l.gate.mu.Unlock()
		l.gate.token <- struct{}{}
	})
}

func (g *MaintenanceGate) ActiveOperation() MaintenanceOperation {
	if g == nil {
		return ""
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.owner
}

func validMaintenanceOperation(operation MaintenanceOperation) bool {
	switch operation {
	case MaintenanceCollection, MaintenanceEdit, MaintenancePurge, MaintenanceBackup, MaintenanceRestore:
		return true
	default:
		return false
	}
}
