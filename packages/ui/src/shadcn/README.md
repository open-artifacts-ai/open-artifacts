# @oa/ui/shadcn

[shadcn/ui](https://ui.shadcn.com) components (new-york style, Radix via the
`radix-ui` package), themed with the Studio tokens. They live apart from the
CSS-module components exported by `@oa/ui`, which keep their names (`Button`,
`Card`, `Tabs`, …).

```ts
import "@oa/ui/tokens.css"; // first: the --oa-* tokens and the Geist fonts
import "@oa/ui/shadcn.css"; // Tailwind v4 + this theme
import { cn } from "@oa/ui/shadcn";
```

`shadcn.css` imports `tailwindcss`, so it includes Tailwind's preflight reset.
Neither entry `@import`s tokens.css itself, because the Google Fonts `@import`
in tokens.css must stay at the top of a stylesheet.

### Which entry

| Entry | Preflight | Use when |
|---|---|---|
| `@oa/ui/shadcn.css` (`shadcn.css`) | yes | every page of the app is on shadcn |
| `@oa/ui/shadcn-utilities.css` (`shadcn-utilities.css`) | no | migrating page by page |

```ts
import "@oa/ui/tokens.css";
import "@oa/ui/shadcn-utilities.css"; // same theme, no preflight
```

Preflight resets heading sizes and margins, borders, `box-sizing` and form
controls on every element, which restyles hand-written pages. The
no-preflight entry imports only `tailwindcss/theme.css` and
`tailwindcss/utilities.css` (Tailwind v4's documented split), plus
`tw-animate-css`, with the same theme, `dark` variant and utilities. The
dashboard uses it until all 7 of its areas are migrated, then flips to
`shadcn.css`.

Both entries import `theme.css`, the shared body: the variable mapping, the
`dark` variant, `@theme inline` and one base rule, `* { border-color;
outline-color }`. That rule stays in both: the components rely on it for
their border and outline colors, and it sets nothing else (no widths,
margins or fonts). The theme has no rule for `body` or headings, so nothing
restyles bare elements. Without preflight, a component that assumes its
resets (`border-style: solid`, zero margins, inherited fonts on buttons)
needs them from the app until the flip.

## Adding components

From `packages/ui`, always through the script:

```sh
pnpm shadcn:add <name…>
```

Components that already exist (e.g. `button.tsx`, pulled in as a
dependency) are kept as they are: the script runs the CLI with `--overwrite`
(its prompts can't be answered non-interactively) and restores every file
that existed before. To update an existing component on purpose, run the CLI
directly and review the diff.

It runs the pinned CLI (`shadcn@4.22.1`), pins any dependency ranges the CLI
saved (`^x` becomes the installed version; a test rejects ranges), and runs
`biome check --write` on `src/shadcn`.

- **Paths.** `components.json` sends files to `src/shadcn/ui/` through the
  package imports in `package.json` (`#shadcn/ui/*`, `#shadcn/lib/*`, …).
  Components import `cn` from the `cn` package, per shadcn's 2026-09 change;
  `lib/utils.ts` re-exports it.
- **CSS.** The CLI's CSS target is `cli-sink.css`, which nothing imports, so
  `add` never edits the theme (it appends neutral `:root`/`.dark` variable
  blocks, e.g. for `sidebar`). The script prints whatever the CLI wrote to
  the sink (new variables, keyframes) and then resets it, so map anything a
  component needs into `theme.css` by hand.
- **Lint.** `packages/ui/biome.jsonc` turns off, for `src/shadcn/ui/**` only,
  the rules shadcn breaks on purpose, each with its reason:
  `noDangerouslySetInnerHtml` (chart's `<style>`), `noDocumentCookie`
  (sidebar state), `noArrayIndexKey` (chart rows) and
  `useExhaustiveDependencies` (sidebar's setter deps).

### Local changes to generated components

- **button, badge:** new-york's destructive variant used `text-white` (2.47:1
  on dark `--oa-danger`) and `dark:bg-destructive/60`. They now use
  `text-destructive-foreground` (`--oa-accent-text`) on a full
  `bg-destructive`: 5.81:1 light, 7.4:1 dark, and at least 4.97:1 at the
  `/90` hover.

- **Focus (button, badge, input):** shadcn's translucent `ring-ring/50` and
  `ring-destructive/20|40` become a solid Studio outline,
  `focus-visible:outline-2 outline-solid outline-offset-2 outline-ring`
  (`--oa-focus`, ≥ 5.88:1 on bg and surface in both themes).
- **Outline button, outline badge, input:** `border-input`
  (`--oa-border-strong`, ≥ 3:1) in both themes, not `border-border`. Input
  drops `dark:bg-input/30`, so its placeholder stays ≥ 4.5:1.

Real-browser checks: `pnpm --filter @oa/ui test:browser` builds Ladle and
drives the "shadcn / a11y fixture" story in Playwright Chromium, in both
themes: axe incl. color-contrast, outlined borders, a Tab walk over every
focus outline, and each overlay opened from the keyboard.

- **Overlays (select, dialog, dropdown-menu, tabs, toggle, scroll-area):**
  the same solid outline replaces every `ring-ring/50` and `focus:ring-2`;
  menu and select items, and the scroll-area viewport, use it inset
  (`-outline-offset-2`). Tabs panels get it too, and inactive tab triggers use
  `text-muted-foreground` instead of `text-foreground/60` (below 4.5:1 in
  light). Select's trigger drops `dark:bg-input/30` like Input.
- **popover:** `rounded-lg` (8px) instead of `rounded-md`, the solid focus
  outline on the content, and `motion-reduce:animate-none!` so it opens and
  closes without the zoom/slide under reduced motion. Exports `PopoverClose`.
- **State indicators:** shadcn's on/active/selected states used `--accent`
  and `--muted`, about 1.05:1 against their surroundings. Toggle and
  ToggleGroup "on" is `bg-brand-soft text-brand-soft-foreground` with a 1px
  inset `--brand` ring (5.88 light, 6.38 dark at worst). The active tab keeps
  its `bg-background` fill and gets a 2px inset ink underline (`--foreground`,
  15.3:1 on the list); the dark `bg-input/30` fill is gone. A selected table
  row is `bg-brand-soft` with a 3px inset `--brand` bar on its first cell.
  Menu and select highlights use `--accent`, now `--oa-sunken`, plus the
  inset focus outline.
- **Reduced motion (dialog, alert-dialog, dropdown-menu, select, tooltip,
  sheet, sidebar):** every `animate-in`/`animate-out` class string adds
  `motion-reduce:animate-none!` (important, so it beats the `data-[state]`
  variants), and every transition that moves or resizes (sidebar width,
  offset, rail, label, menu button, action; sheet) adds
  `motion-reduce:transition-none`. Color-only transitions stay. Sonner's
  toasts already turn motion off under `prefers-reduced-motion`.
- **sidebar, sheet:** the focus rings (`ring-2 ring-sidebar-ring`, a box
  shadow) become the solid outline, inset in the sidebar. The active item is
  `bg-card` with a 1px inset `--input` ring (≥ 3:1) instead of
  `--sidebar-accent` (about 1.2:1). A collapsed off-canvas sidebar is `inert`,
  so its links leave the tab order. The mobile sheet returns focus to the
  trigger that opened it.
- **alert:** four Studio tones, `info` (`bg-brand-soft`), `success`,
  `warning` and `danger` (`bg-{success,warning,danger}-soft`, ours in
  theme.css), each with ink text and no border, beside shadcn's `default`
  and `destructive`. `size="sm"` is the one-line strip. `role` is `alert`
  for `danger`/`destructive` and `status` otherwise (shadcn always used
  `alert`). The title wraps (no `line-clamp-1`). Ours: `AlertAction`, a
  trailing column for buttons or a dismiss, spanning the title and text
  rows. Outline controls inside a tone use `--muted-foreground` edges,
  since `--input` is below 3:1 on the soft fills.
- **textarea, checkbox:** the solid focus outline and no
  `dark:bg-input/30`, like Input; Textarea resizes vertically only.
  Checkbox sits on `bg-card` and shows a dash when `indeterminate`.
- **kbd:** a Studio keycap: mono, `bg-secondary`, a 1px border with a 2px
  bottom.
- **brand.tsx (ours):** `BrandMark`, the Framed Artifact mark inline (frame in
  `currentColor`, corners in the accent), and `SidebarBrand`, the sidebar
  header row with the mark and "Open Artifacts".
- **sonner:** reads the theme from `useDataTheme()`
  (`hooks/use-data-theme.ts`, `<html data-theme>` then the OS) instead of
  `next-themes`, which is not a dependency.

### To fix when these components are added
- **chart:** it scopes dark colors to `.dark`, which nothing sets. Change its
  `THEMES.dark` selector to ours: `:root[data-theme="dark"]` (plus the
  `prefers-color-scheme` case).

## Theme mapping

`theme.css` defines shadcn's variables as references to `--oa-*` tokens, so
`packages/ui/src/tokens/tokens.css` stays the single source of color. Dark mode
comes from the tokens switching; nothing is redefined per theme.

The theme follows `<html data-theme>` only, like tokens.css: `dark` when
`<html data-theme="dark">`, or when the OS prefers dark and `<html>` isn't
`data-theme="light"`. The `dark:` variant uses the same rule. A `data-theme`
on a nested element doesn't switch the theme.

| shadcn variable | Studio token | Note |
|---|---|---|
| `--background` | `--oa-bg` | |
| `--foreground` | `--oa-text` | |
| `--card`, `--popover` | `--oa-surface` | |
| `--card-foreground`, `--popover-foreground` | `--oa-text` | |
| `--primary` | `--oa-text` | Studio's primary button is ink |
| `--primary-foreground` | `--oa-bg` | |
| `--secondary` | `--oa-surface-2` | |
| `--secondary-foreground` | `--oa-text` | |
| `--muted` | `--oa-sunken` | |
| `--muted-foreground` | `--oa-text-muted` | |
| `--accent` | `--oa-sunken` | shadcn's hover and menu-highlight surface, not our accent |
| `--accent-foreground` | `--oa-text` | |
| `--destructive` | `--oa-danger` | |
| `--destructive-foreground` | `--oa-accent-text` | ≥ 4.5:1 on danger in both themes |
| `--border` | `--oa-divider` | |
| `--input` | `--oa-border-strong` | ≥ 3:1 for control boundaries |
| `--ring` | `--oa-focus` | |
| `--brand` | `--oa-accent` | Ours, not shadcn's: `bg-brand`/`text-brand` for state marks |
| `--brand-soft`, `--brand-soft-foreground` | `--oa-accent-soft`, `--oa-accent-fg` | Ours: tinted state fills (toggle on, selected row) |
| `--brand-foreground` | `--oa-accent-text` | Text on a brand fill |
| `--success-soft`, `--warning-soft`, `--danger-soft` | `--oa-success-soft`, `--oa-warning-soft`, `--oa-danger-soft` | Ours: Alert tone fills |
| `--radius` | `--oa-radius-md` | |
| `--chart-1` … `--chart-5` | `--oa-accent`, `--oa-success`, `--oa-warning`, `--oa-danger`, `--oa-text-muted` | |
| `--sidebar` | `--oa-chrome` | |
| `--sidebar-foreground` | `--oa-text` | |
| `--sidebar-primary` | `--oa-text` | |
| `--sidebar-primary-foreground` | `--oa-bg` | |
| `--sidebar-accent` | `color-mix(in srgb, --oa-text 8%, --oa-chrome)` | |
| `--sidebar-accent-foreground` | `--oa-text` | |
| `--sidebar-border` | `--oa-divider` | |
| `--sidebar-ring` | `--oa-focus` | |

| Tailwind theme | Value |
|---|---|
| `--font-sans`, `--font-mono` | `--oa-font-sans`, `--oa-font-mono` (Geist, Geist Mono) |
| `--radius-sm`, `-md`, `-lg` | `--oa-radius-sm` (4px), `--oa-radius-md` (6px), `--oa-radius-lg` (8px) |
| `--radius-xl` … `-4xl` | multiples of `--oa-radius-lg` |

The variables are declared on `:root`, and also on `[data-theme]` elements so a
wrapper that sets its own `--oa-*` values inline (Ladle's side-by-side light
and dark panels) resolves against them.
