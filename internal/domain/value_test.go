package domain

import (
	"math"
	"testing"
	"time"
)

func TestACP2Value01And02MonthlyConversion(t *testing.T) {
	now := time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC)
	weeklyCap := 700.0
	want := 700 * 365.2425 / 12 / 7
	confirmedCap := 700.0
	t.Run("P2-VALUE-01 weekly cap uses the required annualized monthly factor", func(t *testing.T) {
		weekly := CalculateValue(ValueCalculationInput{
			CycleType: LimitCycleWeekly, Metric: "percent", EstimatedLimit: &weeklyCap, At: now,
		})
		if weekly.MonthlyEquivalent == nil || math.Abs(*weekly.MonthlyEquivalent-want) > 1e-12 {
			t.Fatalf("weekly value = %#v, want %v", weekly, want)
		}
	})
	t.Run("P2-VALUE-02 confirmed monthly billing cap is not annualized", func(t *testing.T) {
		confirmed := CalculateValue(ValueCalculationInput{
			CycleType: LimitCycleBilling, BillingConfirmation: BillingConfirmed, Metric: "percent", EstimatedLimit: &confirmedCap, At: now,
		})
		if confirmed.MonthlyEquivalent == nil || *confirmed.MonthlyEquivalent != 700 {
			t.Fatalf("confirmed billing value = %#v", confirmed)
		}
	})
	t.Run("AC-P2-01 weekly and confirmed monthly fixtures match the contract", func(t *testing.T) {
		weekly := CalculateValue(ValueCalculationInput{CycleType: LimitCycleWeekly, Metric: "percent", EstimatedLimit: &weeklyCap, At: now})
		confirmed := CalculateValue(ValueCalculationInput{CycleType: LimitCycleBilling, BillingConfirmation: BillingConfirmed, Metric: "percent", EstimatedLimit: &confirmedCap, At: now})
		if weekly.MonthlyEquivalent == nil || math.Abs(*weekly.MonthlyEquivalent-want) > 1e-12 || confirmed.MonthlyEquivalent == nil || *confirmed.MonthlyEquivalent != 700 {
			t.Fatalf("monthly conversion values = weekly=%#v confirmed=%#v", weekly, confirmed)
		}
	})
}

func TestACP2Value02And03UnsupportedUnitsNeverBecomeValue(t *testing.T) {
	now := time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC)
	price := testStandardPrice(now)
	cap := 700.0
	cases := []struct {
		name   string
		cycle  string
		metric string
		reason ValueReason
	}{
		{name: "AC-P2-02 unconfirmed billing", cycle: LimitCycleBilling, reason: ValueReasonBillingUnconfirmed},
		{name: "AC-P2-02 credits", cycle: LimitCycleWeekly, metric: "credits", reason: ValueReasonMetricUnsupported},
		{name: "AC-P2-02 spend", cycle: LimitCycleWeekly, metric: "spend", reason: ValueReasonMetricUnsupported},
		{name: "AC-P2-02 balance", cycle: LimitCycleBalance, reason: ValueReasonCycleUnsupported},
		{name: "AC-P2-02 usage amount", cycle: LimitCycleUsage, reason: ValueReasonCycleUnsupported},
	}
	t.Run("AC-P2-02 unsupported billing, credits, spend, balance and usage remain native-only", func(t *testing.T) {
		for _, testCase := range cases {
			result := CalculateValue(ValueCalculationInput{
				CycleType: testCase.cycle, BillingConfirmation: BillingUnconfirmed, Metric: testCase.metric,
				EstimatedLimit: &cap, StandardPrice: &price, At: now,
			})
			if result.MonthlyEquivalent != nil || result.ValueMultiplier != nil || result.Reason != testCase.reason {
				t.Fatalf("value = %#v, want no value and reason %q", result, testCase.reason)
			}
		}
	})
	t.Run("P2-VALUE-03 unconfirmed billing and native units never become a value", func(t *testing.T) {
		for _, testCase := range cases {
			result := CalculateValue(ValueCalculationInput{
				CycleType: testCase.cycle, BillingConfirmation: BillingUnconfirmed, Metric: testCase.metric,
				EstimatedLimit: &cap, StandardPrice: &price, At: now,
			})
			if result.MonthlyEquivalent != nil || result.ValueMultiplier != nil || result.Reason != testCase.reason {
				t.Fatalf("%s produced value: %#v", testCase.name, result)
			}
		}
	})
}

func TestACP2Value03And08PriceIsOptionalButMultiplierRequiresValidPrice(t *testing.T) {
	now := time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC)
	cap := 700.0
	price := testStandardPrice(now)
	t.Run("P2-VALUE-06 valid standard price produces the maximum value multiplier", func(t *testing.T) {
		withPrice := CalculateValue(ValueCalculationInput{CycleType: LimitCycleBilling, BillingConfirmation: BillingConfirmed, EstimatedLimit: &cap, StandardPrice: &price, At: now})
		if withPrice.ValueMultiplier == nil || *withPrice.ValueMultiplier != 70 || withPrice.Reason != ValueReasonComputed {
			t.Fatalf("valid price value = %#v", withPrice)
		}
	})
	t.Run("P2-VALUE-07 source URL and validity period are required", func(t *testing.T) {
		outside := now.Add(-time.Hour)
		price.ValidFrom = now
		invalidPeriod := CalculateValue(ValueCalculationInput{CycleType: LimitCycleBilling, BillingConfirmation: BillingConfirmed, EstimatedLimit: &cap, StandardPrice: &price, At: outside})
		missingSource := price
		missingSource.SourceURL = ""
		invalidSource := CalculateValue(ValueCalculationInput{CycleType: LimitCycleBilling, BillingConfirmation: BillingConfirmed, EstimatedLimit: &cap, StandardPrice: &missingSource, At: now})
		if invalidPeriod.MonthlyEquivalent == nil || invalidPeriod.ValueMultiplier != nil || invalidPeriod.Reason != ValueReasonStandardPriceInvalid || invalidSource.ValueMultiplier != nil || invalidSource.Reason != ValueReasonStandardPriceInvalid {
			t.Fatalf("invalid standard prices = period=%#v source=%#v", invalidPeriod, invalidSource)
		}
	})
	t.Run("P2-VALUE-08 missing standard price keeps the Phase 1 estimate", func(t *testing.T) {
		withoutPrice := CalculateValue(ValueCalculationInput{CycleType: LimitCycleBilling, BillingConfirmation: BillingConfirmed, EstimatedLimit: &cap, At: now})
		if withoutPrice.MonthlyEquivalent == nil || *withoutPrice.MonthlyEquivalent != cap || withoutPrice.ValueMultiplier != nil || withoutPrice.Reason != ValueReasonStandardPriceMissing {
			t.Fatalf("missing price = %#v", withoutPrice)
		}
	})
	t.Run("AC-P2-03 valid price metadata gates the multiplier", func(t *testing.T) {
		validPrice := testStandardPrice(now)
		withPrice := CalculateValue(ValueCalculationInput{CycleType: LimitCycleBilling, BillingConfirmation: BillingConfirmed, EstimatedLimit: &cap, StandardPrice: &validPrice, At: now})
		if withPrice.ValueMultiplier == nil || *withPrice.ValueMultiplier != 70 || withPrice.StandardPrice == nil || withPrice.StandardPrice.SourceURL == "" {
			t.Fatalf("price comparison = %#v", withPrice)
		}
	})
	t.Run("missing price does not remove the monthly estimate", func(t *testing.T) {
		withoutPrice := CalculateValue(ValueCalculationInput{CycleType: LimitCycleBilling, BillingConfirmation: BillingConfirmed, EstimatedLimit: &cap, At: now})
		if withoutPrice.MonthlyEquivalent == nil || withoutPrice.ValueMultiplier != nil {
			t.Fatalf("optional price result = %#v", withoutPrice)
		}
	})
}

func TestACP2Value04And05WindowsRemainIndependent(t *testing.T) {
	now := time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC)
	weeklyCap := 700.0
	monthlyCap := 700.0
	values := CalculateValues([]ValueCalculationInput{
		{CycleType: LimitCycleWeekly, EstimatedLimit: &weeklyCap, At: now},
		{CycleType: LimitCycleBilling, BillingConfirmation: BillingConfirmed, EstimatedLimit: &monthlyCap, At: now},
	})
	t.Run("P2-VALUE-04 reset-separated intervals do not inflate the monthly value", func(t *testing.T) {
		resetSeparated := CalculateValues([]ValueCalculationInput{
			{CycleType: LimitCycleWeekly, EstimatedLimit: &weeklyCap, At: now},
			{CycleType: LimitCycleWeekly, EstimatedLimit: &weeklyCap, At: now.AddDate(0, 0, 8)},
		})
		if len(resetSeparated) != 2 || resetSeparated[0].MonthlyEquivalent == nil || resetSeparated[1].MonthlyEquivalent == nil || *resetSeparated[0].MonthlyEquivalent != *resetSeparated[1].MonthlyEquivalent {
			t.Fatalf("reset-separated values = %#v", resetSeparated)
		}
	})
	t.Run("P2-VALUE-05 weekly and confirmed monthly windows remain independent", func(t *testing.T) {
		if len(values) != 2 || values[0].MonthlyEquivalent == nil || values[1].MonthlyEquivalent == nil || *values[0].MonthlyEquivalent == *values[1].MonthlyEquivalent {
			t.Fatalf("independent values = %#v", values)
		}
	})
	t.Run("AC-P2-04 each limit is shown without a combined value", func(t *testing.T) {
		if len(values) != 2 || *values[0].MonthlyEquivalent != weeklyCap*WeeklyMonthlyFactor || *values[1].MonthlyEquivalent != monthlyCap {
			t.Fatalf("independent values = %#v", values)
		}
	})
	t.Run("independent windows are not combined", func(t *testing.T) {
		if len(values) != 2 || *values[0].MonthlyEquivalent == *values[1].MonthlyEquivalent {
			t.Fatalf("combined values = %#v", values)
		}
	})
}

func testStandardPrice(now time.Time) StandardPrice {
	return StandardPrice{ID: "price-1", PlanVersionID: "plan-version-1", USDMonthlyPerSeat: 10, SourceURL: "https://vendor.example/prices", ValidFrom: now.Add(-time.Hour), CreatedAt: now}
}
