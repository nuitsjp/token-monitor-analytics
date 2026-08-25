import {
  Body1,
  Button,
  Caption1,
  FluentProvider,
  makeStyles,
  shorthands,
  Subtitle1,
  tokens,
  webDarkTheme,
  webLightTheme,
} from "@fluentui/react-components";
import { Open16Regular } from "@fluentui/react-icons";
import { useEffect, useState } from "react";

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
    gridTemplateColumns: "1fr auto",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    minHeight: "calc(100vh - 32px)",
  },
  copy: {
    display: "grid",
    gap: tokens.spacingVerticalXS,
  },
  value: {
    fontVariantNumeric: "tabular-nums",
  },
});

type ThemePreference = "light" | "dark" | "system";

export default function App() {
  const styles = useStyles();
  const [preference] = useState<ThemePreference>("system");
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const dark = preference === "dark" || (preference === "system" && systemDark);

  return (
    <FluentProvider theme={dark ? webDarkTheme : webLightTheme}>
      <main className={styles.window} data-theme={dark ? "dark" : "light"}>
        <section className={styles.compact} aria-labelledby="compact-title">
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
            disabled
          >
            開く
          </Button>
        </section>
      </main>
    </FluentProvider>
  );
}
