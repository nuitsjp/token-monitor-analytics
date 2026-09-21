import { createTheme, type CSSVariablesResolver, type MantineColorsTuple } from '@mantine/core';

// 画面全体の色・余白・文字の正本。CSSは var(--tm-*) と var(--mantine-*) だけを参照する。
const brand: MantineColorsTuple = [
  '#e6f5f0', '#cdeae1', '#a3d9c9', '#7bc7b2', '#4eb49a', '#2f9c81', '#1f8f74', '#14866e', '#0e6d59', '#0a5546',
];

export const tokens = {
  text: { primary: '#15352e', secondary: '#3b554e', muted: '#5b736b' },
  surface: { page: '#f4f7f6', panel: '#ffffff', sunken: '#eef3f1' },
  border: { subtle: '#dce6e2', strong: '#c9d6d1' },
  status: {
    ok: brand[7], okBg: brand[0],
    warn: '#b45309', warnBg: '#fff4e6',
    danger: '#c92a2a', dangerBg: '#fff5f5',
  },
  // データ系列。Hubへ登録順に固定割当し、トレンド凡例と共有する。
  series: ['#14866e', '#4c6ef5', '#f08c00', '#7048e8', '#e64980', '#868e96'],
  neutralSeries: '#adb5bd',
  space: ['4px', '8px', '12px', '16px', '24px', '32px'],
} as const;

export const theme = createTheme({
  fontFamily: 'Inter, "Segoe UI", "Yu Gothic UI", Meiryo, sans-serif',
  primaryColor: 'brand',
  primaryShade: 7,
  colors: { brand },
  fontSizes: { xs: '12px', sm: '13px', md: '14px', lg: '16px', xl: '20px' },
  spacing: { xs: '4px', sm: '8px', md: '12px', lg: '16px', xl: '24px' },
  radius: { xs: '2px', sm: '4px', md: '8px', lg: '12px', xl: '16px' },
  defaultRadius: 'md',
  headings: {
    fontWeight: '700',
    sizes: { h1: { fontSize: '28px', lineHeight: '1.2' }, h2: { fontSize: '16px', lineHeight: '1.3' } },
  },
});

export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {
    '--tm-text-1': tokens.text.primary,
    '--tm-text-2': tokens.text.secondary,
    '--tm-text-3': tokens.text.muted,
    '--tm-surface-page': tokens.surface.page,
    '--tm-surface-panel': tokens.surface.panel,
    '--tm-surface-sunken': tokens.surface.sunken,
    '--tm-border-1': tokens.border.subtle,
    '--tm-border-2': tokens.border.strong,
    '--tm-status-ok': tokens.status.ok,
    '--tm-status-ok-bg': tokens.status.okBg,
    '--tm-status-warn': tokens.status.warn,
    '--tm-status-warn-bg': tokens.status.warnBg,
    '--tm-status-danger': tokens.status.danger,
    '--tm-status-danger-bg': tokens.status.dangerBg,
    '--tm-series-neutral': tokens.neutralSeries,
    ...Object.fromEntries(tokens.series.map((color, index) => [`--tm-series-${index + 1}`, color])),
    ...Object.fromEntries(tokens.space.map((value, index) => [`--tm-space-${index + 1}`, value])),
  },
  light: {},
  dark: {},
});

export function seriesColor(index: number) {
  return tokens.series[index % tokens.series.length];
}
