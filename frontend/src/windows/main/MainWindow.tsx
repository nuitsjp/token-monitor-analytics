import {
  Caption1,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  Settings16Regular,
  Cloud16Regular,
  Home16Regular,
  History16Regular,
  Warning16Regular,
  AppsListRegular,
  Database16Regular,
  DocumentSearch16Regular,
  People16Regular,
} from "@fluentui/react-icons";
import {
  MemoryRouter,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router";
import { useCallback, useEffect, useState } from "react";
import {
  DirtyStateDialog,
  useDirtyStateGuard,
} from "../../components/DirtyStateGuard";
import type { FrontendAdapter, OverviewSnapshot } from "../../lib/backend";
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
    flexWrap: "wrap",
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
  pageHeader: {
    display: "flex",
    alignItems: "center",
    minHeight: "20px",
    marginBottom: tokens.spacingVerticalM,
  },
  breadcrumb: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase300,
  },
  showcaseBadge: {
    color: tokens.colorPaletteDarkOrangeForeground1,
    border: `1px solid ${tokens.colorPaletteDarkOrangeBorderActive}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: `0 ${tokens.spacingHorizontalXS}`,
    whiteSpace: "nowrap",
  },
  navCounts: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    marginLeft: "auto",
  },
  navBadge: {
    minWidth: "16px",
    height: "16px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: `0 ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusCircular,
    fontSize: "10px",
    lineHeight: "16px",
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: "tabular-nums",
  },
  navBadgeError: {
    backgroundColor: tokens.colorPaletteRedBackground3,
    color: tokens.colorNeutralForegroundOnBrand,
  },
  navBadgeWarning: {
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorPaletteDarkOrangeForeground1,
    border: `1px solid ${tokens.colorPaletteDarkOrangeForeground1}`,
  },
  navStatusError: {
    padding: `0 ${tokens.spacingHorizontalL}`,
    color: tokens.colorPaletteRedForeground1,
  },
});

function NavCount({
  value,
  title,
  className,
  toneClassName,
}: {
  value: number;
  title: string;
  className: string;
  toneClassName: string;
}) {
  if (value <= 0) return null;
  return (
    <span className={mergeClasses(className, toneClassName)} title={title}>
      {value}
    </span>
  );
}

function breadcrumbForPath(pathname: string): {
  group: string;
  label: string;
  route: string;
} {
  if (pathname.startsWith("/limits")) {
    return { group: "利用状況", label: "利用上限・価値", route: "/limits" };
  }
  if (pathname === "/overview") {
    return { group: "利用状況", label: "概要", route: "/overview" };
  }
  if (pathname === "/review") {
    return { group: "確認・設定", label: "要確認", route: "/review" };
  }
  if (pathname === "/accounts") {
    return {
      group: "確認・設定",
      label: "アカウント・関連付け",
      route: "/accounts",
    };
  }
  if (pathname === "/catalog") {
    return {
      group: "確認・設定",
      label: "サービス・プラン",
      route: "/catalog",
    };
  }
  if (pathname === "/hubs") {
    return { group: "収集・データ", label: "Hub・収集", route: "/hubs" };
  }
  if (pathname === "/evidence") {
    return { group: "収集・データ", label: "観測と根拠", route: "/evidence" };
  }
  if (pathname === "/audit") {
    return { group: "収集・データ", label: "監査記録", route: "/audit" };
  }
  if (pathname === "/data") {
    return { group: "収集・データ", label: "データ管理", route: "/data" };
  }
  return { group: "設定", label: "表示設定", route: "/settings" };
}

function navigationHubCounts(snapshot: OverviewSnapshot): {
  connectionFailures: number;
  collectionFailures: number;
  unsupportedContracts: number;
} {
  const hubs = snapshot.hubs.items ?? [];
  const active = hubs.filter((hub) => hub.enabled);
  return {
    connectionFailures: active.filter(
      (hub) =>
        hub.connection.code !== "connected" &&
        hub.connection.code !== "not_checked" &&
        hub.connection.code !== "unsupported_contract",
    ).length,
    collectionFailures: active.filter(
      (hub) => hub.lastCollection.code === "collection_failed",
    ).length,
    unsupportedContracts: active.filter(
      (hub) => hub.connection.code === "unsupported_contract",
    ).length,
  };
}

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
      <Route
        path="/data"
        element={
          <DataManagementPage
            backend={backend}
            displayTimeZone={displayTimeZone}
          />
        }
      />
      <Route
        path="/settings"
        element={<SettingsPage onDirtyChange={setDirty} />}
      />
      <Route
        path="/hubs"
        element={
          <HubsPage
            backend={backend}
            onDirtyChange={setDirty}
            displayTimeZone={displayTimeZone}
          />
        }
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
        element={
          <CatalogPage
            backend={backend}
            onDirtyChange={setDirty}
            displayTimeZone={displayTimeZone}
          />
        }
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
  const location = useLocation();
  const { settings } = useSettings();
  const [dirty, setDirty] = useState(false);
  const [navigationStatus, setNavigationStatus] =
    useState<OverviewSnapshot | null>(null);
  const [navigationStatusError, setNavigationStatusError] = useState("");
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
  useEffect(() => {
    let active = true;
    const refreshNavigationStatus = () => {
      void backend
        .getOverview(false)
        .then((value) => {
          if (!active) return;
          setNavigationStatus(value);
          setNavigationStatusError("");
        })
        .catch(() => {
          if (!active) return;
          setNavigationStatus(null);
          setNavigationStatusError("状態件数を取得できません");
        });
    };
    refreshNavigationStatus();
    const interval = window.setInterval(refreshNavigationStatus, 30_000);
    window.addEventListener("focus", refreshNavigationStatus);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshNavigationStatus);
    };
  }, [backend, location.pathname]);
  const breadcrumb = breadcrumbForPath(location.pathname);
  const hubNavigationCounts = navigationStatus
    ? navigationHubCounts(navigationStatus)
    : null;
  return (
    <>
      <DirtyStateDialog guard={guard} />
      <div className={styles.window} data-window="main">
        <nav className={styles.navigation} aria-label="メインメニュー">
          <div className={styles.brand}>
            <span className={styles.brandLogo} aria-hidden="true" />
            <span>Token Monitor</span>
            {backend.isShowcase ? (
              <Caption1 className={styles.showcaseBadge}>
                サンプルデータ（モック Hub）
              </Caption1>
            ) : null}
          </div>
          {navigationStatusError ? (
            <Caption1 className={styles.navStatusError} role="status">
              {navigationStatusError}
            </Caption1>
          ) : null}
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
            <AppsListRegular aria-hidden="true" />
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
            {navigationStatus ? (
              <span
                className={styles.navCounts}
                aria-label={`未解決 ${navigationStatus.review.actionItems.count}件、警告 ${navigationStatus.review.warnings.count}件、処理失敗 ${navigationStatus.review.recalculationFailures.count}件`}
              >
                <NavCount
                  className={styles.navBadge}
                  toneClassName={styles.navBadgeWarning}
                  title="未解決"
                  value={navigationStatus.review.actionItems.count}
                />
                <NavCount
                  className={styles.navBadge}
                  toneClassName={styles.navBadgeWarning}
                  title="データ警告"
                  value={navigationStatus.review.warnings.count}
                />
                <NavCount
                  className={styles.navBadge}
                  toneClassName={styles.navBadgeError}
                  title="再計算失敗"
                  value={navigationStatus.review.recalculationFailures.count}
                />
              </span>
            ) : null}
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
            <People16Regular aria-hidden="true" />
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
            <AppsListRegular aria-hidden="true" />
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
            {hubNavigationCounts ? (
              <span
                className={styles.navCounts}
                aria-label={`接続異常 ${hubNavigationCounts.connectionFailures}件、最終取得失敗 ${hubNavigationCounts.collectionFailures}件、未対応契約 ${hubNavigationCounts.unsupportedContracts}件`}
              >
                <NavCount
                  className={styles.navBadge}
                  toneClassName={styles.navBadgeError}
                  title="接続異常"
                  value={hubNavigationCounts.connectionFailures}
                />
                <NavCount
                  className={styles.navBadge}
                  toneClassName={styles.navBadgeError}
                  title="最終取得失敗"
                  value={hubNavigationCounts.collectionFailures}
                />
                <NavCount
                  className={styles.navBadge}
                  toneClassName={styles.navBadgeWarning}
                  title="未対応契約"
                  value={hubNavigationCounts.unsupportedContracts}
                />
              </span>
            ) : null}
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
            <DocumentSearch16Regular aria-hidden="true" />
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
            <Database16Regular aria-hidden="true" />
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
          <header className={styles.pageHeader}>
            <nav className={styles.breadcrumb} aria-label="パンくず">
              <NavLink
                to={breadcrumb.route}
                onClick={(event) => {
                  if (dirty) {
                    event.preventDefault();
                    guardedNavigate(breadcrumb.route);
                  }
                }}
              >
                {breadcrumb.group}
              </NavLink>
              <span aria-hidden="true">›</span>
              <span aria-current="page">{breadcrumb.label}</span>
            </nav>
          </header>
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
