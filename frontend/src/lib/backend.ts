import { Events } from "@wailsio/runtime";
import {
  HubService,
  SettingsService,
  WindowService,
} from "../../bindings/token-monitor-analytics/internal/desktop/index.js";
import type {
  CreateHubInput,
  HubSnapshot,
  UpdateHubInput,
} from "../../bindings/token-monitor-analytics/internal/desktop/models.js";

export type ThemePreference = "light" | "dark" | "system";

export interface SettingsSnapshot {
  theme: ThemePreference;
  displayTimeZone: string;
  ianaTimeZones: readonly string[];
  systemDark?: boolean;
}

export interface SettingsServiceAdapter {
  getSettings(): Promise<SettingsSnapshot> | SettingsSnapshot;
  saveSettings(
    settings: Pick<SettingsSnapshot, "theme" | "displayTimeZone">,
  ): Promise<SettingsSnapshot> | SettingsSnapshot;
}

export type FrontendEventName =
  | "app:quit-requested"
  | "window:main-close-requested"
  | "settings:theme-changed";

export interface FrontendAdapter {
  /** The Go side may replace this with a real overview query later. */
  readonly canOpenMain: boolean;
  readonly initialSettings: SettingsSnapshot;
  getSettings(): Promise<SettingsSnapshot>;
  saveSettings(
    settings: Pick<SettingsSnapshot, "theme" | "displayTimeZone">,
  ): Promise<SettingsSnapshot>;
  OpenMain(): Promise<void>;
  SetMainDirty(dirty: boolean): Promise<void>;
  ConfirmCloseMain(): Promise<void>;
  ConfirmQuit(): Promise<void>;
  getHubs(): Promise<HubSnapshot[]>;
  createHub(input: CreateHubInput): Promise<HubSnapshot>;
  updateHub(input: UpdateHubInput): Promise<HubSnapshot>;
  setHubCollectionEnabled(
    hubID: string,
    enabled: boolean,
  ): Promise<HubSnapshot>;
  saveCredential(hubID: string, secret: string): Promise<HubSnapshot>;
  deleteCredential(hubID: string): Promise<HubSnapshot>;
  checkHubConnection(hubID: string): Promise<HubSnapshot>;
  on(event: FrontendEventName, callback: (data: unknown) => void): () => void;
}

export const defaultSettings: SettingsSnapshot = {
  theme: "system",
  displayTimeZone: "UTC",
  ianaTimeZones: ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Europe/London"],
  systemDark: false,
};

function asSettings(
  value: unknown,
  fallback: SettingsSnapshot,
): SettingsSnapshot {
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  const theme = record.theme;
  const displayTimeZone = record.displayTimeZone;
  const zones = record.ianaTimeZones;
  return {
    theme:
      theme === "light" || theme === "dark" || theme === "system"
        ? theme
        : fallback.theme,
    displayTimeZone:
      typeof displayTimeZone === "string" && displayTimeZone.length > 0
        ? displayTimeZone
        : fallback.displayTimeZone,
    ianaTimeZones:
      Array.isArray(zones) && zones.every((zone) => typeof zone === "string")
        ? zones
        : fallback.ianaTimeZones,
    systemDark:
      typeof record.systemDark === "boolean"
        ? record.systemDark
        : fallback.systemDark,
  };
}

function asPromise<T>(value: Promise<T> | T): Promise<T> {
  return Promise.resolve(value);
}

export interface FakeBackendOptions {
  canOpenMain?: boolean;
  settings?: Partial<SettingsSnapshot>;
  onOpenMain?: () => void;
  onSetMainDirty?: (dirty: boolean) => void;
  onConfirmCloseMain?: () => void;
  onConfirmQuit?: () => void;
  hubs?: HubSnapshot[];
}

export interface FakeFrontendAdapter extends FrontendAdapter {
  emit(event: FrontendEventName, data?: unknown): void;
}

/** A deterministic adapter for component tests and browser development. */
export function createFakeBackend(
  options: FakeBackendOptions = {},
): FakeFrontendAdapter {
  let settings = asSettings(
    { ...defaultSettings, ...options.settings },
    defaultSettings,
  );
  const listeners = new Map<FrontendEventName, Set<(data: unknown) => void>>();
  let hubs = [...(options.hubs ?? [])];
  const backend: FakeFrontendAdapter = {
    canOpenMain: options.canOpenMain ?? false,
    initialSettings: settings,
    getSettings: async () => settings,
    saveSettings: async (next) => {
      settings = asSettings({ ...settings, ...next }, settings);
      return settings;
    },
    OpenMain: async () => options.onOpenMain?.(),
    SetMainDirty: async (dirty) => options.onSetMainDirty?.(dirty),
    ConfirmCloseMain: async () => options.onConfirmCloseMain?.(),
    ConfirmQuit: async () => options.onConfirmQuit?.(),
    getHubs: async () => hubs,
    createHub: async (input) => {
      const hub: HubSnapshot = {
        id: `fake-${hubs.length + 1}`,
        displayName: input.displayName,
        url: input.url,
        collectionEnabled: input.collectionEnabled,
        collectionIntervalSeconds: input.collectionIntervalSeconds,
        apiContract: "",
        credentialState: input.secret ? "registered" : "unregistered",
        credentialReady: Boolean(input.secret),
        connectionState: "not_checked",
        connectionCheckedAt: "",
        connectionFailureNote: "",
      };
      hubs = [...hubs, hub];
      return hub;
    },
    updateHub: async (input) => {
      const current = hubs.find((hub) => hub.id === input.id);
      if (!current) throw new Error("hub was not found");
      const hub = {
        ...current,
        displayName: input.displayName,
        url: input.url,
        collectionIntervalSeconds: input.collectionIntervalSeconds,
      };
      hubs = hubs.map((item) => (item.id === hub.id ? hub : item));
      return hub;
    },
    setHubCollectionEnabled: async (hubID, enabled) => {
      hubs = hubs.map((hub) =>
        hub.id === hubID ? { ...hub, collectionEnabled: enabled } : hub,
      );
      return hubs.find((hub) => hub.id === hubID)!;
    },
    saveCredential: async (hubID) => {
      hubs = hubs.map((hub) =>
        hub.id === hubID
          ? { ...hub, credentialState: "registered", credentialReady: true }
          : hub,
      );
      return hubs.find((hub) => hub.id === hubID)!;
    },
    deleteCredential: async (hubID) => {
      hubs = hubs.map((hub) =>
        hub.id === hubID
          ? { ...hub, credentialState: "unregistered", credentialReady: false }
          : hub,
      );
      return hubs.find((hub) => hub.id === hubID)!;
    },
    checkHubConnection: async (hubID) => {
      hubs = hubs.map((hub) =>
        hub.id === hubID ? { ...hub, connectionState: "connected" } : hub,
      );
      return hubs.find((hub) => hub.id === hubID)!;
    },
    on: (event, callback) => {
      const callbacks = listeners.get(event) ?? new Set();
      callbacks.add(callback);
      listeners.set(event, callbacks);
      return () => callbacks.delete(callback);
    },
    emit: (event, data) => {
      listeners.get(event)?.forEach((callback) => callback(data));
    },
  };
  return backend;
}

export function emitFakeBackendEvent(
  backend: FakeFrontendAdapter,
  event: FrontendEventName,
  data?: unknown,
): void {
  backend.emit(event, data);
}

function normalizeThemeEvent(
  data: unknown,
  current: SettingsSnapshot,
): SettingsSnapshot | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as Record<string, unknown>;
  if (
    value.theme !== "light" &&
    value.theme !== "dark" &&
    value.theme !== "system"
  ) {
    return undefined;
  }
  return asSettings({ ...current, ...value }, current);
}

function createWailsSettingsAdapter(
  service: SettingsServiceAdapter | undefined,
): SettingsServiceAdapter {
  if (service) return service;
  return {
    getSettings: () =>
      asPromise(
        SettingsService.GetSettings() as unknown as Promise<unknown>,
      ).then((value) => asSettings(value, defaultSettings)),
    saveSettings: (next) =>
      asPromise(
        SettingsService.SaveSettings(next) as unknown as Promise<unknown>,
      ).then((value) => asSettings(value, defaultSettings)),
  };
}

export interface ProductionBackendOptions {
  canOpenMain?: boolean;
  settingsService?: SettingsServiceAdapter;
  initialSettings?: SettingsSnapshot;
}

/**
 * Production adapter. Generated Wails bindings stay on this side of the UI;
 * tests can replace the whole adapter with `createFakeBackend`.
 */
export function createProductionBackend(
  options: ProductionBackendOptions = {},
): FrontendAdapter {
  const initial = asSettings(
    options.initialSettings ?? defaultSettings,
    defaultSettings,
  );
  const settings = createWailsSettingsAdapter(options.settingsService);
  return {
    canOpenMain: options.canOpenMain ?? false,
    initialSettings: initial,
    getSettings: () =>
      asPromise(settings.getSettings()).then((value) =>
        asSettings(value, initial),
      ),
    saveSettings: (next) =>
      asPromise(settings.saveSettings(next)).then((value) =>
        asSettings(value, initial),
      ),
    OpenMain: () => asPromise(WindowService.OpenMain()),
    SetMainDirty: (dirty) => asPromise(WindowService.SetMainDirty(dirty)),
    ConfirmCloseMain: () => asPromise(WindowService.ConfirmCloseMain()),
    ConfirmQuit: () => asPromise(WindowService.ConfirmQuit()),
    getHubs: () => asPromise(HubService.GetHubs()).then((value) => value ?? []),
    createHub: (input) => asPromise(HubService.CreateHub(input)),
    updateHub: (input) => asPromise(HubService.UpdateHub(input)),
    setHubCollectionEnabled: (hubID, enabled) =>
      asPromise(HubService.SetHubCollectionEnabled(hubID, enabled)),
    saveCredential: (hubID, secret) =>
      asPromise(HubService.SaveCredential(hubID, secret)),
    deleteCredential: (hubID) => asPromise(HubService.DeleteCredential(hubID)),
    checkHubConnection: (hubID) =>
      asPromise(HubService.CheckHubConnection(hubID)),
    on: (event, callback) =>
      Events.On(event, (wailsEvent) => callback(wailsEvent.data)),
  };
}

/**
 * Keep browser tests and the first-run compact window usable before the Go
 * settings service is generated. The parent process can inject the production
 * adapter at the application boundary.
 */
export const defaultBackend: FrontendAdapter = createProductionBackend({
  canOpenMain: true,
});

export function applyThemeEvent(
  data: unknown,
  current: SettingsSnapshot,
): SettingsSnapshot | undefined {
  return normalizeThemeEvent(data, current);
}
