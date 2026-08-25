import { Events } from "@wailsio/runtime";
import {
  SettingsService,
  WindowService,
} from "../../bindings/token-monitor-analytics/internal/desktop/index.js";

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
