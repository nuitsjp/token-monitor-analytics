/**
 * Project-owned semantic tokens. Fluent UI tokens remain the source for
 * neutral surfaces, spacing and typography; these values cover only the
 * semantics defined by docs/design-system.md §3.2–§3.4.
 *
 * Keep raw colours in this file so policy checks can compare UI usage with a
 * single machine-readable definition.
 */
export const designTokens = {
  light: {
    successForeground: "#0e700e",
    successBackground: "#f1faf1",
    successBorder: "#9fd89f",
    successFill: "#107c10",
    errorForeground: "#bc2f32",
    errorBackground: "#fdf6f6",
    errorBorder: "#eeacb2",
    errorFill: "#d13438",
    warningForeground: "#bc4b09",
    warningBackground: "#fff9f5",
    warningBorder: "#fdcfb4",
    warningFill: "#bc4b09",
    cautionForeground: "#9d5d00",
    cautionFill: "#eaa300",
    estimatedForeground: "#5c2e91",
    estimatedBackground: "#f7f2fa",
    estimatedBorder: "#cdb2e0",
    sharedForeground: "#7a5c00",
    sharedBackground: "#fefbf4",
    sharedBorder: "#f2dcaa",
    sharedPattern: "#eaa300",
    disabledForeground: "#616161",
    disabledBackground: "#f5f5f5",
    disabledBorder: "#e0e0e0",
    disabledFill: "#adadad",
    errorCounterBackground: "#d13438",
    errorCounterForeground: "#ffffff",
  },
  dark: {
    successForeground: "#54b054",
    successFill: "#54b054",
    errorForeground: "#e37d80",
    errorBackground: "#3f1011",
    errorBorder: "#813639",
    errorFill: "#dc5e62",
    warningForeground: "#faa06b",
    warningBackground: "#411200",
    warningBorder: "#7f3c20",
    warningFill: "#faa06b",
    cautionForeground: "#eaa300",
    cautionFill: "#eaa300",
    estimatedForeground: "#c9aef0",
    estimatedBackground: "#2b1c3f",
    estimatedBorder: "#6a4a96",
    sharedForeground: "#ddba55",
    sharedBackground: "#322a10",
    sharedBorder: "#6f5c1e",
    sharedPattern: "#eaa300",
    disabledForeground: "#adadad",
    errorCounterBackground: "#d13438",
    errorCounterForeground: "#ffffff",
  },
} as const;

export type DesignTheme = keyof typeof designTokens;
export type SemanticDesignTokens = (typeof designTokens)[DesignTheme];

export const designTokenCssVariables = {
  errorCounterBackground: "--tma-error-counter-background",
  errorCounterForeground: "--tma-error-counter-foreground",
} as const;
