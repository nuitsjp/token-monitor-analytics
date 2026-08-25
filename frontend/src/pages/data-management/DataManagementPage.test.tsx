import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import type { PropsWithChildren } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DataManagementPage,
  type DataManagementArtifactSnapshot,
  type DataManagementBackupStateSnapshot,
  type DataManagementCancellationSnapshot,
  type DataManagementHubSnapshot,
  type DataManagementPageBackend,
  type DataManagementPurgeSelectionInput,
  type DataManagementPurgeStateSnapshot,
  type DataManagementRestoreApplyStateSnapshot,
  type DataManagementRestoreTrialStateSnapshot,
  type DataManagementRestoreValidationStateSnapshot,
  type DataManagementStateSnapshot,
} from "./DataManagementPage";

const dialogMocks = vi.hoisted(() => ({
  saveFile: vi.fn(),
  openFile: vi.fn(),
}));

vi.mock("@wailsio/runtime", () => ({
  Dialogs: {
    SaveFile: dialogMocks.saveFile,
    OpenFile: dialogMocks.openFile,
  },
}));

vi.mock("@fluentui/react-components", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@fluentui/react-components")>();
  return {
    ...actual,
    Dialog: ({ open, children }: PropsWithChildren<{ open?: boolean }>) =>
      open ? <>{children}</> : null,
    DialogSurface: ({ children }: PropsWithChildren) => (
      <div role="dialog" aria-label="確認ダイアログ">
        {children}
      </div>
    ),
    DialogBody: ({ children }: PropsWithChildren) => <div>{children}</div>,
    DialogTitle: ({ children }: PropsWithChildren) => <h2>{children}</h2>,
    DialogContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
    DialogActions: ({ children }: PropsWithChildren) => <div>{children}</div>,
  };
});

vi.mock("keyborg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("keyborg")>();
  return {
    ...actual,
    createKeyborg: () => ({
      isNavigatingWithKeyboard: () => true,
      subscribe: () => undefined,
      unsubscribe: () => undefined,
      setVal: () => undefined,
    }),
    disposeKeyborg: () => undefined,
  };
});

const sha = "a".repeat(64);
const createdAt = "2026-08-26T01:02:03Z";
const fullPurgePhrase = "すべてのHubの全期間データをパージする";

const artifact: DataManagementArtifactSnapshot = {
  path: "D:\\backup\\token-monitor.zip",
  artifactSha256: sha,
  sizeBytes: 4096,
  formatVersion: 1,
  schemaVersion: 13,
  appVersion: "1.2.3",
  createdAt,
  warning: "監査記録の保存に失敗しました。",
};

const hub: DataManagementHubSnapshot = {
  id: "hub-1",
  displayName: "東京 Hub",
  url: "https://hub.example.test",
  enabled: true,
  collectionEnabled: false,
  collectionIntervalSeconds: 300,
  apiContract: "schema=1",
  credentialState: "post_restore_pending",
  credentialReady: false,
  connectionState: "not_checked",
  connectionCheckedAt: "",
  connectionFailureNote: "",
};

function baseState(): DataManagementStateSnapshot {
  return {
    capacity: {
      status: "success",
      capacity: {
        databaseSizeBytes: 10_485_760,
        rawSnapshotCount: 1_234,
        oldestCompletedAt: "2026-08-01T00:00:00Z",
        latestCompletedAt: "2026-08-26T00:00:00Z",
        rawJsonBytes: 2_048,
      },
      error: null,
    },
    purge: {
      status: "not_run",
      cancelAllowed: false,
      preview: null,
      result: null,
      error: null,
    },
    backup: {
      status: "not_run",
      cancelAllowed: false,
      artifact: null,
      error: null,
    },
    restore: {
      validation: {
        status: "not_run",
        cancelAllowed: false,
        applyAllowed: false,
        operationId: "",
        artifact: null,
        error: null,
      },
      trial: {
        status: "not_run",
        cancelAllowed: false,
        artifactSha256: "",
        testedAt: "",
        warning: "",
        error: null,
      },
      apply: {
        status: "not_run",
        phase: "",
        cancelAllowed: false,
        cancellationBoundary: "none",
        operationId: "",
        artifact: null,
        restoredAt: "",
        auditId: "",
        rollbackSucceeded: false,
        warning: "",
        credentialState: "",
        requiresCredentialReregistration: false,
        error: null,
      },
    },
    recovery: {
      status: "none",
      artifactSha256: "",
      message: "起動時に回復が必要な復元はありません。",
    },
    maintenance: {
      active: false,
      operation: "",
      phase: "",
      cancelAllowed: false,
      cancellationBoundary: "none",
    },
  };
}

interface FakeBackend extends DataManagementPageBackend {
  getDataManagementState: ReturnType<
    typeof vi.fn<DataManagementPageBackend["getDataManagementState"]>
  >;
  getHubs: ReturnType<typeof vi.fn<DataManagementPageBackend["getHubs"]>>;
  createBackup: ReturnType<
    typeof vi.fn<DataManagementPageBackend["createBackup"]>
  >;
  validateRestore: ReturnType<
    typeof vi.fn<DataManagementPageBackend["validateRestore"]>
  >;
  runRestoreTrial: ReturnType<
    typeof vi.fn<DataManagementPageBackend["runRestoreTrial"]>
  >;
  applyRestore: ReturnType<
    typeof vi.fn<DataManagementPageBackend["applyRestore"]>
  >;
  previewPurge: ReturnType<
    typeof vi.fn<DataManagementPageBackend["previewPurge"]>
  >;
  applyPurge: ReturnType<typeof vi.fn<DataManagementPageBackend["applyPurge"]>>;
  cancelCurrentOperation: ReturnType<
    typeof vi.fn<DataManagementPageBackend["cancelCurrentOperation"]>
  >;
}

function fakeBackend(
  initial = baseState(),
  hubs = [hub],
): {
  backend: FakeBackend;
  current: () => DataManagementStateSnapshot;
  setCurrent: (value: DataManagementStateSnapshot) => void;
} {
  let current = initial;
  const successCancellation: DataManagementCancellationSnapshot = {
    status: "cancellation_requested",
    phase: "restore_apply",
    cancelAllowed: false,
    cancellationBoundary: "before_atomic_replace_only",
    message:
      "入替え開始前なら復元を取り消します。入替え開始後は安全のため処理を完遂します。",
    error: null,
  };
  const backend: FakeBackend = {
    getDataManagementState: vi.fn(async () => current),
    getHubs: vi.fn(async () => hubs),
    createBackup: vi.fn(async () => current.backup),
    validateRestore: vi.fn(async () => current.restore.validation),
    runRestoreTrial: vi.fn(async () => current.restore.trial),
    applyRestore: vi.fn(async () => current.restore.apply),
    previewPurge: vi.fn(async () => current.purge),
    applyPurge: vi.fn(async () => current.purge),
    cancelCurrentOperation: vi.fn(async () => successCancellation),
  };
  return {
    backend,
    current: () => current,
    setCurrent: (value) => {
      current = value;
    },
  };
}

function renderPage(backend: DataManagementPageBackend, pollIntervalMs = 10) {
  return render(
    <MemoryRouter>
      <main>
        <DataManagementPage
          backend={backend}
          displayTimeZone="Asia/Tokyo"
          pollIntervalMs={pollIntervalMs}
        />
      </main>
    </MemoryRouter>,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  dialogMocks.saveFile.mockReset();
  dialogMocks.openFile.mockReset();
});

describe("DataManagementPage", () => {
  it("loads capacity and hubs in parallel and shows all five capacity facts without automatic deletion warnings", async () => {
    const stateRequest = deferred<DataManagementStateSnapshot>();
    const hubsRequest = deferred<DataManagementHubSnapshot[]>();
    const fake = fakeBackend();
    fake.backend.getDataManagementState.mockReturnValueOnce(
      stateRequest.promise,
    );
    fake.backend.getHubs.mockReturnValueOnce(hubsRequest.promise);

    renderPage(fake.backend);

    expect(fake.backend.getDataManagementState).toHaveBeenCalledOnce();
    expect(fake.backend.getHubs).toHaveBeenCalledOnce();
    act(() => {
      stateRequest.resolve(baseState());
      hubsRequest.resolve([hub]);
    });

    expect(await screen.findByText("10 MiB")).toBeVisible();
    expect(screen.getByText("1,234")).toBeVisible();
    expect(screen.getByText("2026/8/1 9:00")).toBeVisible();
    expect(screen.getByText("2026/8/26 9:00")).toBeVisible();
    expect(screen.getByText("2 KiB")).toBeVisible();
    expect(screen.queryByText(/自動削除|任意閾値/)).not.toBeInTheDocument();
  });

  it("uses SaveFile and exposes creating then validating through polling before publishing the artifact", async () => {
    const user = userEvent.setup();
    const fake = fakeBackend();
    const backupRequest = deferred<DataManagementBackupStateSnapshot>();
    dialogMocks.saveFile.mockResolvedValue(artifact.path);
    fake.backend.createBackup.mockReturnValue(backupRequest.promise);

    renderPage(fake.backend);
    await user.click(await screen.findByRole("tab", { name: "バックアップ" }));
    await user.click(
      screen.getByRole("button", { name: "ZIPの保存先を選んで作成" }),
    );

    expect(dialogMocks.saveFile).toHaveBeenCalledWith(
      expect.objectContaining({
        Filename: "token-monitor-backup.zip",
        Filters: [{ DisplayName: "ZIPバックアップ", Pattern: "*.zip" }],
      }),
    );
    expect(await screen.findByText("作成中")).toBeVisible();

    const validating: DataManagementStateSnapshot = {
      ...fake.current(),
      backup: {
        status: "validating",
        cancelAllowed: false,
        artifact: null,
        error: null,
      },
      maintenance: {
        active: true,
        operation: "backup",
        phase: "backup_create",
        cancelAllowed: false,
        cancellationBoundary: "none",
      },
    };
    fake.setCurrent(validating);
    expect(await screen.findByText("検証中")).toBeVisible();

    const success: DataManagementBackupStateSnapshot = {
      status: "success",
      cancelAllowed: false,
      artifact,
      error: null,
    };
    fake.setCurrent({
      ...validating,
      backup: success,
      maintenance: baseState().maintenance,
    });
    act(() => backupRequest.resolve(success));

    expect(await screen.findByText(artifact.path)).toBeVisible();
    expect(screen.getByText(sha)).toBeVisible();
    expect(screen.getByText("監査記録の保存に失敗しました。")).toBeVisible();
    expect(screen.getByText(/資格情報や共有秘密は含みません/)).toBeVisible();
    expect(screen.getByText(/未暗号化の機微データ/)).toBeVisible();
    expect(screen.getByText(/暗号化された端末外保存先/)).toBeVisible();
    expect(screen.getByText(/同じ端末または同じ媒体/)).toBeVisible();
  });

  it("keeps ZIP validation, isolated trial, and confirmed restore separate while overlaying M00 and supporting pre-replace cancellation", async () => {
    const user = userEvent.setup();
    const fake = fakeBackend();
    const applyRequest = deferred<DataManagementRestoreApplyStateSnapshot>();
    dialogMocks.openFile.mockResolvedValue("D:\\restore\\candidate.zip");

    const validation: DataManagementRestoreValidationStateSnapshot = {
      status: "success",
      cancelAllowed: false,
      applyAllowed: true,
      operationId: "operation-random-1",
      artifact: { ...artifact, path: "", appVersion: "", sizeBytes: 0 },
      error: null,
    };
    fake.backend.validateRestore.mockImplementation(async () => {
      fake.setCurrent({
        ...fake.current(),
        restore: { ...fake.current().restore, validation },
      });
      return validation;
    });
    const trial: DataManagementRestoreTrialStateSnapshot = {
      status: "passed",
      cancelAllowed: false,
      artifactSha256: sha,
      testedAt: "2026-08-26T02:03:04Z",
      warning: "",
      error: null,
    };
    fake.backend.runRestoreTrial.mockImplementation(async () => {
      fake.setCurrent({
        ...fake.current(),
        restore: { ...fake.current().restore, trial },
      });
      return trial;
    });
    fake.backend.applyRestore.mockImplementation(() => {
      const applying: DataManagementRestoreApplyStateSnapshot = {
        ...fake.current().restore.apply,
        status: "applying",
        phase: "restore_apply",
        cancelAllowed: true,
        cancellationBoundary: "before_atomic_replace_only",
        operationId: "operation-random-1",
      };
      fake.setCurrent({
        ...fake.current(),
        restore: { ...fake.current().restore, apply: applying },
        maintenance: {
          active: true,
          operation: "restore",
          phase: "restore_apply",
          cancelAllowed: true,
          cancellationBoundary: "before_atomic_replace_only",
        },
      });
      return applyRequest.promise;
    });

    renderPage(fake.backend);
    await user.click(await screen.findByRole("tab", { name: "復元" }));
    await user.click(screen.getByRole("button", { name: "ZIPを選択" }));
    expect(dialogMocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        AllowsMultipleSelection: false,
        Filters: [{ DisplayName: "ZIPバックアップ", Pattern: "*.zip" }],
      }),
    );
    expect(screen.getByText("D:\\restore\\candidate.zip")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "ZIPを検証" }));
    await waitFor(() =>
      expect(fake.backend.validateRestore).toHaveBeenCalledWith(
        "D:\\restore\\candidate.zip",
      ),
    );
    expect(await screen.findByText("検証済み")).toBeVisible();
    expect(screen.getByText("アプリ版").parentElement).toHaveTextContent("—");

    await user.click(screen.getByRole("button", { name: "復元試験を実行" }));
    expect(fake.backend.runRestoreTrial).toHaveBeenCalledWith(
      "operation-random-1",
    );
    expect(await screen.findByText("合格")).toBeVisible();
    expect(screen.getByText("2026/8/26 2:03 UTC")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "最終確認へ" }));
    expect(
      screen.getByRole("dialog", { name: "確認ダイアログ" }),
    ).toBeVisible();
    expect(screen.getByText("復元を適用する最終確認")).toBeVisible();
    expect(
      screen.getByText(
        /現在のローカルデータベースを検証済み成果物で置き換えます/,
      ),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "現在のデータを置き換える" }),
    );

    expect(await screen.findByRole("dialog", { name: "復元中" })).toBeVisible();
    expect(screen.getByText(/入替前のみ取消できます/)).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "入替前の取消を要求" }),
    );
    expect(fake.backend.cancelCurrentOperation).toHaveBeenCalledOnce();
    expect(
      await screen.findByText(/入替え開始前なら復元を取り消します/),
    ).toBeVisible();

    const applied: DataManagementRestoreApplyStateSnapshot = {
      status: "success",
      phase: "completed",
      cancelAllowed: false,
      cancellationBoundary: "before_atomic_replace_only",
      operationId: "operation-random-1",
      artifact,
      restoredAt: "2026-08-26T03:04:05Z",
      auditId: "audit-restore-1",
      rollbackSucceeded: false,
      warning: "",
      credentialState: "post_restore_pending",
      requiresCredentialReregistration: true,
      error: null,
    };
    fake.setCurrent({
      ...fake.current(),
      restore: { ...fake.current().restore, apply: applied },
      maintenance: baseState().maintenance,
    });
    act(() => applyRequest.resolve(applied));

    expect(
      await screen.findByText(/資格情報は復元されず、収集は再開していません/),
    ).toBeVisible();
    expect(screen.getByText("復元後再登録待ち")).toBeVisible();
    expect(screen.getByText(/東京 Hub（hub-1）/)).toBeVisible();
    expect(
      screen.getByRole("link", { name: "復元監査記録を開く" }),
    ).toHaveAttribute("href", "/audit?auditId=audit-restore-1");
    expect(screen.getByText(/固定のRTO/)).toBeVisible();
    expect(screen.getByText(/RPOは、暗号化された端末外保存先/)).toBeVisible();
  });

  it("requires the exact backend-provided phrase for all-Hub all-time purge and only reports success after commit", async () => {
    const user = userEvent.setup();
    const fake = fakeBackend();
    const preview: DataManagementPurgeStateSnapshot = {
      status: "ready",
      cancelAllowed: false,
      preview: {
        selection: { allHubs: true, hubIds: [], startAt: "", endAt: "" },
        capacity: {
          databaseSizeBytes: 0,
          rawSnapshotCount: 42,
          oldestCompletedAt: "2026-08-01T00:00:00Z",
          latestCompletedAt: "2026-08-26T00:00:00Z",
          rawJsonBytes: 8192,
        },
        requiredConfirmationText: fullPurgePhrase,
      },
      result: null,
      error: null,
    };
    fake.backend.previewPurge.mockImplementation(async (input) => {
      expect(input).toEqual({
        allHubs: true,
        hubIds: [],
        startAt: "",
        endAt: "",
        confirmationText: "",
      });
      fake.setCurrent({ ...fake.current(), purge: preview });
      return preview;
    });
    const committed: DataManagementPurgeStateSnapshot = {
      status: "success",
      cancelAllowed: false,
      preview: preview.preview,
      result: {
        auditId: "audit-purge-1",
        executedAt: "2026-08-26T04:05:06Z",
        rawSnapshotCount: 42,
        costObservationCount: 4,
        limitObservationCount: 5,
        matchedObservationCount: 6,
        estimationPointCount: 7,
        estimationResultCount: 8,
        estimationEvidenceCount: 9,
        calculationIntervalCount: 10,
        calculationBoundaryCount: 11,
        recalculatedResultCount: 12,
      },
      error: null,
    };
    fake.backend.applyPurge.mockImplementation(async () => {
      fake.setCurrent({ ...fake.current(), purge: committed });
      return committed;
    });

    renderPage(fake.backend);
    await user.click(await screen.findByRole("tab", { name: "明示パージ" }));
    await user.click(
      screen.getByRole("checkbox", { name: "全Hubを明示的に選択" }),
    );
    expect(screen.getByRole("checkbox", { name: "開始なし" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "終了なし" })).toBeChecked();
    await user.click(
      screen.getByRole("button", { name: "削減見込みをプレビュー" }),
    );

    expect(await screen.findByText("全Hub", { selector: "dd" })).toBeVisible();
    expect(screen.getByText("[開始なし, 終了なし)")).toBeVisible();
    expect(screen.getByText(/不可逆に削除します/)).toBeVisible();
    expect(
      screen.getByText(
        /SQLiteファイルが直ちに同じバイト数だけ縮小する保証ではありません/,
      ),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "最終確認へ" }));
    const confirmationInput = await screen.findByRole("textbox", {
      name: `確認語句「${fullPurgePhrase}」を正確に入力`,
    });
    let applyButton = screen.getByRole("button", {
      name: "パージと再計算を実行",
    });
    expect(applyButton).toBeDisabled();
    fireEvent.change(confirmationInput, {
      target: { value: "一致しない語句" },
    });
    expect(applyButton).toBeDisabled();
    fireEvent.change(confirmationInput, { target: { value: fullPurgePhrase } });
    applyButton = screen.getByRole("button", {
      name: "パージと再計算を実行",
    });
    expect(applyButton).toBeEnabled();
    expect(
      screen.queryByText(/パージと再計算をコミットしました/),
    ).not.toBeInTheDocument();
    await user.click(applyButton);

    expect(fake.backend.applyPurge).toHaveBeenCalledWith(
      {
        allHubs: true,
        hubIds: [],
        startAt: "",
        endAt: "",
        confirmationText: fullPurgePhrase,
      } satisfies DataManagementPurgeSelectionInput,
      true,
    );
    expect(
      await screen.findByText("パージと再計算をコミットしました。"),
    ).toBeVisible();
    expect(screen.getByText("12")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "パージ監査記録を開く" }),
    ).toHaveAttribute("href", "/audit?auditId=audit-purge-1");
  });

  it("shows recovery and rollback facts and exposes cancel only when allowed", async () => {
    const user = userEvent.setup();
    const current = baseState();
    current.recovery = {
      status: "rolled_back",
      artifactSha256: sha,
      message: "未完了の復元を検出し、元のデータベースへ戻しました。",
    };
    current.restore.validation = {
      status: "failed",
      cancelAllowed: false,
      applyAllowed: false,
      operationId: "",
      artifact: null,
      error: {
        code: "restore_validation_database_sha",
        message: "データベースのSHA-256が一致しません。",
        details: ["検証項目: database_sha"],
        rolledBack: true,
        currentDataUnchanged: true,
      },
    };
    const fake = fakeBackend(current);

    renderPage(fake.backend);
    expect(
      await screen.findByText(/元のデータベースへ戻しました/),
    ).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "復元" }));
    expect(screen.getByText("変更はロールバック済みです。")).toBeVisible();
    expect(
      screen.getByText("現在のローカル正本は変更されていません。"),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /キャンセル/ }),
    ).not.toBeInTheDocument();
  });

  it("supports keyboard navigation, 200 percent reflow, forced-color-safe boundaries, and axe", async () => {
    const user = userEvent.setup();
    const fake = fakeBackend();
    const previousFontSize = document.documentElement.style.fontSize;
    document.documentElement.style.fontSize = "200%";

    const { container } = renderPage(fake.backend);
    await screen.findByRole("tab", { name: "容量" });
    const backupTab = screen.getByRole("tab", { name: "バックアップ" });
    backupTab.focus();
    expect(backupTab).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(backupTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("バックアップ成果物")).toBeVisible();
    expect(container.firstElementChild).toBeVisible();
    expect(styleSheetText()).toContain("forced-colors");

    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
    document.documentElement.style.fontSize = previousFontSize;
  });
});

function styleSheetText(): string {
  return Array.from(document.styleSheets)
    .flatMap((sheet) => {
      try {
        return Array.from(sheet.cssRules).map((rule) => rule.cssText);
      } catch {
        return [];
      }
    })
    .join("\n");
}
