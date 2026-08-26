import { Caption1, mergeClasses, tokens } from "@fluentui/react-components";
import { ChevronRight16Regular } from "@fluentui/react-icons";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { StatusPresentationSnapshot } from "../../bindings/token-monitor-analytics/internal/desktop/models.js";
import {
  type StatusTone,
  gaugeFillColor,
  toneClass,
  useDesignStyles,
} from "./designStyles";

export function Gauge({
  percent,
  status,
  label,
}: {
  percent: number;
  status?: StatusPresentationSnapshot | null;
  label: string;
}) {
  const styles = useDesignStyles();
  return (
    <div className={styles.gaugeTrack} role="img" aria-label={label}>
      <span
        className={styles.gaugeFill}
        style={{
          width: `${Math.max(0, Math.min(100, percent))}%`,
          backgroundColor:
            status === undefined
              ? tokens.colorBrandBackground
              : gaugeFillColor(status),
        }}
      />
    </div>
  );
}

export function KeyValue({
  label,
  children,
  title,
}: {
  label: ReactNode;
  children: ReactNode;
  title?: string;
}) {
  const styles = useDesignStyles();
  return (
    <div className={styles.keyValue} title={title}>
      <Caption1 className={styles.keyValueKey}>{label}</Caption1>
      <Caption1 className={styles.keyValueValue}>{children}</Caption1>
    </div>
  );
}

export function CountStat({
  icon,
  value,
  label,
  tone = "muted",
}: {
  icon: ReactNode;
  value: ReactNode;
  label: string;
  tone?: StatusTone;
}) {
  const styles = useDesignStyles();
  return (
    <span
      className={mergeClasses(styles.count, toneClass(styles, tone))}
      aria-label={label}
      title={label}
    >
      <span aria-hidden="true">{icon}</span>
      <span className={styles.countValue}>{value}</span>
    </span>
  );
}

/**
 * A card that navigates as a whole. `design-system.md` §2 requires the
 * chevron affordance instead of a separate text button.
 */
export function NavigationCard({
  title,
  to,
  ariaLabel,
  header,
  wide,
  children,
}: {
  title: string;
  to: string;
  ariaLabel: string;
  header?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  const styles = useDesignStyles();
  return (
    <Link
      to={to}
      aria-label={ariaLabel}
      className={mergeClasses(
        styles.card,
        styles.cardLink,
        wide && styles.span2,
      )}
    >
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>{title}</h2>
        {header}
        <span className={styles.cardChevron} aria-hidden="true">
          <ChevronRight16Regular />
        </span>
      </div>
      {children}
    </Link>
  );
}
