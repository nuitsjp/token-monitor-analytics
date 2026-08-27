package domain

import (
	"math"
	"strings"
	"time"
)

// WeeklyMonthlyFactor is the mean number of seven-day periods in a calendar
// month. It is deliberately the requirement's constant, rather than a
// calendar-month approximation that would vary by display timezone.
const WeeklyMonthlyFactor = 365.2425 / 12 / 7

type ValueReason string

const (
	ValueReasonComputed             ValueReason = "computed"
	ValueReasonEstimateMissing      ValueReason = "estimate_missing"
	ValueReasonBillingUnconfirmed   ValueReason = "billing_unconfirmed"
	ValueReasonMetricUnsupported    ValueReason = "metric_not_supported"
	ValueReasonCycleUnsupported     ValueReason = "cycle_not_supported"
	ValueReasonInvalidEstimate      ValueReason = "invalid_estimate"
	ValueReasonStandardPriceMissing ValueReason = "standard_price_missing"
	ValueReasonStandardPriceInvalid ValueReason = "standard_price_invalid"
)

// ValueCalculationInput describes one independent utilization window. A
// slice of inputs is intentionally not reduced into one value: unrelated
// windows must remain separate until their independence is proven.
type ValueCalculationInput struct {
	CycleType           string
	BillingConfirmation BillingConfirmation
	Metric              string
	EstimatedLimit      *float64
	At                  time.Time
	StandardPrice       *StandardPrice
}

type ValueCalculation struct {
	MonthlyEquivalent *float64
	ValueMultiplier   *float64
	Reason            ValueReason
	StandardPrice     *StandardPrice
}

// CalculateValue applies only the Phase 2 value rules. It does not infer a
// cap from balances, credits, spend, or unconfirmed billing observations.
func CalculateValue(input ValueCalculationInput) ValueCalculation {
	result := ValueCalculation{Reason: ValueReasonEstimateMissing}
	if input.EstimatedLimit == nil {
		return result
	}
	if math.IsNaN(*input.EstimatedLimit) || math.IsInf(*input.EstimatedLimit, 0) || *input.EstimatedLimit < 0 {
		result.Reason = ValueReasonInvalidEstimate
		return result
	}
	metric := strings.ToLower(strings.TrimSpace(input.Metric))
	if metric == "credits" || metric == "spend" {
		result.Reason = ValueReasonMetricUnsupported
		return result
	}

	var monthly float64
	switch input.CycleType {
	case LimitCycleWeekly:
		monthly = *input.EstimatedLimit * WeeklyMonthlyFactor
	case LimitCycleBilling:
		if input.BillingConfirmation != BillingConfirmed {
			result.Reason = ValueReasonBillingUnconfirmed
			return result
		}
		monthly = *input.EstimatedLimit
	default:
		result.Reason = ValueReasonCycleUnsupported
		return result
	}
	if math.IsNaN(monthly) || math.IsInf(monthly, 0) {
		result.Reason = ValueReasonInvalidEstimate
		return result
	}
	result.MonthlyEquivalent = &monthly
	if input.StandardPrice == nil {
		result.Reason = ValueReasonStandardPriceMissing
		return result
	}
	price := *input.StandardPrice
	if !standardPriceUsableAt(price, input.At) {
		result.Reason = ValueReasonStandardPriceInvalid
		return result
	}
	result.StandardPrice = &price
	multiplier := monthly / price.USDMonthlyPerSeat
	if math.IsNaN(multiplier) || math.IsInf(multiplier, 0) {
		result.Reason = ValueReasonStandardPriceInvalid
		result.MonthlyEquivalent = nil
		return result
	}
	result.ValueMultiplier = &multiplier
	result.Reason = ValueReasonComputed
	return result
}

// CalculateValues calculates each window independently and preserves input
// order. In particular, it never creates a summed monthly cap or multiplier.
func CalculateValues(inputs []ValueCalculationInput) []ValueCalculation {
	result := make([]ValueCalculation, len(inputs))
	for index, input := range inputs {
		result[index] = CalculateValue(input)
	}
	return result
}

func standardPriceUsableAt(price StandardPrice, at time.Time) bool {
	if math.IsNaN(price.USDMonthlyPerSeat) || math.IsInf(price.USDMonthlyPerSeat, 0) || price.USDMonthlyPerSeat <= 0 {
		return false
	}
	if strings.TrimSpace(price.SourceURL) == "" || validateSourceURL(price.SourceURL) != nil || price.ValidFrom.IsZero() || price.ValidTo != nil && !price.ValidFrom.Before(*price.ValidTo) {
		return false
	}
	if at.IsZero() {
		return false
	}
	instant := at.UTC()
	if instant.Before(price.ValidFrom.UTC()) {
		return false
	}
	return price.ValidTo == nil || instant.Before(price.ValidTo.UTC())
}
