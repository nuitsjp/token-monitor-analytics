import {
  Body1,
  Button,
  Dropdown,
  Field,
  MessageBar,
  MessageBarBody,
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
  preview: {
    display: "grid",
    gap: tokens.spacingVerticalS,
    margin: 0,
    paddingInlineStart: tokens.spacingHorizontalL,
  },
});

type CalendarDate = { year: number; month: number; day: number };
type PeriodPreview = {
  label: string;
  start: Date;
  end: Date;
  durationHours: number;
};

function calendarDateAt(date: Date, timeZone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  })
    .formatToParts(date)
    .filter((part) => part.type !== "literal");
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function addCalendarDays(value: CalendarDate, amount: number): CalendarDate {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day));
  date.setUTCDate(date.getUTCDate() + amount);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function localMidnight(value: CalendarDate, timeZone: string): Date {
  const target = Date.UTC(value.year, value.month - 1, value.day);
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    })
      .formatToParts(new Date(guess))
      .filter((part) => part.type !== "literal");
    const values = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    const observed = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
    );
    guess += target - observed;
  }
  return new Date(guess);
}

function periodPreviews(now: Date, timeZone: string): PeriodPreview[] {
  const today = calendarDateAt(now, timeZone);
  const tomorrow = addCalendarDays(today, 1);
  const weekday = new Date(
    Date.UTC(today.year, today.month - 1, today.day),
  ).getUTCDay();
  const weekStart = addCalendarDays(today, -((weekday + 6) % 7));
  const weekEnd = addCalendarDays(weekStart, 7);
  const monthStart: CalendarDate = {
    year: today.year,
    month: today.month,
    day: 1,
  };
  const monthEnd =
    today.month === 12
      ? { year: today.year + 1, month: 1, day: 1 }
      : { year: today.year, month: today.month + 1, day: 1 };
  return [
    makePeriod("今日", today, tomorrow, timeZone),
    makePeriod("週（月曜始まり）", weekStart, weekEnd, timeZone),
    makePeriod("月", monthStart, monthEnd, timeZone),
  ];
}

function makePeriod(
  label: string,
  startDate: CalendarDate,
  endDate: CalendarDate,
  timeZone: string,
): PeriodPreview {
  const start = localMidnight(startDate, timeZone);
  const end = localMidnight(endDate, timeZone);
  return {
    label,
    start,
    end,
    durationHours: Math.round((end.getTime() - start.getTime()) / 3_600_000),
  };
}

function formatPreviewDate(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(value);
}

function isValidTimeZone(value: string): boolean {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

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
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    // The backend may publish a saved value while this page is mounted.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(settings.theme);
    setDisplayTimeZone(settings.displayTimeZone);
  }, [settings.displayTimeZone, settings.theme]);

  const dirty =
    theme !== settings.theme || displayTimeZone !== settings.displayTimeZone;
  const saveRequired = dirty || !settings.timezoneConfirmed;
  const timeZoneValid = isValidTimeZone(displayTimeZone);
  const previews = timeZoneValid
    ? periodPreviews(new Date(), displayTimeZone)
    : [];
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const submit = async () => {
    setSaveError("");
    setSaving(true);
    try {
      await save({ theme, displayTimeZone });
    } catch (cause) {
      setSaveError(
        cause instanceof Error
          ? cause.message
          : "表示設定を保存できませんでした。",
      );
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
        {!settings.timezoneConfirmed && (
          <MessageBar intent="warning">
            <MessageBarBody>
              表示タイムゾーンは未確認です。値を変更していなくても「確認して保存」で明示確認してください。
            </MessageBarBody>
          </MessageBar>
        )}
        {!timeZoneValid && (
          <MessageBar intent="error">
            <MessageBarBody>
              Windows のタイムゾーンを IANA
              タイムゾーンへ変換できませんでした。候補から表示タイムゾーンを選択してください。
            </MessageBarBody>
          </MessageBar>
        )}
        <Body1>
          取得元タイムゾーンが不明なローカル日付は、表示タイムゾーンへ再配分せず、不明のまま扱います。
        </Body1>
      </section>
      <section
        className={styles.section}
        aria-labelledby="period-preview-heading"
      >
        <Subtitle1 as="h2" id="period-preview-heading">
          期間プレビュー
          {timeZoneValid ? `（${displayTimeZone}）` : ""}
        </Subtitle1>
        <Body1>
          期間は半開区間 [開始, 終了)
          です。暦週は月曜日に始まります。夏時間の移行日には、今日の長さが23時間または25時間になる場合があります。
        </Body1>
        {timeZoneValid ? (
          <ul className={styles.preview}>
            {previews.map((period) => (
              <li key={period.label}>
                {period.label}: [
                {formatPreviewDate(period.start, displayTimeZone)},{" "}
                {formatPreviewDate(period.end, displayTimeZone)})（
                {period.durationHours}時間）
              </li>
            ))}
          </ul>
        ) : (
          <Body1>タイムゾーンを選択すると期間を確認できます。</Body1>
        )}
      </section>
      {saveError && (
        <MessageBar intent="error">
          <MessageBarBody>{saveError}</MessageBarBody>
        </MessageBar>
      )}
      <div className={styles.actions}>
        <Button
          appearance="primary"
          disabled={!saveRequired || saving || !timeZoneValid}
          onClick={() => void submit()}
        >
          {settings.timezoneConfirmed ? "保存" : "確認して保存"}
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
