package usecase

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"token-monitor-analytics/internal/domain"
)

type RestoreApplyStore interface {
	ApplyValidatedRestore(context.Context, string, string, string, domain.BackupManifest, string, time.Time) (domain.RestoreApplyResult, error)
}

type RestoreCollectionController interface {
	Suspend(context.Context) (bool, error)
	Resume(context.Context) error
}

type RestoreApplyUsecase struct {
	validation *RestoreValidationUsecase
	store      RestoreApplyStore
	collection RestoreCollectionController
	clock      Clock
	ids        IDGenerator
	gate       *MaintenanceGate
}

func NewRestoreApplyUsecase(validation *RestoreValidationUsecase, store RestoreApplyStore, collection RestoreCollectionController, clock Clock, ids IDGenerator, gate *MaintenanceGate) (*RestoreApplyUsecase, error) {
	if validation == nil || store == nil || collection == nil || clock == nil || ids == nil || gate == nil {
		return nil, errors.New("restore apply usecase dependencies are required")
	}
	if validation.gate != gate {
		return nil, errors.New("restore operations must share one maintenance gate")
	}
	return &RestoreApplyUsecase{validation: validation, store: store, collection: collection, clock: clock, ids: ids, gate: gate}, nil
}

// Apply accepts only the opaque operation ID returned by validation. A path is
// never accepted at this boundary. confirmed must represent an explicit final
// user confirmation performed immediately before this call.
func (u *RestoreApplyUsecase) Apply(ctx context.Context, operationID string, confirmed bool) (result domain.RestoreApplyResult, resultErr error) {
	if !confirmed {
		return result, errors.New("restore confirmation is required")
	}
	if strings.TrimSpace(operationID) == "" {
		return result, errors.New("restore validation operation ID is required")
	}
	lease, err := u.gate.Acquire(ctx, MaintenanceRestore)
	if err != nil {
		return result, err
	}
	defer lease.Release()
	validated, err := u.validation.claimForApply(operationID)
	if err != nil {
		return result, err
	}
	defer func() {
		cleanupErr := u.validation.finishApply(validated)
		if cleanupErr == nil {
			return
		}
		if resultErr != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("clean consumed restore candidate: %w", cleanupErr))
			return
		}
		result.Warning = appendWarning(result.Warning, "consumed restore candidate cleanup failed")
	}()
	wasRunning, err := u.collection.Suspend(ctx)
	if err != nil {
		return result, fmt.Errorf("suspend collection for restore: %w", err)
	}
	auditID := strings.TrimSpace(u.ids.New())
	if auditID == "" {
		idErr := errors.New("restore audit ID is empty")
		if wasRunning {
			if resumeErr := u.collection.Resume(context.WithoutCancel(ctx)); resumeErr != nil {
				idErr = errors.Join(idErr, fmt.Errorf("resume collection after restore rejection: %w", resumeErr))
			}
		}
		return result, idErr
	}
	result, resultErr = u.store.ApplyValidatedRestore(
		ctx, validated.databasePath, validated.operationID, validated.artifactSHA256,
		validated.manifest, auditID, u.clock.Now().UTC(),
	)
	if resultErr != nil && wasRunning && result.RollbackSucceeded {
		if resumeErr := u.collection.Resume(context.WithoutCancel(ctx)); resumeErr != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("resume collection after restore rollback: %w", resumeErr))
		}
	}
	if resultErr == nil && wasRunning {
		if resumeErr := u.collection.Resume(context.WithoutCancel(ctx)); resumeErr != nil {
			result.Warning = appendWarning(result.Warning, "collection scheduler restart failed")
		}
	}
	return result, resultErr
}
