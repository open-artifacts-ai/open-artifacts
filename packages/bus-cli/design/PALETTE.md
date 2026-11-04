# CLI terminal palette

The `oa-bus` CLI is a UI surface. Its colours come from Studio
(`packages/ui/src/tokens/tokens.css`); its copy is in `transcript.md`. Import the
values, never retype them:

```ts
import { terminal, terminalAnsi } from "@ob/ui";
```

## The table

Contrast is against `bg` in the same theme (WCAG 2.x), checked by
`packages/ui/test/terminal.test.ts`.

| Name       | Light     | Dark      | Studio token               | Contrast (L / D) | Colours only                                       |
| ---------- | --------- | --------- | -------------------------- | ---------------- | -------------------------------------------------- |
| `bg`       | `#FFFFFF` | `#131518` | `--ob-surface` / `--ob-bg` | n/a              | Nothing. The assumed terminal background.          |
| `ink`      | `#15181C` | `#E9EBEE` | `--ob-text`                | 17.8 / 15.3      | All prose. The default; most output is `ink`.      |
| `muted`    | `#5F6670` | `#9097A1` | `--ob-text-muted`          | 5.8 / 6.2        | Meta: pids, token tails, counts, time left.        |
| `accent`   | `#2350D0` | `#7F9CFF` | `--ob-accent`              | 6.7 / 7.1        | The device code, the approval URL, the namespace.  |
| `success`  | `#157A3A` | `#5BC77F` | `--ob-success`             | 5.4 / 8.6        | A completed step; a live agent; `delivered`.       |
| `warning`  | `#8A5A00` | `#E7B44F` | `--ob-warning`             | 5.9 / 9.6        | Waiting, retrying, expiring; a queued agent.       |
| `danger`   | `#BE2F1C` | `#FF7F6B` | `--ob-danger`              | 5.8 / 7.4        | A refusal, a denial, an expiry, a revoked machine. |
| `hairline` | `#BEC4CD` | `#3B414A` | `--ob-border`              | 1.75 / 1.78      | The device-code box border. Nothing else.          |

The CLI never paints a background; `bg` exists so the bars can be measured.

## Colour is state, not decoration

This is the Studio rule. `success` marks a completed step or a delivered receipt.
`warning` marks waiting and expiring. `danger` marks a refusal or a revoked
machine. `accent` marks the device code, the URL and the current namespace.
`muted` marks meta and timestamps. `hairline` draws rules and box borders. `ink`
carries all prose.

When something is coloured, it is telling you something. A step glyph takes the
colour of its state; the words after it stay `ink`. Never colour a whole
sentence to make it stand out.

## ANSI fallback

| Name      | Light slot       | Dark slot          |
| --------- | ---------------- | ------------------ |
| `muted`   | 8 (bright black) | 8 (bright black)   |
| `accent`  | 4 (blue)         | 12 (bright blue)   |
| `success` | 2 (green)        | 10 (bright green)  |
| `warning` | 3 (yellow)       | 11 (bright yellow) |
| `danger`  | 1 (red)          | 9 (bright red)     |

`ink`, `bg` and `hairline` have no slot: `ink` is the terminal's default
foreground, and on a 16-colour terminal the box border is default foreground too.

Use truecolor (`\x1b[38;2;r;g;bm`) when the terminal supports it, ANSI 16
otherwise. Never degrade a state to `ink`: a refusal stays red even on a
16-colour terminal. With colour off entirely, the glyph carries the state.

Risk: ANSI slots are the terminal theme's colours, not ours, so the 4.5:1 bar
is only guaranteed in truecolor. Slot 3 (yellow) on a light background and
slot 8 (bright black) on a pure black background fall below 4.5:1 in some
themes (for example xterm defaults). Prefer truecolor whenever it is detected.

## Glyphs

Use the UTF-8 glyph when the locale is UTF-8 (`LANG`, `LC_ALL` or `LC_CTYPE`
contains `UTF-8`, or Windows Terminal), the ASCII fallback otherwise.

| Glyph        | ASCII     | Meaning                                                              | Colour     |
| ------------ | --------- | -------------------------------------------------------------------- | ---------- |
| `→`          | `>`       | A step the CLI is taking now                                         | `ink`      |
| `✓`          | `+`       | A step that completed                                                | `success`  |
| `!`          | `!`       | A problem that leaves things working; the next line says what to do. | `warning`  |
| `×`          | `x`       | A failure; the CLI stops                                             | `danger`   |
| `○`          | `o`       | A queued agent                                                       | `warning`  |
| `●`          | `*`       | A live agent                                                         | `success`  |
| `·`          | `-`       | Separator inside a meta span                                         | `muted`    |
| `…`          | `...`     | Elided text, or "still going"                                        | as text    |
| `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | `\|/-\\`  | Spinner frames, 80 ms each                                           | `warning`  |
| `╭─╮│╰╯`     | `+-+\|++` | The device-code box                                                  | `hairline` |

## Shape rules

- 80-column safe. Every line in `transcript.md` fits in 80 columns, with labels
  up to 64 characters and namespaces up to 128. Long values are cut by the one rule in
  `transcript.md`, "Cutting long values".
- Exactly one bordered box in the whole CLI: the device code. No box drawing
  around paragraphs, tables or errors.
- Two spaces after a step glyph. Continuation lines of a step indent 3 spaces so
  they line up with its text.
- A blank line before each new phase (header, approval, setup, roster).
- A spinner only while the CLI polls, and only on a TTY. The spinner line is
  redrawn in place and erased before the result line prints. Non-TTY prints
  `Waiting for approval (up to 10 minutes)…` once and nothing until the result.
- Output goes to stdout; a `×` failure block goes to stderr. The exit code is 0
  on success and 1 on any `×`.

## Copy rules

- No em dashes. Sentence case. Plain words.
- In setup output, the machine label and the device code are the only
  identifiers printed in prose. Agent names appear in the roster and in
  receipts (`Delivered to builder-e0.`).
- A token is never printed beyond its `oa_machine_` prefix and 4 trailing
  characters: `oa_machine_…7f3a`. Never in an error, never in a log line.
  There is no `--verbose` flag.
- Every wait has an end: the code says `valid 10 minutes`, the spinner shows
  time left, a retry says which attempt of how many.
- Every failure names the next action on the line after it, starting with a
  verb: `Run npx @open-artifacts/bus again to get a new code.`
- A receipt is never `delivered` before the daemon confirmed the harness
  accepted the message. A refusal prints its reason from the pinned list:
  `unknown_agent`, `closed`, `inbox_full`, `too_large`, `other_namespace`,
  `revoked`, `ambiguous` (see `transcript.md`, Receipts).

## Theme detection

1. `NO_COLOR` (any non-empty value) or `--no-color` disables colour. Glyphs
   stay. `parse()` in `packages/cli` does not accept `--no-color` today; adding
   it is a client-track follow-up. Until then `NO_COLOR` is the switch.
2. `FORCE_COLOR` forces colour: `0` off, `1` ANSI 16, `3` truecolor; anything
   else counts as `1`.
3. Otherwise colour is on only when `process.stdout.isTTY` and
   `process.stdout.hasColors()`. `hasColors(2 ** 24)` selects truecolor;
   `COLORTERM=truecolor` or `24bit` also does.
4. Light or dark follows the terminal's background: `COLORFGBG` (`fg;bg`, a
   background slot of 7 or 15 means light, anything else dark). With no signal,
   default to dark. `TERM=dumb` disables colour.
