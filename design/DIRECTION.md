# Visual direction: Studio

Chosen by the user on 2026-10-18 from three options (Paper, Studio, Ink). The reference mockup is `design/directions/studio.html`; open it with `?view=library|artifact&theme=light|dark`.

## Type pairing

| Role | Family | Weights |
|---|---|---|
| Everything (UI, headings, Markdown body) | **Geist** (self-hosted, @fontsource, no third party), falling back to `ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif` | 400, 500, 600 |
| Code, version numbers, keyboard hints | **Geist Mono**, falling back to `ui-monospace, "SF Mono", Menlo, monospace` | 400, 500 |

One family carries the whole hierarchy through size and weight. There's no serif: D2's `--oa-font-serif` aliases the sans stack.

## Neutral ramp

| Token | Light | Dark | Use |
|---|---|---|---|
| bg | `#EEF0F3` | `#131518` | Page behind cards |
| chrome | `#F5F6F8` | `#17191D` | Sidebar, title bar, side panel |
| surface | `#FFFFFF` | `#1C1F23` | Cards, inputs, menus |
| surface-2 | `#F6F7F9` | `#212429` | Segmented controls, raised rows |
| sunken | `#ECEEF1` | `#181A1E` | Counts, empty bars |
| divider | `#E0E3E8` | `#2C3037` | Decorative hairlines inside a surface; never a control boundary |
| border | `#BEC4CD` | `#3B414A` | Control and card boundaries (≥ 1.5:1 on bg) |
| border-strong | `#848B95` | `#676E78` | Checkboxes, timeline nodes, hover borders (≥ 3:1 on bg, surface and surface-2, WCAG 1.4.11) |
| text | `#15181C` | `#E9EBEE` | Primary text; also the primary button fill |
| text-2 | `#454C56` | `#B7BDC6` | Secondary text |
| text-muted | `#5F6670` | `#9097A1` | Metadata, placeholders |

## Accent

One accent: **`#2350D0`** in light and **`#7F9CFF`** in dark. The accent marks **state only**: the current version, `team` visibility, focus rings, and the leading poll option. Primary actions are ink (`text` fill), not accent.

| Token | Light | Dark | Use |
|---|---|---|---|
| accent | `#2350D0` | `#7F9CFF` | State marks, fills |
| accent-fg | `#1D45B8` | `#A3B8FF` | Accent-colored text, usually on accent-soft |
| accent-soft | `#E7EDFC` | `#1F2A4A` | Tinted badge and row backgrounds |
| accent-text | `#FFFFFF` | `#131518` | Text drawn on an accent fill |
| focus | `#2350D0` | `#7F9CFF` | Same as accent; 2px outline, 2px offset (5.88 / 7.06 on bg) |
| success / success-soft | `#157A3A` / `#E3F3E8` | `#5BC77F` / `#173022` | |
| success-fg | `#157A3A` | `#6FD08F` | Success-colored text on success-soft (the `public` badge) |
| danger / danger-soft | `#BE2F1C` / `#FBE7E3` | `#FF7F6B` / `#3A1E1A` | |
| warning / warning-soft | `#8A5A00` / `#FBF0D9` | `#E7B44F` / `#352914` | |

The visibility badges are `private` in neutral, `team` in accent, and `public` in success. Badge text uses the lighter foreground in dark: `team` is `accent-fg` (`#A3B8FF`), and `public` is `success-fg` (`#6FD08F`) on `success-soft`.

## Corner radius scale

| Token | Value | Use |
|---|---|---|
| radius-sm | 4px | Badges, kbd, inline code, small buttons |
| radius-md | 6px | Buttons, inputs, menus, code blocks |
| radius-lg | 8px | Cards, panels, list containers |

Avatars are round.

## Notes for D2 (tokens)

These are the measured contrasts, with WCAG AA as the bar:

| Pair | Light | Dark |
|---|---|---|
| text on bg | 15.6 | 15.3 |
| text on surface | 17.8 | 13.9 |
| text-muted on bg | 5.08 | 6.21 |

| border on bg | 1.54 | 1.78 |
| accent-text on accent | 6.71 | 7.06 |
| border-strong on bg | 3.01 | 3.55 |
| border-strong on surface | 3.44 | 3.21 |
| border-strong on surface-2 | 3.21 | 3.02 |
| success on success-soft | 4.71 | 6.69 |
| success-fg on success-soft | 4.71 | 7.48 |

- **Border.** The mockup's hairline `#E0E3E8` / `#2C3037` measures only 1.13 / 1.38 against bg, below D2's 1.5:1. It becomes `divider`, and `--oa-border` takes the stronger `#BEC4CD` / `#3B414A`. This deliberately departs from the mockup.
- **accent-text vs accent-fg.** D2's `--oa-accent-text` is the color drawn *on* an accent fill. The mockup's accent-colored text becomes the extra token `--oa-accent-fg`.

## Rationale

Studio fits the brief, "a calm, document-first tool", by treating the chrome as a precise instrument that recedes. The cool gray neutrals and a single sans let artifact thumbnails and rendered content supply all the visual interest. Dense rows and compact cards suit a library that grows to hundreds of agent-made items. Hierarchy comes from size, weight, and the three-step text ramp, not from color. Restricting the blue accent to state (current version, team, focus) keeps it meaningful: when something is blue, it's telling you something. Geist with Geist Mono gives code, version numbers, and agent names a consistent technical voice without a second display face.
