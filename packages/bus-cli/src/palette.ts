/**
 * Terminal palette for the `oa-bus` CLI (design/cli/PALETTE.md).
 * Copied from OpenBus packages/ui (tokens/terminal.ts); the CLI is its only user here.
 * Measured contrast on bg: ink 17.8 / 15.3, muted 5.8 / 6.2, accent 6.7 / 7.1,
 * success 5.4 / 8.6, warning 5.9 / 9.6, danger 5.8 / 7.4, hairline 1.8 / 1.8.
 */
export const terminal: Record<string, { light: string; dark: string }> = {
  bg: { light: "#FFFFFF", dark: "#131518" },
  ink: { light: "#15181C", dark: "#E9EBEE" },
  muted: { light: "#5F6670", dark: "#9097A1" },
  accent: { light: "#2350D0", dark: "#7F9CFF" },
  success: { light: "#157A3A", dark: "#5BC77F" },
  warning: { light: "#8A5A00", dark: "#E7B44F" },
  danger: { light: "#BE2F1C", dark: "#FF7F6B" },
  hairline: { light: "#BEC4CD", dark: "#3B414A" },
};

/** ANSI 16-color fallback when the terminal has no truecolor. */
export const terminalAnsi: Record<string, { light: number; dark: number }> = {
  muted: { light: 8, dark: 8 },
  accent: { light: 4, dark: 12 },
  success: { light: 2, dark: 10 },
  warning: { light: 3, dark: 11 },
  danger: { light: 1, dark: 9 },
};
