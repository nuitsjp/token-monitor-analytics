import { Caption1, makeStyles, tokens } from "@fluentui/react-components";
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
import { LimitsPage } from "../../pages/limits/LimitsPage";
import { DataManagementPage } from "../../pages/data-management/DataManagementPage";
import { useSettings } from "../../app/providers";

const useStyles = makeStyles({
  window: {
    minHeight: "100vh",
    display: "grid",
    gridTemplateColumns: "224px minmax(0, 1fr)",
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
    gap: 0,
    minWidth: 0,
    padding: `${tokens.spacingVerticalS} 0`,
    backgroundColor: tokens.colorNeutralBackground3,
    "@media (max-width: 55rem)": {
      flexDirection: "row",
      flexWrap: "wrap",
      padding: tokens.spacingVerticalM,
    },
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL} ${tokens.spacingVerticalL}`,
    fontWeight: tokens.fontWeightSemibold,
    "@media (max-width: 55rem)": {
      width: "100%",
      marginBottom: 0,
    },
  },
  brandLogo: {
    width: "22px",
    height: "22px",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground,
    flexShrink: 0,
  },
  navCategory: {
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL} ${tokens.spacingVerticalXS}`,
    color: tokens.colorNeutralForeground3,
  },
  navBottom: {
    marginTop: "auto",
    paddingTop: tokens.spacingVerticalS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  navLink: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    minHeight: "38px",
    margin: `0 ${tokens.spacingHorizontalS} ${tokens.spacingVerticalXXS}`,
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
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalXXL}`,
    overflow: "auto",
    "@media (max-width: 55rem)": {
      padding: tokens.spacingVerticalL,
    },
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
        path="/limits"
        element={
          <LimitsPage backend={backend} displayTimeZone={displayTimeZone} />
        }
      />
      <Route
        path="/limits/:seriesID"
        element={
          <LimitsPage backend={backend} displayTimeZone={displayTimeZone} />
        }
      />
      <Route path="/data" element={<DataManagementPage backend={backend} />} />
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
            <span className={styles.brandLogo} aria-hidden="true" />
            <span>Token Monitor</span>
          </div>
          <Caption1 className={styles.navCategory}>利用状況</Caption1>
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
            to="/limits"
            className={({ isActive }) =>
              `${styles.navLink} ${isActive ? styles.navLinkActive : ""}`
            }
            onClick={(event) => {
              if (dirty) {
                event.preventDefault();
                guardedNavigate("/limits");
              }
            }}
          >
            <span aria-hidden="true">◌</span>
            <span>利用上限・価値</span>
          </NavLink>
          <Caption1 className={styles.navCategory}>確認・設定</Caption1>
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
          <Caption1 className={styles.navCategory}>収集・データ</Caption1>
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
            to="/data"
            className={({ isActive }) =>
              `${styles.navLink} ${isActive ? styles.navLinkActive : ""}`
            }
            onClick={(event) => {
              if (dirty) {
                event.preventDefault();
                guardedNavigate("/data");
              }
            }}
          >
            <span aria-hidden="true">▣</span>
            <span>データ管理</span>
          </NavLink>
          <div className={styles.navBottom}>
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
          </div>
        </nav>
        <main className={styles.content} aria-label="メイン画面">
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
