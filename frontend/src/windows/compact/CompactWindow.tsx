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
  const [quitRequested, setQuitRequested] = useState(false);
  useEffect(
    () => backend.on("app:quit-requested", () => setQuitRequested(true)),
    [backend],
  );
  const openMain = () => void backend.OpenMain();
  return (
    <>
      <main
        className={styles.window}
        data-window="compact"
        aria-labelledby="compact-title"
      >
        <section className={styles.compact}>
          <div className={styles.copy}>
            <Caption1>Token Monitor Analytics</Caption1>
            <Subtitle1 as="h1" id="compact-title" className={styles.value}>
              Hub を登録してください
            </Subtitle1>
            <Body1>メイン画面で接続先を設定すると収集を開始できます。</Body1>
          </div>
          <Button
            icon={<Open16Regular />}
            aria-label="メイン画面を開く"
            disabled={!backend.canOpenMain}
            onClick={openMain}
          >
            開く
          </Button>
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
                onClick={() => setQuitRequested(false)}
              >
                キャンセル
              </Button>
              <Button
                appearance="primary"
                onClick={() => void backend.ConfirmQuit()}
              >
                終了
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
