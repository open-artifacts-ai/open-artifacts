# Dashboard screens (Task D4)

High-fidelity static mockups in the Studio direction (`design/DIRECTION.md`). Frontend matches these; Backend renders `oauth-consent.html`.

## How to view

- **Open the file directly** in a browser (`file://…/design/screens/library.html`). Works offline except Google Fonts.
- **Or serve the repo:** run `npx serve` from the repo root and open `http://localhost:3000/design/screens/library.html`. Use this if your browser blocks the relative `tokens.css` link on `file://`.

Every screen except the consent page reads these query params:

| Param | Values | Default |
|---|---|---|
| `theme` | `light`, `dark` | Follows `prefers-color-scheme` when omitted, on every screen (consent always does) |
| `state` | `default`, `empty`, `loading`, `error` (plus extras where listed) | `default` |

Each screen is designed for 1280 px and 390 px wide, with no horizontal page scroll.

**Header.** `library.html` and the quota page (`edge-pages.html?page=quota`) use a search box plus Upload in the top bar. The other app screens use breadcrumbs. This is intentional. Every app screen shares the same sidebar (wordmark, workspace button, Library/Usage/Settings, connected agents), which becomes a drawer below 960 px.

**Instance role.** `role=owner|admin|member|guest` (default `owner`) sets who is signed in. It works on `share-dialog.html`, `settings.html`, `usage.html` and the quota page in `edge-pages.html` (d4-a adds it to library and artifact-view).

| Role | Sidebar | Settings | Usage |
|---|---|---|---|
| `owner`, `admin` | Library, Usage, Settings, agents | Members, Agents, Instance (OAuth clients and tokens are always the signed-in user's own) | Yes |
| `member` | Library, Settings, agents | Agents only: MCP URL, snippets, their own OAuth clients and tokens | 404 |
| `guest` | "Shared with me" only | 404 | 404 |

A screen a role can't reach renders the `edge-pages.html?page=not-found` 404 in place. The role doesn't change the share dialog's creator rules; use `as=` for those.

**Artifact role preview.** `as=creator|editor|viewer` (default `creator`) previews the screen for a non-creator. It works on `share-dialog.html` and `artifact-view.html`.

## Screens

| File | Screen | Extra params | Notes |
|---|---|---|---|
| `library.html` | Library | `layout=grid\|list`, `overlay=none\|drop\|filter\|drawer`, `state=hover\|focus\|active`, `banner=none\|cpu` | Scope tabs, filters, search, drop-zone overlay. `banner=cpu` shows the CPU-limit warning (See plans for owner and admin only; members get "Ask your instance owner about upgrading."). Cards and rows are fully clickable (the title link is stretched over them). `state=hover\|focus\|active` forces that interaction state on the first card, or the first row with `layout=list` |
| `artifact-view.html` | Artifact view | `tab=versions\|share\|details`, `panel=open\|closed`, `menu=none\|version\|more`, `notice=none\|slow\|cpu`, `reloads=0\|2` | Title bar, version picker, side panel, raw-open. `notice=slow\|cpu` shows a dismissible info strip above the frame while the artifact stays visible (the shell can't prove a failure); `reloads=2` adds the Workers Paid hint, with See plans for owner and admin only |
| `version-diff.html` | Version diff | `menu=none\|a\|b` | Source diff plus rendered previews side by side |
| `public-viewer.html` | Anonymous public viewer | none | Minimal chrome, no sign-in |
| `share-dialog.html` | Share dialog | `as=creator\|editor\|viewer`, `vis=team\|private\|public` | Visibility segmented control, invites with role, copy link. Non-creators see everything read-only except Copy link |
| `settings.html` | Settings | `tab=members\|agents\|instance\|token-created` | Agents tab: MCP URL, snippets, OAuth clients, tokens. `tab=token-created` opens the Agents tab with the dialog that shows the new token once |
| `usage.html` | Usage | `state=not-configured`, `cpu=default\|hits` | Four meters with limits, plus a CPU card (per-request limit, not a quota). `cpu=hits` shows 4 requests over the limit and a 9.6 ms p99. "Not configured" state with setup steps |
| `edge-pages.html` | Edge pages | `page=no-access\|sign-in\|not-found\|quota`, `name=` (sign-in); `state` is `default\|loading\|error` only | See below |
| `oauth-consent.html` | OAuth consent | none | No JavaScript; see below |
| `bus.html`, `bus-revoke.html` | Your machines and agents (`/bus`), revoke confirm | none | No JavaScript; see below |

### Edge pages

- `?page=no-access`: signed in, not a member, nothing shared. Offers "Sign in as someone else".
- `?page=sign-in`: "Continue with Cloudflare Access". The heading reads "Sign in to Open Artifacts" by default, because anonymous visitors may not know the instance name. Add `name=` (for example `name=Northwind%20Eng`) to show the variant for a known instance name. `state=loading` shows the redirecting button; `state=error` shows a failed-sign-in banner.
- `?page=not-found`: the 404. An artifact the viewer can't access returns this same page, so the copy never says whether it exists.
- `?page=quota`: the library with the danger banner "Daily free-plan limit reached; resets at 00:00 UTC". `state=loading` shows skeleton cards.

### OAuth consent

Server-rendered by Backend from this file. It's self-contained (inlined tokens, system font stack, no external requests, under 8 KB) and works without JavaScript. Dark mode follows `prefers-color-scheme` only, so it has no `theme` param. The `{{placeholder}}` list is in the HTML comment at the top of the file. The form POSTs `decision=approve` or `decision=deny` with `csrf` and `request` hidden fields.

### Your machines and agents (`/bus`)

Server-rendered from `bus.html` (the page) and `bus-revoke.html` (the revoke confirm), like consent: self-contained, no JavaScript, dark mode from `prefers-color-scheme`. Repeated rows and the inline messages come from `bus-snippets/`. Each file's top comment lists its `{{placeholders}}`; `bus.html`'s also lists the `<!-- block:NAME -->` sections each state keeps. `apps/server/scripts/emit-bus-templates.ts` emits all three into `apps/server/src/bus/page-template.ts`, and `test/bus.page.test.ts` fails when that file is stale.
