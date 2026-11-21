# Folders and tags F3: Agent filing and the backlog sort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any AI agent files what it publishes into the right folder (best guess, tags included) and asks first before access changes; and, when folders ship, each person's own agent proposes a folder tree and tags for that person's existing artifacts, the person reviews it on a proposal page, and the agent applies only what was approved.

**Architecture:** The filing rule lives in one place, a new `folders` section in `apps/server/src/mcp/instructions.ts`, which feeds the MCP server instructions and the generated skill; the landing docs (`mcp-tools.md`, `llms.txt` through `apps/landing/src/lib/llms.ts`) carry the same rule. The sort is a server object, a `sort_proposals` row: the agent creates it with `propose_sort`, the server validates scope and computes each item's access change with F1's `previewAccess`, the person edits and approves it on the dashboard page `/sort/<id>` from a signed-in browser session, approval mints an F1 confirmation token bound to the approved revision, and `apply_sort` runs the approved items in pages through F1's folder, move and tag services.

**Tech Stack:** Cloudflare Workers, Hono, Drizzle + D1, zod, `@modelcontextprotocol/server`, React 19 and TanStack Router and Query, Astro (landing), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-22-folders-and-tags-design.md` (PR #429), "Agents" and "Sorting the backlog". **Builds on:** `docs/superpowers/plans/2026-10-22-folders-f1-server.md` (`resolveFolderPath`, `createFolder`, `moveItems`, `setTags`, `previewAccess`, `signConfirm`/`verifyConfirm`, `requireConfirmed`, the MCP tools) and `docs/superpowers/plans/2026-10-22-folders-f2-dashboard.md` (`AccessWarning`, `FolderTree`, `MovePicker`).

**Depends on:** Task 1 needs F1 Task 14 (the tool names it documents). Tasks 2 to 5 need F1 Tasks 7 to 14. Task 6 needs F2 Tasks 1 and 5.

## Open questions for the manager

All settled 2026-10-22. The coordinator took each plan default below as written. Build to the defaults.

1. **Where the proposal page lives.** Plan default: a dashboard page (`/sort/<id>`) over a server-stored proposal, so approval is a real signed-in action and edits are validated. The alternative is a published artifact with live data that the agent reads back; it is simpler to build but anyone the agent shares it with could approve. Confirm the dashboard page.
2. **Who can approve.** Plan default: approval needs an interactive browser session (sign-in methods `access`, `google`, `code`, `dev`), never a PAT or an MCP OAuth grant, so an agent can't approve its own proposal. Confirm.
3. **The person's own artifacts that live in someone else's folder.** They are the person's (ownership doesn't change), but moving them would remove the folder's people from them. Plan default: left out of the sort, and listed on the page as "in folders others own".
4. **How long a proposal stays open.** Plan default: 7 days, then it expires and nothing in it can be applied.
5. **Tags on apply.** Plan default: proposed tags are added; tags an artifact already has are never removed by the sort.

## Global Constraints

- It mirrors Google Drive; agents never move or re-share anything without the person seeing what will change.
- Filing rule (spec): MCP publish and update accept a folder (by id or by path such as `open-artifacts/hosted/specs`) and tags. With no folder named, the agent picks the best existing folder from context (the repo or project it's working in, the conversation, where similar artifacts already live), creates one if nothing fits, and uses the top level if it can't guess.
- Ask first (folder actions only; `share_artifact`, `unshare_artifact` and `set_visibility` stay one-call): any folder action that would change who can see something returns a preview and a short-lived token; the agent shows the preview, gets the person's yes, then calls again with the token. Without the token nothing changes. Filing where only the person can see needs no confirmation.
- Sort scope: each person sorts only artifacts they own, with their own agent. Artifacts shared with them are out, and nobody sorts another user's library. Hosted: a space manager can run the same flow for a shared space.
- The proposal is shown before anything moves; the owner approves it, edits it, or rejects it. Nothing is shared more widely as a side effect: every artifact keeps its current access unless the owner approves that change.
- Agent-facing text is vendor neutral and says "any AI agent"; no em dashes anywhere.
- Copy, migration, D1-rows and query-plan rules from F1's Global Constraints apply.

## Review Focus

1. **A proposal that names an artifact the caller doesn't own** (an agent bug, or a shared artifact). Expect `propose_sort` to refuse with the ids listed and store nothing; such an item can never reach `apply_sort`. Tested in Task 3.
2. **The owner edits after approving.** Any edit makes a new revision and clears the approval, so the token the agent holds stops working until the owner approves again. Tested in Task 4.
3. **Apply stops halfway** (a timeout or an expired token on page 3 of 5). Calling again resumes where it stopped: folders already made are reused, nothing is moved twice, no duplicate folders appear. Tested in Task 4.
4. **Access changed between approval and apply** (someone shared a target folder). The affected item is skipped and reported, never moved with the new, unapproved access. Tested in Task 4.
5. **An agent asked to "just sort everything" with a PAT.** Approval from a PAT or MCP grant is refused, so the agent can't skip the person. Tested in Task 4.

---

## File structure

- `apps/server/src/mcp/instructions.ts` (modify): `folders` and `sorting` sections and their place in `ORDER`; regenerated `skill.generated.ts`.
- `apps/landing/src/content/docs/mcp-tools.md` (modify): `## Folders and tags`, `## Sorting your library`; `apps/landing/src/lib/llms.ts` (modify).
- `packages/shared/src/sort.ts` (create), `FOLDERS_CONTRACT.md`, `routes.ts`, `errors.ts`, `index.ts` (modify); `packages/shared/src/mocks/sort.ts` (create).
- `apps/server/migrations/NNNN_sort_proposals.sql` (create; suffix `_sort_proposals.sql`); `src/db/schema.ts` (modify).
- `apps/server/src/services/sort.ts`, `routes/sort.ts`, `mcp/tools/sort.ts` (create); `mcp/tool-defs.ts`, `mcp/server.ts`, `auth/route-policy.ts`, `routes/index.ts` (modify).
- `apps/dashboard/src/sort/SortProposal.tsx` (create); `router.tsx`, `api/queries.ts` (modify).
- Tests as named per task.

## Contract names (Task 2 produces)

- `SortProposalInput { spaceId?: string; items: { artifactId: string; folderPath: string | null; tags?: string[] }[] }` (at most `SORT_LIMITS.items`, 1000; paths as in F1's `resolveFolderPath`).
- `SortItem { artifact: { id; title }; from: FolderRef[] | null; to: string | null; tags: string[]; included: boolean; access: AccessPreview | null; accessApproved: boolean; skipped: null | "access_changed" | "gone" | "not_owned" }` (`access` without `confirmToken`).
- `SortProposal { id; url; status: "open" | "approved" | "rejected" | "applying" | "applied" | "expired"; revision: number; scope: { kind: "personal" } | { kind: "space"; space: SpaceRef }; newFolders: string[]; items: SortItem[]; excluded: { artifactId: string; reason: "in_others_folder" }[]; summary: { moves: number; newFolders: number; tagged: number; accessChanges: number }; createdAt; expiresAt; confirmToken?: string }` (`confirmToken` only to the proposal's creator, only while approved).
- `SortProposalPatch { revision: number; items?: { artifactId: string; to?: string | null; tags?: string[]; included?: boolean; accessApproved?: boolean }[]; renames?: { from: string; to: string }[] }`.
- `SortApplyInput { confirmToken: string }`; `SortApplyResult { applied: number; skipped: SortItem[]; remaining: number; continueToken: string | null }`.
- Routes: `R.sortProposals` (POST), `R.sortProposal(id)` (GET, PATCH), `R.sortApprove(id)`, `R.sortReject(id)`, `R.sortApply(id)` (POST); page `sortPath(id)` = `/sort/<id>`.
- Errors: `sort_scope` (400, details `{ artifactIds: string[] }`), `sort_revision` (409: the revision moved on), `sort_closed` (409: rejected, applied or expired), `interactive_required` (403: approve from a signed-in browser).
- `SORT_LIMITS = { items: 1000, applyPage: 100, ttlDays: 7 }`.

---

### Task 1: The filing rule in the agent-facing docs

**Files:**
- Modify: `apps/server/src/mcp/instructions.ts`, `apps/landing/src/content/docs/mcp-tools.md`, `apps/landing/src/lib/llms.ts`; regenerated `apps/server/src/mcp/skill.generated.ts`
- Test: `apps/server/test/skill.test.ts`, `apps/server/test/mcp.neutral.test.ts`, `apps/landing/test/llms.test.ts`, `apps/landing/test/mcp-tools.test.ts`

**Interfaces:**
- Consumes: F1's tool names (`list_folders`, `create_folder`, `move_artifact`, `move_folder`, `set_tags`, `share_folder`, `unshare_folder`, `set_folder_visibility`) and `publish_artifact`'s `folderId`, `folderPath`, `tags`, `confirmToken`.
- Produces: `SECTIONS.folders` (title "Folders and tags"), placed after `publishing` in `ORDER`; the `sharing` section's "owner only" line updated to "the owner, a space manager, or an editor of a folder above it (unless the folder's owner turned off sharing for editors)". The body is this exact copy:

```text
- Every artifact is at the top level or in exactly one folder. Folders nest, and sharing a folder shares everything in it, including what is added later.
- When you publish, pass folderId or folderPath (for example "open-artifacts/hosted/specs") and tags. publish_artifact with an id and a folder moves the artifact.
- If the person didn't name a folder, pick the best existing one from context: the repo or project you're working in, the conversation, and where similar artifacts already live (list_folders, list_artifacts, search_artifacts). If nothing fits, create one with create_folder. If you can't tell, publish at the top level.
- Ask first. If a call would change who can see something (publishing into a shared folder, moving into or out of one, sharing a folder or changing a folder's visibility), it returns status "confirm" with who gains or loses access and a confirmToken. Nothing has changed yet. Show the person the preview, and call again with confirmToken only after they say yes. Filing where only the person can see needs no confirmation.
- Tags are shared labels across folders: everyone who can see an artifact sees its tags. Reuse the tags you see on similar artifacts; set_tags replaces an artifact's tags.
- You can't file something shared with you into your own folders.
```

- `mcp-tools.md` gains `## Folders and tags` with the same rule in prose; `llmsTxt()` adds `section(byId("mcp-tools"), "Folders and tags")` after "Large files".

- [ ] **Step 1: Failing tests:** `"the skill has a Folders and tags section with the filing rule"`, `"the instructions mention folderPath, create_folder and confirmToken"`, `"llms.txt includes the Folders and tags section"`, `"agent-facing text has no em dash and no vendor name"` (existing neutral test, now covering the new sections).
- [ ] **Step 2: Run** `pnpm -F @oa/server test skill mcp.neutral` and `pnpm -F @oa/landing test`. Expected: FAIL.
- [ ] **Step 3: Implement**, then `pnpm -F @oa/server gen` and commit the regenerated skill.
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `docs(agents): the filing rule and ask-first (F3)`

### Task 2: The sort contract and mocks

**Files:**
- Create: `packages/shared/src/sort.ts`, `packages/shared/src/mocks/sort.ts`
- Modify: `packages/shared/src/routes.ts`, `errors.ts`, `index.ts`, `mocks/handlers.ts` (`MockOptions.sort?: boolean`), `packages/shared/FOLDERS_CONTRACT.md`
- Test: `packages/shared/test/sort.test.ts`, `packages/shared/test/mocks.test.ts`

**Interfaces:**
- Produces: every name in "Contract names" above. Mock store: one open proposal for Ada with 6 items: 4 into new private folders, 1 into `Medical` (an access change naming Bob, not approved), 1 excluded as `in_others_folder`.

- [ ] **Step 1: Failing tests:** `"SortProposalInput refuses 1001 items"`, `"SortProposalPatch needs revision"`, `"the mock refuses approve without the current revision (409 sort_revision)"`, `"the mock hides confirmToken until approved"`.
- [ ] **Step 2: Run** `pnpm -F @oa/shared test sort mocks`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): backlog sort contract and mocks (F3)`

### Task 3: Proposals: create, read, edit, reject

**Files:**
- Create: `apps/server/migrations/NNNN_sort_proposals.sql`, `apps/server/src/services/sort.ts`, `apps/server/src/routes/sort.ts`
- Modify: `src/db/schema.ts`, `routes/index.ts`, `auth/route-policy.ts`
- Test: `apps/server/test/sort.proposals.test.ts`, `test/d1-rows.test.ts`

**Interfaces:**
- Table: `sort_proposals(id pk, owner_user_id not null, space_id null, revision int, body json, status, approved_revision null, approved_at null, applied int default 0, cursor null, created_at, updated_at, expires_at)`, index on `(owner_user_id) where status in ('open', 'approved', 'applying')`.
- Produces:
  - `createProposal(env, user: Member, input: SortProposalInput): Promise<SortProposal>`: personal scope (no `spaceId`): every artifact must be live and owned by the caller in their personal space, else 400 `sort_scope` listing the ids, nothing stored; artifacts in a folder the caller doesn't own go to `excluded`. Space scope: the caller must be a manager of that shared space (`roleIn`) and every artifact must be live in it. Each item gets `access` from `previewAccess` (null when empty) and `accessApproved: false`; `newFolders` are the target paths that don't resolve yet.
  - `getProposal(env, user, id)`: the creator only (others 404); `confirmToken` only while approved; past `expires_at`, status `expired`.
  - `reviseProposal(env, user, id, p: SortProposalPatch)`: 409 `sort_revision` on a stale revision, 409 `sort_closed` when not open or approved; any change bumps `revision`, recomputes the changed items' `access`, and returns the status to `open` (clearing an approval).
  - `rejectProposal(env, user, id)`: status `rejected`.
- Routes: `POST R.sortProposals` `{ user: "authorizes each item itself" }`; `GET`/`PATCH R.sortProposal(id)`, `POST R.sortReject(id)` `{ user: "the creator's own proposal" }`.

- [ ] **Step 1: Failing tests:** `"a proposal with an artifact shared with me is 400 sort_scope and stores nothing"`, `"another user's artifact is 400 sort_scope"`, `"my artifact in Bob's folder is excluded as in_others_folder"`, `"an item into a shared folder carries its access change, not approved"`, `"new folders are listed, none created"`, `"nothing moves or changes on create"` (every level and `folder_id` unchanged), `"another user reading the proposal gets 404"`, `"hosted: a space manager proposes for the space; a space editor gets 404"`, `"a stale revision is 409 sort_revision"`, `"reject closes it"`, `"after 7 days it reads expired"`; `d1-rows`: `"creating a proposal writes 2 rows"`.
- [ ] **Step 2: Run** `pnpm -F @oa/server test sort.proposals`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm -F @oa/server test sort.proposals d1-rows route-policy`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): backlog sort proposals (F3)`

### Task 4: Approve and apply

**Files:**
- Modify: `apps/server/src/services/sort.ts`, `routes/sort.ts`, `auth/route-policy.ts`
- Test: `apps/server/test/sort.apply.test.ts`

**Interfaces:**
- Extends F1's `AccessOp` with `{ kind: "sort"; id: string; revision: number }` (its diff hash covers every approved item's `access`).
- Consumes: F1 `signConfirm`, `verifyConfirm`, `previewAccess`, `resolveFolderPath(..., { create: true })`, `moveItems(..., { requireConfirm: false })`, `setTags`; the request's sign-in method (P2 `MeAuth.method`).
- Produces:
  - `approveProposal(env, user, id, revision: number, method: AuthMethod): Promise<SortProposal>`: 403 `interactive_required` unless `method` is `access`, `google`, `code` or `dev`; 409 `sort_revision` on a stale revision; sets `approved_revision` and mints `confirmToken = signConfirm(env, user.id, { kind: "sort", id, revision }, approvedDiff)`.
  - `applyProposal(env, user, id, input: SortApplyInput): Promise<SortApplyResult>`: the token must verify for this user, proposal and approved revision (a `continueToken` from the previous page counts); status goes to `applying`; up to `SORT_LIMITS.applyPage` items per call, from the stored cursor: make missing folders (private, by path, reusing any that exist), move, then add tags. An item is skipped (`access_changed`) when its live `previewAccess` differs from the approved one, or when its access change wasn't approved; `gone` when the artifact is no longer live or no longer the caller's. The last page sets `applied` and returns `continueToken: null`.
- Routes: `POST R.sortApprove(id)`, `POST R.sortApply(id)` `{ user: "the creator's own proposal" }`.

- [ ] **Step 1: Write the failing tests**

```ts
it("approve from a PAT or MCP grant is 403 interactive_required", async () => { /* x2 */ });
it("approve from a browser session mints a token the creator can read", async () => { /* confirmToken present */ });
it("an edit after approval reopens it and the old token stops working", async () => { /* apply 409 */ });
it("apply moves only included items and leaves unapproved access changes where they are", async () => {
  /* Medical item: folder_id unchanged, skipped access_changed; Bob still 404 */
});
it("an approved access change applies with exactly the approved gains", async () => { /* Bob viewer */ });
it("access changed after approval: the item is skipped and reported", async () => { /* skipped access_changed */ });
it("new folders are private and created once even across a retried page", async () => { /* one row per path */ });
it("apply resumes from the cursor after an interruption, with no duplicate moves", async () => {
  /* 250 items: page 1, fail page 2 midway, retry: applied 250, each artifact moved once */
});
it("existing tags are kept; proposed tags are added", async () => { /* union */ });
it("an artifact deleted since the proposal is skipped as gone", async () => { /* skipped gone */ });
```

- [ ] **Step 2: Run** `pnpm -F @oa/server test sort.apply`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm -F @oa/server test sort.apply sort.proposals`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): approve and apply a sort (F3)`

### Task 5: The sort tools and the sorting procedure

**Files:**
- Create: `apps/server/src/mcp/tools/sort.ts`
- Modify: `mcp/tool-defs.ts`, `mcp/server.ts`, `auth/route-policy.ts` (`TOOL_POLICY`), `mcp/instructions.ts` (`SECTIONS.sorting`), `apps/landing/src/content/docs/mcp-tools.md` (`## Sorting your library`), `apps/landing/src/lib/llms.ts`; regenerated `tool-manifest.json`, `skill.generated.ts`, `upgrade.generated.ts`
- Test: `apps/server/test/mcp.sort.test.ts`, `test/mcp.tools.test.ts`, `test/mcp.auth.test.ts`, `test/mcp.neutral.test.ts`, `test/smoke/mcp.ts`, `apps/landing/test/llms.test.ts`

**Interfaces:**
- Tools: `propose_sort` (`SortProposalInput`; result text "Nothing has moved. Send the person this link to review it: <url>" plus `SortProposal`), `get_sort_proposal { id }`, `apply_sort { id, confirmToken }` (result `SortApplyResult`; text says to call again with `continueToken` while `remaining > 0`). `TOOL_POLICY`: `{ user: ... }` for all three.
- `SECTIONS.sorting` (title "Sorting your library"), exact copy:

```text
- Sort only what the person owns, and only when they ask. Never include artifacts shared with them.
- Read their artifacts (list_artifacts with scope "mine") and folders (list_folders), then draft a tree that fits how they work (projects, repos, areas of life) and tags that cut across it. Prefer new private folders; propose a shared folder only when that is clearly where something belongs.
- Call propose_sort with every item. Nothing moves. Send the person the link it returns and wait.
- The person reviews the proposal, edits it, and approves or rejects it there. Check with get_sort_proposal; once it is approved it carries a confirmToken.
- Call apply_sort with that token, and again with continueToken until remaining is 0. Tell the person what was skipped and why.
```

- Tool count: the live count after F1 plus 3, in all four count tests.

- [ ] **Step 1: Failing tests:** `"propose_sort returns the page URL and moves nothing"`, `"get_sort_proposal shows confirmToken only after approval"`, `"apply_sort without the token is an error and moves nothing"`, `"apply_sort pages with continueToken"`, `"tools/list count is F1's plus 3"`, `"llms.txt includes Sorting your library"`.
- [ ] **Step 2: Run** `pnpm -F @oa/server test mcp.sort mcp.tools` and `pnpm -F @oa/landing test`. Expected: FAIL.
- [ ] **Step 3: Implement**, then `pnpm -F @oa/server gen`.
- [ ] **Step 4: Run** `pnpm -F @oa/server test mcp route-policy skill upgrade` and `pnpm -F @oa/landing test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mcp): propose, review and apply a backlog sort (F3)`

### Task 6: The proposal page

**Gated on Design option DS1:** the proposal page: the proposed tree beside the item list, what goes where (from and to), access changes and their approve controls, include and exclude, retargeting an item and renaming a proposed folder, the excluded list, Approve and Reject, and the states (open, approved, applying, applied, expired, rejected). Design gives options; the owner picks.

**Files:**
- Create: `apps/dashboard/src/sort/SortProposal.tsx`
- Modify: `apps/dashboard/src/router.tsx` (`/sort/$id`), `api/queries.ts` (`useSortProposal`, `useReviseSort`, `useApproveSort`, `useRejectSort`)
- Test: `apps/dashboard/test/sort-proposal.test.tsx`, `apps/dashboard/e2e/sort.spec.ts`

**Interfaces:**
- Consumes: Task 2 mocks (`createHandlers({ folders: true, sort: true })`), F2 `AccessWarning` (each access change renders its preview), `FolderTree` for the proposed tree.
- Produces: `<SortProposalPage id={string} />`: every edit sends `PATCH` with the current `revision` (a 409 `sort_revision` reloads and says so); an access change is applied only when its own approve box is ticked (default unticked); Approve sends the revision; after approval the page says "Your agent can now apply this" and shows progress while `applying`.

- [ ] **Step 1: Failing tests:** `"the page lists what goes where and the new folders"`, `"the Medical item shows Bob gaining access, unticked"`, `"ticking it and approving sends accessApproved and the revision"`, `"excluding an item and retargeting another each send one PATCH"`, `"a stale revision reloads with a note"`, `"Reject closes the page with no further actions"`, `"an expired proposal shows read-only"`, `"another user's proposal is Not found"`; `e2e/sort.spec.ts`: axe in light and dark.
- [ ] **Step 2: Run** `pnpm --filter @oa/dashboard test -- sort-proposal`. Expected: FAIL.
- [ ] **Step 3: Implement per DS1.**
- [ ] **Step 4: Run** the same and `pnpm --filter @oa/dashboard test:e2e -- sort`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): backlog sort proposal page (F3)`

### Task 7: The agent journey end to end

**Files:**
- Create: `apps/dashboard/e2e/real/sort.spec.ts`
- Modify: `apps/dashboard/e2e/real/fixtures.ts`, `e2e/real/mcp-client.ts`; `tests/redline/test/folders.test.ts` (F1 Task 16)
- Test: the specs

**Interfaces:**
- Real config against `wrangler dev`: an MCP client as Ada publishes with `folderPath` (filed, no confirmation), publishes into a folder shared with Bob (status `confirm`, then with the token), proposes a sort of 30 artifacts, Ada approves in the browser, the client applies in pages, and the library shows the tree; Bob's access is unchanged except for the one change Ada approved.
- Red line: A's proposal id and A's sort token at B are refused (`crossCheck`), and B's proposal page never renders A's markers.

- [ ] **Step 1: Write the specs.**
- [ ] **Step 2: Run** `pnpm --filter @oa/dashboard test:e2e:real -- sort` and the red-line suite against `rl-a`/`rl-b`. Expected: PASS.
- [ ] **Step 3: Commit** `test(e2e): agent filing and the backlog sort (F3)`

---

## Task order

| Task | Depends on | Parallel with |
|---|---|---|
| 1 Filing rule docs | F1 T14 | 2, 3 |
| 2 Contract and mocks | F1 T1 | 1 |
| 3 Proposals | 2; F1 T7 to T12 | 1 |
| 4 Approve and apply | 3; F1 T9, T12 | 6 |
| 5 Tools and procedure | 4 | 6 |
| 6 Proposal page | 2; F2 T1, T5; DS1 | 4, 5 |
| 7 Journey and red line | 5, 6; F1 T16 | none |

## Self-review

- Spec coverage: publish and update with folder and tags, and the filing rule (Task 1; the parameters are F1 Task 14); ask-first in the docs (Task 1); llms.txt and the skill (Tasks 1, 5); the sort proposal, the page, approve, edit, reject (Tasks 3, 4, 6); applying through confirmation tokens (Task 4, 5); per-person scope and the hosted space-manager variant (Task 3); nothing shared more widely as a side effect (Task 4).
- Proportion: copy is given verbatim where the agent reads it; elsewhere signatures and test names.
