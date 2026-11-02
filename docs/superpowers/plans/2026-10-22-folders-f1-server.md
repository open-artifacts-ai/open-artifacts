# Folders and tags F1: Server and contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nested folders that share like Google Drive folders (access flows down, only adds, warns on moves), shared tags filtered by what each person can see, and MCP tools that never change who can see something without a preview and a confirmation token, on self-hosted and hosted installs alike.

**Architecture:** The contract (`packages/shared/src/folders.ts`, indexed by `packages/shared/FOLDERS_CONTRACT.md`) lands first, with mocks. Migration `NNNN_folders.sql` adds `folders` (adjacency, `space_id` always set: the owner's personal space on self-hosted, the space on hosted), a closure table `folder_ancestors(folder_id, ancestor_id, depth)` (self row at depth 0) and `folder_shares`, plus `artifacts.folder_id` and `artifacts.trash_root`; `NNNN_tags.sql` adds `tags` and `artifact_tags`. `decide` gains one input, the access inherited from live ancestor folders, and `can` gains Drive's folder-editor rights; `authorize` reads both in its one statement and `levelSql`/`listFilterSql` add uncorrelated folder branches. Every access-changing operation computes an `AccessPreview` (`services/access-diff.ts`) and, where confirmation is required, needs an HMAC token bound to the caller, the operation and the diff (`auth/confirm.ts`); REST moves and every MCP access change require it, REST share dialogs don't (the dialog is the confirmation, as in Drive).

**Tech Stack:** Cloudflare Workers, Hono, Drizzle + D1, Durable Objects, zod, vitest with `@cloudflare/vitest-plugin`, `@modelcontextprotocol/server`.

**Spec:** `docs/superpowers/specs/2026-10-22-folders-and-tags-design.md` (PR #429). Builds on P3 `docs/superpowers/plans/2026-10-21-hosted-m1-p3-rbac.md` (spaces, `decide`/`can`/`orgCan`, `authorize`, `levelSql`, `ROUTE_POLICY`/`TOOL_POLICY`, the move rules, the `test/authz/` matrix) and P5 `docs/superpowers/plans/2026-10-20-hosted-m1-p5-redline.md` (`tests/redline/`, `crossCheck`).

**Depends on:** Tasks 1 to 5 can start now (contract, mocks, migrations, pure policy). Tasks 6 onward need P3 Tasks 3, 4, 5 and 10 merged (`authorize` over spaces, `levelSql`, the policy gate, `moveArtifact`). Task 15 needs P3 Task 16; Task 16 needs P5 Task 2.

## Open questions for the manager

All settled 2026-10-22. The coordinator took each plan default below as written (question 7 is the owner's decision). Build to the defaults.

1. **"Editors can't share" reach.** Does the switch on a folder also govern its subfolders and everything below them (plan default: yes, any live ancestor with the switch on blocks inherited editors from sharing), or only that folder and its direct items?
2. **Space roles and Drive's editor rights (hosted).** Inside a folder in a shared space, does a space *editor* get Drive's folder-editor rights (share, change visibility, move, trash items others created), or only people who are editors through a folder share? Plan default: only folder shares and folder ownership grant those rights; space roles keep P3's table, so folders never widen what a space editor could do.
3. **Another owner's subfolder in a deleted folder.** The spec moves other owners' *artifacts* to their owners' top level. Plan default for other owners' *subfolders*: the same (the subfolder and its contents move to its owner's top level, keeping its shares).
4. **Restore onto a taken name.** Sibling names are unique, so a restored folder can collide with a live sibling. Plan default: restore under the name with " (1)", " (2)" appended, as Drive names copies.
5. **"/" in folder names.** Path addressing (`open-artifacts/hosted/specs`) needs a separator, so the plan refuses "/" in names (400). Drive allows it; confirm this second deliberate difference.
6. **Tag scope when `spaces` is turned on later** (our own install, P3 rollout step 2). Self-hosted tags are per install (`scope_id = "*"`); hosted tags are per space. Plan default: links made before the switch keep their install-scope tags, and new tags use the space scope, so one name can exist in both. Alternative: a one-off job, run when `spaces` turns on, that re-homes each link into its artifact's space. Which?
7. **Ask-first on the existing tools. Resolved (owner, 2026-10-22): folder actions only.** `share_artifact`, `unshare_artifact` and `set_visibility` stay one-call and unchanged; only `publish_artifact` with a folder target, `move_artifact`, `move_folder`, `share_folder`, `unshare_folder` and `set_folder_visibility` ask first.

## Global Constraints

- It mirrors Google Drive: anything that behaves differently from Drive is wrong unless the spec says otherwise. The one stated difference: siblings can't share a name.
- Each artifact is at the top level of its library or space, or in exactly one folder; its location is one global value, never per viewer. No shortcuts: an artifact appears in one folder only.
- Ownership never changes with location. You can't file an artifact shared with you into your own folders.
- Access flows down to everything inside, at any depth, including items added later. Access only adds: the level is the highest of the direct share, any folder above, and (hosted) the space role.
- Moves into or out of a shared folder warn and name who gains or loses access; direct shares on the moved item stay.
- While a folder is in trash, nobody gets access through it.
- Folder editors: Drive's rights (add, move, remove items, create subfolders, edit everything inside, share, change visibility, trash items others own; live-data writes included), unless the folder owner (or a space manager) turned on "Editors can't share".
- Hosted: a folder in a shared space can be shared only with people an artifact there could be shared with; Personal space folders follow the artifact guest rules; space public-links rules cap folders.
- Tags never grant access; a tag list shows only tags on at least one artifact the caller can see. Tag names are case-insensitive, shown as first typed. Tag admin: instance owner and admins (self-hosted), space managers (hosted).
- Ask first: any agent action that would change who can see something returns a preview and a short-lived token; without the token nothing changes. Filing where only the person can see needs no confirmation.
- Same feature on self-hosted and hosted, no hosted-only switch. Upgrades: existing artifacts land at the top level and nothing changes until someone creates a folder; `json-shapes.snapshot.test.ts` stays byte-identical for an install with no folders and no tags.
- Access checks go through `decide`/`can`/`orgCan` and the policy gate only. 404 for no access, never 403, except the explicit codes.
- Every migration is additive, `IF NOT EXISTS`, the next free number at rebase (tests find it by suffix); never `--allow-downgrade`. D1 rows written stay pinned in `test/d1-rows.test.ts`; plans pinned in `test/query-plans.test.ts`.
- No new KV namespace; confirmation tokens are stateless HMAC.
- Copy: no em dashes; say "any AI agent".

## Review Focus

1. **A guest whose only access is a folder share.** Removing the last *artifact* share must not deactivate a guest who still has a folder share, and removing their last folder share must deactivate them as the last artifact share does today (`UNSHARED_GUEST` in `services/shares.ts` reads only `shares`). Tested in Task 10.
2. **Moving a folder with more than 50 live artifacts out of a shared or public folder.** Every affected artifact's sockets must close, not only the first `MAX_CLOSE` (50) that `closeRuntimeSockets` signals. Tested in Task 9.
3. **A token used after access changed.** Someone shares the target folder between the preview and the confirm: expect 409 `confirm_required` with a fresh preview and nothing moved. Tested in Tasks 8 and 9.
4. **An artifact that was public only through a folder, after that folder goes to trash.** Expect `/p/` and the OG metadata to stop at once, and people with the folder share to lose access in the same request. Tested in Task 11.
5. **Renaming a tag onto a name that exists only on artifacts the admin can't see.** Expect a merge with no 409 and no hint of the hidden tag beyond the resulting visible count. Tested in Task 13.

---

## File structure

- `packages/shared/src/folders.ts` (create): folder, tag, move and preview shapes, `FOLDER_LIMITS`, `TAG_LIMITS`, `CONFIRM_TTL_SEC`, `folderCan`, `normTagKey`, `validFolderName`.
- `packages/shared/FOLDERS_CONTRACT.md` (create): the index, in `HOSTED_CONTRACT.md`'s style.
- `packages/shared/src/{schemas,routes,errors,index}.ts`, `src/hosted/core.ts` (modify): appended optional fields, `R.*`, error codes, `artifactCan` options.
- `packages/shared/src/mocks/{folders,handlers,fixtures}.ts` (create/modify).
- `apps/server/migrations/NNNN_folders.sql`, `NNNN_tags.sql` (create); `src/db/schema.ts` (modify).
- `apps/server/src/auth/policy.ts`, `authz.ts`, `route-policy.ts`, `keys.ts` (modify); `auth/confirm.ts` (create).
- `apps/server/src/services/folders.ts`, `moves.ts`, `access-diff.ts`, `folder-shares.ts`, `trash.ts`, `tags.ts` (create); `services/{artifacts,shares,search}.ts`, `content/app.ts`, `routes/artifacts.ts` (modify).
- `apps/server/src/routes/folders.ts`, `routes/tags.ts` (create); `routes/index.ts` (modify).
- `apps/server/src/mcp/tools/folders.ts` (create); `mcp/tool-defs.ts`, `mcp/server.ts`, `mcp/tools/artifacts.ts` (modify); regenerated `tool-manifest.json`, `skill.generated.ts`, `upgrade.generated.ts`.
- Tests under `apps/server/test/` as named per task; `apps/server/test/authz/` (P3) extended; `tests/redline/test/folders.test.ts` (P5 suite).

## Contract names (Task 1 produces; every later task uses them verbatim)

- `FolderRef { id, name }`; `Folder { id, name, parentId: string | null, space?: SpaceRef, owner: UserRef | null, visibility: Visibility, effectiveVisibility: Visibility, editorsCanShare: boolean, access: AccessLevel, can: FolderCan, path: FolderRef[], createdAt, updatedAt, deletedAt: string | null }` (`path`: root to parent; `owner` null in a shared space).
- `FolderCan { edit, share, setVisibility, delete, move, restrictSharing }`; `folderCan(level, { personal, cap, inheritedEditor, sharingRestricted })`.
- `FolderCreate { name, parentId?, spaceId? }`; `FolderPatch { name?, visibility?, editorsCanShare?, confirmToken? }`; `FoldersQuery { spaceId?, parentId? (id or "root"), scope?: "mine" | "shared", trashed?, cursor?, limit? }`.
- `FolderItems { folders: Folder[]; artifacts: Page<ArtifactSummary> }` (child folders complete, at most `FOLDER_LIMITS.childFolders`; the cursor pages artifacts).
- `ItemRef = { kind: "artifact" | "folder"; id }`; `MoveInput { items: ItemRef[] (1 to FOLDER_LIMITS.moveItems), to: { folderId: string | null; spaceId?: string }, confirmToken? }`; `MoveResult { moved: ItemRef[]; artifacts: ArtifactSummary[]; folders: Folder[] }`.
- `FolderShareInput { email, role: ShareRole, confirmToken? }` (response `ShareResult`).
- `Audience = { kind: "person"; email; name: string | null } | { kind: "team" } | { kind: "public" } | { kind: "space"; space: SpaceRef; memberCount: number }`; `AccessChange { who: Audience; from: AccessLevel | null; to: AccessLevel | null; via: FolderRef | SpaceRef | null; items: number }`; `AccessPreview { gains: AccessChange[]; losses: AccessChange[]; items: number; truncated: boolean; confirmToken: string; expiresAt: string }`.
- `Tag { id, name, count }` (count of artifacts the caller can see); `TagsQuery { spaceId?, q?, limit? }`; `SetTagsInput { tags: string[] }`; `TagPatch { name }`.
- Appended optional fields: `ArtifactSummary.folder?: FolderRef` (omitted at top level), `.tags?: string[]` (omitted when none), `.effectiveVisibility?: Visibility` (omitted when equal to `visibility`); `ListQuery.tag?`, `ListQuery.folderId?`; `SearchQuery.folderId?` (whole subtree), `SearchQuery.tag?`; `PublishInput.folderId?`, `.folderPath?`, `.tags?`, `.confirmToken?`; `MoveArtifactInput` unchanged.
- Routes: `R.folders`, `R.folder(id)`, `R.restoreFolder(id)`, `R.folderItems(id)`, `R.libraryItems` (`/api/v1/library/items?spaceId=`), `R.folderShares(id)`, `R.folderShare(id, email)`, `R.moves`, `R.tags`, `R.tag(id)`, `R.artifactTags(id)`; page helper `folderPath(id)` = `/folders/<id>`.
- Errors: `confirm_required` (409, details `AccessPreview`), `folder_name_taken` (409), `folder_cycle` (400), `folder_too_deep` (400), `move_blocked` (409, details `{ blocked: number; sample: ItemRef[] }`).
- Limits: `FOLDER_LIMITS = { nameMax: 200, depth: 20, perSpace: 5000, childFolders: 500, moveItems: 100 }`, `TAG_LIMITS = { nameMax: 50, perArtifact: 20, perScope: 2000 }`, `CONFIRM_TTL_SEC = 600`, `PREVIEW_PEOPLE = 50`.

---

### Task 1: The contract

**Files:**
- Create: `packages/shared/src/folders.ts`, `packages/shared/FOLDERS_CONTRACT.md`
- Modify: `packages/shared/src/schemas.ts` (appended optional fields), `routes.ts`, `errors.ts`, `hosted/core.ts` (`artifactCan` options), `index.ts`
- Test: `packages/shared/test/folders.test.ts`, `apps/server/test/json-shapes.snapshot.test.ts`

**Interfaces:**
- Produces: every name in "Contract names" above, plus `validFolderName(name: string): { ok: true; name: string } | { ok: false; error: string }` (NFC, trimmed, 1 to 200 chars, no "/", no control characters), `normTagKey(name: string): string` (NFC, trimmed, `toLowerCase()`), and `artifactCan(level, { personal, cap, inheritedEditor?, sharingRestricted? })` (new options default false, so today's results are unchanged).
- `inheritedEditor` true sets `share` and `setVisibility` to `!sharingRestricted`, and `delete` and `move` to true, for an uncapped `editor`; `folderCan` applies the same table to folders, with `restrictSharing` for owner and manager only.

- [ ] **Step 1: Write the failing tests**

```ts
it("artifactCan is unchanged without the new options", () => {
  for (const level of LEVELS) for (const personal of [true, false]) for (const cap of CAPS)
    expect(artifactCan(level, { personal, cap })).toEqual(P3_TABLE[level][String(personal)][String(cap)]);
});
it("an inherited editor may share, set visibility, move and delete", () => {
  expect(artifactCan("editor", { personal: true, inheritedEditor: true })).toMatchObject({ share: true, setVisibility: true, move: true, delete: true, transfer: false });
});
it("Editors can't share keeps move and delete but not share", () => {
  expect(artifactCan("editor", { personal: true, inheritedEditor: true, sharingRestricted: true })).toMatchObject({ share: false, setVisibility: false, move: true, delete: true });
});
it("a capped inherited editor gets viewer actions only", () => { /* every write false, dataWrite false */ });
it("validFolderName refuses '', 201 chars, '/', and U+0000", () => { /* ok: false x4; "  Specs " -> "Specs" */ });
it("normTagKey folds case and NFC", () => expect(normTagKey(" Café ")).toBe(normTagKey("café".toUpperCase())));
it("MoveInput refuses 0 and 101 items", () => { /* safeParse fails x2 */ });
it("R.folderShare encodes the email", () => expect(R.folderShare(ID, "a+b@x.com")).toBe(`/api/v1/folders/${ID}/shares/a%2Bb%40x.com`));
```

In `json-shapes.snapshot.test.ts`: `"an artifact at the top level with no tags serializes byte-identically"` (no `folder`, `tags` or `effectiveVisibility` keys).

- [ ] **Step 2: Run** `pnpm -F @oa/shared test folders`. Expected: FAIL, `Cannot find module '../src/folders.js'`.
- [ ] **Step 3: Implement** the shapes, routes, error codes (`STATUS_FOR` entries with one-line docs), and `FOLDERS_CONTRACT.md` (routes table with body, response and who; schemas table; errors table; the ask-first rule).
- [ ] **Step 4: Run** `pnpm -F @oa/shared test && pnpm -F @oa/server test json-shapes`. Expected: PASS, snapshot unchanged.
- [ ] **Step 5: Commit** `feat(shared): folders and tags contract (F1)`

### Task 2: Mocks for the dashboard

**Files:**
- Create: `packages/shared/src/mocks/folders.ts`
- Modify: `packages/shared/src/mocks/handlers.ts` (`MockOptions.folders?: boolean`), `mocks/fixtures.ts`
- Test: `packages/shared/test/mocks.test.ts`

**Interfaces:**
- Consumes: Task 1 shapes, `artifactCan`, `folderCan`.
- Produces: `createHandlers({ folders: true })` (off by default, so existing dashboard tests are unchanged). Store: Ada's tree `Projects / open-artifacts / specs` (private), `Medical` (shared with `bob@example.com` editor), `Job hunt` (team, "Editors can't share" on); "Meeting notes" filed in `specs`; tags `roadmap` (2 visible), `hosted` (1), and `layoffs` on an artifact the mock caller can't see (never listed). Every route in Task 1; moves into or out of `Medical` answer 409 `confirm_required` with a preview naming Bob until the body carries the returned token; `folder_name_taken` on a duplicate sibling.

- [ ] **Step 1: Write the failing tests:** `"folders off: no folder routes answer"`, `"tag list never includes layoffs"`, `"move into Medical without a token is 409 with Bob in gains"`, `"the same move with the token answers MoveResult"`, `"a duplicate sibling name is 409 folder_name_taken"`.
- [ ] **Step 2: Run** `pnpm -F @oa/shared test mocks`. Expected: 5 failed.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm -F @oa/shared test mocks`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mocks): folders and tags (F1)`

### Task 3: The folders migration

**Files:**
- Create: `apps/server/migrations/NNNN_folders.sql` (found by suffix `_folders.sql`)
- Modify: `apps/server/src/db/schema.ts`
- Test: `apps/server/test/folders.migration.test.ts`, `test/d1-rows.test.ts`, `test/query-plans.test.ts`

**Interfaces:**
- Tables (all `IF NOT EXISTS`, text PKs `WITHOUT ROWID` as in 0009):
  - `folders(id pk, space_id not null references spaces, parent_id null references folders, owner_user_id null references users, created_by not null, name not null, name_key not null, visibility default 'private' check in (private, team, public), editors_can_share int default 1 check in (0, 1), created_at, updated_at, deleted_at null, deleted_by null, trash_root null)`.
  - `folder_ancestors(folder_id, ancestor_id, depth, pk(folder_id, ancestor_id))`, index `folder_ancestors_ancestor_idx(ancestor_id)`; both FKs `on delete cascade`.
  - `folder_shares(folder_id, email, role check in (viewer, editor), created_by, created_at, pk(folder_id, email))`, index `folder_shares_email_idx(email)`, FK cascade.
- Columns: `artifacts.folder_id` (references folders), `artifacts.trash_root` (the folder whose deletion trashed it).
- Indexes: `folders_sibling_name_uq` unique on `(space_id, coalesce(parent_id, ''), name_key) where deleted_at is null`; `folders_space_live_idx(space_id) where deleted_at is null`; `folders_visible_live_idx(visibility) where deleted_at is null and visibility <> 'private'`; `artifacts_folder_live_idx(folder_id) where deleted_at is null and folder_id is not null`.
- Triggers: `folders_ancestors_self` (after insert: self row, then the parent's rows at depth + 1); `artifacts_folder_space_check` (before insert or update of `folder_id`: abort `'folder in another space'` when the folder is in a shared space whose id differs from `new.space_id`, or when a shared-space artifact names a personal-space folder).
- No backfill: every artifact stays at the top level.

- [ ] **Step 1: Write the failing tests**

```ts
it("after the migration every artifact is at the top level and every level is unchanged", async () => {
  const before = await snapshotLevels(env); await applyMigration(env, FOLDERS);
  expect(await snapshotLevels(env)).toEqual(before);
  expect(await count(env, "select count(*) from artifacts where folder_id is not null")).toBe(0);
});
it("inserting a folder writes its closure rows", async () => { /* a/b/c: c has (c,0),(b,1),(a,2) */ });
it("two live siblings can't share a name, case-insensitively", async () => { /* 'Specs' then 'specs' aborts */ });
it("a trashed sibling frees its name", async () => { /* insert succeeds */ });
it("a shared-space artifact can't point at a personal folder", async () => { /* aborts */ });
```

`d1-rows.test.ts`: publish at the top level stays at today's count; `"publish into a folder writes one more row (artifacts_folder_live_idx)"`; `"creating a folder at depth 3 writes 1 + 4 closure + 3 index rows"` (pin the measured number).
`query-plans.test.ts`: `"a folder's artifacts use artifacts_folder_live_idx"`, `"a sibling-name lookup uses folders_sibling_name_uq"`.

- [ ] **Step 2: Run** `pnpm -F @oa/server test folders.migration`. Expected: FAIL, `no such table: folders`.
- [ ] **Step 3: Implement** (drizzle-kit, then hand-edit as 0009 did) and the Drizzle mirrors.
- [ ] **Step 4: Run** `pnpm -F @oa/server test folders.migration d1-rows query-plans`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): folders, closure table and folder shares (F1)`

### Task 4: The tags migration

**Files:**
- Create: `apps/server/migrations/NNNN_tags.sql` (suffix `_tags.sql`)
- Modify: `apps/server/src/db/schema.ts`
- Test: `apps/server/test/tags.migration.test.ts`, `test/d1-rows.test.ts`

**Interfaces:**
- `tags(id pk, scope_id not null, name not null, name_key not null, created_by, created_at)`, unique `tags_scope_key_uq(scope_id, name_key)`. `scope_id` is `"*"` when the `spaces` feature is off, else the artifact's `space_id` (see open question 6).
- `artifact_tags(artifact_id references artifacts on delete cascade, tag_id references tags on delete cascade, created_at, pk(artifact_id, tag_id))`, index `artifact_tags_tag_idx(tag_id)`.

- [ ] **Step 1: Failing tests:** `"one tag per scope and name key"` (`"Roadmap"` then `"roadmap"` in `"*"` aborts; the same in two spaces succeeds), `"purging an artifact removes its tag links"`; `d1-rows`: `"tagging an artifact with an existing tag writes 2 rows"` (row plus `artifact_tags_tag_idx`).
- [ ] **Step 2: Run** `pnpm -F @oa/server test tags.migration`. Expected: FAIL, `no such table: tags`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm -F @oa/server test tags.migration d1-rows`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): tags (F1)`

### Task 5: Inherited access in the decision table

**Files:**
- Modify: `apps/server/src/auth/policy.ts`
- Test: `apps/server/test/policy.folders.test.ts`, `apps/server/test/policy.table.test.ts` (existing rows unchanged)

**Interfaces:**
- `DecisionInput` gains `inherited: { role: "viewer" | "editor" | null; visibility: Visibility | null; sharingRestricted: boolean }` (from live ancestor folders only; owning an ancestor folder counts as role `editor`). Absent or malformed fields read as `{ role: null, visibility: null, sharingRestricted: false }` (fail closed).
- `decide`: `best = max(spaceRole if shared, shareRole, inherited.role)`; the visibility rules use `max(artifact.visibility, inherited.visibility)` (public still needs personal or `publicLinks`); deleted rows ignore `inherited`; the cap still lowers to viewer.
- `CanCtx` gains `inheritedEditor?: boolean`, `sharingRestricted?: boolean`; `can` grants `share`, `unshare`, `visibility` to an uncapped inherited editor unless `sharingRestricted`, and `delete`, `move` either way. `transfer`, `data.reset`, `undelete` stay owner or manager.
- `decideFolder(i: FolderDecisionInput): AccessLevel | null`, where `FolderDecisionInput = { caller, cap, folder: { spaceId; spaceKind; ownerUserId: string | null; visibility; deleted; deletedBy: string | null }, space, spaceRole, shareRole, inherited, allowDeleted }`: the same table with ownership read from `ownerUserId` in personal spaces; a deleted folder is visible (with `allowDeleted`) only to its owner, a space manager, or `deletedBy`.
- New `OrgAction`s: `tags.manage` (`orgCan`: org owner or admin with `spaces` off; space manager with `spaces` on, passed as `opts.spaceRole`).

- [ ] **Step 1: Write the failing tests** (literal table, `it.each`):

```ts
it("a folder share gives at least its role on everything below", () => {
  expect(decide({ ...base, inherited: { role: "editor", visibility: null, sharingRestricted: false } })).toBe("editor");
});
it("access only adds: a direct editor share beats an inherited viewer", () => { /* editor */ });
it("a team folder makes a private artifact visible to members, never to guests or capped callers", () => { /* viewer; null; null */ });
it("a public folder in a no-public-links space grants nothing to anonymous callers", () => { /* null */ });
it("a deleted artifact ignores inherited access", () => { /* null even with inherited editor */ });
it("inherited editor may share unless sharing is restricted; move and delete either way", () => { /* can(...) table */ });
it("a capped caller with an inherited editor share is viewer with no data writes", () => { /* viewer; data.write false */ });
it("orgCan tags.manage: admins with spaces off, space managers with spaces on, never space editors", () => { /* table */ });
it("decideFolder: the creator of a subfolder in someone else's personal folder owns it", () => { /* owner */ });
it("decideFolder: a trashed folder is visible only to its owner, a space manager or whoever trashed it", () => { /* table */ });
```

- [ ] **Step 2: Run** `pnpm -F @oa/server test policy`. Expected: the new file fails (`inherited` is not read); `policy.table` passes.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm -F @oa/server test policy`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(auth): inherited folder access in decide and can (F1)`

### Task 6: Inherited access in `authorize`, lists, search and the content host

**Files:**
- Modify: `apps/server/src/auth/authz.ts` (`authorize`, `authorizeFolder`, `levelSql`, `listFilterSql`), `auth/route-policy.ts` (`Policy` kind `folder`), `services/search.ts`, `content/app.ts`, `routes/artifacts.ts` (OG metadata), `auth/policy.ts` (`isPubliclyServable`)
- Test: `apps/server/test/authz.folders.test.ts`, `test/search.authz.test.ts`, `test/content-host.test.ts`, `test/query-plans.test.ts`, `test/route-policy.test.ts`

**Interfaces:**
- Consumes: Task 5 `decide`, `decideFolder`; P3's `authorize` (one statement) and `levelSql`.
- Produces:
  - `authorize(...)` unchanged in signature; its statement adds three scalar subqueries over `folder_ancestors fa join folders f on f.id = fa.ancestor_id and f.deleted_at is null where fa.folder_id = artifacts.folder_id`: max share rank for the caller's email (from `folder_shares`), 2 when `f.owner_user_id = caller.id`, max visibility rank, and min `editors_can_share`. Its returned `can` uses the new `artifactCan` options.
  - `authorizeFolder(env, c: Caller, folderId: string, action: FolderAction, opts?: { allowDeleted?: boolean }): Promise<{ level: AccessLevel; folder: FolderRow; can: FolderCan }>`, where `FolderAction = "view" | "edit" | "share" | "unshare" | "visibility" | "delete" | "restore" | "move" | "restrictSharing"`; 404 when not allowed.
  - `Policy` gains `{ folder: FolderAction; allowDeleted?: true }` (checks `:id`); `enforce` routes it to `authorizeFolder`.
  - `listFilterSql` adds, inside the `shared` and `all` scopes, `folder_id in (select fa.folder_id from folder_ancestors fa join folder_shares fs on fs.folder_id = fa.ancestor_id join folders f on f.id = fa.ancestor_id and f.deleted_at is null where fs.email = ?)` and the same over `f.owner_user_id = ?`; inside `team`, the same over `f.visibility in ('team', 'public')` (omitted for guests and capped callers). Each branch keeps `deleted_at is null`.
  - `levelSql` takes the max with the inherited rank (one correlated subquery per row).
  - `isPubliclyServable` gains `folderPublic?: boolean`; the content host's serve statement and `GET /a/:id`'s OG lookup compute it in their existing statement.
- Rows read: `authorize` at depth 3 reads at most 4 + 3 x 3 = 13 rows (pinned).

- [ ] **Step 1: Write the failing tests**

```ts
it("an artifact filed three levels under a folder shared with Bob is readable by Bob", async () => { /* 200 */ });
it("list(all) ids and levels equal authorize() for every seeded caller and folder artifact", async () => {
  for (const who of CALLERS) expect(await listAll(who)).toEqual(pickNonNull(await authorizeAll(who)));
});
it("Shared with me includes artifacts reached through a folder share", async () => { /* ids */ });
it("search never returns an artifact whose only path is a trashed folder", async () => { /* empty */ });
it("/p/ serves an artifact public only through a live public folder, and 404s once that folder is private", async () => { /* 200 then 404 */ });
it("authorize at depth 3 is one statement reading at most 13 rows", async () => { /* rows.read <= 13; statements 1 */ });
it("every folder route has a ROUTE_POLICY entry of kind folder or user", () => { /* route-policy.test */ });
```

`query-plans.test.ts`: `"the folder-share branch is evaluated once (uncorrelated) through folder_shares_email_idx"`.

- [ ] **Step 2: Run** `pnpm -F @oa/server test authz.folders search.authz content-host`. Expected: the new cases fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm -F @oa/server test authz search content-host query-plans route-policy`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(auth): folder inheritance in authorize, lists, search and /p/ (F1)`

### Task 7: Folder create, read, rename and paths

**Files:**
- Create: `apps/server/src/services/folders.ts`, `apps/server/src/routes/folders.ts`
- Modify: `routes/index.ts`, `auth/route-policy.ts`
- Test: `apps/server/test/folders.api.test.ts`

**Interfaces:**
- Consumes: `authorizeFolder`, P3 `loadSpace(env, c, spaceId, "space.publish")`.
- Produces:
  - `createFolder(env, user: Member, input: FolderCreate): Promise<Folder>`: a parent needs folder `edit`; no parent needs `space.publish` on `spaceId` (default the caller's personal space). Owner: the caller in a personal space, null in a shared space. 409 `folder_name_taken`; 400 `folder_too_deep` past depth 20; 400 `bad_request` past `perSpace`.
  - `getFolder(env, c, id): Promise<Folder>` (with `path`); `listFolders(env, c, q: FoldersQuery): Promise<Page<Folder>>`; `folderItems(env, c, id, page): Promise<FolderItems>`; `libraryItems(env, c, { spaceId?, cursor?, limit? }): Promise<FolderItems>` (top level: the caller's own top-level folders and artifacts in their personal space, or a shared space's top level).
  - `renameFolder(env, user, id, name): Promise<Folder>` (folder `edit`).
  - `resolveFolderPath(env, c, path: string, opts: { spaceId?: string; create?: boolean }): Promise<FolderRow>`: segments matched by `name_key` from the library or space root the caller can see; `create` makes missing segments (each needs `edit` on its parent); 404 otherwise.
- Routes and policies: `GET R.folders` and `GET R.libraryItems` `{ user }`; `POST R.folders` `{ user: "authorizes the parent or space itself" }`; `GET R.folder(id)`, `GET R.folderItems(id)` `{ folder: "view" }` (anonymous allowed when public through the chain); `PATCH R.folder(id)` `{ folder: "edit" }` (visibility and the switch are Task 10's).

- [ ] **Step 1: Failing tests:** `"create at the top level of my library"`, `"create inside a folder I only view is 404"`, `"create in a shared space needs editor (403 space_forbidden for a viewer)"`, `"a duplicate sibling is 409 folder_name_taken"`, `"depth 21 is 400 folder_too_deep"`, `"'a/b' as a name is 400"`, `"resolveFolderPath matches case-insensitively and creates missing segments"`, `"resolveFolderPath never resolves into another user's library"`, `"a public folder's items are listed to an anonymous caller; a private one is 404"`, `"libraryItems leaves out my artifact filed in someone else's folder"`, `"FolderItems lists folders first, then artifacts by updatedAt desc, cursor on artifacts only"`.
- [ ] **Step 2: Run** `pnpm -F @oa/server test folders.api`. Expected: 11 failed.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm -F @oa/server test folders.api route-policy`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): create, read and rename folders (F1)`

### Task 8: Access previews and confirmation tokens

**Files:**
- Create: `apps/server/src/services/access-diff.ts`, `apps/server/src/auth/confirm.ts`
- Modify: `apps/server/src/auth/keys.ts` (`KEY_LABELS` adds `"oa:confirm"`)
- Test: `apps/server/test/access-diff.test.ts`, `apps/server/test/confirm.test.ts`

**Interfaces:**
- Produces:
  - `type AccessOp = { kind: "move"; input: MoveInput } | { kind: "publish"; folderId: string } | { kind: "folder.share"; folderId; email; role } | { kind: "folder.unshare"; folderId; email } | { kind: "folder.visibility"; folderId; visibility } | { kind: "artifact.share" | "artifact.unshare" | "artifact.visibility"; ... }`.
  - `previewAccess(env, c: Caller, op: AccessOp): Promise<Omit<AccessPreview, "confirmToken" | "expiresAt">>`: audiences of the *changing* part only (for a move, the ancestor chain above the moved items and, across spaces, the space members and the public-links rewrite); people come from `folder_shares`, artifact shares and, hosted, the space as one `space` audience; names from `users`; at most `PREVIEW_PEOPLE` per side, `truncated` beyond; each change counts the live items it reaches.
  - `isEmpty(p): boolean`.
  - `signConfirm(env, uid: string, op: AccessOp, p): Promise<{ token: string; expiresAt: string }>` and `verifyConfirm(env, uid, op, p, token): Promise<boolean>`: HMAC (`deriveKey(env, "oa:confirm")`) over `uid`, the canonical JSON of `op` without `confirmToken`, a SHA-256 of the sorted gains and losses, and `exp` (`CONFIRM_TTL_SEC`).
  - `requireConfirmed(env, c, op, token: string | undefined, required: boolean): Promise<void>`: when `required` and the preview isn't empty, throws `confirm_required` with a fresh signed `AccessPreview` unless `verifyConfirm` passes.

- [ ] **Step 1: Write the failing tests**

```ts
it("moving into a folder shared with Bob previews Bob gaining viewer on 3 items", async () => {
  expect(await previewAccess(env, ada, moveOp([a1, a2, a3], medical))).toMatchObject({ gains: [{ who: { kind: "person", email: "bob@x.com" }, from: null, to: "viewer", items: 3 }], losses: [] });
});
it("moving out lists who loses the access they had through the old folder; direct shares stay", async () => { /* Bob loses; Cy (direct share) absent */ });
it("filing into a folder only I can see is empty", async () => { /* isEmpty true */ });
it("a team or public chain shows the team or public audience", async () => { /* { kind: "team" } */ });
it("hosted: moving to another space lists both spaces and the public-to-team rewrite", async () => { /* space audiences */ });
it("over 50 people is truncated", async () => { /* gains.length 50; truncated true */ });
it("a token verifies only for the same user, op and diff, before expiry", async () => {
  /* other uid false; other target false; diff changed false; exp+1 s false */
});
it("requireConfirmed with no token and a non-empty preview throws confirm_required carrying a token", async () => { /* code, details.confirmToken */ });
```

- [ ] **Step 2: Run** `pnpm -F @oa/server test access-diff confirm`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm -F @oa/server test access-diff confirm keys`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): access previews and confirmation tokens (F1)`

### Task 9: Moves and publishing into folders

**Files:**
- Create: `apps/server/src/services/moves.ts`
- Modify: `services/artifacts.ts` (`publish`: `folderId`, `folderPath`, `confirmToken`; P3's `moveArtifact` becomes a wrapper), `routes/folders.ts` (`POST R.moves`), `directory/sync-do.ts` (P3's access-job queue gains `closeArtifacts(ids)`, pages of `MAX_CLOSE`)
- Test: `apps/server/test/folders.move.test.ts`, `test/spaces.move.test.ts` (P3 cases unchanged), `test/d1-rows.test.ts`

**Interfaces:**
- Consumes: `authorize`, `authorizeFolder`, `previewAccess`, `requireConfirmed`, P3 `orgCan("space.publish")`, `closeRuntimeSockets`.
- Produces: `moveItems(env, user: Member, input: MoveInput, opts: { requireConfirm: boolean; ctx? }): Promise<MoveResult>`:
  - Each artifact needs `can.move`; each folder needs folder `move`; the target needs folder `edit`, or (top level) the caller's own library or `space.publish` on `to.spaceId`.
  - A shared-space artifact can't go to a personal folder or library (400 `space_personal`); someone else's artifact can't go to the caller's own top level (404, as in Drive "shared with me").
  - Across spaces: manager or owner on every item and `space.publish` in the target, else 409 `move_blocked` for the whole move (all or nothing); every artifact under a moved folder changes `space_id` with it; a public folder or artifact entering a space with `publicLinks` off becomes `team` in the same batch.
  - 400 `folder_cycle` for a folder into itself or below; 400 `folder_too_deep` past depth 20.
  - One D1 batch: `folder_id`/`parent_id` updates, closure rows rewritten for each moved subtree (delete the rows above the moved root, insert the new chain x subtree), `updated_at`.
  - Then `closeArtifacts` (queued, every affected id) when the preview had losses or a visibility drop.
- `POST R.moves` (`{ user: "authorizes each item itself" }`) calls `moveItems(..., { requireConfirm: true })`; P3's `POST R.moveArtifact(id)` calls it with `requireConfirm: false`, unchanged in behaviour.
- `publish`: with `folderId` or `folderPath` on create, the artifact is created in that folder's space (`spaceId` must agree or be absent, else 400); an access-widening target needs the token when called with `requireConfirm` (MCP, Task 14); on an existing id, a folder means a move through `moveItems`.

- [ ] **Step 1: Write the failing tests**

```ts
it("move into a shared folder without a token is 409 confirm_required and changes nothing", async () => { /* folder_id unchanged */ });
it("the same move with the returned token moves and keeps direct shares", async () => { /* folder_id set; shares intact */ });
it("a token from before someone shared the target is refused with a fresh preview", async () => { /* 409; new gains include the new person */ });
it("Bob, an editor of Ada's folder, moves his own artifact in; it stays his and leaves his top level", async () => { /* owner Bob; libraryItems(Bob) lacks it */ });
it("Bob can't file Ada's artifact shared with him into his own folder", async () => { /* 404 */ });
it("a folder into its own child is 400 folder_cycle", async () => { /* 400 */ });
it("a cross-space folder move with one item the caller can't move is 409 move_blocked and moves nothing", async () => { /* all space_id unchanged */ });
it("a public folder moved into a no-public-links space becomes team with its public artifacts", async () => { /* visibility team x n */ });
it("moving a folder of 120 artifacts out of a shared folder closes sockets on all 120", async () => {
  const socks = await openSockets(oneTwentyArtifacts); await moveWithToken(ada, folder, null);
  for (const ws of socks) expect(await ws.closed).toMatchObject({ code: 4403 });
});
it("publish with folderPath creates in that folder; into a shared one needs the token over MCP only", async () => { /* REST 201; MCP confirm */ });
it("R.moveArtifact keeps P3's behaviour (no token)", async () => { /* 200 */ });
```

`d1-rows.test.ts`: `"moving one artifact between two folders writes 2 rows"`; `"moving a 3-folder subtree from depth 1 to depth 2 writes the pinned closure count"`.

- [ ] **Step 2: Run** `pnpm -F @oa/server test folders.move`. Expected: 11 failed.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm -F @oa/server test folders.move spaces.move d1-rows`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): folder moves with access previews (F1)`

### Task 10: Folder sharing, visibility and "Editors can't share"

**Files:**
- Create: `apps/server/src/services/folder-shares.ts`
- Modify: `services/shares.ts` (extract `assertShareTarget`; `UNSHARED_GUEST` and `REACTIVATE_GUEST` read `folder_shares` too), `services/folders.ts` (`patchFolder`), `services/artifacts.ts` (`patch`: inherited editors), `routes/folders.ts`, `auth/route-policy.ts`
- Test: `apps/server/test/folders.share.test.ts`, `test/shares-adv.test.ts`

**Interfaces:**
- Consumes: `authorizeFolder`, `requireConfirmed`, `closeArtifacts`, `emailShare` (folder variant: folder name, `folderPath(id)`).
- Produces:
  - `assertShareTarget(env, sharer: Member, space: SpaceRow, email: string, role: ShareRole): Promise<void>`: the one check artifact and folder shares both call (today's rules, plus P3's space rules on hosted), so a folder can be shared with exactly whom an artifact in the same space could be.
  - `listFolderShares`, `putFolderShare(env, user, folderId, s: FolderShareInput, opts: { requireConfirm })`, `deleteFolderShare(env, user, folderId, email, opts)`: folder `share`/`unshare`; `MAX_SHARES` (200) per folder; a new share with a non-member emails them; unsharing closes sockets on the subtree's artifacts and runs `removeGuestIfUnshared`.
  - `patchFolder(env, user, id, p: FolderPatch, opts)`: `visibility` needs folder `visibility` (403 `public_links_off` in a no-public-links space); `editorsCanShare` needs `restrictSharing` (owner or manager); a visibility drop closes sockets on the subtree.
- Routes: `GET/PUT R.folderShares(id)` `{ folder: "share" }`, `DELETE R.folderShare(id, email)` `{ folder: "unshare" }`; REST passes `requireConfirm: false`.

- [ ] **Step 1: Write the failing tests**

```ts
it("a folder share reaches items added later", async () => { /* share, then publish into it: Bob reads it */ });
it("an inherited editor shares an item they don't own; with Editors can't share on, 404", async () => { /* 200 then 404 */ });
it("only the owner or a space manager may turn Editors can't share on", async () => { /* editor 404; owner 200 */ });
it("hosted: a shared-space folder accepts exactly the targets an artifact there accepts", async () => {
  for (const t of TARGETS) expect(await shareFolder(mgr, spaceFolder, t)).toEqual(await shareArtifact(mgr, spaceArt, t));
});
it("hosted: a guest given editor on a Personal space folder is capped at viewer", async () => { /* viewer; no data writes */ });
it("public on a folder in a no-public-links space is 403 public_links_off", async () => { /* 403 */ });
it("a guest keeps their account while a folder share remains, and is removed after the last one", async () => {
  await unshareArtifact(ada, art, guest); expect(await status(guest)).toBe("active");
  await unshareFolder(ada, folder, guest); expect(await status(guest)).toBe("removed");
});
it("unsharing a folder closes Bob's sockets on its artifacts", async () => { /* 4403 */ });
```

- [ ] **Step 2: Run** `pnpm -F @oa/server test folders.share`. Expected: 8 failed.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm -F @oa/server test folders.share shares shares-adv`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): folder sharing and Editors can't share (F1)`

### Task 11: Trash and restore

**Files:**
- Create: `apps/server/src/services/trash.ts`
- Modify: `services/artifacts.ts` (`undelete`: gone parent; `purgeDeleted`: folders after their artifacts), `routes/folders.ts` (`DELETE R.folder(id)`, `POST R.restoreFolder(id)`), `auth/route-policy.ts`
- Test: `apps/server/test/folders.trash.test.ts`, `test/cron.test.ts`

**Interfaces:**
- Produces:
  - `trashFolder(env, user, id, ctx?): Promise<void>` (folder `delete`): one batch sets `deleted_at`, `deleted_by`, `trash_root = id` on the subtree's folders and on the artifacts the deleter owns (all of them in a shared space); other owners' artifacts get `folder_id = null` (their owner's top level, direct shares kept); other owners' subfolders follow open question 3; then `closeArtifacts` for every artifact that lost a path.
  - `restoreFolder(env, user, id): Promise<Folder>` (folder `restore`, `allowDeleted`; within `LIMITS.softDeleteDays`): restores every row with `trash_root = id`; a parent that is gone (trashed or purged) puts the folder at the top level of its space; a taken name follows open question 4.
  - `undelete` (existing): an artifact whose folder is gone returns to its owner's top level (the space's top level in a shared space).
  - `purgeDeleted` also purges folders deleted more than `softDeleteDays` ago once none of their artifacts remain (cascade clears closure and share rows).
  - `FoldersQuery.trashed` lists folders the caller may restore.

- [ ] **Step 1: Failing tests:** `"trashing a folder trashes its subtree and my own items"`, `"Bob's artifact in Ada's trashed folder moves to Bob's top level and keeps its direct shares"`, `"while a folder is in trash its share grants nothing"` (Cy, who had the folder share, gets 404 at once), `"an artifact public only through the trashed folder stops on /p/ and in OG metadata"`, `"restore brings everything back where it was"`, `"restoring when the parent is gone lands at the top level"`, `"restoring an artifact whose folder is trashed lands at its owner's top level"`, `"a shared-space folder delete trashes everything inside"`, `"only the owner, a space manager or whoever trashed it may restore"`, `"purge removes a folder after 30 days, after its artifacts"`.
- [ ] **Step 2: Run** `pnpm -F @oa/server test folders.trash`. Expected: 10 failed.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm -F @oa/server test folders.trash cron d1-rows`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): folder trash and restore (F1)`

### Task 12: Tags on artifacts, tag lists and filters

**Files:**
- Create: `apps/server/src/services/tags.ts`, `apps/server/src/routes/tags.ts`
- Modify: `services/artifacts.ts` (`listQuery`: `tag`, `folderId`; `toSummary`: `tags`, `folder`, `effectiveVisibility`; `publish`: `tags`), `services/search.ts` (`folderId` subtree, `tag`), `auth/route-policy.ts`
- Test: `apps/server/test/tags.test.ts`, `test/search.test.ts`, `test/query-plans.test.ts`

**Interfaces:**
- Produces:
  - `tagScope(env, a: ArtifactRow): string` (`"*"` with `spaces` off, else `a.spaceId`).
  - `setTags(env, user, artifactId, names: string[]): Promise<string[]>` (needs `publish`, the edit right): dedupes by `normTagKey`; reuses the scope's tag (its first-typed name) or creates one; at most `perArtifact` (400 beyond); drops tag rows left with no artifacts, in the same batch.
  - `listTags(env, c, q: TagsQuery): Promise<Tag[]>`: only tags with at least one artifact the caller can see (`listFilterSql(c, "all")`), `count` over those only, by name, at most 500.
  - List and search filters: `tag` (by `normTagKey`, within the caller's visible set) and `folderId` (search: the whole subtree through `folder_ancestors`).
- Routes: `PUT R.artifactTags(id)` `art("publish", signedIn)`; `GET R.tags` `{ user: "filtered by listFilterSql" }`.

- [ ] **Step 1: Failing tests:** `"tags are case-insensitive and keep the first-typed name"`, `"a viewer can't set tags (404); an editor can"`, `"a tag on only invisible artifacts is not listed"` (`layoffs`), `"counts include only visible artifacts"`, `"tags never grant access: filtering by tag returns only visible artifacts"`, `"search by folder covers the subtree"`, `"21 tags is 400"`, `"hosted: the same name in two spaces is two tags"`, `"removing the last use of a tag deletes it"`; `query-plans`: `"tag filter uses artifact_tags_tag_idx"`.
- [ ] **Step 2: Run** `pnpm -F @oa/server test tags search`. Expected: the new cases fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm -F @oa/server test tags search query-plans json-shapes`. Expected: PASS (snapshot unchanged for untagged artifacts).
- [ ] **Step 5: Commit** `feat(server): tags, visible tag lists and filters (F1)`

### Task 13: Tag admin

**Files:**
- Modify: `apps/server/src/services/tags.ts`, `routes/tags.ts`, `auth/route-policy.ts`
- Test: `apps/server/test/tags.admin.test.ts`

**Interfaces:**
- Produces: `renameTag(env, user, tagId, name): Promise<Tag>` (onto an existing name in the scope it merges, links deduped, with no 409 and nothing about the other tag beyond the visible count) and `deleteTag(env, user, tagId): Promise<void>` (removes it from every artifact in its scope). Both need `orgCan(user, "tags.manage", { spaceRole })` for the tag's scope, and the tag must be one the caller can see (else 404).
- Routes: `PATCH R.tag(id)`, `DELETE R.tag(id)`, policy `{ user: "authorizes the tag's scope itself" }`.

- [ ] **Step 1: Failing tests:** `"a self-hosted admin renames a tag across the install"`, `"a member gets 404"`, `"hosted: a space manager renames within their space; a space editor gets 404; an org admin with no space role gets 404"`, `"rename onto a name used only on artifacts the admin can't see merges, with no 409 and count of visible only"`, `"delete removes the tag from every artifact in scope"`, `"a tag the caller can't see is 404"`.
- [ ] **Step 2: Run** `pnpm -F @oa/server test tags.admin`. Expected: 6 failed.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm -F @oa/server test tags.admin`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): tag rename, merge and delete (F1)`

### Task 14: MCP tools with ask-first

**Files:**
- Create: `apps/server/src/mcp/tools/folders.ts`
- Modify: `mcp/tool-defs.ts`, `mcp/server.ts`, `mcp/tools/artifacts.ts` (`publish_artifact` folder and tags; `share_artifact`, `unshare_artifact`, `set_visibility` unchanged, per open question 7), `auth/route-policy.ts` (`TOOL_POLICY`), `packages/shared/src/schemas.ts` (tool inputs); regenerated `tool-manifest.json`, `skill.generated.ts`, `upgrade.generated.ts`
- Test: `apps/server/test/mcp.folders.test.ts`, `test/mcp.tools.test.ts`, `test/mcp.auth.test.ts`, `test/mcp.neutral.test.ts`, `test/smoke/mcp.ts`, `test/route-policy.test.ts`

**Interfaces:**
- New tools (inputs in `schemas.ts`): `list_folders { spaceId?, parentId?, path?, cursor?, limit? }` (each item carries `path` and `private: boolean`, true when only the caller can see it), `create_folder { name?, parentId?, path?, spaceId? }` (exactly one of `name` or `path`) (`path` creates missing segments), `move_artifact { id, folderId?: string | null, folderPath?, confirmToken? }`, `move_folder { id, parentId?: string | null, spaceId?, confirmToken? }`, `set_tags { id, tags }`, `share_folder { id, email, role, confirmToken? }`, `unshare_folder { id, email, confirmToken? }`, `set_folder_visibility { id, visibility, confirmToken? }`.
- Every access-changing tool calls its service with `requireConfirm: true`. On `confirm_required` the result is not an error: text `"Nothing changed yet. Show the person who gains or loses access, ask them, then call again with confirmToken."` plus `{ status: "confirm", preview: AccessPreview }`; on success `{ status: "done", ... }`.
- `TOOL_POLICY`: `list_folders` `{ user }`, `create_folder` `{ user: "authorizes the parent or space itself" }`, `move_artifact` `art("move")`, `move_folder` `{ folder: "move" }`, `set_tags` `art("publish")`, `share_folder` `{ folder: "share" }`, `unshare_folder` `{ folder: "unshare" }`, `set_folder_visibility` `{ folder: "visibility" }`.
- Descriptions say "owner, space manager or folder editor" where rights changed; no vendor names.
- Tool count: the live count at rebase plus 8 (26 after P3's `list_spaces`), in all four count tests in the same commit.

- [ ] **Step 1: Write the failing tests**

```ts
it("publish_artifact into a shared folder returns status confirm and creates nothing", async () => { /* count unchanged */ });
it("calling again with confirmToken publishes into the folder", async () => { /* folder.id */ });
it("publish_artifact into a private folder needs no token", async () => { /* done */ });
it("move_artifact out of a shared folder previews the losses", async () => { /* losses */ });
it("share_folder with a stale token gets a fresh preview", async () => { /* confirm again */ });
it("share_artifact still shares in one call (no confirmation)", async () => { /* status done, share exists */ });
it("create_folder with a path makes missing segments, no confirmation", async () => { /* done; 3 folders */ });
it("set_tags on a viewer's artifact is not_found", async () => { /* isError */ });
it("every tool in tool-manifest.json has a TOOL_POLICY entry and vice versa", () => { /* route-policy.test */ });
it("tools/list has 26 tools", async () => { /* all four count tests */ });
```

- [ ] **Step 2: Run** `pnpm -F @oa/server test mcp.folders mcp.tools`. Expected: FAIL.
- [ ] **Step 3: Implement**, then run `pnpm -F @oa/server gen` and commit the regenerated files.
- [ ] **Step 4: Run** `pnpm -F @oa/server test mcp route-policy skill upgrade`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mcp): folder and tag tools that ask first (F1)`

### Task 15: The in-install access matrix

**Files:**
- Modify: `apps/server/test/authz/fixture.ts`, `test/authz/expect.ts`, `test/authz/surfaces.ts` (P3 Task 16)
- Test: `apps/server/test/authz.surface-matrix.test.ts`, `test/cross-user.generated.test.ts`

**Interfaces:**
- Callers added: `folderViewer`, `folderEditor` (Drive rights), `folderEditorRestricted` (switch on), `folderOwnerOtherItem` (Ada over Bob's item in her folder), `guestFolderShared`.
- Artifacts added: `inPrivateFolder`, `inSharedFolder`, `deepInSharedFolder` (depth 5), `inTeamFolder`, `inPublicFolder`, `inPublicFolderLinksOff`, `inTrashedFolder`, `otherOwnerInMyFolder`.
- Surfaces added: every folder and tag route, the `R.moves` route, `R.libraryItems`, and the 8 new tools; `EXPECTED` literal rows for each caller and artifact, independent of `policy.ts`.

- [ ] **Step 1: Write the cases:** `"SURFACES cover every folder entry in ROUTE_POLICY and TOOL_POLICY"`, the matrix rows, and `"a non-member gets 404 on every folder route and tool"` (generated).
- [ ] **Step 2: Run** `pnpm -F @oa/server test authz.surface-matrix cross-user`. Expected: PASS once Tasks 5 to 14 are in; a failure names the surface and its owning task.
- [ ] **Step 3: Run the probe** `pnpm -F @oa/server test:authz-probe --base http://localhost:8787 --creds .dev-creds.json`. Expected: exit 0.
- [ ] **Step 4: Commit** `test(server): folders and tags in the access matrix (F1)`

### Task 16: Red-line cases for hosted

**Files:**
- Create: `tests/redline/test/folders.test.ts`
- Modify: `tests/redline/src/` seed (a private folder, a folder shared with an A member, a public folder and a tag on each install, titles carrying the `REDLINE-<install>-<random>` marker)
- Test: the file itself, run against `rl-a`/`rl-b`

**Interfaces:**
- Consumes: P5 `crossCheck`, `expectRefused`, `asA/asB`, `loadTargets`; P3's `SURFACES` (Task 15 extended them, so P5 Task 3b covers folder surfaces automatically).
- Cases, each through `crossCheck`: A's credential on every B folder route and tool with B's folder ids; A's confirm token replayed at B (move, share, publish) answers 409 or 404 and changes nothing (keys derive from each install's `SESSION_SECRET`); A's tag ids at B; B's tag list with A's credential never contains B's marker tag; A's public folder id at B's content host and app host is 404; a folder share email link from A opened at B creates no share; on one install, a shared-space folder can't be shared with an address the space rules refuse, and a Personal space folder share to a guest is read-only on every surface (MCP and data API included).

- [ ] **Step 1: Write the tests** as above.
- [ ] **Step 2: Run** `env -i PATH="$PATH" HOME="$HOME" pnpm -F @oa/redline exec vitest run folders` against `rl-a`/`rl-b`. Expected: PASS. Any failure is a red-line bug: stop and file it with the Manager as a blocker; don't weaken the test.
- [ ] **Step 3: Commit** `test(redline): folders, confirm tokens and tags don't cross installs (F1)`

---

## Task order

| Task | Depends on | Parallel with |
|---|---|---|
| 1 Contract | none | none |
| 2 Mocks | 1 | 3, 4, 5 |
| 3, 4 Migrations | 1 | 2, 5 |
| 5 Pure policy | 1 | 2, 3, 4 |
| 6 authorize and lists | 3, 5; P3 T3 to T5 | 4 |
| 7 Folder CRUD | 6 | 8, 12 |
| 8 Previews and tokens | 6 | 7, 12 |
| 9 Moves | 7, 8; P3 T10 | 10, 11 |
| 10 Sharing | 7, 8 | 9, 11 |
| 11 Trash | 7 | 9, 10 |
| 12 Tags | 4, 6 | 7 to 11 |
| 13 Tag admin | 12 | 14 |
| 14 MCP | 9, 10, 12 | 13 |
| 15 Matrix | 5 to 14; P3 T16 | 16 |
| 16 Red line | 15; P5 T2 | none |

F2 can start against the mocks once Task 2 merges. F3 needs Tasks 9, 10, 12 and 14.

## Rollout

1. Tasks 1 to 6 (no behaviour change: every artifact is at the top level; the snapshot is byte-identical). Release; watch CPU and D1 rows.
2. Tasks 7 to 14, then 15. Folders are live on every install; nothing changes for anyone until a folder exists.
3. Task 16 joins the red-line gate before the release that ships F1 to a hosted install.

## Self-review

- Spec coverage: model and locations (3, 7, 9), nesting and names (3, 7), ownership (5, 9), no shortcuts (3, 9), trash and restore (11), cross-space moves (9), sharing, flow-down, only-adds, warnings (5, 6, 8, 9, 10), folder editors and the switch (5, 10), hosted cap and red line (10, 15, 16), tags and their leak rule (12), tag admin (13), agents and ask-first (14), contract first (1), upgrades (1, 3). Filing instructions, the backlog sort and the UI are F3 and F2.
- Proportion: signatures, rules and test names; no bodies.
