package usecase

import (
	"time"
)

type Clock interface {
	Now() time.Time
}

type IDGenerator interface {
	New() string
}

type FailureInjector interface {
	Check(point string) error
}

type SystemClock struct{}

func (SystemClock) Now() time.Time { return time.Now().UTC() }
