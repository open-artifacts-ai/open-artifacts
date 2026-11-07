# Real-client validation

Run on 2026-11-07 against a private synthetic HTML artifact, using the existing
OAuth-authorized Open Artifacts MCP connection. No store entries were seeded.
Personal instance URLs, session IDs and raw screenshots are omitted here.

## Claude Code CLI 2.1.319

- Loaded the candidate with `--plugin-dir`, explicit instance/namespace options
  and an isolated MCP configuration. The empty-session command returned no links.
- A real content publish created v1; a real read recorded checked v1. A new
  process resuming that session restored its title, URL and both version fields.
- The genuine PTY displayed the native band with a Chinese/emoji title. Native
  terminal screenshots and interactive terminal-link clicks were not exercised.
- `/clear` removed the band; `/oa-artifacts` returned no publications. Resuming
  the original session restored its own reference.
- `--fork-session --resume` created a distinct session whose command returned
  no publications, without inheriting the original session's shortcut metadata.
- After Desktop published v2, CLI still displayed published v1. An explicit
  service read returned the exact v2 HTML marker; the command then displayed
  published v1 and separately last checked v2 with its observation time.

## Claude Desktop Code 2.1.317

- Loaded the same candidate through the project `.claude/skills` plugin loader.
  The host identifies it as `open-artifacts-shortcuts@skills-dir`; options were
  configured with the official CLI `configure --values-stdin` command. Native
  debug output confirmed project settings are not sources for plugin options.
- Read the fixture's v1, then really published a changed HTML body with
  `expectedVersion: 1`, retaining private visibility. `/oa-artifacts` recorded v2.
- Reloading the plugin restored the published v2 link above the prompt. Its
  Chinese/emoji title remained on one row with the Files pane narrowing the
  transcript. The prompt retained focus after rendering.
- Clicking the band link opened the ordinary viewer: private, current v2, with
  the exact new synthetic HTML marker.
- `/clear` removed the band; the command returned no publications in the new
  session. No managed hook or trust policy was bypassed.

## Evidence limits

Synthetic tests cover concurrent completion, malformed receipts, store failures,
session switches during asynchronous reads/rendering and row limits. These are
separate from the real-client observations above. Real UI stress with ten
artifacts, extremely narrow terminal cells, logout/revocation and simultaneous
processes writing the same session were not exercised. The store is presentation
metadata, not an authorization source or an atomic distributed history.
