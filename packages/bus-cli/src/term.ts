import { terminal, terminalAnsi } from "./palette.ts";

/** Palette names (design/cli/PALETTE.md); `ink` is the terminal's default. */
export type Tone =
  | "muted"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "hairline";

/**
 * How lines are painted. `tags` renders the transcript's own notation
 * (`[[accent]]…[[/accent]]`): the parity tests compare against it verbatim.
 */
export type Style = {
  color: "none" | "ansi" | "truecolor" | "tags";
  dark: boolean;
  utf8: boolean;
};

export type Env = Record<string, string | undefined>;
export type Stream = {
  isTTY?: boolean;
  hasColors?: (depth?: number) => boolean;
};

/** PALETTE.md "Theme detection", in its order. */
export function detectStyle(env: Env, stream: Stream, noColor = false): Style {
  const fgbg = env.COLORFGBG?.split(";").at(-1);
  const dark = !(fgbg === "7" || fgbg === "15");
  const locale = `${env.LC_ALL ?? ""} ${env.LC_CTYPE ?? ""} ${env.LANG ?? ""}`;
  const utf8 = /utf-?8/i.test(locale) || Boolean(env.WT_SESSION);
  const style = (color: Style["color"]): Style => ({ color, dark, utf8 });
  if (noColor || env.NO_COLOR) return style("none");
  const force = env.FORCE_COLOR;
  if (force !== undefined)
    return style(force === "0" ? "none" : force === "3" ? "truecolor" : "ansi");
  if (env.TERM === "dumb" || !stream.isTTY || !stream.hasColors?.())
    return style("none");
  const deep =
    stream.hasColors(2 ** 24) ||
    /^(truecolor|24bit)$/i.test(env.COLORTERM ?? "");
  return style(deep ? "truecolor" : "ansi");
}

const rgb = (hex: string) =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(";");

export function paint(style: Style, tone: Tone, text: string): string {
  if (text === "") return text;
  switch (style.color) {
    case "none":
      return text;
    case "tags":
      return `[[${tone}]]${text}[[/${tone}]]`;
    case "truecolor": {
      const hex = terminal[tone]?.[style.dark ? "dark" : "light"];
      return hex ? `\x1b[38;2;${rgb(hex)}m${text}\x1b[39m` : text;
    }
    case "ansi": {
      // Hairline has no slot: default foreground (PALETTE.md, ANSI fallback).
      const slot = terminalAnsi[tone]?.[style.dark ? "dark" : "light"];
      if (slot === undefined) return text;
      return `\x1b[${slot < 8 ? 30 + slot : 90 + slot - 8}m${text}\x1b[39m`;
    }
  }
}

const GLYPHS = {
  step: ["→", ">"],
  done: ["✓", "+"],
  retry: ["!", "!"],
  fail: ["×", "x"],
  queued: ["○", "o"],
  live: ["●", "*"],
  sep: ["·", "-"],
  more: ["…", "..."],
} as const;
export type GlyphName = keyof typeof GLYPHS;

export const glyph = (style: Style, name: GlyphName): string =>
  GLYPHS[name][style.utf8 ? 0 : 1];

export const SPINNER_UTF8 = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_ASCII = ["|", "/", "-", "\\"];
export const spinnerFrame = (style: Style, n: number): string => {
  const frames = style.utf8 ? SPINNER_UTF8 : SPINNER_ASCII;
  return frames[n % frames.length] as string;
};

/** The device-code box pieces: corners, rule, side. */
export const box = (style: Style) =>
  style.utf8
    ? { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" }
    : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };
