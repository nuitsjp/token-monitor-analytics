import {
  Badge,
  Body1,
  Button,
  Caption1,
  Card,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Spinner,
  Subtitle1,
  Tab,
  TabList,
  Text,
  Tooltip,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowSync16Regular,
  CheckmarkCircle16Regular,
  ErrorCircle16Regular,
  Info16Regular,
  Warning16Regular,
} from "@fluentui/react-icons";
import { Dialogs } from "@wailsio/runtime";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { presentStatus } from "../../lib/status";

export interface DataManagementErrorSnapshot {
  code: string;
  message: string;
  details: string[] | null;
  rolledBack: boolean;
  currentDataUnchanged: boolean;
}

export interface DataManagementCapacitySnapshot {
  databaseSizeBytes: number;
  rawSnapshotCount: number;
  oldestCompletedAt: string;
  latestCompletedAt: string;
  rawJsonBytes: number;
}

export interface DataManagementCapacityResultSnapshot {
  status: string;
  capacity: DataManagementCapacitySnapshot | null;
  error: DataManagementErrorSnapshot | null;
}

export interface DataManagementPurgeSelectionInput {
  allHubs: boolean;
  hubIds: string[] | null;
  startAt: string;
  endAt: string;
  confirmationText: string;
}

export interface DataManagementPurgeSelectionSnapshot {
  allHubs: boolean;
  hubIds: string[] | null;
  startAt: string;
  endAt: string;
}

export interface DataManagementPurgePreviewSnapshot {
  selection: DataManagementPurgeSelectionSnapshot;
  capacity: DataManagementCapacitySnapshot;
  requiredConfirmationText: string;
}

export interface DataManagementPurgeResultSnapshot {
  auditId: string;
  executedAt: string;
  rawSnapshotCount: number;
  costObservationCount: number;
  limitObservationCount: number;
  matchedObservationCount: number;
  estimationPointCount: number;
  estimationResultCount: number;
  estimationEvidenceCount: number;
  calculationIntervalCount: number;
  calculationBoundaryCount: number;
  recalculatedResultCount: number;
}

export interface DataManagementPurgeStateSnapshot {
  status: string;
  cancelAllowed: boolean;
  preview: DataManagementPurgePreviewSnapshot | null;
  result: DataManagementPurgeResultSnapshot | null;
  error: DataManagementErrorSnapshot | null;
}

export interface DataManagementArtifactSnapshot {
  path: string;
  artifactSha256: string;
  sizeBytes: number;
  formatVersion: number;
  schemaVersion: number;
  appVersion: string;
  createdAt: string;
  warning: string;
}

export interface DataManagementBackupStateSnapshot {
  status: string;
  cancelAllowed: boolean;
  artifact: DataManagementArtifactSnapshot | null;
  error: DataManagementErrorSnapshot | null;
}

export interface DataManagementRestoreValidationStateSnapshot {
  status: string;
  cancelAllowed: boolean;
  applyAllowed: boolean;
  operationId: string;
  artifact: DataManagementArtifactSnapshot | null;
  error: DataManagementErrorSnapshot | null;
}

export interface DataManagementRestoreTrialStateSnapshot {
  status: string;
  cancelAllowed: boolean;
  artifactSha256: string;
  testedAt: string;
  warning: string;
  error: DataManagementErrorSnapshot | null;
}

export interface DataManagementRestoreApplyStateSnapshot {
  status: string;
  phase: string;
  cancelAllowed: boolean;
  cancellationBoundary: string;
  operationId: string;
  artifact: DataManagementArtifactSnapshot | null;
  restoredAt: string;
  auditId: string;
  rollbackSucceeded: boolean;
  warning: string;
  credentialState: string;
  requiresCredentialReregistration: boolean;
  error: DataManagementErrorSnapshot | null;
}

export interface DataManagementRestoreStateSnapshot {
  validation: DataManagementRestoreValidationStateSnapshot;
  trial: DataManagementRestoreTrialStateSnapshot;
  apply: DataManagementRestoreApplyStateSnapshot;
}

export interface DataManagementRecoveryNoticeSnapshot {
  status: string;
  artifactSha256: string;
  message: string;
}

export interface DataManagementMaintenanceSnapshot {
  active: boolean;
  operation: string;
  phase: string;
  cancelAllowed: boolean;
  cancellationBoundary: string;
}

export interface DataManagementCancellationSnapshot {
  status: string;
  phase: string;
  cancelAllowed: boolean;
  cancellationBoundary: string;
  message: string;
  error: DataManagementErrorSnapshot | null;
}

export interface DataManagementStateSnapshot {
  capacity: DataManagementCapacityResultSnapshot;
  purge: DataManagementPurgeStateSnapshot;
  backup: DataManagementBackupStateSnapshot;
  restore: DataManagementRestoreStateSnapshot;
  recovery: DataManagementRecoveryNoticeSnapshot;
  maintenance: DataManagementMaintenanceSnapshot;
}

export interface DataManagementHubSnapshot {
  id: string;
  displayName: string;
  url: string;
  enabled: boolean;
  collectionEnabled: boolean;
  collectionIntervalSeconds: number;
  apiContract: string;
  credentialState: string;
  credentialReady: boolean;
  connectionState: string;
  connectionCheckedAt: string;
  connectionFailureNote: string;
}

export interface DataManagementPageBackend {
  getDataManagementState(): Promise<DataManagementStateSnapshot>;
  getHubs(): Promise<DataManagementHubSnapshot[]>;
  createBackup(
    destinationPath: string,
  ): Promise<DataManagementBackupStateSnapshot>;
  validateRestore(
    archivePath: string,
  ): Promise<DataManagementRestoreValidationStateSnapshot>;
  runRestoreTrial(
    operationId: string,
  ): Promise<DataManagementRestoreTrialStateSnapshot>;
  applyRestore(
    operationId: string,
    confirmed: boolean,
  ): Promise<DataManagementRestoreApplyStateSnapshot>;
  previewPurge(
    input: DataManagementPurgeSelectionInput,
  ): Promise<DataManagementPurgeStateSnapshot>;
  applyPurge(
    input: DataManagementPurgeSelectionInput,
    confirmed: boolean,
  ): Promise<DataManagementPurgeStateSnapshot>;
  cancelCurrentOperation(): Promise<DataManagementCancellationSnapshot>;
}

type PageTab = "capacity" | "backup" | "restore" | "purge";

interface PurgeDraft {
  allHubs: boolean;
  hubIds: string[];
  omitStart: boolean;
  omitEnd: boolean;
  startAt: string;
  endAt: string;
}

const initialPurgeDraft: PurgeDraft = {
  allHubs: false,
  hubIds: [],
  omitStart: true,
  omitEnd: true,
  startAt: "",
  endAt: "",
};

const useStyles = makeStyles({
  page: {
    display: "grid",
    width: "100%",
    minWidth: 0,
    gap: tokens.spacingVerticalL,
  },
  heading: {
    display: "grid",
    gap: tokens.spacingVerticalXS,
  },
  tabs: {
    width: "100%",
    overflowX: "auto",
  },
  panel: {
    display: "grid",
    minWidth: 0,
    gap: tokens.spacingVerticalL,
  },
  cards: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 14rem), 1fr))",
    gap: tokens.spacingHorizontalL,
  },
  card: {
    display: "grid",
    minWidth: 0,
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalL,
    boxShadow: tokens.shadow4,
  },
  cardLabel: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  value: {
    overflowWrap: "anywhere",
    fontSize: tokens.fontSizeHero700,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: "tabular-nums",
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  metadata: {
    display: "grid",
    gridTemplateColumns: "minmax(9rem, auto) minmax(0, 1fr)",
    gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    margin: 0,
    fontVariantNumeric: "tabular-nums",
    "@media (max-width: 36rem)": {
      gridTemplateColumns: "1fr",
    },
  },
  term: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  detail: {
    minWidth: 0,
    margin: 0,
    overflowWrap: "anywhere",
  },
  code: {
    fontFamily: "Consolas, 'Cascadia Code', monospace",
    fontSize: tokens.fontSizeBase200,
    overflowWrap: "anywhere",
  },
  form: {
    display: "grid",
    gap: tokens.spacingVerticalM,
  },
  formGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 16rem), 1fr))",
    gap: tokens.spacingHorizontalL,
  },
  hubList: {
    display: "grid",
    maxHeight: "18rem",
    overflowY: "auto",
    gap: tokens.spacingVerticalXS,
  },
  longListItem: {
    contentVisibility: "auto",
    containIntrinsicSize: "0 3rem",
  },
  safetyList: {
    display: "grid",
    gap: tokens.spacingVerticalXS,
    marginBlock: 0,
    paddingInlineStart: tokens.spacingHorizontalXXL,
  },
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 10000,
    display: "grid",
    placeItems: "center",
    padding: tokens.spacingHorizontalXXL,
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  overlayContent: {
    display: "grid",
    width: "min(36rem, 100%)",
    gap: tokens.spacingVerticalL,
    padding: tokens.spacingHorizontalXXL,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow28,
  },
  dialogContent: {
    display: "grid",
    gap: tokens.spacingVerticalM,
  },
  warningText: {
    color: tokens.colorPaletteDarkOrangeForeground1,
  },
  numeric: {
    fontVariantNumeric: "tabular-nums",
  },
  screenReaderOnly: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: 0,
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    border: 0,
  },
  forcedColorBoundary: {
    "@media (forced-colors: active)": {
      border: "1px solid CanvasText",
    },
  },
});

export function DataManagementPage({
  backend,
  displayTimeZone = "UTC",
  pollIntervalMs = 500,
}: {
  backend: DataManagementPageBackend;
  displayTimeZone?: string;
  pollIntervalMs?: number;
}) {
  const styles = useStyles();
  const [tab, setTab] = useState<PageTab>("capacity");
  const [state, setState] = useState<DataManagementStateSnapshot | null>(null);
  const [hubs, setHubs] = useState<DataManagementHubSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [operationInFlight, setOperationInFlight] = useState(false);
  const [operationNotice, setOperationNotice] = useState("");
  const [restorePath, setRestorePath] = useState("");
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const [purgeConfirmOpen, setPurgeConfirmOpen] = useState(false);
  const [purgeConfirmationText, setPurgeConfirmationText] = useState("");
  const [purgeDraft, setPurgeDraft] = useState<PurgeDraft>(initialPurgeDraft);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const [nextState, nextHubs] = await Promise.all([
        backend.getDataManagementState(),
        backend.getHubs(),
      ]);
      setState(nextState);
      setHubs(nextHubs);
    } catch (cause) {
      setLoadError(
        errorMessage(cause, "データ管理情報を読み込めませんでした。"),
      );
    } finally {
      setLoading(false);
    }
  }, [backend]);

  const refreshState = useCallback(async () => {
    const nextState = await backend.getDataManagementState();
    setState(nextState);
  }, [backend]);

  useEffect(() => {
    // This initial read synchronizes the page with the external desktop adapter.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const shouldPoll = operationInFlight || state?.maintenance.active === true;
  useEffect(() => {
    if (!shouldPoll) return undefined;
    let disposed = false;
    let timer = 0;
    const poll = async () => {
      try {
        const nextState = await backend.getDataManagementState();
        if (!disposed) setState(nextState);
      } catch {
        // The in-flight command owns the user-facing failure. Polling stays observational.
      } finally {
        if (!disposed)
          timer = window.setTimeout(() => void poll(), pollIntervalMs);
      }
    };
    timer = window.setTimeout(() => void poll(), pollIntervalMs);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [backend, pollIntervalMs, shouldPoll]);

  const maintenanceActive =
    operationInFlight || state?.maintenance.active === true;
  const applyRunning =
    state?.restore.apply.status === "applying" ||
    state?.maintenance.phase === "restore_apply";

  const hubNames = useMemo(
    () => new Map(hubs.map((hub) => [hub.id, hub.displayName])),
    [hubs],
  );

  const finishOperation = useCallback(() => {
    setOperationInFlight(false);
    void refreshState();
  }, [refreshState]);

  const createBackup = async () => {
    const destinationPath = await Dialogs.SaveFile({
      Title: "バックアップZIPの保存先",
      ButtonText: "保存",
      Filename: "token-monitor-backup.zip",
      CanChooseFiles: true,
      CanChooseDirectories: false,
      Filters: [{ DisplayName: "ZIPバックアップ", Pattern: "*.zip" }],
    });
    if (!destinationPath) return;
    setOperationNotice("");
    setOperationInFlight(true);
    setState((current) =>
      current === null
        ? current
        : {
            ...current,
            backup: {
              status: "creating",
              cancelAllowed: false,
              artifact: null,
              error: null,
            },
          },
    );
    try {
      const backup = await backend.createBackup(destinationPath);
      setState((current) =>
        current === null ? current : { ...current, backup },
      );
    } catch (cause) {
      setOperationNotice(
        errorMessage(cause, "バックアップを作成できませんでした。"),
      );
    } finally {
      finishOperation();
    }
  };

  const selectRestoreArchive = async () => {
    const archivePath = await Dialogs.OpenFile({
      Title: "復元するバックアップZIPを選択",
      ButtonText: "選択",
      CanChooseFiles: true,
      CanChooseDirectories: false,
      AllowsMultipleSelection: false,
      Filters: [{ DisplayName: "ZIPバックアップ", Pattern: "*.zip" }],
    });
    if (typeof archivePath === "string" && archivePath)
      setRestorePath(archivePath);
  };

  const validateRestorePath = async (archivePath: string) => {
    if (!archivePath) return;
    setOperationNotice("");
    setOperationInFlight(true);
    setState((current) =>
      current === null
        ? current
        : {
            ...current,
            restore: {
              ...current.restore,
              validation: {
                status: "validating",
                cancelAllowed: true,
                applyAllowed: false,
                operationId: "",
                artifact: null,
                error: null,
              },
            },
          },
    );
    try {
      const validation = await backend.validateRestore(archivePath);
      setState((current) =>
        current === null
          ? current
          : { ...current, restore: { ...current.restore, validation } },
      );
    } catch (cause) {
      setOperationNotice(
        errorMessage(cause, "バックアップZIPを検証できませんでした。"),
      );
    } finally {
      finishOperation();
    }
  };

  const validateCreatedBackup = () => {
    const archivePath = state?.backup.artifact?.path ?? "";
    if (archivePath) void validateRestorePath(archivePath);
  };

  const runRestoreTrial = async () => {
    const operationId = state?.restore.validation.operationId ?? "";
    if (!operationId) return;
    setOperationNotice("");
    setOperationInFlight(true);
    setState((current) =>
      current === null
        ? current
        : {
            ...current,
            restore: {
              ...current.restore,
              trial: {
                ...current.restore.trial,
                status: "running",
                cancelAllowed: true,
                error: null,
              },
            },
          },
    );
    try {
      const trial = await backend.runRestoreTrial(operationId);
      setState((current) =>
        current === null
          ? current
          : { ...current, restore: { ...current.restore, trial } },
      );
    } catch (cause) {
      setOperationNotice(
        errorMessage(cause, "隔離復元試験を実行できませんでした。"),
      );
    } finally {
      finishOperation();
    }
  };

  const applyRestore = async () => {
    const operationId = state?.restore.validation.operationId ?? "";
    if (!operationId) return;
    setRestoreConfirmOpen(false);
    setOperationNotice("");
    setOperationInFlight(true);
    setState((current) =>
      current === null
        ? current
        : {
            ...current,
            restore: {
              ...current.restore,
              apply: {
                ...current.restore.apply,
                status: "applying",
                phase: "restore_apply",
                cancelAllowed: true,
                cancellationBoundary: "before_atomic_replace_only",
                operationId,
                error: null,
              },
            },
          },
    );
    try {
      const apply = await backend.applyRestore(operationId, true);
      setState((current) =>
        current === null
          ? current
          : { ...current, restore: { ...current.restore, apply } },
      );
      if (apply.status === "success") {
        const [nextState, nextHubs] = await Promise.all([
          backend.getDataManagementState(),
          backend.getHubs(),
        ]);
        setState(nextState);
        setHubs(nextHubs);
      }
    } catch (cause) {
      setOperationNotice(errorMessage(cause, "復元を適用できませんでした。"));
    } finally {
      finishOperation();
    }
  };

  const cancelOperation = async () => {
    try {
      const result = await backend.cancelCurrentOperation();
      setOperationNotice(result.error?.message ?? result.message);
      await refreshState();
    } catch (cause) {
      setOperationNotice(
        errorMessage(cause, "取消要求を送信できませんでした。"),
      );
    }
  };

  const purgeInput = useCallback(
    (confirmationText: string): DataManagementPurgeSelectionInput => ({
      allHubs: purgeDraft.allHubs,
      hubIds: purgeDraft.allHubs ? [] : purgeDraft.hubIds,
      startAt: purgeDraft.omitStart ? "" : toUTC(purgeDraft.startAt),
      endAt: purgeDraft.omitEnd ? "" : toUTC(purgeDraft.endAt),
      confirmationText,
    }),
    [purgeDraft],
  );

  const previewPurge = async () => {
    setOperationNotice("");
    setPurgeConfirmationText("");
    setOperationInFlight(true);
    setState((current) =>
      current === null
        ? current
        : {
            ...current,
            purge: {
              status: "previewing",
              cancelAllowed: true,
              preview: null,
              result: null,
              error: null,
            },
          },
    );
    try {
      const purge = await backend.previewPurge(purgeInput(""));
      setState((current) =>
        current === null ? current : { ...current, purge },
      );
    } catch (cause) {
      setOperationNotice(
        errorMessage(cause, "パージ対象を確認できませんでした。"),
      );
    } finally {
      finishOperation();
    }
  };

  const applyPurge = async () => {
    const preview = state?.purge.preview;
    if (preview === null || preview === undefined) return;
    setPurgeConfirmOpen(false);
    setOperationNotice("");
    setOperationInFlight(true);
    const input = inputFromPreview(preview, purgeConfirmationText);
    setState((current) =>
      current === null
        ? current
        : {
            ...current,
            purge: {
              ...current.purge,
              status: "applying",
              cancelAllowed: false,
              error: null,
            },
          },
    );
    try {
      const purge = await backend.applyPurge(input, true);
      setState((current) =>
        current === null ? current : { ...current, purge },
      );
    } catch (cause) {
      setOperationNotice(errorMessage(cause, "パージを実行できませんでした。"));
    } finally {
      finishOperation();
    }
  };

  if (loading) return <Spinner label="データ管理を読み込み中" />;
  if (loadError || state === null) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>
          {loadError || "データ管理情報を表示できません。"}
          <Button appearance="transparent" onClick={() => void load()}>
            再試行
          </Button>
        </MessageBarBody>
      </MessageBar>
    );
  }

  const validationMatchesBackup =
    state.backup.artifact !== null &&
    state.restore.validation.status === "success" &&
    state.restore.validation.artifact?.artifactSha256 ===
      state.backup.artifact.artifactSha256;

  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        <Subtitle1 as="h1">データ管理</Subtitle1>
        <Body1>容量、バックアップ、復元、明示パージを安全に管理します。</Body1>
      </header>

      {state.recovery.status !== "none" ? (
        <MessageBar
          intent={state.recovery.status === "rolled_back" ? "warning" : "info"}
        >
          <MessageBarBody>
            {state.recovery.message}
            {state.recovery.artifactSha256 ? (
              <span className={styles.code}>
                {" "}
                対象SHA-256: {state.recovery.artifactSha256}
              </span>
            ) : null}
          </MessageBarBody>
        </MessageBar>
      ) : null}

      {operationNotice ? (
        <MessageBar intent="info">
          <MessageBarBody>{operationNotice}</MessageBarBody>
        </MessageBar>
      ) : null}

      <TabList
        className={styles.tabs}
        selectedValue={tab}
        onTabSelect={(_, data) => setTab(data.value as PageTab)}
        aria-label="データ管理の区分"
      >
        <Tab id="data-tab-capacity" value="capacity">
          容量
        </Tab>
        <Tab id="data-tab-backup" value="backup">
          バックアップ
        </Tab>
        <Tab id="data-tab-restore" value="restore">
          復元
        </Tab>
        <Tab id="data-tab-purge" value="purge">
          明示パージ
        </Tab>
      </TabList>

      {tab === "capacity" ? (
        <CapacityPanel
          state={state.capacity}
          styles={styles}
          displayTimeZone={displayTimeZone}
        />
      ) : tab === "backup" ? (
        <BackupPanel
          state={state}
          styles={styles}
          displayTimeZone={displayTimeZone}
          maintenanceActive={maintenanceActive}
          validationMatchesBackup={validationMatchesBackup}
          onCreate={() => void createBackup()}
          onValidate={validateCreatedBackup}
          onTrial={() => void runRestoreTrial()}
          onCancel={() => void cancelOperation()}
        />
      ) : tab === "restore" ? (
        <RestorePanel
          state={state}
          hubs={hubs}
          styles={styles}
          displayTimeZone={displayTimeZone}
          restorePath={restorePath}
          maintenanceActive={maintenanceActive}
          onSelect={() => void selectRestoreArchive()}
          onValidate={() => void validateRestorePath(restorePath)}
          onTrial={() => void runRestoreTrial()}
          onApply={() => setRestoreConfirmOpen(true)}
          onCancel={() => void cancelOperation()}
        />
      ) : (
        <PurgePanel
          state={state.purge}
          hubs={hubs}
          hubNames={hubNames}
          styles={styles}
          displayTimeZone={displayTimeZone}
          draft={purgeDraft}
          maintenanceActive={maintenanceActive}
          onDraftChange={setPurgeDraft}
          onPreview={() => void previewPurge()}
          onConfirm={() => setPurgeConfirmOpen(true)}
          onCancel={() => void cancelOperation()}
        />
      )}

      <RestoreConfirmationDialog
        open={restoreConfirmOpen}
        artifact={state.restore.validation.artifact}
        onOpenChange={setRestoreConfirmOpen}
        onConfirm={() => void applyRestore()}
      />
      <PurgeConfirmationDialog
        open={purgeConfirmOpen}
        preview={state.purge.preview}
        hubNames={hubNames}
        confirmationText={purgeConfirmationText}
        onConfirmationTextChange={setPurgeConfirmationText}
        onOpenChange={setPurgeConfirmOpen}
        onConfirm={() => void applyPurge()}
        styles={styles}
      />

      {applyRunning ? (
        <RestoreOverlay
          state={state.restore.apply}
          styles={styles}
          onCancel={() => void cancelOperation()}
        />
      ) : null}
    </div>
  );
}

function CapacityPanel({
  state,
  styles,
  displayTimeZone,
}: {
  state: DataManagementCapacityResultSnapshot;
  styles: ReturnType<typeof useStyles>;
  displayTimeZone: string;
}) {
  if (state.status !== "success" || state.capacity === null) {
    return (
      <section
        role="tabpanel"
        aria-labelledby="data-tab-capacity"
        className={styles.panel}
      >
        <ErrorMessage
          error={state.error}
          fallback="容量情報を取得できませんでした。"
          styles={styles}
        />
      </section>
    );
  }
  const capacity = state.capacity;
  const items = [
    ["データベース", formatBytes(capacity.databaseSizeBytes)],
    ["原JSONスナップショット", formatCount(capacity.rawSnapshotCount)],
    ["最古の取得完了", formatTime(capacity.oldestCompletedAt, displayTimeZone)],
    ["最新の取得完了", formatTime(capacity.latestCompletedAt, displayTimeZone)],
    ["保存済み原JSON", formatBytes(capacity.rawJsonBytes)],
  ];
  return (
    <section
      role="tabpanel"
      aria-labelledby="data-tab-capacity"
      className={styles.panel}
    >
      <div className={styles.cards}>
        {items.map(([label, value]) => (
          <Card className={styles.card} key={label}>
            <Caption1 className={styles.cardLabel}>{label}</Caption1>
            <Text className={styles.value}>{value}</Text>
          </Card>
        ))}
      </div>
    </section>
  );
}

function BackupPanel({
  state,
  styles,
  displayTimeZone,
  maintenanceActive,
  validationMatchesBackup,
  onCreate,
  onValidate,
  onTrial,
  onCancel,
}: {
  state: DataManagementStateSnapshot;
  styles: ReturnType<typeof useStyles>;
  displayTimeZone: string;
  maintenanceActive: boolean;
  validationMatchesBackup: boolean;
  onCreate: () => void;
  onValidate: () => void;
  onTrial: () => void;
  onCancel: () => void;
}) {
  const backup = state.backup;
  const trial = state.restore.trial;
  return (
    <section
      role="tabpanel"
      aria-labelledby="data-tab-backup"
      className={styles.panel}
    >
      <Card className={styles.card}>
        <div className={styles.actions}>
          <Subtitle1 as="h2">バックアップ成果物</Subtitle1>
          <OperationStatusBadge status={backup.status} />
        </div>
        <Button
          appearance="primary"
          disabled={maintenanceActive}
          onClick={onCreate}
        >
          ZIPの保存先を選んで作成
        </Button>
        {backup.artifact !== null ? (
          <ArtifactDetails
            artifact={backup.artifact}
            styles={styles}
            displayTimeZone={displayTimeZone}
            showPath
          />
        ) : null}
        <ErrorMessage error={backup.error} fallback="" styles={styles} />
      </Card>

      <Card className={styles.card}>
        <div className={styles.actions}>
          <Subtitle1 as="h2">隔離復元試験</Subtitle1>
          <OperationStatusBadge status={trial.status} />
        </div>
        <Body1>
          ZIP検証と復元試験は別の操作です。空の一時環境へ復元し、主要件数と代表履歴を照合します。
        </Body1>
        <div className={styles.actions}>
          <Button
            disabled={maintenanceActive || backup.artifact === null}
            onClick={onValidate}
          >
            作成済みZIPを検証
          </Button>
          <Button
            appearance="primary"
            disabled={maintenanceActive || !validationMatchesBackup}
            onClick={onTrial}
          >
            復元試験を実行
          </Button>
          {trial.cancelAllowed ? (
            <Button onClick={onCancel}>試験をキャンセル</Button>
          ) : null}
        </div>
        <dl className={styles.metadata}>
          <dt className={styles.term}>最終試験UTC日時</dt>
          <dd className={styles.detail}>{formatUTC(trial.testedAt)}</dd>
          <dt className={styles.term}>対象SHA-256</dt>
          <dd className={`${styles.detail} ${styles.code}`}>
            {trial.artifactSha256 || "—"}
          </dd>
        </dl>
        {trial.warning ? (
          <MessageBar intent="warning">
            <MessageBarBody>{trial.warning}</MessageBarBody>
          </MessageBar>
        ) : null}
        <ErrorMessage error={trial.error} fallback="" styles={styles} />
      </Card>

      <SafetyExplanation styles={styles} />
    </section>
  );
}

function RestorePanel({
  state,
  hubs,
  styles,
  displayTimeZone,
  restorePath,
  maintenanceActive,
  onSelect,
  onValidate,
  onTrial,
  onApply,
  onCancel,
}: {
  state: DataManagementStateSnapshot;
  hubs: DataManagementHubSnapshot[];
  styles: ReturnType<typeof useStyles>;
  displayTimeZone: string;
  restorePath: string;
  maintenanceActive: boolean;
  onSelect: () => void;
  onValidate: () => void;
  onTrial: () => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const restore = state.restore;
  return (
    <section
      role="tabpanel"
      aria-labelledby="data-tab-restore"
      className={styles.panel}
    >
      <Card className={styles.card}>
        <div className={styles.actions}>
          <Subtitle1 as="h2">1. ZIPを選択して検証</Subtitle1>
          <OperationStatusBadge status={restore.validation.status} />
        </div>
        <div className={styles.actions}>
          <Button disabled={maintenanceActive} onClick={onSelect}>
            ZIPを選択
          </Button>
          <Button
            appearance="primary"
            disabled={maintenanceActive || !restorePath}
            onClick={onValidate}
          >
            ZIPを検証
          </Button>
          {restore.validation.cancelAllowed ? (
            <Button onClick={onCancel}>検証をキャンセル</Button>
          ) : null}
        </div>
        <Text className={styles.code}>
          {restorePath || "ZIPは選択されていません。"}
        </Text>
        <Body1>
          形式・版・SHA-256・SQLite整合性・参照整合性・意味制約・秘密不在・再計算可能性を個別に検証します。
        </Body1>
        {restore.validation.artifact !== null ? (
          <ArtifactDetails
            artifact={restore.validation.artifact}
            styles={styles}
            displayTimeZone={displayTimeZone}
            showPath={false}
          />
        ) : null}
        <ErrorMessage
          error={restore.validation.error}
          fallback=""
          styles={styles}
        />
      </Card>

      <Card className={styles.card}>
        <div className={styles.actions}>
          <Subtitle1 as="h2">2. 隔離復元試験</Subtitle1>
          <OperationStatusBadge status={restore.trial.status} />
        </div>
        <Body1>
          検証済み成果物を専用の空環境へ復元し、論理内容を照合します。
        </Body1>
        <div className={styles.actions}>
          <Button
            disabled={maintenanceActive || !restore.validation.operationId}
            onClick={onTrial}
          >
            復元試験を実行
          </Button>
          {restore.trial.cancelAllowed ? (
            <Button onClick={onCancel}>試験をキャンセル</Button>
          ) : null}
        </div>
        <dl className={styles.metadata}>
          <dt className={styles.term}>最終試験UTC日時</dt>
          <dd className={styles.detail}>{formatUTC(restore.trial.testedAt)}</dd>
          <dt className={styles.term}>対象SHA-256</dt>
          <dd className={`${styles.detail} ${styles.code}`}>
            {restore.trial.artifactSha256 || "—"}
          </dd>
        </dl>
        <ErrorMessage error={restore.trial.error} fallback="" styles={styles} />
      </Card>

      <Card className={styles.card}>
        <div className={styles.actions}>
          <Subtitle1 as="h2">3. 現在のデータベースを置き換える</Subtitle1>
          <OperationStatusBadge status={restore.apply.status} />
        </div>
        <MessageBar intent="warning">
          <MessageBarBody>
            適用すると現在のローカル正本を置き換えます。取消要求が有効なのは原子的入替えの開始前だけで、開始後は安全のため完遂します。
          </MessageBarBody>
        </MessageBar>
        <Button
          appearance="primary"
          disabled={maintenanceActive || !restore.validation.applyAllowed}
          onClick={onApply}
        >
          最終確認へ
        </Button>
        <ErrorMessage error={restore.apply.error} fallback="" styles={styles} />
        {restore.apply.status === "success" ? (
          <RestoreSuccess
            state={restore.apply}
            hubs={hubs}
            styles={styles}
            displayTimeZone={displayTimeZone}
          />
        ) : null}
      </Card>

      <Card className={styles.card}>
        <Subtitle1 as="h2">復旧目標の考え方</Subtitle1>
        <Body1>
          RPOは、暗号化された端末外保存先へコピーされ、隔離復元試験に合格した最後のバックアップ時点です。
        </Body1>
        <Body1>
          環境とデータ量で所要時間が変わるため、固定のRTO（復旧時間目標）は示しません。
        </Body1>
      </Card>
    </section>
  );
}

function PurgePanel({
  state,
  hubs,
  hubNames,
  styles,
  displayTimeZone,
  draft,
  maintenanceActive,
  onDraftChange,
  onPreview,
  onConfirm,
  onCancel,
}: {
  state: DataManagementPurgeStateSnapshot;
  hubs: DataManagementHubSnapshot[];
  hubNames: Map<string, string>;
  styles: ReturnType<typeof useStyles>;
  displayTimeZone: string;
  draft: PurgeDraft;
  maintenanceActive: boolean;
  onDraftChange: React.Dispatch<React.SetStateAction<PurgeDraft>>;
  onPreview: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const hasTarget = draft.allHubs || draft.hubIds.length > 0;
  return (
    <section
      role="tabpanel"
      aria-labelledby="data-tab-purge"
      className={styles.panel}
    >
      <Card className={styles.card}>
        <div className={styles.actions}>
          <Subtitle1 as="h2">対象を指定</Subtitle1>
          <OperationStatusBadge status={state.status} />
        </div>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            onPreview();
          }}
        >
          <Checkbox
            checked={draft.allHubs}
            label="全Hubを明示的に選択"
            disabled={maintenanceActive}
            onChange={(_, data) =>
              onDraftChange((current) => ({
                ...current,
                allHubs: data.checked === true,
              }))
            }
          />
          {hubs.length === 0 ? (
            <Body1>選択できるHubはありません。</Body1>
          ) : (
            <div className={styles.hubList} aria-label="パージ対象Hub">
              {hubs.map((hub) => (
                <div className={styles.longListItem} key={hub.id}>
                  <Checkbox
                    checked={draft.hubIds.includes(hub.id)}
                    disabled={maintenanceActive || draft.allHubs}
                    label={`${hub.displayName}（${hub.id}）`}
                    onChange={(_, data) =>
                      onDraftChange((current) => ({
                        ...current,
                        hubIds:
                          data.checked === true
                            ? Array.from(new Set([...current.hubIds, hub.id]))
                            : current.hubIds.filter((id) => id !== hub.id),
                      }))
                    }
                  />
                </div>
              ))}
            </div>
          )}
          <div className={styles.formGrid}>
            <div className={styles.form}>
              <Checkbox
                checked={draft.omitStart}
                label="開始なし"
                disabled={maintenanceActive}
                onChange={(_, data) =>
                  onDraftChange((current) => ({
                    ...current,
                    omitStart: data.checked === true,
                  }))
                }
              />
              {draft.omitStart ? null : (
                <Field label="開始日時（UTC・含む）">
                  <Input
                    type="datetime-local"
                    value={draft.startAt}
                    disabled={maintenanceActive}
                    onChange={(_, data) =>
                      onDraftChange((current) => ({
                        ...current,
                        startAt: data.value,
                      }))
                    }
                  />
                </Field>
              )}
            </div>
            <div className={styles.form}>
              <Checkbox
                checked={draft.omitEnd}
                label="終了なし"
                disabled={maintenanceActive}
                onChange={(_, data) =>
                  onDraftChange((current) => ({
                    ...current,
                    omitEnd: data.checked === true,
                  }))
                }
              />
              {draft.omitEnd ? null : (
                <Field label="終了日時（UTC・含まない）">
                  <Input
                    type="datetime-local"
                    value={draft.endAt}
                    disabled={maintenanceActive}
                    onChange={(_, data) =>
                      onDraftChange((current) => ({
                        ...current,
                        endAt: data.value,
                      }))
                    }
                  />
                </Field>
              )}
            </div>
          </div>
          <div className={styles.actions}>
            <Button
              appearance="primary"
              type="submit"
              disabled={maintenanceActive || !hasTarget}
            >
              削減見込みをプレビュー
            </Button>
            {state.cancelAllowed ? (
              <Button type="button" onClick={onCancel}>
                プレビューをキャンセル
              </Button>
            ) : null}
          </div>
        </form>
      </Card>

      {state.preview !== null ? (
        <PurgePreview
          preview={state.preview}
          hubNames={hubNames}
          styles={styles}
          displayTimeZone={displayTimeZone}
          maintenanceActive={maintenanceActive}
          onConfirm={onConfirm}
        />
      ) : null}
      <ErrorMessage error={state.error} fallback="" styles={styles} />
      {state.status === "success" && state.result !== null ? (
        <PurgeSuccess
          result={state.result}
          styles={styles}
          displayTimeZone={displayTimeZone}
        />
      ) : null}
    </section>
  );
}

function OperationStatusBadge({ status }: { status: string }) {
  const presentation = operationStatus(status);
  const icon =
    presentation.kind === "success" ? (
      <CheckmarkCircle16Regular />
    ) : presentation.kind === "error" ? (
      <ErrorCircle16Regular />
    ) : presentation.kind === "working" ? (
      <ArrowSync16Regular />
    ) : presentation.kind === "warning" ? (
      <Warning16Regular />
    ) : (
      <Info16Regular />
    );
  const color =
    presentation.kind === "success"
      ? "success"
      : presentation.kind === "error"
        ? "danger"
        : presentation.kind === "warning"
          ? "warning"
          : "informative";
  return (
    <Tooltip content={presentation.description} relationship="description">
      <Badge appearance="tint" color={color} icon={icon}>
        {presentation.label}
      </Badge>
    </Tooltip>
  );
}

function ArtifactDetails({
  artifact,
  styles,
  displayTimeZone,
  showPath,
}: {
  artifact: DataManagementArtifactSnapshot;
  styles: ReturnType<typeof useStyles>;
  displayTimeZone: string;
  showPath: boolean;
}) {
  const rows = [
    ...(showPath ? [["保存先", artifact.path || "—"]] : []),
    ["作成日時", formatTime(artifact.createdAt, displayTimeZone)],
    [
      "形式版",
      artifact.formatVersion > 0 ? String(artifact.formatVersion) : "—",
    ],
    [
      "スキーマ版",
      artifact.schemaVersion > 0 ? String(artifact.schemaVersion) : "—",
    ],
    ["アプリ版", artifact.appVersion || "—"],
    ["サイズ", artifact.sizeBytes > 0 ? formatBytes(artifact.sizeBytes) : "—"],
    ["SHA-256", artifact.artifactSha256 || "—"],
    ["検証結果", "検証済み"],
  ];
  return (
    <>
      <dl className={styles.metadata}>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className={styles.term}>{label}</dt>
            <dd
              className={`${styles.detail} ${label === "SHA-256" || label === "保存先" ? styles.code : ""}`}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {artifact.warning ? (
        <MessageBar intent="warning">
          <MessageBarBody>{artifact.warning}</MessageBarBody>
        </MessageBar>
      ) : null}
    </>
  );
}

function SafetyExplanation({
  styles,
}: {
  styles: ReturnType<typeof useStyles>;
}) {
  return (
    <Card className={styles.card}>
      <Subtitle1 as="h2">成果物の安全上の注意</Subtitle1>
      <ul className={styles.safetyList}>
        <li>
          Windows Credential
          Managerの資格情報や共有秘密は含みません。復元後は全Hubで資格情報の再登録が必要です。
        </li>
        <li>
          原JSON、アカウント識別情報、利用履歴を含む未暗号化の機微データです。
        </li>
        <li>
          暗号化された端末外保存先へ利用者がコピーしてください。アプリは外部転送しません。
        </li>
        <li>
          同じ端末または同じ媒体だけの保存では、十分な復旧手段になりません。
        </li>
      </ul>
    </Card>
  );
}

function RestoreSuccess({
  state,
  hubs,
  styles,
  displayTimeZone,
}: {
  state: DataManagementRestoreApplyStateSnapshot;
  hubs: DataManagementHubSnapshot[];
  styles: ReturnType<typeof useStyles>;
  displayTimeZone: string;
}) {
  return (
    <div className={styles.panel}>
      <MessageBar intent="success">
        <MessageBarBody>
          復元が成功しました。資格情報は復元されず、収集は再開していません。
        </MessageBarBody>
      </MessageBar>
      <dl className={styles.metadata}>
        <dt className={styles.term}>復元日時</dt>
        <dd className={styles.detail}>
          {formatTime(state.restoredAt, displayTimeZone)}
        </dd>
        <dt className={styles.term}>資格情報状態</dt>
        <dd className={styles.detail}>
          {presentStatus(state.credentialState).label}
        </dd>
        <dt className={styles.term}>監査記録</dt>
        <dd className={styles.detail}>
          {state.auditId ? (
            <Link to={`/audit?auditId=${encodeURIComponent(state.auditId)}`}>
              復元監査記録を開く
            </Link>
          ) : (
            "—"
          )}
        </dd>
      </dl>
      <Subtitle1 as="h3">資格情報の再登録が必要なHub</Subtitle1>
      {hubs.length === 0 ? (
        <Body1>復元済みHubはありません。</Body1>
      ) : (
        <ul className={styles.safetyList} aria-label="復元後再登録待ちのHub">
          {hubs.map((hub) => (
            <li className={styles.longListItem} key={hub.id}>
              {hub.displayName}（{hub.id}）:{" "}
              {presentStatus(hub.credentialState).label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PurgePreview({
  preview,
  hubNames,
  styles,
  displayTimeZone,
  maintenanceActive,
  onConfirm,
}: {
  preview: DataManagementPurgePreviewSnapshot;
  hubNames: Map<string, string>;
  styles: ReturnType<typeof useStyles>;
  displayTimeZone: string;
  maintenanceActive: boolean;
  onConfirm: () => void;
}) {
  return (
    <Card className={styles.card}>
      <Subtitle1 as="h2">パージのプレビュー</Subtitle1>
      <dl className={styles.metadata}>
        <dt className={styles.term}>対象Hub</dt>
        <dd className={styles.detail}>
          {formatSelectedHubs(preview.selection, hubNames)}
        </dd>
        <dt className={styles.term}>対象期間</dt>
        <dd className={styles.detail}>
          {formatRange(preview.selection, displayTimeZone)}
        </dd>
        <dt className={styles.term}>原JSONスナップショット</dt>
        <dd className={styles.detail}>
          {formatCount(preview.capacity.rawSnapshotCount)}
        </dd>
        <dt className={styles.term}>最古の取得完了</dt>
        <dd className={styles.detail}>
          {formatTime(preview.capacity.oldestCompletedAt, displayTimeZone)}
        </dd>
        <dt className={styles.term}>最新の取得完了</dt>
        <dd className={styles.detail}>
          {formatTime(preview.capacity.latestCompletedAt, displayTimeZone)}
        </dd>
        <dt className={styles.term}>論理削減見込み</dt>
        <dd className={styles.detail}>
          {formatBytes(preview.capacity.rawJsonBytes)}
        </dd>
      </dl>
      <MessageBar intent="warning">
        <MessageBarBody>
          原JSON全体と、それだけを根拠とする元観測・派生結果を不可逆に削除します。Hub、カタログ、論理アカウント、関連付け、プラン履歴、設定変更監査履歴は保持します。
        </MessageBarBody>
      </MessageBar>
      <Body1>
        論理削減見込みは、SQLiteファイルが直ちに同じバイト数だけ縮小する保証ではありません。
      </Body1>
      <Body1>
        削除トランザクションの開始後はキャンセルできません。削除と再計算の両方がコミットされた場合だけ成功します。
      </Body1>
      <Button
        appearance="primary"
        disabled={maintenanceActive}
        onClick={onConfirm}
      >
        最終確認へ
      </Button>
    </Card>
  );
}

function PurgeSuccess({
  result,
  styles,
  displayTimeZone,
}: {
  result: DataManagementPurgeResultSnapshot;
  styles: ReturnType<typeof useStyles>;
  displayTimeZone: string;
}) {
  return (
    <Card className={styles.card}>
      <MessageBar intent="success">
        <MessageBarBody>パージと再計算をコミットしました。</MessageBarBody>
      </MessageBar>
      <dl className={styles.metadata}>
        <dt className={styles.term}>完了日時</dt>
        <dd className={styles.detail}>
          {formatTime(result.executedAt, displayTimeZone)}
        </dd>
        <dt className={styles.term}>削除した原JSON</dt>
        <dd className={styles.detail}>
          {formatCount(result.rawSnapshotCount)}
        </dd>
        <dt className={styles.term}>再計算した推定結果</dt>
        <dd className={styles.detail}>
          {formatCount(result.recalculatedResultCount)}
        </dd>
        <dt className={styles.term}>監査記録</dt>
        <dd className={styles.detail}>
          {result.auditId ? (
            <Link to={`/audit?auditId=${encodeURIComponent(result.auditId)}`}>
              パージ監査記録を開く
            </Link>
          ) : (
            "—"
          )}
        </dd>
      </dl>
    </Card>
  );
}

function RestoreConfirmationDialog({
  open,
  artifact,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  artifact: DataManagementArtifactSnapshot | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>復元を適用する最終確認</DialogTitle>
          <DialogContent>
            <Body1>
              現在のローカルデータベースを検証済み成果物で置き換えます。
            </Body1>
            <Body1>対象SHA-256: {artifact?.artifactSha256 || "—"}</Body1>
            <Body1>
              取消要求は原子的入替えの開始前だけ有効です。開始後は安全のため完遂します。
            </Body1>
            <Body1>
              復元後は全Hubの資格情報を再登録し、接続確認を行うまで収集を再開しません。
            </Body1>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>
              戻る
            </Button>
            <Button appearance="primary" onClick={onConfirm}>
              現在のデータを置き換える
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function PurgeConfirmationDialog({
  open,
  preview,
  hubNames,
  confirmationText,
  onConfirmationTextChange,
  onOpenChange,
  onConfirm,
  styles,
}: {
  open: boolean;
  preview: DataManagementPurgePreviewSnapshot | null;
  hubNames: Map<string, string>;
  confirmationText: string;
  onConfirmationTextChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  styles: ReturnType<typeof useStyles>;
}) {
  const requiredText = preview?.requiredConfirmationText ?? "";
  const confirmed = requiredText === "" || confirmationText === requiredText;
  return (
    <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>明示パージの最終確認</DialogTitle>
          <DialogContent className={styles.dialogContent}>
            {preview !== null ? (
              <>
                <Body1>
                  対象Hub: {formatSelectedHubs(preview.selection, hubNames)}
                </Body1>
                <Body1>対象期間: {formatRange(preview.selection, "UTC")}</Body1>
                <Body1>
                  原JSONスナップショット:{" "}
                  {formatCount(preview.capacity.rawSnapshotCount)}
                </Body1>
                <Body1>
                  論理削減見込み: {formatBytes(preview.capacity.rawJsonBytes)}
                </Body1>
              </>
            ) : null}
            <MessageBar intent="warning">
              <MessageBarBody>
                この削除は不可逆です。削除トランザクション開始後はキャンセルできません。
              </MessageBarBody>
            </MessageBar>
            <Body1>
              Hub、カタログ、論理アカウント、関連付け、プラン履歴、設定変更監査履歴は保持します。
            </Body1>
            {requiredText ? (
              <Field label={`確認語句「${requiredText}」を正確に入力`}>
                <Input
                  value={confirmationText}
                  onChange={(_, data) => onConfirmationTextChange(data.value)}
                  autoComplete="off"
                />
              </Field>
            ) : null}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>
              戻る
            </Button>
            <Button
              appearance="primary"
              disabled={!confirmed || preview === null}
              onClick={onConfirm}
            >
              パージと再計算を実行
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function RestoreOverlay({
  state,
  styles,
  onCancel,
}: {
  state: DataManagementRestoreApplyStateSnapshot;
  styles: ReturnType<typeof useStyles>;
  onCancel: () => void;
}) {
  return (
    <div
      className={`${styles.overlay} ${styles.forcedColorBoundary}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="restore-overlay-title"
    >
      <div className={styles.overlayContent}>
        <Spinner label="復元中" />
        <Subtitle1 as="h2" id="restore-overlay-title">
          復元中
        </Subtitle1>
        <Body1>
          M00の収集・編集・パージ・復元操作とウィンドウを閉じる操作を停止しています。
        </Body1>
        <Body1>
          入替前のみ取消できます。原子的入替え開始後は安全のため処理を完遂します。
        </Body1>
        {state.cancelAllowed ? (
          <Button onClick={onCancel}>入替前の取消を要求</Button>
        ) : (
          <Body1>現在の段階では取消できません。完了までお待ちください。</Body1>
        )}
      </div>
    </div>
  );
}

function ErrorMessage({
  error,
  fallback,
  styles,
}: {
  error: DataManagementErrorSnapshot | null;
  fallback: string;
  styles: ReturnType<typeof useStyles>;
}) {
  if (error === null && !fallback) return null;
  return (
    <MessageBar intent="error">
      <MessageBarBody>
        {error?.message || fallback}
        {error?.rolledBack ? <div>変更はロールバック済みです。</div> : null}
        {error?.currentDataUnchanged ? (
          <div>現在のローカル正本は変更されていません。</div>
        ) : null}
        {error !== null && (error.details?.length ?? 0) > 0 ? (
          <ul className={styles.safetyList}>
            {(error.details ?? []).map((detail) => (
              <li className={styles.longListItem} key={detail}>
                {detail}
              </li>
            ))}
          </ul>
        ) : null}
      </MessageBarBody>
    </MessageBar>
  );
}

function operationStatus(status: string): {
  label: string;
  description: string;
  kind: "info" | "working" | "success" | "warning" | "error";
} {
  switch (status) {
    case "creating":
      return {
        label: "作成中",
        description: "バックアップZIPを作成しています。",
        kind: "working",
      };
    case "validating":
      return {
        label: "検証中",
        description: "成果物を読み直して検証しています。",
        kind: "working",
      };
    case "previewing":
      return {
        label: "プレビュー中",
        description: "削除対象と削減見込みを確認しています。",
        kind: "working",
      };
    case "ready":
      return {
        label: "確認待ち",
        description: "プレビューが完了し、最終確認を待っています。",
        kind: "warning",
      };
    case "applying":
      return {
        label: "処理中",
        description: "保守操作を適用しています。",
        kind: "working",
      };
    case "running":
      return {
        label: "試験中",
        description: "隔離環境で復元試験を実行しています。",
        kind: "working",
      };
    case "passed":
      return {
        label: "合格",
        description: "隔離復元試験に合格しました。",
        kind: "success",
      };
    case "success":
      return {
        label: "成功",
        description: "操作が完了しました。",
        kind: "success",
      };
    case "failed":
      return {
        label: "失敗",
        description: "操作に失敗しました。理由を確認してください。",
        kind: "error",
      };
    case "not_run":
      return {
        label: "未実施",
        description: "操作はまだ実行されていません。",
        kind: "info",
      };
    default:
      return {
        label: status || "不明",
        description: "未定義の状態です。",
        kind: "warning",
      };
  }
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${new Intl.NumberFormat("ja-JP").format(value)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let unit = "B";
  for (const candidate of units) {
    amount /= 1024;
    unit = candidate;
    if (amount < 1024) break;
  }
  return `${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 }).format(amount)} ${unit}`;
}

function formatCount(value: number): string {
  return Number.isFinite(value)
    ? new Intl.NumberFormat("ja-JP").format(value)
    : "—";
}

function formatTime(value: string, displayTimeZone: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日時不明";
  try {
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: displayTimeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  } catch {
    return "日時不明";
  }
}

function formatUTC(value: string): string {
  if (!value) return "—";
  const formatted = formatTime(value, "UTC");
  return formatted === "日時不明" ? formatted : `${formatted} UTC`;
}

function toUTC(value: string): string {
  if (!value) return "";
  const date = new Date(`${value}:00Z`);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function formatRange(
  selection: DataManagementPurgeSelectionSnapshot,
  displayTimeZone: string,
): string {
  const start = selection.startAt
    ? formatTime(selection.startAt, displayTimeZone)
    : "開始なし";
  const end = selection.endAt
    ? formatTime(selection.endAt, displayTimeZone)
    : "終了なし";
  return `[${start}, ${end})`;
}

function formatSelectedHubs(
  selection: DataManagementPurgeSelectionSnapshot,
  hubNames: Map<string, string>,
): string {
  if (selection.allHubs) return "全Hub";
  const hubIds = selection.hubIds ?? [];
  if (hubIds.length === 0) return "対象なし";
  return hubIds
    .map((id) => `${hubNames.get(id) ?? "表示名不明"}（${id}）`)
    .join("、");
}

function inputFromPreview(
  preview: DataManagementPurgePreviewSnapshot,
  confirmationText: string,
): DataManagementPurgeSelectionInput {
  return {
    allHubs: preview.selection.allHubs,
    hubIds: [...(preview.selection.hubIds ?? [])],
    startAt: preview.selection.startAt,
    endAt: preview.selection.endAt,
    confirmationText,
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
