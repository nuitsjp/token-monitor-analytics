export function formatOverviewInstant(
  value: string,
  displayTimeZone: string,
): string {
  if (!value) return "—";
  const instant = new Date(value);
  const currentYear = new Intl.DateTimeFormat("en", {
    timeZone: displayTimeZone,
    year: "numeric",
  }).format(new Date());
  const valueYear = new Intl.DateTimeFormat("en", {
    timeZone: displayTimeZone,
    year: "numeric",
  }).format(instant);
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: displayTimeZone,
    ...(currentYear === valueYear ? {} : { year: "numeric" as const }),
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).format(instant);
}

export function formatOverviewBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024)
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

export function progressColor(
  status: StatusPresentationSnapshot,
): "success" | "warning" | "error" {
  switch (status.code) {
    case "remaining_high":
      return "success";
    case "remaining_medium":
      return "warning";
    case "remaining_low":
      return "error";
    default:
      throw new Error(`Unsupported remaining status: ${status.code}`);
  }
}
import type { StatusPresentationSnapshot } from "../../bindings/token-monitor-analytics/internal/desktop/models.js";
