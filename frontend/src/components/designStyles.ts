import { makeStyles, tokens } from "@fluentui/react-components";
import type { StatusPresentationSnapshot } from "../../bindings/token-monitor-analytics/internal/desktop/models.js";

/**
 * Shared surfaces for the main window. The rules come from
 * `docs/design-system.md` §3, §4 and §7 and the sample markup in
 * `docs/design-samples/screens.html`.
 */
export const useDesignStyles = makeStyles({
  page: {
    display: "grid",
    gap: tokens.spacingVerticalL,
    maxWidth: "100rem",
    minWidth: 0,
  },
  pageHeader: {
    display: "flex",
    alignItems: "baseline",
    gap: tokens.spacingHorizontalM,
    minWidth: 0,
  },
  pageTitle: {
    margin: 0,
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
  },
  pageMeta: {
    marginLeft: "auto",
    color: tokens.colorNeutralForeground3,
    whiteSpace: "nowrap",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: tokens.spacingHorizontalL,
    alignItems: "stretch",
    "@media (max-width: 70rem)": {
      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    },
    "@media (max-width: 45rem)": {
      gridTemplateColumns: "minmax(0, 1fr)",
    },
  },
  span2: {
    gridColumn: "span 2",
    "@media (max-width: 45rem)": { gridColumn: "auto" },
  },
  card: {
    position: "relative",
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    padding: "14px 16px",
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid transparent`,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow4,
    color: tokens.colorNeutralForeground1,
    textDecorationLine: "none",
    "@media (forced-colors: active)": { border: "1px solid CanvasText" },
  },
  cardLink: {
    cursor: "pointer",
    ":hover": {
      border: `1px solid ${tokens.colorNeutralStroke1}`,
      textDecorationLine: "none",
    },
    ":focus-visible": {
      border: `1px solid ${tokens.colorBrandForegroundLink}`,
    },
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground3,
    minWidth: 0,
  },
  cardTitle: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: "0.02em",
    color: tokens.colorNeutralForeground3,
  },
  cardChevron: {
    marginLeft: "auto",
    display: "inline-flex",
    color: tokens.colorNeutralForeground3,
  },
  metric: {
    fontSize: tokens.fontSizeHero700,
    lineHeight: tokens.lineHeightHero700,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: "tabular-nums",
    letterSpacing: "-0.3px",
    overflowWrap: "anywhere",
  },
  metricRow: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(7rem, 1fr))",
    gap: tokens.spacingHorizontalL,
  },
  metricCell: { display: "grid", gap: "2px", minWidth: 0 },
  metricLabel: { color: tokens.colorNeutralForeground3 },
  keyValue: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
    padding: "1px 0",
  },
  keyValueKey: { color: tokens.colorNeutralForeground3, whiteSpace: "nowrap" },
  keyValueValue: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    fontVariantNumeric: "tabular-nums",
    minWidth: 0,
    textAlign: "end",
  },
  counts: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalL,
  },
  count: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
  },
  countValue: {
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: "tabular-nums",
  },
  badgeRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
  },
  gaugeRow: { display: "grid", gap: "5px", minWidth: 0 },
  gaugeHeader: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  gaugeName: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: tokens.fontWeightSemibold,
  },
  gaugeContext: {
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightRegular,
  },
  gaugePercent: {
    flexShrink: 0,
    fontWeight: tokens.fontWeightBold,
    fontVariantNumeric: "tabular-nums",
  },
  gaugeTrack: {
    height: "4px",
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground6,
    overflow: "hidden",
    "@media (forced-colors: active)": { border: "1px solid CanvasText" },
  },
  gaugeFill: {
    display: "block",
    height: "100%",
    borderRadius: tokens.borderRadiusCircular,
    "@media (forced-colors: active)": { backgroundColor: "CanvasText" },
  },
  muted: { color: tokens.colorNeutralForeground3 },
  numeric: { fontVariantNumeric: "tabular-nums" },
  success: { color: tokens.colorPaletteGreenForeground1 },
  warning: { color: tokens.colorPaletteDarkOrangeForeground1 },
  danger: { color: tokens.colorPaletteRedForeground1 },
  caution: { color: tokens.colorPaletteMarigoldForeground1 },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
  th: {
    fontWeight: tokens.fontWeightRegular,
    color: tokens.colorNeutralForeground3,
    textAlign: "start",
    whiteSpace: "nowrap",
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    padding: "6px 8px",
  },
  td: {
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: "7px 8px",
    verticalAlign: "middle",
    overflowWrap: "anywhere",
  },
  numericCell: { textAlign: "end", fontVariantNumeric: "tabular-nums" },
});

export type DesignStyles = ReturnType<typeof useDesignStyles>;

export type StatusTone = "success" | "warning" | "danger" | "caution" | "muted";

export function toneClass(styles: DesignStyles, tone: StatusTone): string {
  switch (tone) {
    case "success":
      return styles.success;
    case "warning":
      return styles.warning;
    case "danger":
      return styles.danger;
    case "caution":
      return styles.caution;
    default:
      return styles.muted;
  }
}

export function intentTone(intent: string): StatusTone {
  switch (intent) {
    case "success":
      return "success";
    case "warning":
      return "warning";
    case "danger":
      return "danger";
    default:
      return "muted";
  }
}

/** Fill colours follow the remaining thresholds of `design-system.md` §5.3. */
export function gaugeFillColor(
  status: StatusPresentationSnapshot | null,
): string {
  switch (status?.code) {
    case "remaining_high":
      return tokens.colorPaletteGreenBackground3;
    case "remaining_medium":
      return tokens.colorPaletteMarigoldBackground3;
    case "remaining_low":
      return tokens.colorPaletteRedBackground3;
    default:
      return tokens.colorNeutralBackground6;
  }
}

export function gaugeTextClass(
  styles: DesignStyles,
  status: StatusPresentationSnapshot,
): string {
  switch (status.code) {
    case "remaining_high":
      return styles.success;
    case "remaining_medium":
      return styles.caution;
    case "remaining_low":
      return styles.danger;
    default:
      return styles.muted;
  }
}
