# Email templates

Transactional emails in the Studio direction (see `../DIRECTION.md`). Each one has an HTML and a plain-text part; send both as `multipart/alternative`.

| Template | Subject |
|---|---|
| `invite.html`, `invite.txt` | `{{inviterName}} added you to {{instanceName}}` |
| `share.html`, `share.txt` | `{{inviterName}} shared “{{artifactTitle}}” with you` |

## Placeholders

| Placeholder | Used in | Meaning |
|---|---|---|
| `{{inviterName}}` | both | Display name of the member who added or shared, falling back to their email |
| `{{instanceName}}` | both | The instance's display name; also the invite CTA label, `Go to {{instanceName}}` (the share CTA is `Open the artifact`) |
| `{{introLine}}` | invite | The intro sentence, computed by the server. When `instanceName` is not `Open Artifacts`: `{{instanceName}} runs Open Artifacts, a place where any AI agent publishes pages, docs, code and PDFs for your team.` Otherwise: `Open Artifacts is a place where any AI agent publishes pages, docs, code and PDFs for your team.` Escape it like any other value |
| `{{recipientEmail}}` | both | The address this email goes to |
| `{{signInLine}}` | both | How this address signs in, computed by the server from the sign-in methods that can admit it (never promises a one-time code unless codes are offered to it). For example `There's no password to set up. You'll sign in with your Google account or a one-time code sent to ada@acme.com.` On a share whose recipient can't sign in yet, it says so and asks them to get an invite |
| `{{signInPreheader}}` | invite (HTML) | The same sentence for the hidden preheader, naming `this address` instead of the email |
| `{{appHost}}` | both | The instance's host, such as `artifacts.example.com` (no scheme) |
| `{{logoUrl}}` | both (HTML) | Absolute HTTPS URL of `logo@2x.png` served by the instance |
| `{{signInUrl}}` | invite | Absolute URL of the sign-in page, ideally with the email prefilled |
| `{{artifactUrl}}` | share | Absolute URL of the shared artifact; it routes through sign-in when needed |
| `{{artifactTitle}}` | share | The artifact's title |
| `{{artifactFormat}}` | share | Human-readable format: `HTML page`, `Markdown doc`, `Code`, `PDF` |
| `{{role}}` | share | `Viewer` or `Editor` |

**Escape every value.** Backend must HTML-escape each value before substituting it into the `.html` files (titles and names are user-controlled), and must not escape values going into the `.txt` files or the subject. URLs must be absolute `https:` URLs; reject anything else.

## Logo

Email clients don't render inline SVG reliably, so the HTML uses `<img src="{{logoUrl}}" width="156" height="44">`. Backend serves `logo@2x.png` (312×88, checked in here) from the instance, rendered at 2x from `packages/ui/src/brand/logo.svg`. It sits on an opaque white plate so it stays legible when a client darkens or inverts the email. This is the only image; there are no tracking pixels or other remote resources.

To re-render after the logo changes, screenshot the SVG at 123×22 inside a 156×44 white plate (1px `#E0E3E8` border, 8px radius) at `deviceScaleFactor: 2` with a transparent page background.

## Email-safe rules

- Table layout, inline styles, 560px max width, hidden preheader, bulletproof button with a VML fallback for Outlook.
- The only `<style>` block holds dark-mode overrides (`prefers-color-scheme` and Outlook's `[data-ogsc]`/`[data-ogsb]`) and the mobile padding tweak. Clients that strip it get the light design.
- Geist is named first in the font stack but never loaded; clients fall back to the system sans.
- Copy has no em dashes.
