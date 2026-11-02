# Track I — Integration, adversarial pass, deploy, release

Read `00-overview.md` first.

**Ownership:** I1 and I2 belong to **OpenArtifacts QA & Security**, an independent red team that didn't write the code. QA & Security is a cyberstrike session on the agent-bus (see the overview). I3 and I4 belong to **OpenArtifacts Platform**. Frontend and Design join where noted. These tasks start once their milestone inputs (listed in the overview) are green.

Anything shown to the user goes to them as visually rich HTML in the visual companion.

---

### Task I1: Cross-track end-to-end ("an agent's day")

**Files:**
- Create: `e2e/agent-journey.spec.ts` (repo root Playwright project) and `e2e/mcp-client.ts`.

**Interfaces:**
- Consumes:
  - FE12 `fixtures.ts`.
  - `@modelcontextprotocol/client`, which `mcp-client.ts` wraps as a real MCP client over Streamable HTTP. It supports both auth modes: a PAT, and OAuth with a dev-login session that drives the consent page.

**What the journey covers:**

1. An agent connects through **OAuth** (register → consent as a member). It calls `publish_artifact` with a 3-file HTML poll. The poll declares `capabilities: { db: true, viewer: true }` and uses `openArtifacts.db.collection("votes")`.
2. The owner opens the library. The poll is listed, and `lastAgent` shows the registered client name.
3. Owner and member vote in two separate browser contexts. Each sees the other's vote **live**, within 2 s, without reloading.
4. The agent publishes v2 with a changed label. The diff shows that line, and the votes from v1 survive.
5. The owner makes the poll **public** with `allowAnonymousWrites`. An anonymous context votes. The 31st anonymous write in a minute is rejected with a visible error.
6. The agent uploads a 5 MB PDF with `create_upload` → PUT → `publish_artifact`. The owner views it. After that, `search_artifacts` finds a phrase from page 2 (the text came from the browser).
7. The owner deletes the poll. The agent's `get_artifact` gets `not_found`. The owner undoes the delete, and it comes back.
8. A PAT agent runs `artifact_data_query` and reads the votes.

**Steps:**

- [ ] **Step 1: Write the spec.**
- [ ] **Step 2: Run it and fix anything it uncovers.** Fixes go to the owning track, with a message to that track's lead.
  - Run: `pnpm playwright test e2e/agent-journey.spec.ts`
  - Expected: PASS three runs in a row (a flakiness gate).
- [ ] **Step 3: Commit.** Message: `test(e2e): agent journey`.

---

### Task I2: Adversarial security pass (all leads)

**Files:**
- Create: `e2e/escape.spec.ts`, `e2e/fixtures/malicious/*.html`, and `docs/security/2026-review.md`.

**Malicious fixtures.** Each one is published and opened in the shell. Each must fail in exactly the way described:

| Fixture | What it tries | Expected outcome |
|---|---|---|
| `read-parent.html` | `parent.document.cookie` | Throws a SecurityError. The artifact reports through `db.set` that it caught it. |
| `top-nav.html` | `top.location = "https://evil.test"` | The shell URL is unchanged. |
| `fetch-api.html` | `fetch("http://app.localhost:8787/api/v1/me", { credentials: "include" })` | Rejected or 401. The opaque origin blocks the cookie. |
| `forge-result.html` | Posts `{oa:1,type:"result",…}` and fake `welcome` messages to itself and to the parent | The shell ignores them. No state changes. |
| `cross-artifact.html` | Calls `db.set` with params naming another artifact's id | The write lands in its **own** DO. The other artifact is unchanged. |
| `popup-escape.html` | `window.open` then accesses `opener` | The popup stays sandboxed. `opener` is null. |
| `svg-script.svg` (entry) | Script inside SVG on the content host | Runs only inside the sandbox. Same checks as `read-parent`. |
| `meta-refresh.html` | `<meta http-equiv=refresh>` to the app host's `/auth/logout` | The app session survives. CSRF protection and SameSite rules apply. |
| `huge-dom.html` | A 50 MB DOM via the runtime snapshot | The thumbnail is refused (over the size limit). The shell stays responsive. |

**Steps:**

- [ ] **Step 1: Write the spec with every fixture above.**
- [ ] **Step 2: Fan out reviewers.** Dispatch three parallel adversarial subagents, one per lead:
  - **Backend:** auth, OAuth, PAT, signing, D1 injection, and the DO.
  - **Frontend:** the bridge, XSS, and CSRF.
  - **Design and docs:** whether `security.md` claims match observed behavior.

  Each writes failing tests for any finding.
- [ ] **Step 3: Fix and record.** Fix everything. Record each finding in `docs/security/2026-review.md`: the issue, its severity, the fix, and the test that pins it.
  - Run: `pnpm playwright test e2e/escape.spec.ts && pnpm test`
  - Expected: all pass.
- [ ] **Step 4: Commit.** Message: `test(security): sandbox escape suite and review`.

---

### Task I3: Staging becomes a real, open instance

**Interfaces:**
- Consumes: B16 setup, I1, and I2 (all green on staging).

**Steps:**
- [ ] **Step 1: Prove setup adopts the existing staging resources.**
  - Run `pnpm oa:setup --name open-artifacts-staging --app-host staging.open-artifacts.com --content-host staging-content.open-artifacts.com --owner-email <the owner's address> --upgrade --json`.
  - Expected: every resource step reports `skipped`, and `deploy` and `selftest` report `ok`.
- [ ] **Step 2: Prove the install flow end to end, following `llms.txt` to the letter.**
  - Do a fresh clone into a scratch dir, using the landing preview's `/llms.txt`.
  - Run `pnpm oa:setup --name oa-e2e-scratch`, with hosts `scratch.open-artifacts.com` and `scratch-content.open-artifacts.com`.
  - Expected: everything is created and the self-test is green.
  - Then tear the scratch instance down with `pnpm oa:setup --name oa-e2e-scratch --destroy`. Add the `--destroy` flag to B16 in this task's PR: it deletes the worker, D1, R2, KV, and Access app, behind a typed-name confirmation.
- [ ] **Step 3: Show the user the I2 security review summary** as a visual-companion page. This is for their information only; don't wait for a reply.
- [ ] **Step 4: Run the I1 journey against staging.**
  - Use `E2E_BASE_URL=https://staging.open-artifacts.com`, a real one-time-PIN login done once by the user, and a stored Playwright storage state.
- [ ] **Step 5: Run the B17 CPU scenarios against staging,** using `wrangler tail --env staging --format json`.
  - Expected: every p95 is ≤ 10 ms.
  - Ship any fixes as PRs.

---

### Task I3b: Production instance at artifacts.leourbina.com (owner: OpenArtifacts Platform)

- [ ] **Step 1:** At the first stable release (after B14), install production by following llms.txt from that tag:
  `pnpm oa:setup --name open-artifacts-prod --app-host artifacts.leourbina.com --content-host artifacts-content.leourbina.com --owner-email <the owner's address> --json`.
  Relay each `action_required` to the user as a blocker.
- [ ] **Step 2:** Add a `deploy-prod` job to `release-please.yml` that runs only for stable releases and calls `oa:setup --upgrade --name open-artifacts-prod --json`, with the same secrets preflight and smoke as staging. A test asserts that it never runs for pre-releases or on pushes to main.
- [ ] **Step 3:** Verify: owner login on `artifacts.leourbina.com`, a publish from a real agent over MCP, and the B17 CPU budgets on production.

### Task I4: M3 release via release-please (merged by the Platform lead; no human gate)

Earlier releases go out the same way at M1 (expected 0.1.0) and M2. Use Steps 1–3 below for those as well.

**Interfaces:**
- Consumes: the release-please PR, which F4 has kept up to date on every merge.

**Steps:**
- [ ] **Step 1: Check the release PR.**
  - Its `CHANGELOG.md` must list every feature by scope, with no `chore` noise.
  - The version is whatever release-please computed. Don't override it.
  - Fix bad entries by editing the squash titles' follow-ups. Use a `fix:` or `docs:` PR, never a hand edit of the release PR.
- [ ] **Step 2: Show the user the release notes** as a visual-companion page, with links to staging and the landing preview. This is for their information only; don't wait for a reply.
- [ ] **Step 3: Merge the release PR.**
  - Run: `gh pr merge <release-pr> --squash`.
  - Expected: release-please creates the release tag and a GitHub release, and `release-please.yml` deploys `apps/landing` to `open-artifacts.com`.
  - Verify with `curl -s https://open-artifacts.com/llms.txt`. It must contain the setup procedure, and `git ls-remote --tags https://github.com/open-artifacts-ai/open-artifacts 'v*'` must show the new tag.
- [ ] **Step 4: Verify the release from a stranger's point of view.**
  - Follow `https://open-artifacts.com/llms.txt` from a clean directory, installing the new tag into a scratch instance.
  - Expected: green, with no local state.
  - Destroy the scratch instance afterward.
- [ ] **Step 5: Final whole-system review.**
  - Dispatch a fresh reviewer on the most capable model with the spec, this plan, and the repo.
  - Brief: "List every spec requirement not demonstrably working on staging, with evidence."
  - Close each gap with PRs, or get the user's sign-off to defer it.
