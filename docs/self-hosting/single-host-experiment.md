# Single-host delivery experiment

This opt-in branch experiments with running the application and artifact content on one hostname. It is not a released upstream deployment option or a production security certification. Existing installs remain on the separate content-host mode unless explicitly configured otherwise.

In this mode `/c/…`, `/p/…` and manifest-scoped `/_oa/…` use the existing content handler, including its signed URL checks, response CSP sandbox and opaque iframe origin. The application, OAuth and MCP routes remain on their existing paths. The viewer keeps its Window, opaque-origin and per-load nonce checks. Arbitrary interactive HTML and multi-file assets remain supported targets; this mode does not sanitize artifacts into static pages.

For a fresh experimental installation the setup interface is `--single-host --app-host artifacts.example.com`, with the usual owner/name/solo arguments. No second hostname argument is required. The rendered configuration has one Custom Domain, equal APP_HOST/CONTENT_HOST, and CONTENT_ROUTING=path. Omitting the flag still requires different hostnames. This branch has only been exercised locally; do not use setup to change an existing production install during this experiment.

Saved single-host state retains its mode on upgrade. A state-less `--upgrade --name` can recover the mode from the deployed Worker. If all app/content/owner flags are supplied and no state is present, also supply `--single-host`: setup deliberately does not infer a mode from equal hostnames. There is no supported in-place switch between modes in this experiment. Before writing setup state, configuration or resources, setup verifies the deployed routing mode; an unreadable or unknown mode stops the run. Do not remove an old domain binding or reinterpret its URLs during an upgrade.

The security tradeoff is losing the separate network-origin layer. Response and iframe sandbox remain required, without allow-same-origin. Same-host navigations may carry app cookies; the content handler must continue ignoring them, and content CORS must never spread to app APIs. An iframe sandbox is not a reason to remove CSP, top-level handling or cookie/CSRF checks.

## Reproduce locally

Install the pinned package manager/dependencies, then build `@oa/server` from this branch. Use an isolated test port and the real-server harness; it creates temporary local D1/R2/KV/DO state and tears down its server. It does not deploy Cloudflare resources. Browser binaries must match the installed Playwright version.

```sh
pnpm --filter @oa/server build
OA_E2E_SINGLE_HOST=1 OA_E2E_PORT=8897 OA_E2E_SKIP_BUILD=1 pnpm --filter @oa/dashboard exec playwright test -c playwright.single-host.config.ts
```

The opt-in config covers HTML, Markdown, PDF, multi-file module/CSS loading, version update, public/private content, direct visits, cookie API read/preflight isolation, a real logout form with trusted session readback, and nonce/renavigation checks in Chromium, WebKit and Firefox. It adds no browsers to the default CI matrix. Run the normal real-server config without OA_E2E_SINGLE_HOST for two-host regression checks.

The existing `consent.spec.ts`, `artifact-links.spec.ts` and first OAuth/MCP publish case in `agent-journey.spec.ts` can also run under OA_E2E_SINGLE_HOST=1. The upstream harness documents that WebKit drops the provider's Secure consent cookie over plain HTTP localhost; a successful local preview does not claim WebKit HTTPS OAuth acceptance. Production HTTPS/cookies, actual Access sign-in, hosted embedding, capture and deployed-client compatibility still need their own acceptance. Do not publish test traces containing credentials or signed content URLs.
