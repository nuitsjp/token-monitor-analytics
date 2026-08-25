import {
  Body1,
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  makeStyles,
  shorthands,
  Subtitle1,
  tokens,
} from "@fluentui/react-components";
import { Open16Regular } from "@fluentui/react-icons";
import { useEffect, useState } from "react";
import type { FrontendAdapter } from "../../lib/backend";

const useStyles = makeStyles({
  window: {
    minHeight: "100vh",
    overflow: "hidden",
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground1,
    fontFamily:
      '"Segoe UI Variable Text", "Segoe UI", "Yu Gothic UI", Meiryo, sans-serif',
    ...shorthands.padding(tokens.spacingVerticalL, tokens.spacingHorizontalL),
  },
  compact: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    minHeight: "calc(100vh - 32px)",
  },
  limits: {
    minWidth: 0,
    maxHeight: "50vh",
    overflowY: "auto",
    scrollbarGutter: "stable",
  },
  actions: {
    display: "grid",
    gap: tokens.spacingVerticalS,
    alignContent: "center",
  },
  copy: {
    display: "grid",
    gap: tokens.spacingVerticalXS,
    minWidth: 0,
  },
  value: {
    fontVariantNumeric: "tabular-nums",
    overflowWrap: "anywhere",
  },
});

export function CompactWindow({ backend }: { backend: FrontendAdapter }) {
  const styles = useStyles();
  const [expanded, setExpanded] = useState(
    () =>
      typeof window !== "undefined" &&
      window.innerWidth >= 400 &&
      window.innerWidth < 800,
  );
  const [quitRequested, setQuitRequested] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const [quitError, setQuitError] = useState<string | null>(null);
  useEffect(
    () =>
      backend.on("app:quit-requested", () => {
        setQuitError(null);
        setQuitting(false);
        setQuitRequested(true);
      }),
    [backend],
  );
  useEffect(() => {
    const updateExpandedFromNativeWindow = () => {
      setExpanded(window.innerWidth >= 400 && window.innerWidth < 800);
    };
    window.addEventListener("resize", updateExpandedFromNativeWindow, {
      passive: true,
    });
    return () =>
      window.removeEventListener("resize", updateExpandedFromNativeWindow);
  }, []);
  const openMain = () => void backend.OpenMain();
  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    void backend.SetCompactExpanded(next).catch(() => setExpanded(expanded));
  };
  const confirmQuit = async () => {
    if (quitting) return;
    setQuitError(null);
    setQuitting(true);
    try {
      const hubs = await backend.getHubs();
      await Promise.all(
        hubs
          .filter((hub) => hub.collectionEnabled)
          .map((hub) => backend.stopCollection(hub.id)),
      );
      await backend.ConfirmQuit();
    } catch {
      setQuitError("収集処理を停止できなかったため、終了していません。");
      setQuitting(false);
    }
  };
  return (
    <>
      <main
        className={styles.window}
        data-window="compact"
        data-compact-expanded={expanded}
        aria-labelledby="compact-title"
      >
        <section className={styles.compact}>
          <div className={styles.copy}>
            <Caption1>Token Monitor Analytics</Caption1>
            <Subtitle1 as="h1" id="compact-title" className={styles.value}>
              Hub を登録してください
            </Subtitle1>
            <div className={styles.limits} data-region="limit-list">
              <Body1>メイン画面で接続先を設定すると収集を開始できます。</Body1>
            </div>
          </div>
          <div className={styles.actions}>
            <Button
              appearance="subtle"
              aria-expanded={expanded}
              aria-label={expanded ? "利用枠を折りたたむ" : "利用枠を展開"}
              onClick={toggleExpanded}
            >
              {expanded ? "折りたたむ" : "展開"}
            </Button>
            <Button
              icon={<Open16Regular />}
              aria-label="メイン画面を開く"
              disabled={!backend.canOpenMain}
              onClick={openMain}
            >
              開く
            </Button>
          </div>
        </section>
      </main>
      <Dialog
        open={quitRequested}
        onOpenChange={(_, data) => !data.open && setQuitRequested(false)}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>アプリを終了しますか？</DialogTitle>
            <DialogContent>
              収集処理を停止して、すべての画面を閉じます。
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                disabled={quitting}
                onClick={() => setQuitRequested(false)}
              >
                キャンセル
              </Button>
              <Button
                appearance="primary"
                disabled={quitting}
                onClick={() => void confirmQuit()}
              >
                {quitting ? "停止中…" : "終了"}
              </Button>
            </DialogActions>
            {quitError ? <Body1 role="alert">{quitError}</Body1> : null}
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
