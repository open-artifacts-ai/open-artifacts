# Folders and tags F2: Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Folders and tags in the app the way a Google Drive user expects: a folder tree in the sidebar, a folder view with a breadcrumb, a Drive-style Move picker and drag and drop that warn before access changes, a folder share dialog, tags with a tag list and tag view, folder and tag search filters, and a Trash that restores.

**Architecture:** Every shape comes from F1's contract (`packages/shared/src/folders.ts`, `FOLDERS_CONTRACT.md`) through the dashboard adapter `api/contract.ts`; tests run against F1's mocks (`createHandlers({ folders: true })`). One hook, `useConfirmed`, owns the ask-first flow for every access-changing call: the call answers 409 `confirm_required` with an `AccessPreview`, the `AccessWarning` dialog shows it, and Continue repeats the call with its `confirmToken`. Actions follow the server's `can` (`ArtifactCan`, `FolderCan`) only. Self-hosted shows one library tree; hosted shows a tree under each space.

**Tech Stack:** React 19, TanStack Router and Query, `@oa/ui` and `@oa/ui/shadcn`, zod, MSW (`@oa/shared/mocks`), vitest plus Testing Library, Playwright (mock and real configs).

**Spec:** `docs/superpowers/specs/2026-10-22-folders-and-tags-design.md` (PR #429), "UI" and "Sharing". **Contract and server:** `docs/superpowers/plans/2026-10-22-folders-f1-server.md` (Task 1 contract, Task 2 mocks). P4 (`docs/superpowers/plans/2026-10-21-hosted-m1-p4-spaces-ui.md`) for `useHosted`, `useCan`, `errorCopy`, `mountHosted`, the space switcher and `MoveDialog`.

**Depends on:** F1 Tasks 1 and 2 merged (contract and mocks). Task 13's real e2e needs F1 Tasks 7 to 14 merged.

## Open questions for the manager

All settled 2026-10-22. The coordinator took each plan default below as written. Build to the defaults.

1. **Trash page.** The dashboard has no Trash today (deletes offer an undo toast). The spec's "restore brings everything back" needs one, so Task 11 adds a Trash page for folders and artifacts. Confirm it's in scope for F2.
2. **Library home once folders exist.** Today `/` is a flat list of everything you can see. Drive's My Drive shows only the top level (folders, then unfiled files). This is Design's call between options (DF2), but the owner should know the choice changes what `/` shows after the first folder is made; until then `/` stays exactly as today (Global Constraints).

## Global Constraints

- It mirrors Google Drive: a Drive user is never surprised. Moves into or out of a shared folder warn and name who gains or loses access before anything changes; nothing moves on Cancel or Escape.
- An artifact is in one folder only (no shortcuts); an artifact shared with you appears under "Shared with me" and is never offered as movable into your own folders.
- Actions follow `artifact.can` and `folder.can` only; no component reads `access` for rights. A folder viewer, or an editor under "Editors can't share", sees no control they can't use.
- Tags never imply access: the tag list and tag view show only what the server returns.
- Self-hosted: one library tree, no space UI, no hosted request. Hosted: the tree sits under each space (P4's switcher) and folder controls respect `SpaceRef.publicLinks` (no "public" when off).
- An install with no folders and no tags looks and behaves as today: the library list, rows and cards are unchanged until the caller has a folder; the sidebar gains only the "New folder" entry Design places (DF1).
- Every hosted error code and the five F1 codes (`confirm_required`, `folder_name_taken`, `folder_cycle`, `folder_too_deep`, `move_blocked`) have one UI string in `api/errorCopy.ts`; others show the server's `message`.
- Folder and tag names are untrusted text: rendered as text, never markup, bidi-isolated (`<bdi>`).
- Copy: no em dashes in any user-facing string; say "any AI agent".
- Boundary: this track edits only `apps/dashboard`. A missing or wrong shape is a message to Backend.
- Visual choices are Design's: tasks marked **Gated on DFn** start only after the owner picks among Design's options. Logic and tests may be written first against a neutral layout of existing `@oa/ui` primitives.
- No `git stash`. One PR per task through the merge queue.

## Review Focus

1. **A drop onto a shared folder.** Dragging a card onto a folder shared with others must open the access warning and move nothing until Continue; Escape, Cancel and a drop outside any target move nothing. Tested in Task 7.
2. **The preview went stale.** Continue answers 409 `confirm_required` again (someone shared the target meanwhile): the dialog shows the new list with a note and waits for a second Continue; it never loops or moves silently. Tested in Task 5.
3. **Deep and hostile names.** A 20-level path with 200-character names, RTL and bidi-override names, and `<script>` in a name: the breadcrumb collapses the middle, stays one line, and renders text only. Tested in Task 2.
4. **Keyboard and screen reader users.** The tree is an ARIA tree (arrows expand and move, Enter opens), and every drag and drop move has a keyboard path through the Move picker. Tested in Tasks 3 and 7.
5. **An editor under "Editors can't share".** No Share control on the folder or its items, but Move and Delete remain; a stale tab that tries to share shows the server's message. Tested in Task 8.

---

## Design options needed

Each is a question for Design, who produce options; the owner picks.

- **DF1 Sidebar tree:** placement under Library (self-hosted) and under each space (hosted), expand and collapse, indentation and overflow at depth, the "New folder" entry, shared folders and "Shared with me", the tag list below it.
- **DF2 Library home and folder view:** whether `/` stays flat or becomes the top level once folders exist; folders as rows or tiles; tags on each row and card; the empty folder state.
- **DF3 Breadcrumb:** truncation at depth, a shared-folder marker, the folder's actions (share, rename, move, delete).
- **DF4 Move picker:** Drive's dialog (browse the tree, spaces on hosted, "New folder" inline), disabled targets with a reason.
- **DF5 Access warning:** layout and copy for gains and losses, people versus team, public and space audiences, truncation ("and 12 more"), the stale-preview note.
- **DF6 Drag and drop:** drop targets (tree nodes, folder rows, breadcrumb segments), hover and invalid states, multi-select.
- **DF7 Folder share dialog:** people and roles, general access (private, team, public), the "Editors can't share" switch, inherited access shown on an artifact's Share panel ("Has access through Medical").
- **DF8 Tags:** the editor on an artifact (add, remove, suggestions), chips on rows, the sidebar tag list, the tag view.
- **DF9 Search filters:** folder and tag filters in Search and the library filters.
- **DF10 Trash:** folders and artifacts together, restore, the 30-day note.
- **DF11 Tag admin:** rename, merge (by renaming onto a name) and delete, for admins and space managers.

## Error copy (proposed; Design finalizes)

| Code | Where | UI copy |
|---|---|---|
| `confirm_required` | any access-changing call | (not an error: opens the access warning, Task 5) |
| `folder_name_taken` | create, rename, move | "A folder with this name is already here. Pick another name." |
| `folder_cycle` | move | "A folder can't go inside itself." |
| `folder_too_deep` | create, move | "Folders can be nested 20 levels deep at most." |
| `move_blocked` | move across spaces | "Some items can't move to this space, so nothing was moved." |

## File structure

`apps/dashboard/src`
- `api/contract.ts`, `api/queries.ts`, `api/errorCopy.ts` (modify): folder and tag shapes, hooks, `qk` keys, copy.
- `folders/` (create): `useConfirmed.ts`, `AccessWarning.tsx`, `FolderTree.tsx`, `FolderView.tsx`, `Breadcrumb.tsx`, `FolderDialog.tsx` (new and rename), `MovePicker.tsx`, `dnd.ts`, `FolderShare.tsx`.
- `tags/` (create): `TagEditor.tsx`, `TagChips.tsx`, `TagList.tsx`, `TagView.tsx`.
- `trash/Trash.tsx` (create); `settings/Tags.tsx` (create).
- Modify: `router.tsx`, `layout/AppLayout.tsx` (sidebar), `library/{Library,ArtifactCard,ArtifactRow,Filters,Search}.tsx`, `library/{useLibraryQuery,useSearchQuery}.ts`, `viewer/panels/{Details,Share}.tsx`, `viewer/Crumbs.tsx`, `settings/SettingsLayout.tsx`.

Tests: `apps/dashboard/test/folders-{queries,confirm,view,tree,dialog,move,dnd,share,trash}.test.tsx`, `test/tags-{ui,admin}.test.tsx`, `test/search-filters.test.tsx`; `test/harness.tsx` (modify: `mountFolders`); `e2e/folders.spec.ts`, `e2e/folders-a11y.spec.ts` (create); `e2e/real/folders.spec.ts` (create); extended `e2e/library-layout.spec.ts`, `e2e/share-layout.spec.ts`, `e2e/m2-hostile.spec.ts`.

## Task order

| Task | Depends on | Gated on Design | Parallel with |
|---|---|---|---|
| 1 Hooks and copy | F1 T1, T2 | none | none |
| 2 Folder view and breadcrumb | 1 | DF2, DF3 | 3, 5, 9 |
| 3 Sidebar tree | 1 | DF1 | 2, 5, 9 |
| 4 New and rename | 2, 3 | DF1, DF2 | 5, 9 |
| 5 Access warning | 1 | DF5 | 2, 3, 9 |
| 6 Move picker | 3, 5 | DF4 | 8, 9 |
| 7 Drag and drop | 6 | DF6 | 8, 10 |
| 8 Folder share | 5 | DF7 | 6, 7, 10 |
| 9 Tags | 1 | DF8 | 2 to 8 |
| 10 Search filters | 2, 9 | DF9 | 7, 8, 11 |
| 11 Trash | 2 | DF10 | 10, 12 |
| 12 Tag admin | 9 | DF11 | 11 |
| 13 e2e and a11y | 2 to 12 | none | none |

Same-file pairs run in sequence: `router.tsx` (2, 9, 11, 12), `AppLayout.tsx` (3, 9), `Library.tsx` (2, 10), `Share.tsx` (8), `Details.tsx` (6, 9).

---

### Task 1: Folder and tag hooks, error copy, test harness

**Files:**
- Modify: `apps/dashboard/src/api/contract.ts`, `api/queries.ts`, `api/errorCopy.ts`, `test/harness.tsx`
- Test: `apps/dashboard/test/folders-queries.test.tsx`, `test/error-copy.test.ts`

**Interfaces:**
- Consumes: F1 shapes and `R.*` (`R.folders`, `R.folder`, `R.restoreFolder`, `R.folderItems`, `R.libraryItems`, `R.folderShares`, `R.folderShare`, `R.moves`, `R.tags`, `R.tag`, `R.artifactTags`), `folderCan`.
- Produces:
  - `qk.folder(id)`, `qk.folderItems(id)`, `qk.libraryItems(spaceId?)`, `qk.folders(q)`, `qk.folderShares(id)`, `qk.tags(q)`.
  - `useFolder(id)`, `useFolderItems(id)`, `useLibraryItems(spaceId?)`, `useFolders(q: FoldersQuery)`, `useFolderShares(id)`, `useTags(q?: TagsQuery)`.
  - Mutations (each takes an optional `confirmToken` in its variables): `useCreateFolder()`, `usePatchFolder(id)`, `useDeleteFolder()`, `useRestoreFolder()`, `useMoveItems()`, `usePutFolderShare(id)`, `useDeleteFolderShare(id)`, `useSetTags(artifactId)`, `usePatchTag()`, `useDeleteTag()`. A move invalidates the source and target `folderItems`, `libraryItems`, and each moved artifact.
  - `folderCanOf(f: Folder): FolderCan` (the server's `can`, else the contract's `folderCan`).
  - `mountFolders(path, opts?: { hosted?: true | HostedMockOptions; me?: (m: Me) => Me; overrides?: HttpHandler[] })`.
- `errorCopy` gains the five strings above.

- [ ] **Step 1: Failing tests:** `"useLibraryItems calls R.libraryItems without spaceId on self-hosted"`, `"a move invalidates both folders and the moved artifact"`, `"useMoveItems surfaces confirm_required with the preview in details"`, `"errorCopy maps the five folder codes"`, `"folderCanOf falls back to folderCan"`.
- [ ] **Step 2: Run** `pnpm --filter @oa/dashboard test -- folders-queries error-copy`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): folder and tag hooks and copy (F2)`

### Task 2: Folder view and breadcrumb

**Gated on DF2, DF3.**

**Files:**
- Create: `apps/dashboard/src/folders/FolderView.tsx`, `folders/Breadcrumb.tsx`
- Modify: `router.tsx` (`/folders/$id`), `library/Library.tsx` (top level per DF2), `library/{ArtifactRow,ArtifactCard}.tsx` (tag chips), `viewer/Crumbs.tsx` (the artifact's folder path)
- Test: `apps/dashboard/test/folders-view.test.tsx`, `e2e/m2-hostile.spec.ts`

**Interfaces:**
- Consumes: `useFolder`, `useFolderItems`, `useLibraryItems`, `folderCanOf`, `TagChips` (Task 9; a plain list until it lands).
- Produces: `<FolderView id={string} />` (breadcrumb, then child folders, then artifacts with their tags; the cursor pages artifacts); `<Breadcrumb path={FolderRef[]} current={FolderRef} />`, a `nav` labelled "Folder path" that collapses the middle segments past four; `folderPath(id)` links.

- [ ] **Step 1: Write the failing tests**

```ts
it("a folder shows its breadcrumb, then folders, then artifacts", async () => {
  mountFolders(`/folders/${SPECS}`);
  const nav = await screen.findByRole("navigation", { name: "Folder path" });
  expect(within(nav).getAllByRole("link").map((l) => l.textContent)).toEqual(["Projects", "open-artifacts"]);
  expect(order(screen.getAllByRole("row"))).toEqual(["folder", "folder", "artifact"]);
});
it("an install with no folders renders the library exactly as today", async () => { /* no folder rows; same headings as the library test */ });
it("a 20-level path collapses the middle and stays text", async () => { /* 4 links plus an overflow button */ });
it("a name with <script> and a bidi override renders as text", async () => { /* no script element; <bdi> */ });
it("an artifact in a folder shows the folder path in the viewer crumbs", async () => { /* "specs" link */ });
it("an unknown or unseen folder id shows Not found", async () => { /* 404 copy */ });
```

- [ ] **Step 2: Run** `pnpm --filter @oa/dashboard test -- folders-view`. Expected: FAIL.
- [ ] **Step 3: Implement per DF2, DF3.**
- [ ] **Step 4: Run** the same and `pnpm --filter @oa/dashboard test:e2e -- m2-hostile`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): folder view and breadcrumb (F2)`

### Task 3: Sidebar folder tree

**Gated on DF1.**

**Files:**
- Create: `apps/dashboard/src/folders/FolderTree.tsx`
- Modify: `layout/AppLayout.tsx` (`Sidebar`)
- Test: `apps/dashboard/test/folders-tree.test.tsx`

**Interfaces:**
- Consumes: `useFolders({ parentId, spaceId })` (lazy, one request per expanded node), `useHosted` (P4), `useCurrentSpace` (P4).
- Produces: `<FolderTree root={{ spaceId?: string; label: string }} />`, an ARIA `tree` labelled by its root (Up and Down move, Right expands or enters, Left collapses or goes to the parent, Enter opens `/folders/<id>`, `aria-expanded` and `aria-level` set); the current folder's ancestors open on load. Self-hosted: one tree under Library. Hosted: one per space in `Me.spaces` plus the personal space. A "Shared with me" group lists shared folders (`useFolders({ scope: "shared" })`). Each node is a drop target hook point for Task 7 (`data-folder-id`).

- [ ] **Step 1: Failing tests:** `"self-hosted: one tree under Library, no space names"`, `"hosted: a tree per space"`, `"expanding a node requests its children once"`, `"arrow keys move and expand; Enter opens the folder"`, `"the current folder's ancestors are expanded on load"`, `"shared folders appear under Shared with me"`, `"no folders: the tree renders nothing but DF1's New folder entry"`.
- [ ] **Step 2: Run** `pnpm --filter @oa/dashboard test -- folders-tree`. Expected: FAIL.
- [ ] **Step 3: Implement per DF1.**
- [ ] **Step 4: Run** the same and `pnpm --filter @oa/dashboard test -- layout`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): folder tree in the sidebar (F2)`

### Task 4: New folder and rename

**Gated on DF1, DF2.**

**Files:**
- Create: `apps/dashboard/src/folders/FolderDialog.tsx`
- Modify: `folders/FolderTree.tsx`, `folders/FolderView.tsx`, `folders/Breadcrumb.tsx`
- Test: `apps/dashboard/test/folders-dialog.test.tsx`

**Interfaces:**
- Produces: `<FolderDialog mode="create" parentId={string | null} spaceId?={string} />` and `<FolderDialog mode="rename" folder={Folder} />`; client checks mirror `validFolderName` (1 to 200 characters, no "/"), the server's `folder_name_taken` keeps the dialog open with its copy. "New folder" shows where the caller has `edit` on the current folder (or owns the library or can publish to the space); Rename only with `folder.can.edit`.

- [ ] **Step 1: Failing tests:** `"New folder creates inside the current folder and opens nothing else"`, `"a name with / is refused before sending"`, `"folder_name_taken keeps the dialog open with the copy"`, `"a folder viewer sees no New folder or Rename"`, `"Rename updates the breadcrumb and tree"`.
- [ ] **Step 2: Run** `pnpm --filter @oa/dashboard test -- folders-dialog`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): new folder and rename (F2)`

### Task 5: The access warning and the confirm flow

**Gated on DF5.**

**Files:**
- Create: `apps/dashboard/src/folders/useConfirmed.ts`, `folders/AccessWarning.tsx`
- Test: `apps/dashboard/test/folders-confirm.test.tsx`

**Interfaces:**
- Produces:
  - `useConfirmed<V extends { confirmToken?: string }, R>(m: UseMutationResult<R, ApiClientError, V>): { run(v: V): Promise<R | null>; dialog: ReactNode }`: runs `m`; on `confirm_required` it renders `AccessWarning` with `details` (an `AccessPreview`); Continue repeats with `confirmToken`; a second `confirm_required` replaces the preview and shows the stale note; Cancel or Escape resolves `null` and sends nothing more.
  - `<AccessWarning preview={AccessPreview} stale={boolean} onContinue onCancel />`, a `dialog` titled per DF5; each gain and loss row names the person (or "Everyone in the team", "Anyone with the link", "Everyone in <space>") and the level change, with "and N more" when `truncated`.

- [ ] **Step 1: Write the failing tests**

```ts
it("a 409 confirm_required opens the warning naming Bob; nothing else is sent", async () => { /* 1 request */ });
it("Continue repeats the call with the token", async () => { /* second body has confirmToken */ });
it("a second confirm_required shows the new list and the stale note, and waits", async () => { /* 2 requests, dialog open */ });
it("Escape and Cancel resolve null and send nothing more", async () => { /* request count unchanged */ });
it("team, public and space audiences read as groups, not people", async () => { /* three rows */ });
it("a truncated preview says and N more", async () => { /* "and 12 more" */ });
```

- [ ] **Step 2: Run** `pnpm --filter @oa/dashboard test -- folders-confirm`. Expected: FAIL.
- [ ] **Step 3: Implement per DF5.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): access warning before access changes (F2)`

### Task 6: The Move picker

**Gated on DF4.**

**Files:**
- Create: `apps/dashboard/src/folders/MovePicker.tsx`
- Modify: `viewer/panels/Details.tsx` (Move), `folders/FolderView.tsx` (row and selection actions); P4's `spaces/MoveDialog.tsx` (hosted: the space step becomes part of the picker)
- Test: `apps/dashboard/test/folders-move.test.tsx`

**Interfaces:**
- Consumes: `useMoveItems`, `useConfirmed`, `useFolders`, `useCreateFolder`, P4 `canPublishTo`.
- Produces: `<MovePicker items={ItemRef[]} from={FolderRef | null} onClose />`, a dialog that browses the tree (and, hosted, spaces), offers "New folder" in place, disables the current location, the moved folders and their descendants (with a reason), and calls `useConfirmed(useMoveItems()).run({ items, to })`. Move shows only when every item's `can.move` is true.

- [ ] **Step 1: Failing tests:** `"Move into a private folder moves without a warning"`, `"Move into Medical shows Bob in the warning first"`, `"a folder can't be moved into itself or below (disabled with the reason)"`, `"an artifact shared with me has no Move"`, `"hosted: the picker lists spaces I can publish to; move_blocked shows its copy and moves nothing"`, `"New folder inside the picker selects the new folder"`, `"self-hosted: no space step"`.
- [ ] **Step 2: Run** `pnpm --filter @oa/dashboard test -- folders-move spaces-move`. Expected: FAIL for the new file; P4's cases stay green.
- [ ] **Step 3: Implement per DF4.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): Drive-style Move picker (F2)`

### Task 7: Drag and drop

**Gated on DF6.**

**Files:**
- Create: `apps/dashboard/src/folders/dnd.ts`
- Modify: `folders/FolderTree.tsx`, `folders/FolderView.tsx`, `folders/Breadcrumb.tsx`, `library/{ArtifactCard,ArtifactRow}.tsx`
- Test: `apps/dashboard/test/folders-dnd.test.tsx`, `e2e/folders.spec.ts`

**Interfaces:**
- Produces: `useDraggableItem(item: ItemRef, can: { move: boolean })` and `useDropTarget(target: { folderId: string | null; spaceId?: string; disabled?: string })` over native HTML drag and drop (`application/x-oa-items` payload of `ItemRef[]`); a drop calls the same `useConfirmed(useMoveItems())` as the picker. Items without `can.move` aren't draggable; invalid targets (itself, a descendant, no `edit`) show the reason and accept nothing. Every move has the Move picker as its keyboard path.

- [ ] **Step 1: Failing tests:** `"dropping a card on a shared tree node opens the warning; nothing moves before Continue"`, `"a drop outside any target, Escape, or Cancel moves nothing"`, `"a folder dropped on its own child is refused with the reason"`, `"a view-only card isn't draggable"`, `"dropping two selected rows sends one move with both"`; `e2e/folders.spec.ts`: `"drag a row onto a sidebar folder, confirm, see it in the folder"`.
- [ ] **Step 2: Run** `pnpm --filter @oa/dashboard test -- folders-dnd`. Expected: FAIL.
- [ ] **Step 3: Implement per DF6.**
- [ ] **Step 4: Run** the same and `pnpm --filter @oa/dashboard test:e2e -- folders`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): drag and drop with the access warning (F2)`

### Task 8: Folder share dialog

**Gated on DF7.**

**Files:**
- Create: `apps/dashboard/src/folders/FolderShare.tsx`
- Modify: `viewer/panels/Share.tsx` (an artifact's inherited access: "Has access through <folder>", read only there), `folders/Breadcrumb.tsx` (Share action)
- Test: `apps/dashboard/test/folders-share.test.tsx`, `e2e/share-layout.spec.ts`

**Interfaces:**
- Consumes: `useFolderShares`, `usePutFolderShare`, `useDeleteFolderShare`, `usePatchFolder`, `parseEmail` (existing, `Share.tsx`), P4's public-links rule.
- Produces: `<FolderShare folder={Folder} />`: people with roles, general access (private, team, public; "public" absent when `space.publicLinks` is false or the install has no public links), the "Editors can't share" switch shown only with `can.restrictSharing`. The REST share calls need no token (the dialog is the confirmation, as in Drive). Server errors (`public_links_off`, the hosted share-target refusals) show their copy in place.

- [ ] **Step 1: Failing tests:** `"sharing a folder with Bob adds him with the role"`, `"general access team then public updates the folder"`, `"no public option in a space with public links off"`, `"the switch shows only for the owner or a manager"`, `"an editor under Editors can't share sees no Share on the folder or its items, but Move and Delete remain"`, `"an artifact in Medical shows Bob with through Medical, not removable there"`, `"a stale tab sharing anyway shows the server's message"`.
- [ ] **Step 2: Run** `pnpm --filter @oa/dashboard test -- folders-share share`. Expected: FAIL for the new cases.
- [ ] **Step 3: Implement per DF7.**
- [ ] **Step 4: Run** the same and `pnpm --filter @oa/dashboard test:e2e -- share-layout`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): share a folder (F2)`

### Task 9: Tags on artifacts, the tag list and the tag view

**Gated on DF8.**

**Files:**
- Create: `apps/dashboard/src/tags/{TagEditor,TagChips,TagList,TagView}.tsx`
- Modify: `viewer/panels/Details.tsx` (editor), `layout/AppLayout.tsx` (tag list), `router.tsx` (`/tags/$name`), `library/{ArtifactRow,ArtifactCard}.tsx` (chips)
- Test: `apps/dashboard/test/tags-ui.test.tsx`

**Interfaces:**
- Consumes: `useTags`, `useSetTags`, `useArtifacts({ tag })`.
- Produces: `<TagEditor artifact={ArtifactSummary} />` (only with `can.edit`; suggestions from `useTags({ q })`; case-insensitive matching keeps the existing tag's spelling; at most 20, 1 to 50 characters each), `<TagChips tags={string[]} />` (each links to `/tags/<name>`), `<TagList />` (sidebar, from `useTags()`), `<TagView name={string} />` (everything with the tag across folders, each row showing its folder).

- [ ] **Step 1: Failing tests:** `"an editor adds roadmap; typing ROADMAP reuses roadmap"`, `"a viewer sees chips but no editor"`, `"the sidebar lists only the tags the server returns (no layoffs)"`, `"clicking a tag shows everything with it across folders"`, `"a 21st tag is refused before sending"`, `"no tags: rows render exactly as today"`.
- [ ] **Step 2: Run** `pnpm --filter @oa/dashboard test -- tags-ui`. Expected: FAIL.
- [ ] **Step 3: Implement per DF8.**
- [ ] **Step 4: Run** the same and `pnpm --filter @oa/dashboard test:e2e -- library-layout`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): tags, tag list and tag view (F2)`

### Task 10: Search filters by folder and tag

**Gated on DF9.**

**Files:**
- Modify: `apps/dashboard/src/library/{Search,Filters}.tsx`, `library/{useSearchQuery,useLibraryQuery}.ts`
- Test: `apps/dashboard/test/search-filters.test.tsx`

**Interfaces:**
- Produces: `?folder=<id>` and `?tag=<name>` in the URL for Search (`SearchQuery.folderId`, covering the subtree, and `.tag`) and for the library list (`ListQuery.tag`); unknown or unseen values are dropped from the URL after the server answers, as P4's space filter does.

- [ ] **Step 1: Failing tests:** `"searching inside a folder sends folderId and shows the folder chip"`, `"the tag filter sends tag"`, `"clearing a chip removes it from the URL"`, `"an unseen folder id is cleared"`.
- [ ] **Step 2: Run** `pnpm --filter @oa/dashboard test -- search-filters search`. Expected: FAIL for the new cases.
- [ ] **Step 3: Implement per DF9.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): search by folder and tag (F2)`

### Task 11: Delete a folder and the Trash

**Gated on DF10.** See open question 1.

**Files:**
- Create: `apps/dashboard/src/trash/Trash.tsx`
- Modify: `router.tsx` (`/trash`), `layout/AppLayout.tsx` (Trash entry), `folders/Breadcrumb.tsx` (Delete)
- Test: `apps/dashboard/test/folders-trash.test.tsx`

**Interfaces:**
- Consumes: `useDeleteFolder`, `useRestoreFolder`, `useFolders({ trashed: true })`, `useArtifacts({ includeDeleted: true })` and the existing undelete call.
- Produces: Delete on a folder (with `can.delete`), with a confirmation that says other people's items move to their owners and that it can be restored for 30 days; `<Trash />` lists restorable folders and artifacts, each with Restore.

- [ ] **Step 1: Failing tests:** `"deleting a folder removes it from the tree and view"`, `"the confirmation names what happens to other people's items"`, `"Trash lists the folder; Restore brings it back where it was"`, `"an item restored after its folder is gone shows at the top level"`, `"a viewer has no Delete"`.
- [ ] **Step 2: Run** `pnpm --filter @oa/dashboard test -- folders-trash`. Expected: FAIL.
- [ ] **Step 3: Implement per DF10.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): delete folders and restore from Trash (F2)`

### Task 12: Tag admin

**Gated on DF11.**

**Files:**
- Create: `apps/dashboard/src/settings/Tags.tsx`
- Modify: `settings/SettingsLayout.tsx`, `router.tsx` (`/settings/tags`)
- Test: `apps/dashboard/test/tags-admin.test.tsx`

**Interfaces:**
- Consumes: `useTags`, `usePatchTag`, `useDeleteTag`, `useHosted`.
- Produces: `/settings/tags` for instance owners and admins (self-hosted) or a space manager for each of their spaces (hosted): rename (renaming onto an existing name merges; the copy says so), delete with a confirmation naming the count the caller can see. Members see no entry.

- [ ] **Step 1: Failing tests:** `"an admin renames a tag"`, `"renaming onto an existing name says it merges"`, `"delete asks first and removes the row"`, `"a member has no Tags entry"`, `"hosted: a space manager manages tags per space"`.
- [ ] **Step 2: Run** `pnpm --filter @oa/dashboard test -- tags-admin`. Expected: FAIL.
- [ ] **Step 3: Implement per DF11.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): tag admin (F2)`

### Task 13: End to end and accessibility

**Files:**
- Create: `apps/dashboard/e2e/folders-a11y.spec.ts`, `e2e/real/folders.spec.ts`
- Modify: `e2e/folders.spec.ts`, `e2e/real/fixtures.ts`
- Test: the specs

**Interfaces:**
- Mock config: the Drive journey (make `Projects/specs`, move an artifact in, share the folder with Bob, warning on a move out, tag it, find it by tag and by folder search, delete and restore the folder); axe on the folder view, tree, picker, warning, share dialog, tag view and Trash, in light and dark.
- Real config (`playwright.real.config.ts`, F1 merged): the same journey against `wrangler dev`, plus Bob signing in and seeing the artifact under Shared with me only through the folder, and losing it after the folder is unshared.

- [ ] **Step 1: Write the specs.**
- [ ] **Step 2: Run** `pnpm --filter @oa/dashboard test:e2e -- folders folders-a11y` and `pnpm --filter @oa/dashboard test:e2e:real -- folders`. Expected: PASS, no axe violations.
- [ ] **Step 3: Commit** `test(dashboard): folders and tags end to end (F2)`

---

## Self-review

- Spec coverage: sidebar tree (3), folder view and breadcrumb with tags on rows (2, 9), Move picker and drag and drop with the access warning (5, 6, 7), folder sharing and the switch (8), tags and the tag view (9), search by folder and tag (10), trash and restore (11), tag admin (12), hosted spaces and public-links caps (3, 6, 8). Agent filing and the sort page are F3.
- Every screen is gated on a DF pick; Task 1 and Task 13 are not.
