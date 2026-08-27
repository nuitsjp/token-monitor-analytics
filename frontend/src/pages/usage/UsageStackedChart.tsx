import { Caption1, makeStyles, tokens } from "@fluentui/react-components";
import { memo, useMemo } from "react";
import type { UsagePointSnapshot, UsageSnapshot } from "../../lib/backend";

const CHART_HEIGHT = 380;
const MARGIN = { top: 24, right: 76, bottom: 70, left: 82 };
const CATEGORY_COLORS = [
  tokens.colorPaletteBlueBorderActive,
  tokens.colorPaletteTealBorderActive,
  tokens.colorPaletteCornflowerBorderActive,
  tokens.colorPalettePurpleBorderActive,
  tokens.colorPaletteBrassBorderActive,
];
const OTHER_COLOR = tokens.colorNeutralForeground4;

const useStyles = makeStyles({
  root: { display: "grid", gap: tokens.spacingVerticalM, minWidth: 0 },
  metricGuide: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalL,
    flexWrap: "wrap",
  },
  metricItem: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    fontWeight: tokens.fontWeightSemibold,
  },
  metricBar: {
    display: "inline-block",
    width: "0.65rem",
    height: "1.15rem",
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorBrandBackground,
  },
  costBar: {
    backgroundColor: tokens.colorNeutralForeground2,
  },
  chartScroller: {
    overflowX: "auto",
    paddingBottom: tokens.spacingVerticalXS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  chart: { display: "block", height: `${CHART_HEIGHT}px` },
  gridLine: { stroke: tokens.colorNeutralStroke2, strokeWidth: 1 },
  axisLine: { stroke: tokens.colorNeutralStroke1, strokeWidth: 1 },
  axisText: {
    fill: tokens.colorNeutralForeground3,
    fontSize: "12px",
    fontVariantNumeric: "tabular-nums",
  },
  axisTitle: {
    fill: tokens.colorNeutralForeground2,
    fontSize: "12px",
    fontWeight: tokens.fontWeightSemibold,
  },
  periodLabel: {
    fill: tokens.colorNeutralForeground2,
    fontSize: "12px",
    fontVariantNumeric: "tabular-nums",
  },
  periodGroup: {
    cursor: "pointer",
    outline: "none",
    "&:focus-visible .usage-period-focus": {
      stroke: tokens.colorStrokeFocus2,
      strokeWidth: 3,
    },
  },
  selectedPeriod: {
    fill: tokens.colorBrandBackground2,
    stroke: tokens.colorBrandStroke1,
    strokeWidth: 1,
  },
  periodFocus: {
    fill: "transparent",
    stroke: "transparent",
  },
  empty: {
    minHeight: "15rem",
    display: "grid",
    placeItems: "center",
    color: tokens.colorNeutralForeground3,
    border: `1px dashed ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  legend: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    flexWrap: "wrap",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  legendItem: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
  },
  swatch: {
    width: "0.75rem",
    height: "0.75rem",
    borderRadius: tokens.borderRadiusSmall,
    flexShrink: 0,
  },
});

type Breakdown = NonNullable<UsageSnapshot["breakdown"]>[number];

type VisualSegment = Breakdown & {
  color: string;
  patternIndex: number;
  shared: boolean;
};

type CategoryLegendItem = {
  categoryKey: string;
  label: string;
  color: string;
};

type ChartPoint = UsagePointSnapshot & {
  segments: VisualSegment[];
};

function formatTokens(value: number): string {
  return new Intl.NumberFormat("ja-JP", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatCompactTokens(value: number): string {
  if (value === 0) return "0";
  return new Intl.NumberFormat("ja-JP", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatCost(value: number): string {
  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)} USD*`;
}

function formatAxisCost(value: number): string {
  if (value === 0) return "$0";
  return `$${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value < 10 ? 2 : 1,
  }).format(value)}`;
}

function formatPeriod(
  value: string,
  granularity: string,
  displayTimeZone: string,
): string {
  const date = new Date(value);
  if (granularity === "month") {
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: displayTimeZone,
      year: "numeric",
      month: "short",
    }).format(date);
  }
  if (granularity === "week") {
    return `${new Intl.DateTimeFormat("ja-JP", {
      timeZone: displayTimeZone,
      month: "numeric",
      day: "numeric",
    }).format(date)}週`;
  }
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: displayTimeZone,
    month: "numeric",
    day: "numeric",
  }).format(date);
}

function segmentTitle(period: string, segment: VisualSegment): string {
  const shared =
    segment.attribution === "共有利用実績" ? "・共有利用（按分なし）" : "";
  return `${period}・${segment.label}${shared}\n利用量 ${formatTokens(segment.tokens)} トークン\nAPI換算利用金額 ${formatCost(segment.apiCostUsd)}`;
}

function stableCategoryHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function createCategoryColorMap(breakdown: Breakdown[]): Map<string, string> {
  const categoryKeys = [
    ...new Set(
      breakdown
        .map((row) => row.categoryKey)
        .filter((categoryKey) => categoryKey !== "other"),
    ),
  ].sort();
  const usedIndexes = new Set<number>();
  const colorByCategory = new Map<string, string>();

  for (const categoryKey of categoryKeys) {
    let colorIndex = stableCategoryHash(categoryKey) % CATEGORY_COLORS.length;
    while (usedIndexes.has(colorIndex)) {
      colorIndex = (colorIndex + 1) % CATEGORY_COLORS.length;
    }
    usedIndexes.add(colorIndex);
    colorByCategory.set(categoryKey, CATEGORY_COLORS[colorIndex]);
  }
  colorByCategory.set("other", OTHER_COLOR);
  return colorByCategory;
}

function sharedLegendPattern(color: string) {
  return {
    backgroundColor: color,
    backgroundImage: `repeating-linear-gradient(135deg, transparent 0 4px, ${tokens.colorNeutralBackground1} 4px 5px)`,
  };
}

export const UsageStackedChart = memo(function UsageStackedChart({
  points,
  breakdown,
  displayTimeZone,
  granularity,
  selectedPeriodStart,
  onSelectPeriod,
}: {
  points: UsagePointSnapshot[];
  breakdown: Breakdown[];
  displayTimeZone: string;
  granularity: string;
  selectedPeriodStart: string;
  onSelectPeriod: (periodStart: string) => void;
}) {
  const styles = useStyles();
  const {
    chartPoints,
    segmentLegend,
    categoryLegend,
    maximumTokens,
    maximumCost,
  } = useMemo(() => {
    const colorByCategory = createCategoryColorMap(breakdown);
    const seenCategories = new Set<string>();
    const nextCategoryLegend: CategoryLegendItem[] = [];
    const nextSegmentLegend: VisualSegment[] = [];
    for (const row of breakdown) {
      const color = colorByCategory.get(row.categoryKey) ?? OTHER_COLOR;
      if (!seenCategories.has(row.categoryKey)) {
        seenCategories.add(row.categoryKey);
        nextCategoryLegend.push({
          categoryKey: row.categoryKey,
          label: row.label,
          color,
        });
      }
      nextSegmentLegend.push({
        ...row,
        color,
        patternIndex: nextSegmentLegend.length,
        shared: row.attribution === "共有利用実績",
      });
    }

    let nextMaximumTokens = 0;
    let nextMaximumCost = 0;
    const nextPoints: ChartPoint[] = [];
    for (const point of points) {
      if (point.tokens > nextMaximumTokens) nextMaximumTokens = point.tokens;
      if (point.apiCostUsd > nextMaximumCost)
        nextMaximumCost = point.apiCostUsd;
      const byKey = new Map(
        (point.breakdown ?? []).map((segment) => [segment.key, segment]),
      );
      const segments = nextSegmentLegend.flatMap((item) => {
        const segment = byKey.get(item.key);
        return segment
          ? [
              {
                ...segment,
                color: item.color,
                patternIndex: item.patternIndex,
                shared: item.shared,
              },
            ]
          : [];
      });
      nextPoints.push({ ...point, segments });
    }
    return {
      chartPoints: nextPoints,
      segmentLegend: nextSegmentLegend,
      categoryLegend: nextCategoryLegend,
      maximumTokens: nextMaximumTokens || 1,
      maximumCost: nextMaximumCost || 1,
    };
  }, [breakdown, points]);

  if (points.length === 0) {
    return (
      <div className={styles.empty} role="status">
        選択した期間・条件に該当する利用実績はありません。
      </div>
    );
  }

  const chartWidth = Math.max(900, points.length * 54 + 158);
  const plotWidth = chartWidth - MARGIN.left - MARGIN.right;
  const plotHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;
  const slotWidth = plotWidth / points.length;
  const barGroupWidth = Math.min(46, slotWidth * 0.72);
  const barGap = Math.min(5, barGroupWidth * 0.12);
  const barWidth = (barGroupWidth - barGap) / 2;
  const labelEvery = Math.max(1, Math.ceil(points.length / 10));
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className={styles.root}>
      <div className={styles.metricGuide} aria-label="棒グラフの尺度">
        <span className={styles.metricItem}>
          <i className={styles.metricBar} aria-hidden="true" />
          左の棒・左軸: 利用量（トークン）
        </span>
        <span className={styles.metricItem}>
          <i
            className={`${styles.metricBar} ${styles.costBar}`}
            aria-hidden="true"
          />
          右の棒・右軸: API換算利用金額（USD）
        </span>
        <Caption1>棒を選択すると、その期間の内訳を確認できます。</Caption1>
        <Caption1>* API単価による換算値。実際の請求額ではありません。</Caption1>
      </div>
      <div className={styles.chartScroller}>
        <svg
          className={styles.chart}
          width={chartWidth}
          height={CHART_HEIGHT}
          viewBox={`0 0 ${chartWidth} ${CHART_HEIGHT}`}
          role="group"
          aria-label="利用量とAPI換算利用金額の分類別積み上げ棒グラフ"
        >
          <defs>
            {segmentLegend.map((item) => (
              <pattern
                id={`usage-segment-${item.patternIndex}`}
                key={item.key}
                width="8"
                height="8"
                patternUnits="userSpaceOnUse"
              >
                <rect width="8" height="8" fill={item.color} />
                {item.shared ? (
                  <path
                    d="M-2 6L2 10M0 0L8 8M6-2L10 2"
                    stroke={tokens.colorNeutralBackground1}
                    strokeWidth="1"
                    opacity="0.72"
                  />
                ) : null}
              </pattern>
            ))}
          </defs>
          {ticks.map((ratio) => {
            const y = MARGIN.top + plotHeight * (1 - ratio);
            return (
              <g key={ratio}>
                <line
                  x1={MARGIN.left}
                  x2={chartWidth - MARGIN.right}
                  y1={y}
                  y2={y}
                  className={ratio === 0 ? styles.axisLine : styles.gridLine}
                  vectorEffect="non-scaling-stroke"
                />
                <text
                  x={MARGIN.left - 10}
                  y={y + 4}
                  textAnchor="end"
                  className={styles.axisText}
                >
                  {formatCompactTokens(maximumTokens * ratio)}
                </text>
                <text
                  x={chartWidth - MARGIN.right + 10}
                  y={y + 4}
                  className={styles.axisText}
                >
                  {formatAxisCost(maximumCost * ratio)}
                </text>
              </g>
            );
          })}
          <text
            x={MARGIN.left}
            y={14}
            textAnchor="start"
            className={styles.axisTitle}
          >
            利用量
          </text>
          <text
            x={chartWidth - MARGIN.right}
            y={14}
            textAnchor="end"
            className={styles.axisTitle}
          >
            API換算利用金額
          </text>
          {chartPoints.map((point, pointIndex) => {
            const centerX = MARGIN.left + slotWidth * (pointIndex + 0.5);
            const groupX = centerX - barGroupWidth / 2;
            const period = formatPeriod(
              point.periodStart,
              granularity,
              displayTimeZone,
            );
            let tokensY = MARGIN.top + plotHeight;
            let costY = MARGIN.top + plotHeight;
            const selected = selectedPeriodStart === point.periodStart;
            const select = () => onSelectPeriod(point.periodStart);
            return (
              <g
                key={point.periodStart}
                className={styles.periodGroup}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={`${period}の内訳を表示。利用量 ${formatTokens(point.tokens)} トークン、API換算利用金額 ${formatCost(point.apiCostUsd)}`}
                onClick={select}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    select();
                  }
                }}
              >
                <rect
                  x={MARGIN.left + slotWidth * pointIndex + 2}
                  y={MARGIN.top - 6}
                  width={Math.max(slotWidth - 4, 1)}
                  height={plotHeight + 16}
                  rx={4}
                  className={
                    selected ? styles.selectedPeriod : styles.periodFocus
                  }
                />
                <rect
                  x={MARGIN.left + slotWidth * pointIndex + 2}
                  y={MARGIN.top - 6}
                  width={Math.max(slotWidth - 4, 1)}
                  height={plotHeight + 16}
                  rx={4}
                  className={`usage-period-focus ${styles.periodFocus}`}
                />
                {point.segments.map((segment) => {
                  const height = (segment.tokens / maximumTokens) * plotHeight;
                  tokensY -= height;
                  if (height <= 0) return null;
                  return (
                    <rect
                      key={`tokens-${segment.key}`}
                      x={groupX}
                      y={tokensY}
                      width={barWidth}
                      height={height}
                      fill={`url(#usage-segment-${segment.patternIndex})`}
                      stroke={tokens.colorNeutralBackground1}
                      strokeWidth={0.75}
                      vectorEffect="non-scaling-stroke"
                    >
                      <title>{segmentTitle(period, segment)}</title>
                    </rect>
                  );
                })}
                {point.segments.map((segment) => {
                  const height =
                    (segment.apiCostUsd / maximumCost) * plotHeight;
                  costY -= height;
                  if (height <= 0) return null;
                  return (
                    <rect
                      key={`cost-${segment.key}`}
                      x={groupX + barWidth + barGap}
                      y={costY}
                      width={barWidth}
                      height={height}
                      fill={`url(#usage-segment-${segment.patternIndex})`}
                      stroke={tokens.colorNeutralBackground1}
                      strokeWidth={0.75}
                      vectorEffect="non-scaling-stroke"
                    >
                      <title>{segmentTitle(period, segment)}</title>
                    </rect>
                  );
                })}
                {pointIndex % labelEvery === 0 ||
                pointIndex === chartPoints.length - 1 ? (
                  <text
                    x={centerX}
                    y={MARGIN.top + plotHeight + 28}
                    textAnchor="middle"
                    className={styles.periodLabel}
                  >
                    {period}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
      <ul className={styles.legend} aria-label="分類別の凡例">
        {categoryLegend.map((item) => (
          <li className={styles.legendItem} key={item.categoryKey}>
            <i
              className={styles.swatch}
              style={{ backgroundColor: item.color }}
              data-category-key={item.categoryKey}
              aria-hidden="true"
            />
            <span>{item.label}</span>
          </li>
        ))}
        {segmentLegend.some((item) => item.attribution === "共有利用実績") ? (
          <li className={styles.legendItem}>
            <i
              className={styles.swatch}
              style={sharedLegendPattern(OTHER_COLOR)}
              data-pattern="shared-diagonal"
              aria-hidden="true"
            />
            <span>斜線: 共有利用（按分なし）</span>
          </li>
        ) : null}
      </ul>
    </div>
  );
});
