import { describe, expect, it, vi } from "vitest";

type BindingCall = {
  service: string;
  method: string;
  args: unknown[];
};

const bindingState = vi.hoisted(() => ({
  calls: [] as BindingCall[],
  cancellations: [] as string[],
  events: [] as { event: string; callback: (value: unknown) => void }[],
}));

vi.mock(
  "../../bindings/token-monitor-analytics/internal/desktop/index.js",
  () => {
    const service = (serviceName: string) =>
      new Proxy(
        {},
        {
          get:
            (_target, property) =>
            (...args: unknown[]) => {
              const method = String(property);
              bindingState.calls.push({ service: serviceName, method, args });
              const pending = Promise.resolve(undefined) as Promise<unknown> & {
                cancel?: (reason: string) => void;
              };
              if (serviceName === "UsageService" && method === "ExportUsage") {
                pending.cancel = (reason: string) =>
                  bindingState.cancellations.push(reason);
              }
              return pending;
            },
        },
      );
    return {
      AccountService: service("AccountService"),
      AuditService: service("AuditService"),
      CatalogService: service("CatalogService"),
      CollectionService: service("CollectionService"),
      DataManagementService: service("DataManagementService"),
      EstimationService: service("EstimationService"),
      HubService: service("HubService"),
      OverviewService: service("OverviewService"),
      ReviewService: service("ReviewService"),
      SettingsService: service("SettingsService"),
      UsageService: service("UsageService"),
      WindowService: service("WindowService"),
    };
  },
);

vi.mock("@wailsio/runtime", () => ({
  Events: {
    On: (event: string, callback: (value: unknown) => void) => {
      bindingState.events.push({ event, callback });
      return () => undefined;
    },
  },
}));

import { createProductionBackend } from "./backend";

type AdapterCall = {
  binding: string;
  args: unknown[];
};

describe("production Wails adapter contract", () => {
  it("delegates every service operation to its generated binding", async () => {
    bindingState.calls.length = 0;
    const backend = createProductionBackend({ canOpenMain: true });
    const callable = backend as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const contract: Record<string, AdapterCall> = {
      getSettings: { binding: "SettingsService.GetSettings", args: [] },
      saveSettings: {
        binding: "SettingsService.SaveSettings",
        args: [{ theme: "dark", displayTimeZone: "UTC" }],
      },
      OpenMain: { binding: "WindowService.OpenMain", args: [] },
      OpenMainRoute: {
        binding: "WindowService.OpenMainRoute",
        args: ["/usage"],
      },
      SetCompactExpanded: {
        binding: "WindowService.SetCompactExpanded",
        args: [true],
      },
      SetMainDirty: { binding: "WindowService.SetMainDirty", args: [true] },
      ConfirmCloseMain: {
        binding: "WindowService.ConfirmCloseMain",
        args: [],
      },
      ConfirmQuit: { binding: "WindowService.ConfirmQuit", args: [] },
      getOverview: {
        binding: "OverviewService.GetOverview",
        args: [true],
      },
      getLimitSeries: {
        binding: "EstimationService.GetLimitSeries",
        args: [{ serviceId: "service" }],
      },
      getLimitSeriesDetail: {
        binding: "EstimationService.GetLimitSeriesDetail",
        args: ["series"],
      },
      getUsage: { binding: "UsageService.GetUsage", args: [{ from: "a" }] },
      getCalendarPeriodUsage: {
        binding: "UsageService.GetCalendarPeriodUsage",
        args: [{ displayTimeZone: "Asia/Tokyo" }],
      },
      exportUsage: {
        binding: "UsageService.ExportUsage",
        args: [{ from: "a" }, "csv"],
      },
      getDataManagementState: {
        binding: "DataManagementService.GetState",
        args: [],
      },
      createBackup: {
        binding: "DataManagementService.CreateBackup",
        args: ["backup.zip"],
      },
      validateRestore: {
        binding: "DataManagementService.ValidateRestore",
        args: ["backup.zip"],
      },
      runRestoreTrial: {
        binding: "DataManagementService.RunRestoreTrial",
        args: ["operation"],
      },
      applyRestore: {
        binding: "DataManagementService.ApplyRestore",
        args: ["operation", true],
      },
      previewPurge: {
        binding: "DataManagementService.PreviewPurge",
        args: [{ mode: "all" }],
      },
      applyPurge: {
        binding: "DataManagementService.ApplyPurge",
        args: [{ mode: "all" }, true],
      },
      cancelCurrentOperation: {
        binding: "DataManagementService.CancelCurrentOperation",
        args: [],
      },
      getHubs: { binding: "HubService.GetHubs", args: [] },
      createHub: { binding: "HubService.CreateHub", args: [{ id: "hub" }] },
      updateHub: { binding: "HubService.UpdateHub", args: [{ id: "hub" }] },
      setHubCollectionEnabled: {
        binding: "HubService.SetHubCollectionEnabled",
        args: ["hub", true],
      },
      setHubEnabled: {
        binding: "HubService.SetHubEnabled",
        args: ["hub", false],
      },
      saveCredential: {
        binding: "HubService.SaveCredential",
        args: ["hub", "secret"],
      },
      deleteCredential: {
        binding: "HubService.DeleteCredential",
        args: ["hub"],
      },
      checkHubConnection: {
        binding: "HubService.CheckHubConnection",
        args: ["hub"],
      },
      startCollection: {
        binding: "CollectionService.StartCollection",
        args: ["hub"],
      },
      stopCollection: {
        binding: "CollectionService.StopCollection",
        args: ["hub"],
      },
      collectNow: {
        binding: "CollectionService.CollectNow",
        args: ["hub"],
      },
      getCollectionAttempts: {
        binding: "CollectionService.GetCollectionAttempts",
        args: ["hub"],
      },
      getRawSnapshots: {
        binding: "CollectionService.GetRawSnapshots",
        args: ["hub"],
      },
      getRawSnapshot: {
        binding: "CollectionService.GetRawSnapshot",
        args: ["snapshot"],
      },
      getCostObservations: {
        binding: "CollectionService.GetCostObservations",
        args: ["hub"],
      },
      getLimitObservations: {
        binding: "CollectionService.GetLimitObservations",
        args: ["hub"],
      },
      getAudits: { binding: "AuditService.GetAudits", args: [{ limit: 10 }] },
      getReviewItems: {
        binding: "ReviewService.GetReviewItems",
        args: [{ limit: 10 }],
      },
      getCatalog: { binding: "CatalogService.GetCatalog", args: [] },
      getAccounts: { binding: "AccountService.GetAccounts", args: [] },
      getHubAccountCandidates: {
        binding: "AccountService.GetHubAccountCandidates",
        args: ["service", "pending"],
      },
      getLogicalAccounts: {
        binding: "AccountService.GetLogicalAccounts",
        args: ["service", true],
      },
      getPlanHistories: {
        binding: "AccountService.GetPlanHistories",
        args: ["account"],
      },
      createLogicalAccount: {
        binding: "AccountService.CreateLogicalAccount",
        args: [{ id: "account" }],
      },
      updateLogicalAccount: {
        binding: "AccountService.UpdateLogicalAccount",
        args: [{ id: "account" }],
      },
      archiveLogicalAccount: {
        binding: "AccountService.ArchiveLogicalAccount",
        args: ["account"],
      },
      restoreLogicalAccount: {
        binding: "AccountService.RestoreLogicalAccount",
        args: ["account"],
      },
      createLogicalAccountFromCandidate: {
        binding: "AccountService.CreateLogicalAccountFromCandidate",
        args: [{ candidateId: "candidate" }],
      },
      associateHubAccountCandidate: {
        binding: "AccountService.AssociateHubAccountCandidate",
        args: ["candidate", "account"],
      },
      rejectHubAccountCandidate: {
        binding: "AccountService.RejectHubAccountCandidate",
        args: ["candidate"],
      },
      releaseHubAccountCandidate: {
        binding: "AccountService.ReleaseHubAccountCandidate",
        args: ["candidate"],
      },
      splitLogicalAccount: {
        binding: "AccountService.SplitLogicalAccount",
        args: [{ id: "account" }],
      },
      mergeLogicalAccounts: {
        binding: "AccountService.MergeLogicalAccounts",
        args: ["source", "target"],
      },
      createPlanHistory: {
        binding: "AccountService.CreatePlanHistory",
        args: [{ id: "history" }],
      },
      updatePlanHistory: {
        binding: "AccountService.UpdatePlanHistory",
        args: [{ id: "history" }],
      },
      getLinkingSnapshot: {
        binding: "AccountService.GetLinkingSnapshot",
        args: [],
      },
      createUsageCostAssociation: {
        binding: "AccountService.CreateUsageCostAssociation",
        args: [{ id: "association" }],
      },
      updateUsageCostAssociation: {
        binding: "AccountService.UpdateUsageCostAssociation",
        args: [{ id: "association" }],
      },
      previewUsageCostAssociation: {
        binding: "AccountService.PreviewUsageCostAssociation",
        args: [{ id: "association" }],
      },
      createUsageLimitAssociation: {
        binding: "AccountService.CreateUsageLimitAssociation",
        args: [{ id: "association" }],
      },
      updateUsageLimitAssociation: {
        binding: "AccountService.UpdateUsageLimitAssociation",
        args: [{ id: "association" }],
      },
      previewUsageLimitAssociation: {
        binding: "AccountService.PreviewUsageLimitAssociation",
        args: [{ id: "association" }],
      },
      previewUsageCostSourceCompleteness: {
        binding: "AccountService.PreviewUsageCostSourceCompleteness",
        args: [{ sourceId: "source" }],
      },
      confirmUsageCostSourceCompleteness: {
        binding: "AccountService.ConfirmUsageCostSourceCompleteness",
        args: [{ sourceId: "source" }],
      },
      updateUsageCostSourceCompleteness: {
        binding: "AccountService.UpdateUsageCostSourceCompleteness",
        args: [{ sourceId: "source" }],
      },
      previewHubSwitch: {
        binding: "AccountService.PreviewHubSwitch",
        args: [{ fromHubId: "a", toHubId: "b" }],
      },
      confirmHubSwitch: {
        binding: "AccountService.ConfirmHubSwitch",
        args: [{ fromHubId: "a", toHubId: "b" }],
      },
      createService: {
        binding: "CatalogService.CreateService",
        args: [{ id: "service" }],
      },
      updateService: {
        binding: "CatalogService.UpdateService",
        args: [{ id: "service" }],
      },
      archiveService: {
        binding: "CatalogService.ArchiveService",
        args: ["service"],
      },
      restoreService: {
        binding: "CatalogService.RestoreService",
        args: ["service"],
      },
      createServiceIdentifierMapping: {
        binding: "CatalogService.CreateServiceIdentifierMapping",
        args: [{ id: "mapping" }],
      },
      updateServiceIdentifierMapping: {
        binding: "CatalogService.UpdateServiceIdentifierMapping",
        args: [{ id: "mapping" }],
      },
      createLimitDefinition: {
        binding: "CatalogService.CreateLimitDefinition",
        args: [{ id: "definition" }],
      },
      updateLimitDefinition: {
        binding: "CatalogService.UpdateLimitDefinition",
        args: [{ id: "definition" }],
      },
      setBillingConfirmation: {
        binding: "CatalogService.SetBillingConfirmation",
        args: ["definition", "confirmed"],
      },
      createPlan: {
        binding: "CatalogService.CreatePlan",
        args: [{ id: "plan" }],
      },
      updatePlan: {
        binding: "CatalogService.UpdatePlan",
        args: [{ id: "plan" }],
      },
      setBaselinePlan: {
        binding: "CatalogService.SetBaselinePlan",
        args: ["service", "plan"],
      },
      createPlanVersion: {
        binding: "CatalogService.CreatePlanVersion",
        args: [{ id: "version" }],
      },
      createPlanLimitRule: {
        binding: "CatalogService.CreatePlanLimitRule",
        args: [{ id: "rule" }],
      },
      createStandardPrice: {
        binding: "CatalogService.CreateStandardPrice",
        args: [{ id: "price" }],
      },
      updateStandardPrice: {
        binding: "CatalogService.UpdateStandardPrice",
        args: [{ id: "price" }],
      },
      confirmIdentificationCandidate: {
        binding: "CatalogService.ConfirmIdentificationCandidate",
        args: [{ candidateId: "candidate" }],
      },
      rejectIdentificationCandidate: {
        binding: "CatalogService.RejectIdentificationCandidate",
        args: ["candidate"],
      },
      releaseIdentificationCandidate: {
        binding: "CatalogService.ReleaseIdentificationCandidate",
        args: ["candidate"],
      },
      correctIdentificationCandidate: {
        binding: "CatalogService.CorrectIdentificationCandidate",
        args: [{ candidateId: "candidate" }],
      },
      splitIdentificationCandidate: {
        binding: "CatalogService.SplitIdentificationCandidate",
        args: [{ candidateId: "candidate" }],
      },
      decideLabelChangeCandidate: {
        binding: "CatalogService.DecideLabelChangeCandidate",
        args: [{ candidateId: "candidate" }],
      },
    };

    for (const [adapterMethod, expected] of Object.entries(contract)) {
      bindingState.calls.length = 0;
      await Promise.resolve(callable[adapterMethod](...expected.args));
      const [service, method] = expected.binding.split(".");
      expect(bindingState.calls, adapterMethod).toEqual([
        { service, method, args: expected.args },
      ]);
    }
  });

  it("wires cancellable exports and Wails events", async () => {
    bindingState.calls.length = 0;
    bindingState.cancellations.length = 0;
    bindingState.events.length = 0;
    const backend = createProductionBackend();

    const exportTask = backend.beginUsageExport({} as never, "json");
    exportTask.cancel();
    await exportTask.promise;
    expect(bindingState.calls).toEqual([
      {
        service: "UsageService",
        method: "ExportUsage",
        args: [{}, "json"],
      },
    ]);
    expect(bindingState.cancellations).toEqual(["user cancelled usage export"]);

    const callback = vi.fn();
    const dispose = backend.on("navigation:open", callback);
    expect(bindingState.events).toHaveLength(1);
    expect(bindingState.events[0].event).toBe("navigation:open");
    bindingState.events[0].callback({ data: "/usage" });
    expect(callback).toHaveBeenCalledWith("/usage");
    expect(dispose).toBeTypeOf("function");
  });
});
