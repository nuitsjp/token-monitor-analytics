package hubapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"time"
)

// The values below are deliberately fixed.  They are part of the Hub
// boundary, rather than settings exposed to the user.
const (
	ConnectTimeout   = 5 * time.Second
	RequestTimeout   = 15 * time.Second
	MaxResponseBytes = 8 << 20
)

type Classification string

const (
	ClassificationAuth         Classification = "auth"
	ClassificationTLS          Classification = "tls"
	ClassificationTimeout      Classification = "timeout"
	ClassificationUnreachable  Classification = "unreachable"
	ClassificationUnsupported  Classification = "unsupported"
	ClassificationInvalidJSON  Classification = "invalid_json"
	ClassificationBodyTooLarge Classification = "body_too_large"
	ClassificationHTTP         Classification = "http"
)

// Error contains only a stable, non-sensitive classification.  In
// particular, response bodies, headers, URLs, and credentials are omitted.
type Error struct {
	Classification Classification
	Operation      string
	Reason         string
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if e.Reason == "" {
		return fmt.Sprintf("hub API %s: %s", e.Operation, e.Classification)
	}
	return fmt.Sprintf("hub API %s: %s (%s)", e.Operation, e.Classification, e.Reason)
}

func classify(operation string, classification Classification, reason string) error {
	return &Error{Classification: classification, Operation: operation, Reason: reason}
}

func ClassificationOf(err error) Classification {
	var classified *Error
	if errors.As(err, &classified) {
		return classified.Classification
	}
	return ""
}

// BuildIdentity is the identity contained by /api/health's hubBuild object.
type BuildIdentity struct {
	SchemaVersion   int
	Runtime         string
	CoreBuildID     string
	RuntimeBuildID  string
	CoreRevision    int
	RuntimeRevision int
}

type Contract struct {
	Build BuildIdentity
	// UsageUpdatedAt is intentionally explicit.  A build is not accepted for
	// collection until its stats contract guarantees this field.
	UsageUpdatedAt bool
}

type stageOneKey struct {
	SchemaVersion int
	Runtime       string
}

type stageTwoKey struct {
	SchemaVersion  int
	Runtime        string
	CoreBuildID    string
	RuntimeBuildID string
}

// Allowlist is a two-stage allowlist.  Stage one recognizes the schema/runtime
// family; stage two recognizes the exact build identity.  Only entries with
// UsageUpdatedAt=true are suitable for this adapter.
type Allowlist struct {
	stageOne map[stageOneKey]struct{}
	stageTwo map[stageTwoKey]Contract
}

func NewAllowlist(contracts ...Contract) Allowlist {
	a := Allowlist{
		stageOne: make(map[stageOneKey]struct{}),
		stageTwo: make(map[stageTwoKey]Contract),
	}
	for _, contract := range contracts {
		if !contract.UsageUpdatedAt || !validBuildIdentity(contract.Build) {
			continue
		}
		one := stageOneKey{SchemaVersion: contract.Build.SchemaVersion, Runtime: contract.Build.Runtime}
		two := stageTwoKey{SchemaVersion: contract.Build.SchemaVersion, Runtime: contract.Build.Runtime, CoreBuildID: contract.Build.CoreBuildID, RuntimeBuildID: contract.Build.RuntimeBuildID}
		a.stageOne[one] = struct{}{}
		a.stageTwo[two] = contract
	}
	return a
}

// DefaultAllowlist is intentionally empty until a Hub build that guarantees
// usageUpdatedAt has been verified.  In particular, the evaluation Hub build
// observed by SP-01 is not a supported contract.
var DefaultAllowlist = NewAllowlist()

func (a Allowlist) match(build BuildIdentity) (Contract, bool) {
	if _, ok := a.stageOne[stageOneKey{SchemaVersion: build.SchemaVersion, Runtime: build.Runtime}]; !ok {
		return Contract{}, false
	}
	contract, ok := a.stageTwo[stageTwoKey{SchemaVersion: build.SchemaVersion, Runtime: build.Runtime, CoreBuildID: build.CoreBuildID, RuntimeBuildID: build.RuntimeBuildID}]
	return contract, ok && contract.UsageUpdatedAt
}

type Health struct {
	Build BuildIdentity
	Raw   []byte
}

type Stats struct {
	Raw   []byte
	Value any
}

func parseHealth(raw []byte) (Health, error) {
	value, err := decodeJSON(raw)
	if err != nil {
		return Health{}, err
	}
	object, ok := value.(map[string]any)
	if !ok {
		return Health{}, errors.New("health response must be an object")
	}
	rawBuild, ok := object["hubBuild"]
	if !ok {
		return Health{}, errors.New("health response has no hubBuild")
	}
	buildObject, ok := rawBuild.(map[string]any)
	if !ok {
		return Health{}, errors.New("health hubBuild must be an object")
	}
	build, err := parseBuild(buildObject)
	if err != nil {
		return Health{}, err
	}
	return Health{Build: build, Raw: append([]byte(nil), raw...)}, nil
}

func parseBuild(object map[string]any) (BuildIdentity, error) {
	schemaVersion, err := requiredInt(object, "schemaVersion")
	if err != nil {
		return BuildIdentity{}, err
	}
	runtime, err := requiredString(object, "runtime")
	if err != nil {
		return BuildIdentity{}, err
	}
	coreBuildID, err := requiredString(object, "coreBuildId")
	if err != nil {
		return BuildIdentity{}, err
	}
	runtimeBuildID, err := requiredString(object, "runtimeBuildId")
	if err != nil {
		return BuildIdentity{}, err
	}
	build := BuildIdentity{SchemaVersion: schemaVersion, Runtime: runtime, CoreBuildID: coreBuildID, RuntimeBuildID: runtimeBuildID}
	if value, present := object["coreRevision"]; present {
		build.CoreRevision, err = intValue(value)
		if err != nil {
			return BuildIdentity{}, errors.New("health coreRevision is invalid")
		}
	}
	if value, present := object["runtimeRevision"]; present {
		build.RuntimeRevision, err = intValue(value)
		if err != nil {
			return BuildIdentity{}, errors.New("health runtimeRevision is invalid")
		}
	}
	if !validBuildIdentity(build) {
		return BuildIdentity{}, errors.New("health hubBuild is invalid")
	}
	return build, nil
}

func parseStats(raw []byte) (Stats, error) {
	value, err := decodeJSON(raw)
	if err != nil {
		return Stats{}, err
	}
	if _, ok := value.(map[string]any); !ok {
		return Stats{}, errors.New("stats response must be an object")
	}
	if err := validateFiniteNumbers(value); err != nil {
		return Stats{}, err
	}
	return Stats{Raw: append([]byte(nil), raw...), Value: value}, nil
}

func decodeJSON(raw []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	if err := validateFiniteNumbers(value); err != nil {
		return nil, err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		// A second token or a malformed suffix is trailing data.  The exact
		// decoder error is intentionally not returned because it can contain
		// untrusted content.
		return nil, errors.New("JSON has trailing data")
	}
	return value, nil
}

func validateFiniteNumbers(value any) error {
	switch typed := value.(type) {
	case json.Number:
		number, err := typed.Float64()
		if err != nil || math.IsNaN(number) || math.IsInf(number, 0) {
			return errors.New("JSON contains a non-finite number")
		}
	case map[string]any:
		for _, child := range typed {
			if err := validateFiniteNumbers(child); err != nil {
				return err
			}
		}
	case []any:
		for _, child := range typed {
			if err := validateFiniteNumbers(child); err != nil {
				return err
			}
		}
	}
	return nil
}

func validBuildIdentity(build BuildIdentity) bool {
	return build.SchemaVersion > 0 && build.Runtime != "" && build.CoreBuildID != "" && build.RuntimeBuildID != ""
}

func requiredString(object map[string]any, key string) (string, error) {
	value, ok := object[key]
	if !ok {
		return "", fmt.Errorf("health hubBuild has no %s", key)
	}
	stringValue, ok := value.(string)
	if !ok || stringValue == "" {
		return "", fmt.Errorf("health hubBuild %s is invalid", key)
	}
	return stringValue, nil
}

func requiredInt(object map[string]any, key string) (int, error) {
	value, ok := object[key]
	if !ok {
		return 0, fmt.Errorf("health hubBuild has no %s", key)
	}
	return intValue(value)
}

func intValue(value any) (int, error) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, errors.New("value is not an integer")
	}
	parsed, err := strconv.ParseInt(string(number), 10, 64)
	if err != nil || parsed <= 0 || int64(int(parsed)) != parsed {
		return 0, errors.New("value is not a positive integer")
	}
	return int(parsed), nil
}

func validateUsageUpdatedAt(value any) error {
	if value == nil {
		return errors.New("usageUpdatedAt is null")
	}
	text, ok := value.(string)
	if !ok || text == "" {
		return errors.New("usageUpdatedAt is not a string")
	}
	if _, err := time.Parse(time.RFC3339, text); err != nil {
		return errors.New("usageUpdatedAt is not RFC3339")
	}
	return nil
}
