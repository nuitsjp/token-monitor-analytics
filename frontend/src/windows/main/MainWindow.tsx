import {
  Body1,
  Button,
  Caption1,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  Settings16Regular,
  Cloud16Regular,
  Home16Regular,
  History16Regular,
  Warning16Regular,
} from "@fluentui/react-icons";
import {
  MemoryRouter,
  Navigate,
  NavLink,
  Route,
  Routes,
  useNavigate,
} from "react-router";
import { useCallback, useEffect, useState } from "react";
import {
  DirtyStateDialog,
  useDirtyStateGuard,
} from "../../components/DirtyStateGuard";
import type { FrontendAdapter } from "../../lib/backend";
import { SettingsPage } from "../../pages/settings/SettingsPage";
import { HubsPage } from "../../pages/hubs/HubsPage";
import { AuditPage } from "../../pages/audit/AuditPage";
import { CatalogPage } from "../../pages/catalog/CatalogPage";
import { AccountsPage } from "../../pages/accounts/AccountsPage";
import { EvidencePage } from "../../pages/evidence/EvidencePage";
import { ReviewPage } from "../../pages/review/ReviewPage";
import { OverviewPage } from "../../pages/overview/OverviewPage";
import { useSettings } from "../../app/providers";

const useStyles = makeStyles({
  window: {
    minHeight: "100vh",
    display: "grid",
    gridTemplateColumns: "minmax(12rem, 14rem) minmax(0, 1fr)",
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground1,
    fontFamily:
      '"Segoe UI Variable Text", "Segoe UI", "Yu Gothic UI", Meiryo, sans-serif',
    "@media (max-width: 55rem)": {
      gridTemplateColumns: "minmax(0, 1fr)",
    },
  },
  navigation: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    minWidth: 0,
    padding: tokens.spacingVerticalL,
    backgroundColor: tokens.colorNeutralBackground3,
    "@media (max-width: 55rem)": {
      flexDirection: "row",
      flexWrap: "wrap",
      padding: tokens.spacingVerticalM,
    },
  },
  brand: {
    display: "grid",
    gap: tokens.spacingVerticalXS,
    marginBottom: tokens.spacingVerticalL,
    "@media (max-width: 55rem)": {
      width: "100%",
      marginBottom: 0,
    },
  },
  navLink: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    minHeight: "38px",
    padding: `0 ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground1,
    textDecorationLine: "none",
    ":hover": { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  navLinkActive: {
    backgroundColor: tokens.colorNeutralBackground1Hover,
    fontWeight: tokens.fontWeightSemibold,
    boxShadow: `inset 4px 0 ${tokens.colorBrandBackground}`,
  },
  content: {
    minWidth: 0,
    padding: tokens.spacingVerticalXXL,
    overflow: "auto",
    "@media (max-width: 55rem)": {
      padding: tokens.spacingVerticalL,
    },
  },
  compactHeading: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalL,
    flexWrap: "wrap",
  },
});

function MainRoutes({
  backend,
  setDirty,
  displayTimeZone,
}: {
  backend: FrontendAdapter;
  setDirty: (dirty: boolean) => void;
  displayTimeZone: string;
}) {
  return (
    <Routes>
      <Route
        path="/overview"
        element={
          <OverviewPage backend={backend} displayTimeZone={displayTimeZone} />
        }
      />
      <Route
        path="/settings"
        element={<SettingsPage onDirtyChange={setDirty} />}
      />
      <Route
        path="/hubs"
        element={<HubsPage backend={backend} onDirtyChange={setDirty} />}
      />
      <Route
        path="/evidence"
        element={
          <EvidencePage backend={backend} displayTimeZone={displayTimeZone} />
        }
      />
      <Route
        path="/audit"
        element={
          <AuditPage backend={backend} displayTimeZone={displayTimeZone} />
        }
      />
      <Route
        path="/review"
        element={
          <ReviewPage backend={backend} displayTimeZone={displayTimeZone} />
        }
      />
      <Route
        path="/catalog"
        element={<CatalogPage backend={backend} onDirtyChange={setDirty} />}
      />
      <Route
        path="/accounts"
        element={
          <AccountsPage
            backend={backend}
            onDirtyChange={setDirty}
            displayTimeZone={displayTimeZone}
          />
        }
      />
      <Route path="*" element={<Navigate to="/overview" replace />} />
    </Routes>
  );
}

function MainWindowContents({ backend }: { backend: FrontendAdapter }) {
  const styles = useStyles();
  const navigate = useNavigate();
  const { settings } = useSettings();
  const [dirty, setDirty] = useState(false);
  const guard = useDirtyStateGuard(backend, dirty);
  const guardedOpen = useCallback(
    (action: () => void | Promise<void>) => void guard.request("main", action),
    [guard],
  );
  const guardedNavigate = useCallback(
    (path: string) => void guard.request("navigate", () => navigate(path)),
    [guard, navigate],
  );
  useEffect(
    () =>
      backend.on("navigation:open", (data) => {
        if (typeof data === "string") guardedNavigate(data);
      }),
    [backend, guardedNavigate],
  );
  return (
    <>
      <DirtyStateDialog guard={guard} />
      <div className={styles.window} data-window="main">
        <nav className={styles.navigation} aria-label="メインメニュー">
          <div className={styles.brand}>
            <Caption1>Token Monitor Analytics</Caption1>
            <Body1>ローカル観測</Body1>
          </div>
          <NavLink
            to="/overview"
            className={({ isActive }) =>
              `${styles.navLink} ${isActive ? styles.navLinkActive : ""}`
            }
            onClick={(event) => {
              if (dirty) {
                event.preventDefault();
                guardedNavigate("/overview");
              }
            }}
          >
            <Home16Regular aria-hidden="true" />
            <span>概要</span>
          </NavLink>
          <NavLink
            to="/hubs"
            className={({ isActive }) =>
              `${styles.navLink} ${isActive ? styles.navLinkActive : ""}`
            }
            onClick={(event) => {
              if (dirty) {
                event.preventDefault();
                guardedNavigate("/hubs");
              }
            }}
          >
            <Cloud16Regular aria-hidden="true" />
            <span>Hub・収集</span>
          </NavLink>
          <NavLink
            to="/evidence"
            className={({ isActive }) =>
              `${styles.navLink} ${isActive ? styles.navLinkActive : ""}`
            }
            onClick={(event) => {
              if (dirty) {
                event.preventDefault();
                guardedNavigate("/evidence");
              }
            }}
          >
            <span aria-hidden="true">◎</span>
            <span>観測と根拠</span>
          </NavLink>
          <NavLink
            to="/catalog"
            className={({ isActive }) =>
              `${styles.navLink} ${isActive ? styles.navLinkActive : ""}`
            }
            onClick={(event) => {
              if (dirty) {
                event.preventDefault();
                guardedNavigate("/catalog");
              }
            }}
          >
            <span aria-hidden="true">◈</span>
            <span>サービス・プラン</span>
          </NavLink>
          <NavLink
            to="/accounts"
            className={({ isActive }) =>
              `${styles.navLink} ${isActive ? styles.navLinkActive : ""}`
            }
            onClick={(event) => {
              if (dirty) {
                event.preventDefault();
                guardedNavigate("/accounts");
              }
            }}
          >
            <span aria-hidden="true">◎</span>
            <span>アカウント・関連付け</span>
          </NavLink>
          <NavLink
            to="/audit"
            className={({ isActive }) =>
              `${styles.navLink} ${isActive ? styles.navLinkActive : ""}`
            }
            onClick={(event) => {
              if (dirty) {
                event.preventDefault();
                guardedNavigate("/audit");
              }
            }}
          >
            <History16Regular aria-hidden="true" />
            <span>監査記録</span>
          </NavLink>
          <NavLink
            to="/review"
            className={({ isActive }) =>
              `${styles.navLink} ${isActive ? styles.navLinkActive : ""}`
            }
            onClick={(event) => {
              if (dirty) {
                event.preventDefault();
                guardedNavigate("/review");
              }
            }}
          >
            <Warning16Regular aria-hidden="true" />
            <span>要確認</span>
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `${styles.navLink} ${isActive ? styles.navLinkActive : ""}`
            }
            onClick={(event) => {
              if (dirty) {
                event.preventDefault();
                guardedNavigate("/settings");
              }
            }}
          >
            <Settings16Regular aria-hidden="true" />
            <span>表示設定</span>
          </NavLink>
        </nav>
        <main className={styles.content} aria-label="メイン画面">
          <div className={styles.compactHeading}>
            <div>
              <Caption1>ローカル観測</Caption1>
              <Body1>
                設定を保存すると、すべてのウィンドウへ反映されます。
              </Body1>
            </div>
            <Button
              appearance="subtle"
              onClick={() => guardedOpen(() => undefined)}
            >
              閉じる
            </Button>
          </div>
          <MainRoutes
            backend={backend}
            setDirty={setDirty}
            displayTimeZone={settings.displayTimeZone}
          />
        </main>
      </div>
    </>
  );
}

export function MainWindow({ backend }: { backend: FrontendAdapter }) {
  const requestedRoute = new URLSearchParams(window.location.search).get(
    "route",
  );
  return (
    <MemoryRouter initialEntries={[requestedRoute || "/overview"]}>
      <MainWindowContents backend={backend} />
    </MemoryRouter>
  );
}
