import {
  FluentProvider,
  webDarkTheme,
  webLightTheme,
} from "@fluentui/react-components";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  applyThemeEvent,
  defaultSettings,
  type FrontendAdapter,
  type SettingsSnapshot,
  type ThemePreference,
} from "../lib/backend";

interface SettingsContextValue {
  settings: SettingsSnapshot;
  preference: ThemePreference;
  dark: boolean;
  save: (
    next: Pick<SettingsSnapshot, "theme" | "displayTimeZone">,
  ) => Promise<void>;
}

const settingsContext = createContext<SettingsContextValue | null>(null);

const fontFamilyBase =
  '"Inter Variable", "Segoe UI Variable Text", "Segoe UI", "Yu Gothic UI", Meiryo, sans-serif';
const lightTheme = { ...webLightTheme, fontFamilyBase };
const darkTheme = { ...webDarkTheme, fontFamilyBase };

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSettings(): SettingsContextValue {
  const value = useContext(settingsContext);
  if (!value) throw new Error("useSettings must be used inside AppProviders");
  return value;
}

export function AppProviders({
  backend,
  children,
}: {
  backend: FrontendAdapter;
  children: React.ReactNode;
}) {
  const [settings, setSettings] = useState<SettingsSnapshot>(
    backend.initialSettings ?? defaultSettings,
  );
  const [systemDark, setSystemDark] = useState(
    settings.systemDark ?? systemPrefersDark(),
  );

  useEffect(() => {
    let active = true;
    void backend.getSettings().then((loaded) => {
      if (!active) return;
      setSettings(loaded);
      if (typeof loaded.systemDark === "boolean")
        setSystemDark(loaded.systemDark);
    });
    return () => {
      active = false;
    };
  }, [backend]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    return backend.on("settings:theme-changed", (data) => {
      setSettings((current) => {
        const next = applyThemeEvent(data, current);
        if (next?.systemDark !== undefined) setSystemDark(next.systemDark);
        return next ?? current;
      });
    });
  }, [backend]);

  const save = useCallback(
    async (next: Pick<SettingsSnapshot, "theme" | "displayTimeZone">) => {
      const saved = await backend.saveSettings(next);
      setSettings(saved);
      if (typeof saved.systemDark === "boolean")
        setSystemDark(saved.systemDark);
    },
    [backend],
  );
  const dark =
    settings.theme === "dark" || (settings.theme === "system" && systemDark);
  const value = useMemo(
    () => ({ settings, preference: settings.theme, dark, save }),
    [dark, save, settings],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);

  return (
    <settingsContext.Provider value={value}>
      <FluentProvider theme={dark ? darkTheme : lightTheme}>
        {children}
      </FluentProvider>
    </settingsContext.Provider>
  );
}
