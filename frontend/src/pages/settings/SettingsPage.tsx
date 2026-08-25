import {
  Body1,
  Button,
  Dropdown,
  Field,
  Option,
  Radio,
  RadioGroup,
  Subtitle1,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { useEffect, useState } from "react";
import { useSettings } from "../../app/providers";
import type { ThemePreference } from "../../lib/backend";

const useStyles = makeStyles({
  page: {
    display: "grid",
    gap: tokens.spacingVerticalL,
    maxWidth: "56rem",
  },
  section: {
    display: "grid",
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow4,
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
  },
});

export function SettingsPage({
  onDirtyChange,
}: {
  onDirtyChange: (dirty: boolean) => void;
}) {
  const styles = useStyles();
  const { settings, save } = useSettings();
  const [theme, setTheme] = useState<ThemePreference>(settings.theme);
  const [displayTimeZone, setDisplayTimeZone] = useState(
    settings.displayTimeZone,
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // The backend may publish a saved value while this page is mounted.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(settings.theme);
    setDisplayTimeZone(settings.displayTimeZone);
  }, [settings.displayTimeZone, settings.theme]);

  const dirty =
    theme !== settings.theme || displayTimeZone !== settings.displayTimeZone;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const submit = async () => {
    setSaving(true);
    try {
      await save({ theme, displayTimeZone });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.page}>
      <div>
        <Subtitle1 as="h1">表示設定</Subtitle1>
        <Body1>表示方法とタイムゾーンを選択できます。</Body1>
      </div>
      <section className={styles.section} aria-labelledby="theme-heading">
        <Subtitle1 as="h2" id="theme-heading">
          テーマ
        </Subtitle1>
        <RadioGroup
          aria-label="テーマ"
          value={theme}
          onChange={(_, data) => setTheme(data.value as ThemePreference)}
        >
          <Radio value="light" label="ライト" />
          <Radio value="dark" label="ダーク" />
          <Radio value="system" label="システム設定に合わせる" />
        </RadioGroup>
      </section>
      <section className={styles.section} aria-labelledby="timezone-heading">
        <Subtitle1 as="h2" id="timezone-heading">
          表示タイムゾーン
        </Subtitle1>
        <Field label="IANA タイムゾーン">
          <Dropdown
            aria-label="IANA タイムゾーン"
            value={displayTimeZone}
            selectedOptions={[displayTimeZone]}
            onOptionSelect={(_, data) => {
              if (typeof data.optionValue === "string")
                setDisplayTimeZone(data.optionValue);
            }}
          >
            {settings.ianaTimeZones.map((zone) => (
              <Option key={zone} value={zone} text={zone}>
                {zone}
              </Option>
            ))}
          </Dropdown>
        </Field>
      </section>
      <div className={styles.actions}>
        <Button
          appearance="primary"
          disabled={!dirty || saving}
          onClick={() => void submit()}
        >
          保存
        </Button>
        <Button
          appearance="secondary"
          disabled={!dirty || saving}
          onClick={() => {
            setTheme(settings.theme);
            setDisplayTimeZone(settings.displayTimeZone);
          }}
        >
          変更を取り消す
        </Button>
      </div>
    </div>
  );
}
