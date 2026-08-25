import { Badge, type BadgeProps, Tooltip } from "@fluentui/react-components";
import {
  ArrowSync16Regular,
  CheckmarkCircle16Regular,
  ErrorCircle16Regular,
  Info16Regular,
  Warning16Regular,
} from "@fluentui/react-icons";
import type { StatusPresentationSnapshot } from "../../bindings/token-monitor-analytics/internal/desktop/models.js";

function statusIcon(icon: string): React.ReactElement {
  switch (icon) {
    case "checkmark":
      return <CheckmarkCircle16Regular />;
    case "warning":
      return <Warning16Regular />;
    case "error":
      return <ErrorCircle16Regular />;
    case "sync":
      return <ArrowSync16Regular />;
    case "info":
      return <Info16Regular />;
    default:
      throw new Error(`Unsupported status icon: ${icon}`);
  }
}

function statusColor(intent: string): BadgeProps["color"] {
  switch (intent) {
    case "success":
    case "warning":
    case "danger":
    case "informative":
    case "subtle":
      return intent;
    default:
      throw new Error(`Unsupported status intent: ${intent}`);
  }
}

export function StatusBadge({
  status,
}: {
  status: StatusPresentationSnapshot;
}) {
  const description = status.nextAction
    ? `${status.description} 次の操作: ${status.nextAction}`
    : status.description;
  return (
    <Tooltip content={description} relationship="description">
      <Badge
        appearance="tint"
        color={statusColor(status.intent)}
        icon={statusIcon(status.icon)}
        aria-label={`${status.label}。${description}`}
      >
        {status.label}
      </Badge>
    </Tooltip>
  );
}
