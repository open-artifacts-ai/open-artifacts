# Hosted M1 · P3: Spaces, roles and Google group sync Implementation Plan (v4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every artifact lives in a space. Access comes from one decision function fed by space roles (set by hand or synced from Google Workspace), shares, visibility and a cap for guests and restricted groups. It is enforced by one middleware on every surface, and directory removals cut live access within minutes.

**Architecture:** Migration `NNNN_spaces.sql` (the next free number when T1 rebases: after P2's `0008` and the nightly trigger's `0009` (#387), likely `0010`) adds spaces, user-id-keyed memberships, group mappings, directory state, audit events and `users.status`. Each user gets a personal space whose id is their user id. It is created on every user insert, so today's installs map 1:1 with no access change. `auth/policy.ts` is the pure decision table (`decide`, `can`, `orgCan`). `auth/authz.ts` gathers its inputs in one D1 statement (`authorize`), and `listFilterSql` returns the same level per row. A Hono middleware enforces `ROUTE_POLICY` before every handler, with `TOOL_POLICY` doing the same for each MCP tool. Two new SQLite Durable Object classes:
- `DirectorySync`: one per install. It runs Google polling and the queued access jobs: space-wide socket closes and revocation retries.
- `UserPresence`: one per user. It records that user's sockets so a revocation closes them at once.

**Tech Stack:** Cloudflare Workers, Hono, Drizzle + D1, Durable Objects (SQLite, hibernating WebSockets, alarms), Google Admin SDK Directory and Reports APIs through the control-plane auth broker, and vitest with `@cloudflare/vitest-plugin`.

**Spec:** `docs/superpowers/specs/2026-10-20-hosted-open-artifacts-design.md` (branch `docs/hosted-design`): sections 3, 4.1, 4.2, 4.5 (tier changes), 4.7 and 5. Roadmap artifact `axtJ4ieni2LsKfTk`, card P3. Review: `hosted-m1-review-p3.md` (v3 not approved; every finding is mapped in "Review traceability" below). **Shared contract:** PR #359 (branch `be/hosted-contract`, at `ed1105c`), indexed by `packages/shared/HOSTED_CONTRACT.md`, sources in `packages/shared/src/hosted/{core,spaces,artifacts,directory,test-hooks}.ts` plus the hosted additions to `schemas.ts`, `routes.ts` and `errors.ts`. It is the source of truth for every shape, route (`R.*`), error code and feature flag named here; this plan uses its names verbatim.

## Global Constraints

- Same code for hosted and self-hosted; hosted features ship in the open-source product behind configuration (spec 3).
- **`HOSTED=1` only tightens or reports.** It may add a fail-closed requirement (broker transport, Turnstile for codes, a named host) or report itself (`Me.instance.hosted`), never enable a feature or loosen a check. Every `HOSTED` read in `apps/server/src` is listed with its reason in `test/node/hosted-lint.test.ts`.
- **A tier change never widens access** (spec 4.5).
- Personal artifacts: admins and execs can't browse or read them. "Execs see everything" means every shared space, never personal spaces (spec 4.2).
- Space artifacts belong to the company; space managers can share, move or delete any artifact in their space.
- When someone leaves, their personal artifacts wait for an admin transfer. Until then nobody new gets access: no new shares and no visibility changes.
- Contractors, outside guests and restricted groups get no more than read-only on any surface, including MCP and the data API. They make no live-data writes and create nothing.
- "Public links off" on a space only blocks NEW public links (403 `public_links_off`); existing public artifacts and `/p/` links keep working.
- 404 for no access, never 403 (existing rule). Contract exceptions: `space_forbidden` (403) on publish or move into a space the caller can't publish to, and on any create by a capped caller; `public_links_off` (403) on making an artifact public in a space with public links off; `space_forbidden` (403) and `directory_mapping_off` (403) on a space manager's mapping PUT (Task 9); `capability_denied`; `csrf`.
- Only the control-plane broker holds shared secrets (spec 4.1/4.7). Installs never hold the Google client secret.
- No new KV namespace (account cap); any new limiter is a `ratelimits` entry in the wrangler template; DO classes join the template `migrations` list under the next tag.
- Free-plan-style CPU per request and per DO alarm (target under 10 ms); D1 rows written pinned in `test/d1-rows.test.ts` (#248).
- Copy: no em dashes in user-facing copy; say "any AI agent".
- Upgrades never pass `--allow-downgrade`; every migration is additive and uses `IF NOT EXISTS`.

## Decided (manager, 2026-10-21; supersedes v3)

- **API role names:** the space roles are `viewer | editor | manager`. `AccessLevel` is `viewer | editor | manager | owner`: a space manager's `access` reads `manager`, and `owner` means only the personal owner. Artifact responses also carry `can` (allowed actions) and `space.myRole`. MCP text says "owner or space manager".
- **Sync failure is fail static, with these limits:**
  - Suspensions and deletions always apply, and a partial read never removes anyone.
  - A wrong customer or domain fails closed.
  - Once sync has been unhealthy for over 1 h, browser sessions older than 24 h are refused and a banner appears. PATs and MCP OAuth grants are exempt from that cap; the banner says "agent tokens not re-verified" (`tokensUnverified: true`).
  - Owners get an email at 24 h.
  - There is **no stale cutoff** (user decision, 2026-10-21 PM): while sync is unhealthy, synced people keep last-sync access indefinitely, PATs and MCP OAuth grants included. `staleAt` is informational only (Task 18).
- **Break-glass for an org owner locked out by `customer_mismatch`** (a stale directory never locks anyone out):
  - It needs a fresh Google sign-in (`hd` verified, within 10 min).
  - It opens only the directory status, connect and sync routes.
  - Every use is audited and emails the owner.
- **Reconcile:** hourly, and also at sign-in (that user only), on mapping changes and on "Sync now". Add Directory `users.watch` if the Reports lag measured on FinQore exceeds 15 min.
- **Content URL revocation lives in D1.** The content host's existing artifact statement joins `users.status` (for user-bound tokens). No KV deny list. The space's public-links toggle is not part of it: it only blocks new public links, so an existing `/p/` link keeps working.
- **The broker does the directory token exchange and refresh on hosted installs.** The install keeps only the AES-GCM-encrypted refresh token. **Self-hosted installs may use a direct transport** with their own Google app (decided by the manager and the user); `HOSTED=1` refuses it.
- **`DIRECTORY_TOKEN_KEY` comes from Platform (P1) provisioning.** It is not a user step.
- **Token cap during unhealthy sync (decided):** the 24 h cap is browser sessions only; PATs and MCP OAuth grants are exempt, and there is no stale cutoff for them either (last-sync access is kept); the owner banner adds "agent tokens not re-verified".
- **`team` in shared spaces keeps today's meaning** (every uncapped member). The protection is who can widen: only managers and personal owners may set visibility; org owners and admins only by self-adding as manager (audited).
- **Owners and admins can't be restricted** (`restrict_admin`); sync skips them in restricted groups. A cap also drops every admin power in `orgCan` as belt and braces.
- **Fail closed on malformed inputs:** `decide` allowlists roles, kinds and flags; capped callers never see trash.
- **Former open questions, now decided:**
  1. Shares on a departed person's artifacts stay until transfer; no new shares or visibility changes.
  2. A new directory id behind an email cuts that email's shares and memberships.
  3. Guests and capped users lose live-data writes; ordinary viewers keep them.
  4. Admins may add themselves to shared spaces only. This is audited and the space managers are emailed.
  5. `owner` stays as a level for personal owners only; managers read `manager`; add `can` and `space.myRole`.
  6. Measure the Reports lag on FinQore.

## Review Focus

1. **Recycled email** (old Bob deleted, new Bob gets the address). Expect new Bob to get a new user row, an empty personal space, and none of old Bob's shares or memberships. Tested in Tasks 14 and 16.
2. **Space toggled to "public links off"** while anonymous viewers hold sockets and `/p/` URLs. Expect the existing `/p/` URLs and sockets to keep working, and only a NEW public link to be refused with 403 `public_links_off`; the toggle never rewrites an artifact or revokes a link. (A move of a public artifact into that space still rewrites it to `team` and closes its sockets.) Tested in Tasks 9 and 11.
3. **The rollout window between Task 1 and Task 9.** Expect a new user or artifact created on a build with only Tasks 1 to 5 to have a personal space and `space_id`, with no FK failure. Tested in Task 1.
4. **A contractor in a restricted group who also gets `allMembersRole` editor or an editor share.** Expect viewer, no publish, no live-data writes, and no creation, even in their personal space. Tested in Tasks 2 and 16.
5. **A delegated (non-super) admin connects the directory.** Expect the connection refused, because partial listings look complete. Tested in Task 12.

---

## Decision table (`auth/policy.ts`; Task 2)

Inputs, gathered by one statement (Task 3):
- **`caller`:** anonymous, or an active member with `id` and `orgRole`. Inactive users never reach the table: `getUser` returns null (Task 6), as it does for synced users while the directory is in `customer_mismatch` (Task 18). Access unchanged when stale; `staleAt` is informational.
- **`cap`:** a `CapReason | null` from `capOf`. `"guest"`: guests when P2's `authConfig.guestsReadOnly` is true. That is the one source: it is true whenever Google or email sign-in is enabled and is not configurable; `FEATURES` cannot set `guests_read_only`, which is only reported. `"restricted"`: the contract's `Restriction` `{ manual, groups: GroupRef[] }` (`Member.restriction`) is restricted if either applies. It is stored as `users.restricted_manual` (the admin's flag) and `users.restricted_sync` (member of a restricted group, kept by sync; frozen group restrictions stay in force). Restricted users never get `allMembersRole`. It is also reported as `Me.auth.cap`.
- **Artifact:** `spaceKind` personal or shared, `spaceId`, `visibility`, `deleted`.
- **Space:** `publicLinks`, `allMembersRole`.
- **`spaceRole`:** the max over `space_members` rows for `caller.id` (manual and sync), the caller's "Every space" role (the max `org_group_mappings.role` over the caller's groups, resolved at read time; shared spaces only, never personal), plus `allMembersRole` when the caller is not a guest and `!cap`.
- **`shareRole`:** the caller's share on this artifact, if any.

First match wins. Then, if `cap` is set, the level is capped at viewer.

| # | Condition | Level |
|---|---|---|
| 1 | Artifact missing | none (404) |
| 2 | Deleted, `allowDeleted`, personal and `spaceId == caller.id` | owner |
| 3 | Deleted, `allowDeleted`, shared and `spaceRole = manager` | manager |
| 4 | Deleted, otherwise | none |
| 5 | Personal and `spaceId == caller.id` | owner |
| 6 | Shared and `spaceRole = manager` | manager |
| 7 | max(`spaceRole` if shared, `shareRole`) = editor | editor |
| 8 | max(`spaceRole` if shared, `shareRole`) = viewer | viewer |
| 9 | `visibility = team`, signed in, not a guest | viewer |
| 10 | `visibility = public` (any space; `publicLinks` never changes a level) | viewer |
| 11 | Otherwise (org admins with no space role, anyone else's personal artifact) | none (404) |

Internal `can(level, action, ctx)` where `ctx = { cap: CapReason | null; personal: boolean }`. The response field `ArtifactSummary.can` is the contract's shared `artifactCan(level, { personal, cap })` (edit, share, setVisibility, delete, transfer, move, dataWrite); a test pins that `can` agrees with `artifactCan` on those seven for every level, kind and cap.

| Action | viewer | editor | manager, owner | Extra rule |
|---|---|---|---|---|
| `view`, `versions`, `version.file`, `thumbnail.read`, `content.mint`, `data.read`, `events`, `subscribe` | yes | yes | yes | |
| `data.write`, `storage` | yes | yes | yes | not if `cap` |
| `thumbnail.write` | first thumbnail only, via share or team (today's rule) | yes | yes | not if `cap` |
| `version.text`, `publish`, `restore`, `upload` | no | yes | yes | |
| `share`, `unshare`, `visibility`, `delete`, `undelete`, `data.reset`, `move` | no | no | yes | an inactive personal owner never reaches here, so no new shares or visibility changes happen until transfer (decision 1) |
| `transfer` (to a person) | no | no | owner only | personal owner only |
| `anonId` | anonymous callers only, with `allowAnonymousWrites` | | | |

`orgCan(member, action, spaceRole?)`:

| Action | Who |
|---|---|
| `space.create`, `space.delete` (empty), `space.mappings` (any role, any space), `org.mappings` (Every-space), `space.allMembers` (`allMembersRole`), `restricted.groups` (add: 409 `directory_sync_off` when sync is off or frozen; remove: any mode, which lifts a frozen restriction), `restricted.member` (manual flag, any mode; never lifts a group restriction) | org owner, org admin |
| `space.publicLinks` (PATCH `publicLinks`; audited) | org owner, org admin, space manager |
| `space.members` (manual rows), `space.rename` | org owner, org admin, space manager |
| `space.mappings.manage` (`spaceParam: "sid"`; per-space mappings on the manager's own shared space). Role ceiling: viewer and editor only. PUT over an existing `manager` row, or with role `manager`, is 403 `space_forbidden`. When the org setting `spaceManagerMappings` is off, PUT is 403 `directory_mapping_off`; GET and DELETE of viewer and editor rows stay allowed (removing access is always allowed). GET on a personal space is 400 `space_personal`. Audited in the handler. | org owner, org admin (no ceiling), space manager (ceiling) |
| `space.adminSelfAdd` (`POST R.spaceMemberSelf(id)`, body `SpaceMemberPut`, 201) | org owner, org admin (shared spaces only; audited `space.admin_self_add`; managers emailed) |
| `space.publish` (publish or move into) | space editor or manager, not `cap` |
| `artifact.create` (incl. personal) | any active non-capped member |
| `transfer.departed` | org owner, org admin |
| `directory.manage` (connect, sync, confirm held) | org owner; break-glass subset (Task 18) |
| `audit.read` | org owner, org admin |
| `members.manage`, `settings.manage` (incl. `spaceManagerMappings`, default true, audited `settings.space_manager_mappings`), `usage.read` | unchanged (owner, admin) |
| `tokens.create`, `mcp.connect` | non-guest, not `cap` |

`ArtifactSummary.can` and `ArtifactSummary.space` (`SpaceRef`, which carries `publicLinks`) are filled on every artifact response, list and search included.

## Per-surface enforcement

Each surface's gate is enforced by `enforcePolicy` middleware (Task 5) before the handler runs. Handlers read `c.var.access` and never re-derive it.

| Surface | Policy entry | Revocation after detection |
|---|---|---|
| Web REST artifacts: get, patch, delete, undelete, versions list, version files, restore, version text, thumbnail get/put, content-url, shares, unshare, move, transfer | `ROUTE_POLICY` artifact actions | next request |
| Library list, trash | `listFilterSql` (level per row from SQL) | next request |
| Search | `listFilterSql` + level per hit | next request |
| Uploads (create, put) | `upload` on the target artifact | next request |
| MCP tools, all 17 plus `list_spaces` | `TOOL_POLICY`, checked against `tool-manifest.json` | next call (user row read per call; grants revoked) |
| REST data API, storage, data reset, anon id | runtime `gate()` kinds mapped 1:1 to actions | next request |
| Content host `/c/` signed (frame and `?dl=1`) | minted after `content.mint`; token carries `uid`; the serve statement joins `users.status` and the `customer_mismatch` check (staleness is not checked) | next request |
| Content host `/p/` public | the serve statement requires `visibility = public` (the public-links toggle only blocks new links, so it is not part of this check) | next request |
| data-subscribe WS | `subscribe` + presence `touch(authzAt)` awaited in the DO accept path | under 1 s |
| events WS | `events` + same presence path; publisher names from policy | under 1 s |
| Spaces, directory, audit, members, settings, usage, tokens, OAuth consent | `orgCan` entries | next request |
| `/auth/*`, OAuth provider endpoints, `/healthz`, `/p/` | explicit `public: true` entries with a reason | n/a |

---

## File structure

- `apps/server/migrations/NNNN_spaces.sql` (create; the next free number, never hardcoded in code or tests): tables, backfill, triggers, indexes.
- `apps/server/src/db/schema.ts` (modify): Drizzle mirrors.
- `apps/server/src/auth/policy.ts` (create): `decide`, `can`, `orgCan`, `namedEvents`, `capOf`. No I/O.
- `apps/server/src/auth/authz.ts` (modify): `authorize`, `listFilterSql`, `loadSpace`.
- `apps/server/src/auth/route-policy.ts` (create): `ROUTE_POLICY`, `TOOL_POLICY`, `enforcePolicy` middleware.
- `apps/server/src/services/spaces.ts`, `routes/spaces.ts` (create): spaces, members, mappings, move, transfer.
- `apps/server/src/services/audit.ts`, `routes/audit.ts` (create).
- `apps/server/src/runtime/presence.ts` (create): `UserPresence` and `revokeUserLive`.
- `apps/server/src/directory/` (create):
  - `google.ts`: API client.
  - `broker.ts`: broker token calls.
  - `crypto.ts`: refresh token at rest.
  - `sync-do.ts`: `DirectorySync`.
  - `apply.ts`: diffs to rows.
  - `signin.ts`: P2 hook.
- `apps/server/src/routes/directory.ts` (create).
- `apps/server/src/content/signing.ts`, `content/app.ts` (modify): `uid` in tokens; the serve statement joins `users` and `spaces`.
- `apps/server/src/services/{users,members,artifacts,shares,uploads,search}.ts` (modify): status, personal space on insert, the ad-hoc `ownerId` checks removed.
- `apps/server/src/mcp/tools/{artifacts,data}.ts`, `mcp/tool-defs.ts`, `mcp/instructions.ts` (modify).
- `apps/server/wrangler.{template,test,staging}.jsonc` (modify): `DIRECTORY_SYNC` and `USER_PRESENCE` bindings; migration tag `v2` with `new_sqlite_classes: ["UserPresence"]` (Task 7, shipped one release before the code that uses it), then tag `v3` with `new_sqlite_classes: ["DirectorySync"]` (Task 13); `ratelimits` entry `RL_DIRECTORY`.
- P2's `POST /__test/session` (extend body only, Task 17).
- `apps/server/src/routes/usage.ts` (modify, Task 19: `usage_off`).
- Tests: `apps/server/test/` as named per task; P5 hooks under `apps/server/test/authz/`.

## Contract names used (PR #359)

- Core (`hosted/core.ts`): `AccessLevelSchema` (`owner | editor | viewer | manager`), `SpaceRole`, `SpaceKind`, `SpaceRef` (`{ id, kind, name, publicLinks }`), `MySpace`, `MemberStatus`, `CapReason` (`guest | restricted`), `GroupRef` (`{ groupId, email, name }`), `Restriction` (`{ manual, groups: GroupRef[] }`), `Tier`, `DirectoryMode` (`off | google | frozen`), `FeatureFlag` + `parseFeatures` + `ENV_FEATURE_FLAGS`, `InstanceDirectory` (`{ mode, healthy, unhealthySince, banner, tokensUnverified }`), `MeAuth` (`{ method, readOnly, cap, expiresAt }`), `ArtifactCan` + `artifactCan`.
- Spaces (`hosted/spaces.ts`): `Space`, `SpacesQuery`, `SpaceCreate`, `SpacePatch`, `SPACE_MANAGER_FIELDS`, `SpaceMember` (user-id keyed, with `status`, `source`, `manualRole`, `syncRole`, `groups: GroupRef[]`, `cap`), `SpaceMemberPut`, `GroupMapping` (`GroupRef` + `role`, `memberCount`, `lastSyncedAt`), `GroupMappingPut`, `RestrictedGroup` (`GroupRef` + `memberCount`, `createdAt`). `Space` has no `outsideSharing`.
- Artifacts (`hosted/artifacts.ts`): `HostedListQuery`, `HostedSearchQuery`, `HostedPublishInput`, `MoveArtifactInput`, `TransferArtifactInput`, `TransferSummary`, `TransferInput`, `TransferResult`, `TRANSFER_PAGE` (100), `MembersQuery`.
- Directory (`hosted/directory.ts`): `DirUser` (`{ id, primaryEmail, suspended, deleted }`), `DirectoryBinding`, `HeldSweep` (`GroupRef` + counts), `SyncStatus` (`{ mode, binding, healthy, state: ok | backoff | auth_failed | customer_mismatch | never, unhealthySince, lastSuccessAt, lastError, nextRunAt, staleAt, alertedAt, customerMismatch, held }`), `DirectoryGroup` (`{ groupId, email, name, memberCount }`), `DirectoryGroupsQuery`, `DirectoryConnectError`, `AuditReason` (why a status changed: `directory_suspend | directory_unsuspend | directory_delete | directory_new_id | directory_stale | admin_suspend | admin_remove | admin_restore`; `directory_stale` is unused by P3, since staleness never changes a status, and should be dropped from the contract), `AuditAction`, `AuditEvent`.
- Test hooks (`hosted/test-hooks.ts`): `TEST_HOOKS_ALLOWED`, `TestSessionInput` (`spaces?: { spaceId, role }[]`).
- Errors (no `space_publish_forbidden`, no `forbidden_identity`): `space_forbidden` (403), `public_links_off` (403), `space_personal`, `space_not_empty`, `use_move`, `invalid_successor`, `member_active`, `directory_sync_off`, `reauth_required`.
- Server-internal (not in the contract): `GoogleUser` (`DirUser` plus `isAdmin`, `customerId`, used by `google.ts`), `roleIn(env, userId, spaceId): Promise<SpaceRole | null>`, `Cred = { cookie?: string; pat?: string; oauth?: string }` (`test/authz/surfaces.ts`), `AuditActor = { kind: "user" | "sync" | "system"; id: string | null }`.

---

### Task 1: The spaces migration and the rollout window

**Files:**
- Create: `apps/server/migrations/NNNN_spaces.sql` (tests find it by suffix: `migrations.find((m) => m.name.endsWith("_spaces.sql"))`)
- Modify: `apps/server/src/db/schema.ts`, `services/users.ts` (every user insert), `services/artifacts.ts` (create), `services/members.ts` (`removeMember` with the flag off)
- Test: `apps/server/test/spaces.migration.test.ts`, `apps/server/test/d1-rows.test.ts`

**Interfaces:**
- Consumes: P2's `0008` (`identities(provider, subject, user_id)`, `login_codes`, and `users.status` `active|suspended|removed`, which P3 does not re-add but owns changing); P2's `insertUserStmts` is the only app insert path, and the personal space still comes from P3's trigger.
- Tables (all `IF NOT EXISTS`):
  - `spaces(id pk, kind 'personal'|'shared', name, owner_user_id null, all_members_role null, public_links int default 0, created_at, deleted_at)`. No `outside_sharing` column: it is dropped from both the schema and the contract until M4 (decided).
  - `space_members(space_id, user_id, role, source 'manual'|'sync', created_at, pk(space_id, user_id, source))`, with an index on `(user_id)`.
  - `group_mappings(space_id, group_id, group_email, role, pk(space_id, group_id))`.
  - `org_group_mappings(group_id pk, group_email, role)`: the "Every space" mapping. One row per group, never expanded into per-space rows: it is resolved at read time as the max with the per-space roles (Tasks 3 and 4), applies to every shared space including ones created later, and never to a personal space.
  - `restricted_groups(group_id pk, group_email)`, keyed by Google `groupId`, never the email.
  - `directory_groups(group_id pk, email, parent_ids json, gen)`.
  - `directory_members(group_id, user_id, gen, pk(group_id, user_id))`.
  - `directory_state(key pk, value)`.
  - `audit_events(id pk, at, actor_kind, actor_id, action, target_type, target_id, space_id, detail json)`, with an index on `(at)`.
- Columns: `users.restricted_manual int default 0`, `users.restricted_sync int default 0`, `artifacts.space_id` (references `spaces`), `identities.directory_bound int default 0` (on P2's table).
- Backfill: one personal space per user (`id = users.id`), then `update artifacts set space_id = owner_id`.
- Index: `artifacts_space_live_idx on artifacts(space_id) where deleted_at is null`, created after the update.
- Triggers:
  - `artifacts_space_required`: before insert, `select raise(abort, 'space_id required') where new.space_id is null`.
  - `users_personal_space`: after insert, `insert or ignore into spaces ... values (new.id, 'personal', ...)`.
  The trigger makes the personal space exist wherever a user row is inserted, including P2's admission and invites, even before Task 9 ships.
- `createArtifact` writes `space_id = input.spaceId ?? user.id` from Task 1 onward.
- `removeMember` with the flag off reassigns `space_id` together with `owner_id` to the instance owner (today's behaviour, now also moving the space).

- [ ] **Step 1: Write the failing tests**

```ts
it("the spaces migration keeps every (user, artifact) access level", async () => {
  const before = await snapshotLevels(env, legacyAccessLevel); // seeded at 0008
  await applyMigration(env, SPACES_MIGRATION); // found by suffix, not number
  expect(await snapshotLevels(env, accessLevel)).toEqual(before);
});
it("a user inserted after the spaces migration has a personal space (trigger)", async () => {
  const u = await insertUser(env, { email: "late@x.com", role: "member" });
  expect(await spaceRow(env, u.id)).toMatchObject({ kind: "personal", owner_user_id: u.id });
});
it("an artifact created on the T1-T5 build gets space_id = creator", async () => {
  const { id } = await publish(cookieOf("late@x.com"), { title: "t", format: "html", content: "<p>x" });
  expect((await row(env, id)).space_id).toBe(userId("late@x.com"));
});
it("insert without space_id aborts", async () => {
  await expect(rawInsertArtifact(env, { space_id: null })).rejects.toThrow("space_id required");
});
it("flag-off removeMember moves owner_id and space_id together", async () => { /* expect both = owner id */ });
```

- [ ] **Step 2: Run** `pnpm -F @oa/server test spaces.migration`. Expected: 5 failed (`no such table: spaces`).
- [ ] **Step 3: Implement** the migration (hand-edited after drizzle-kit, as in 0000), the schema, and the create and remove changes.
- [ ] **Step 4: Update `d1-rows.test.ts`**: publish goes from `10` to `11` (`+1 artifacts_space_live_idx`); a new version stays `5`.
- [ ] **Step 5: Run** `pnpm -F @oa/server test spaces.migration d1-rows query-plans`. Expected: all pass.
- [ ] **Step 6: Commit** `feat(server): spaces schema, personal space per user (P3)`.

### Task 2: Pure decision table

**Files:** Create `apps/server/src/auth/policy.ts`; Test `apps/server/test/policy.table.test.ts`

**Interfaces:**
- Produces:
  - `decide(i: DecisionInput): AccessLevel | null`
  - `can(level: AccessLevel | null, action: PolicyAction, ctx: CanCtx): boolean`
  - `orgCan(m: Member, action: OrgAction, spaceRole?: SpaceRole | null, ctx?: { cap: boolean }): boolean`
  - `capOf(m: Member & { restrictedManual: boolean; restrictedSync: boolean }, authConfig: { guestsReadOnly: boolean }): CapReason | null` (`decide` takes its result; `authConfig` is P2's)
  - `namedEvents(caller, level, visibility): boolean`
- `PolicyAction` is the union of the action names in the `can` table above (a superset of the contract's `ArtifactAction`, which names only the seven `can` fields); `OrgAction` is the union of the names in the `orgCan` table.
- `DecisionInput = { caller: { id: string; orgRole: Role } | null; cap: boolean; artifact: { spaceId; spaceKind; visibility; deleted }; space: { publicLinks: boolean; allMembersRole: SpaceRole | null }; spaceRole: SpaceRole | null; shareRole: "viewer" | "editor" | null; allowDeleted: boolean }`.

- [ ] **Step 1: Write the failing test.** Encode the three tables above as literal arrays, `it.each` over every row, plus:

```ts
it("restricted member with allMembersRole editor and an editor share is viewer", () => {
  expect(decide({ ...base, cap: true, spaceRole: "editor", shareRole: "editor" })).toBe("viewer");
});
it("cap removes data.write and storage", () => {
  expect(can("viewer", "data.write", { ...ctx, cap: true })).toBe(false);
  expect(can("viewer", "data.write", { ...ctx, cap: false })).toBe(true);
});
it("org admin with no space role on a shared private artifact is null", () => { /* null */ });
it("org owner on someone's personal private artifact is null", () => { /* null */ });
it("internal can agrees with the contract's artifactCan on its seven actions", () => {
  for (const level of LEVELS) for (const personal of [true, false]) for (const cap of [null, "guest", "restricted"] as const)
    expect(pickSeven((a) => can(level, a, { personal, cap }))).toEqual(artifactCan(level, { personal, cap }));
});
it("orgCan artifact.create refuses capped members", () => { /* false */ });
```

- [ ] **Step 2: Run** `pnpm -F @oa/server test policy.table`. Expected: fails with `Cannot find module '../src/auth/policy.js'`.
- [ ] **Step 3: Implement.** Space-role ranks are `viewer 1, editor 2, manager 3`. Level ranks are `viewer 1, editor 2, manager 3, owner 3`: manager and owner allow the same artifact actions except `transfer` (owner only).
- [ ] **Step 4: Run.** Expected: every row passes.
- [ ] **Step 5: Commit** `feat(server): central access decision table (P3)`.

### Task 3: `authorize()` and `roleIn()`

**Files:** Modify `apps/server/src/auth/authz.ts`; Test `apps/server/test/authz.matrix.test.ts` (existing cases unchanged), `apps/server/test/authz.spaces.test.ts`

**Interfaces:**
- Produces:
  - `authorize(env, c: Caller, artifactId, action: PolicyAction, opts?: { allowDeleted?: boolean }): Promise<{ level: AccessLevel; artifact: ArtifactRow; space: SpaceRow; can: ArtifactCan }>` (`can` from `artifactCan`). It throws `not_found` when `!can`, or `capability_denied` for runtime actions on an undeclared capability.
  - `roleIn(env, userId: string, spaceId: string): Promise<SpaceRole | null>`.
  - `loadSpace(env, c: Caller, spaceId, action: OrgAction): Promise<SpaceRow>`: an unseen space is 404; a personal space is 400 `space_personal` on every spaces route, move and transfer target (contract), except `space.publish` when `spaceId == caller.id` (publishing into one's own personal space).
- One SQL statement: `artifacts` by PK, joined to `spaces` by PK and to `shares` on (artifact, caller email). A scalar `max(rank)` over `space_members where space_id = ? and user_id = ?`, maxed (when `spaces.kind = 'shared'`) with a scalar `max(rank)` over `org_group_mappings` joined to `directory_members` on `group_id` for `user_id = ?`, gives the space role (the Every-space term reads one row per org mapping, a handful); `users.restricted` and `status` come from the session row already loaded.
- `accessLevel` becomes a thin wrapper until Task 5 deletes it. `requireAccess(min)` stays, built on the contract's exact-owner rule (server `meetsLevel`): `manager` has the owner's rank but never passes an owner check, so `requireAccess(..., "owner")` refuses `manager`. Every manager-allowed action (share, setVisibility, delete, undelete, data reset, move) goes through `authorize(..., action)` and `can`, never `requireAccess("owner")`. The only `requireAccess("owner")` left is single transfer.

- [ ] **Step 1: Write failing tests** with rows-read counting (the `meta.rows_read` proxy, as `d1-rows.test.ts` does):

```ts
it("one statement, at most 4 rows read", async () => {
  rows.read = 0; await authorize(counted, callerOf(editor), spaceArt, "publish");
  expect(rows.read).toBeLessThanOrEqual(4); expect(rows.statements).toBe(1);
});
it("creator who is only a space editor cannot change visibility or anon writes", async () => {
  await expect(patch(editorCookie, spaceArt, { visibility: "public" })).resolves.toHaveProperty("status", 404);
});
it("space manager can share, setVisibility and delete a space artifact", async () => { /* 200 x3 */ });
it("space manager cannot single-transfer (owner only)", async () => { /* 404 */ });
it("requireAccess(\"owner\") refuses a manager", async () => { /* not_found */ });
it("creator removed from the space loses access to what they created there", async () => { /* 404 */ });
it("MCP data tools: creator without db capability gets capability_denied", async () => { /* not owner bypass */ });
```

- [ ] **Step 2: Run** `pnpm -F @oa/server test authz`. Expected: the new tests fail; the existing ones pass.
- [ ] **Step 3: Implement**, and delete the ad-hoc `ownerId` checks:
  - `services/artifacts.ts` publish-sharing branch and `patchArtifact`: use `can(level, "visibility" | "share")`.
  - `mcp/tools/data.ts` `store()`: the owner capability bypass goes through `authorize(..., "data.write")`, which keeps the B14 owner rule as `level === "owner" && isPersonalOwner`.
  - List and search: the access level comes from SQL (Task 4).
- [ ] **Step 4: Run** `pnpm -F @oa/server test authz query-plans`. Expected: all pass, and the plan snapshot shows PK and index use (no `SCAN`).
- [ ] **Step 5: Commit** `feat(server): authorize() over spaces; drop ad-hoc owner checks (P3)`.

### Task 4: Lists and search with the level in SQL

**Files:** Modify `authz.ts` (`listFilterSql`, `levelSql`), `services/artifacts.ts` list, `services/search.ts`; Test `apps/server/test/list.spaces.test.ts`, `search.authz.test.ts`, `query-plans.test.ts`

**Interfaces:**
- Produces:
  - `listFilterSql(c, scope, includeDeleted?, spaceId?): SQL`
  - `levelSql(c): SQL`: a `CASE` expression yielding `owner | editor | viewer`, the same rules as `decide`.
- Branches, each with `deleted_at is null` (one per scope):
  - **mine:** `space_id = caller.id`.
  - **shared:** the share subquery.
  - **team:** `visibility in (team, public)` for non-guests; public regardless of the space's public-links toggle (it only blocks new public links).
  - **spaces:** `space_id in (select sm.space_id from space_members sm join spaces s on s.id = sm.space_id and s.kind = 'shared' where sm.user_id = ?)`, OR `space_id in (select id from spaces where kind = 'shared' and all_members_role is not null)` (omitted for guests and capped users), OR `space_id in (select id from spaces where kind = 'shared') and exists (select 1 from org_group_mappings ogm join directory_members dm on dm.group_id = ogm.group_id where dm.user_id = ?)` (the Every-space mapping, resolved at read time; never personal spaces). `levelSql` takes the max of the per-space role and the Every-space role in the same `CASE`.
  - **space:** one shared space (`loadSpace` first).

- [ ] **Step 1: Failing tests**

```ts
it("list(all) ids and levels equal authorize() for every seeded artifact", async () => {
  for (const who of CALLERS) {
    const listed = await listAll(who);                       // id -> access
    const allowed = await authorizeAll(who);                 // id -> level | null
    expect(listed).toEqual(pickNonNull(allowed));
  }
});
it("scope=space with another user's personal space id returns 400 space_personal and lists nothing", async () => { /* attack seed */ });
it("search never returns another user's personal artifact to an admin", async () => { /* empty */ });
it("an Every-space editor mapping lists every shared space (including one created after the mapping) at editor, and no personal space", async () => { /* editor; personal absent */ });
it("Every-space viewer and per-space manager resolve to manager (max at read time)", async () => { /* manager */ });
```

- [ ] **Step 2: Run.** Expected: fails (`scope` enum has no "space").
- [ ] **Step 3: Implement**, folding the contract's `HostedListQuerySchema` into `ListQuerySchema` (scope `space` and `spaces`, `spaceId`, the `space` needs `spaceId` refine) and `HostedSearchQuerySchema` into `SearchQuerySchema` in `packages/shared/src/schemas.ts`, then delete the two `Hosted*` schemas. Because those schemas also define the MCP `list_artifacts` and `search_artifacts` inputs and the generated skill, run `pnpm -F @oa/server gen` and commit the regenerated `tool-manifest.json`, `skill.generated.ts` and `upgrade.generated.ts`.
- [ ] **Step 4: Run** `pnpm -F @oa/server test list.spaces search.authz query-plans`. Expected: passes, plan shows `MULTI-INDEX OR`.
- [ ] **Step 5: Commit** `feat(server): space-aware list and search with SQL levels (P3)`.

### Task 5: Enforced route and tool policy

**Files:** Create `apps/server/src/auth/route-policy.ts`; Modify `app.ts`, `index.ts` (content host), `routes/*.ts`, `mcp/server.ts`, `mcp/tools/*.ts`, `runtime/routes.ts`; Test `apps/server/test/route-policy.test.ts`, `apps/server/test/cross-user.generated.test.ts`

**Interfaces:**
- Produces:
  - `ROUTE_POLICY: Record<"METHOD /path/:param", Policy>`, where `Policy = { artifact: PolicyAction; idParam: "id" } | { org: OrgAction; spaceParam?: "sid" } | { public: true; reason: string } | { signed: "content" }`.
  - `TOOL_POLICY: Record<ToolName, Policy>`.
  - `enforcePolicy(): MiddlewareHandler`: resolves the matched route's policy, runs `authorize` or `orgCan`, sets `c.var.access`, and throws 404 for a route with no policy entry.
- It covers the app host, the content host, `/auth/*`, the OAuth provider routes and the runtime routes. The MCP dispatcher runs `TOOL_POLICY` before each tool handler.
- Lint test: no `.role ===`, `TEAM_ROLES` or `.ownerId` comparison outside `src/auth/` and `services/users.ts` attribution helpers, and no `requireAccess(…, "owner")` call outside `transferArtifact`. It parses with the TypeScript compiler API (`ts.createSourceFile`), not a regex.

- [ ] **Step 1: Failing tests**

```ts
it("every mounted route (app, content, auth, oauth, runtime) has a policy", () => {
  for (const r of allRoutes(createApp())) expect(ROUTE_POLICY).toHaveProperty(`${r.method} ${r.path}`);
});
it("every tool in tool-manifest.json has a TOOL_POLICY entry and vice versa", () => {
  expect(Object.keys(TOOL_POLICY).sort()).toEqual(manifest.map((t) => t.name).sort());
});
it("no ad-hoc role or ownerId checks, no requireAccess(\"owner\") outside transfer (AST scan)", () => { expect(findAdHocChecks("src")).toEqual([]); });
// cross-user.generated.test.ts: for each scoped route and tool, a non-member caller gets 404
describe.each(scopedRoutesAndTools())("%s", (r) => {
  it("non-member → 404", async () => expect((await r.call(nonMember)).status).toBe(404));
});
```

- [ ] **Step 2: Run.** Expected: fails (`ROUTE_POLICY` is undefined).
- [ ] **Step 3: Implement**, and replace every inline check (from `grep -rn 'TEAM_ROLES\|\.role\|ownerId\|requireAccess\|accessLevel' src`). Delete the `accessLevel` wrapper.
- [ ] **Step 4: Run** `pnpm -F @oa/server test && pnpm -F @oa/server typecheck`. Expected: all pass.
- [ ] **Step 5: Commit** `refactor(server): enforce route and tool policy in middleware (P3)`.

### Task 6: User status and admission

**Files:** Modify `services/users.ts` (`getUser`, `insertUser`), `services/members.ts`; Test `apps/server/test/members.status.test.ts`

**Interfaces:**
- Produces: `setUserStatus(env, userId, status, why: AuditReason, ctx?): Promise<void>`. It writes the status, revokes PATs, calls `revokeAllGrants` and then `revokeUserLive`, and writes an `audit` row in the same batch.
- `getUser` returns null unless `status = 'active'` (Task 18 extends the same statement with the `customer_mismatch` check for synced users). Access unchanged when stale; `staleAt` is informational.
- Admission is P2's (confirmed seam): `identities(provider, subject)` is the only link, P2 verifies `sub ==` the directory user id, refuses non-active users, and then calls P3's `onGoogleSignIn(env, user)` (Task 14). P3 adds no admission code; its tests assert the seam behaviour end to end.
- `removeMember` with `FEATURES.spaces` on calls `setUserStatus("removed")` and keeps the row and personal space.

- [ ] **Step 1: Failing tests**

```ts
it.each(["cookie", "pat", "oauth"])("suspended user → 401 via %s", async (cred) => { /* 401 */ });
it("removed user's personal artifacts stay unreadable by the org owner", async () => { /* 404 */ });
it("a removed user signing in with a valid Google identity is refused (P2 admission)", async () => { /* 302 /sign-in?error=removed (P2's SignInError; identity conflicts are identity_conflict) */ });
it("reactivated user's PATs stay revoked", async () => { /* 401 */ });
it("gatherer: a suspended or removed user resolves to nobody on every surface", async () => { /* getUser returns only status='active' rows (#368) */ });
it("unsuspend sets status back to active; a removed row stays removed", async () => { /* active; removed */ });
```

- [ ] **Step 2: Run.** Expected: 4 failures. **Step 3: Implement.** **Step 4: Run** `pnpm -F @oa/server test members`. Expected: passes.
- [ ] **Step 5: Commit** `feat(server): user status, admission seam with P2 (P3)`.

### Task 7: `UserPresence` and prompt socket revocation

**Files:** Create `apps/server/src/runtime/presence.ts`; Modify `runtime/do.ts`, `runtime/routes.ts`, `runtime/revoke.ts`, `env.ts`, `wrangler.*.jsonc`, `docs/security/security.md`; Test `apps/server/test/presence.test.ts`

**Interfaces:**
- `UserPresence` RPCs:
  - `touch(artifactId: string, authzAt: number): Promise<{ ok: boolean }>`: records `(artifact_id, seen_at)` and returns `ok: false` when `revokedAt >= authzAt`.
  - `closeAll(reason): Promise<number>`: sets `revokedAt = now` first. It then calls `closeActor` per recorded artifact, and failed closes go to a durable retry queue in its own storage, retried by alarm with backoff until 11 min old.
- The route passes `authzAt` (when `authorize` ran) in a header to the artifact DO. The DO's accept path awaits `presence.touch`; if `ok` is false, it closes the socket with 4403 at once.
- `ArtifactRuntime.closeActor(actor, reason): number`: every data and events socket is tagged `a:{actor}`.
- `revokeUserLive(env, userId, reason, ctx?)`: never throws. It is called by `setUserStatus`, membership and mapping narrowing, sync, `removeMember`, transfer and a customer mismatch (Task 18). Staleness never calls it.

- [ ] **Step 1: Failing tests**

```ts
it("suspending a user closes their data and events sockets with 4403", async () => {
  const ws = await openSockets(member, art); await setUserStatus(env, member.id, "suspended", admin);
  expect(await ws.closed).toMatchObject({ code: 4403 });
});
it("socket accepted after revocation started is closed (authzAt <= revokedAt)", async () => { /* 4403 */ });
it("other users' sockets stay open", async () => { /* open */ });
it("a failed closeActor is retried from the queue", async () => { /* fake DO throws once; closed on retry */ });
```

- [ ] **Step 2: Run.** Expected: fails. **Step 3: Implement.** **Step 4: Run** `pnpm -F @oa/server test presence runtime events`. Expected: passes.
- [ ] **Step 5:** Update `docs/security/security.md`: sockets close within 1 s of detection, and today's 10 min ceiling for team artifacts is retired.
- [ ] **Step 6: Commit** `feat(server): per-user presence closes live sockets (P3)`.

### Task 8: Audit events

**Files:** Create `services/audit.ts`, `routes/audit.ts`; Test `apps/server/test/audit.test.ts`

**Interfaces:**
- Produces: `audit(env, action: AuditAction, target: AuditEvent["target"], actor: AuditActor, extra?: { spaceId?: string; reason?: AuditReason; detail?: Record<string, unknown> }): D1PreparedStatement`. Callers add the statement to their own batch. Rows read back as the contract's `AuditEvent` (target types `space | artifact | user | mapping | directory | group`, `group` being a Google group id).
- `AuditAction` is the contract enum: `auth.signin`, `space.create`, `space.update`, `space.public_links`, `space.delete`, `space.member.add`, `space.member.remove`, `space.member.role`, `space.admin_self_add`, `mapping.set`, `mapping.remove`, `restricted.set`, `restricted.remove`, `artifact.move`, `artifact.transfer`, `artifact.share`, `artifact.unshare`, `artifact.visibility`, `user.status`, `identity.reset`, `directory.connect`, `directory.disconnect`, `directory.sync`, `directory.sync.failed`, `directory.stale`, `directory.sweep.held`, `directory.sweep.confirmed`, `directory.break_glass`, `features.change`. A customer mismatch is `directory.sync.failed` with `detail.state = "customer_mismatch"`.
- Sign-ins are recorded through P2's admission hook. Share and visibility changes come from `services/shares.ts` and `services/artifacts.ts`.
- `R.audit` (`Page<AuditEvent>`) and `R.auditExport` (NDJSON) are for org owners and admins.

- [ ] **Step 1: Failing tests**

```ts
it("artifact.share writes one audit row in the share batch", async () => {
  const before = await count(env, "audit_events"); await share(owner, art, "x@y.com", "viewer");
  expect(await count(env, "audit_events")).toBe(before + 1);
  expect(await lastAudit(env)).toMatchObject({ action: "artifact.share", target_id: art, actor_kind: "user" });
});
it("sign-in is audited as auth.signin", async () => { /* action auth.signin */ });
it("member and guest get 404 on /audit", async () => { /* 404, 404 */ });
it("export streams NDJSON with one line per event", async () => { /* lines.length === n */ });
```

- [ ] **Step 2: Run.** Expected: 4 failures (`no such table` is gone after Task 1; `audit is not a function`). **Step 3: Implement.** **Step 4: Run** `pnpm -F @oa/server test audit`. Expected: 4 passed.
- [ ] **Step 5: Commit** `feat(server): audit events incl. shares, visibility and sign-ins (P3)`.

### Task 9: Spaces API and space-wide narrowing

**Files:** Create `services/spaces.ts`, `routes/spaces.ts`; Modify `directory/sync-do.ts` (access jobs); Test `apps/server/test/spaces.api.test.ts`

**Interfaces:**
- Routes and shapes exactly as in PR #359: `R.spaces` (`SpacesQuery` → `Page<Space>`), `R.space(id)`, `R.spaceMembers(id)` (`Page<SpaceMember>`), `R.spaceMember(id, userId)`, `R.spaceMappings(id)`, `R.spaceMapping(id, groupId)`, and the instance-wide `R.restrictedGroups` / `R.restrictedGroup(groupId)` (keyed by `groupId`; groups appear as `GroupRef { groupId, email, name }` everywhere). `PUT R.restrictedGroup` is 409 `directory_sync_off` when sync is off or frozen; `DELETE` works in any mode and lifts a frozen restriction. The manual flag `PUT/DELETE R.memberRestricted(id)` (→ `Member` with `restriction`; org owner or admin; any mode; audited `restricted.set` / `restricted.remove`) covers Team, manual and frozen installs and never lifts a group restriction. Any restriction change calls `revokeUserLive`. Owners and admins can never be restricted: `R.memberRestricted` on an owner or admin target is 400 `restrict_admin` (contract #370), and `orgCan` also drops every admin power under a cap as belt and braces. Mapping changes and restricted-group adds while sync is off or frozen are 409 `directory_sync_off`. Personal spaces on any of these routes are 400 `space_personal`; deleting a non-empty space is 409 `space_not_empty`.
- **Per-space mappings by space managers (`space.mappings.manage`, `spaceParam: "sid"`):** on `R.spaceMappings(id)` and `R.spaceMapping(id, groupId)`, org owners and admins may map any role; a space manager may map only `viewer` or `editor` on their own shared space. A manager's PUT with role `manager`, or over an existing `manager`-role row, is 403 `space_forbidden`. The org setting `spaceManagerMappings` (in `PATCH R.settings`, `settings.manage`, default true, audited `settings.space_manager_mappings`) gates manager PUTs: when off, a manager's PUT is 403 `directory_mapping_off`, while GET and DELETE of viewer and editor rows on their own space keep working (removing access is always allowed). GET on a personal space is 400 `space_personal`. The handler writes `mapping.set` / `mapping.remove` in the same batch.
- **Every-space mappings (pending contract additions):** `GET R.orgMappings` (`GET /api/v1/directory/org-mappings` → `Page<GroupMapping>`), `PUT R.orgMapping(groupId)` (`PUT /api/v1/directory/org-mappings/:groupId`, `GroupMappingPut` → `GroupMapping`) and `DELETE R.orgMapping(groupId)` (204), org owner or admin only (`org.mappings`), 409 `directory_sync_off` while sync is off or frozen, audited `mapping.set` / `mapping.remove` with `detail.scope = "org"`. PUT and DELETE write the one `org_group_mappings` row and the audit row; they never write per-space rows. The role is resolved at read time as the max with per-space roles (Tasks 3 and 4), applies to shared spaces created later with no extra write, and never applies to a personal space. PUT kicks `DirectorySync` (`mapping`) so the group's `directory_members` rows exist; DELETE or a lowered role enqueues `revokeUsers` for the group's members.
- `PATCH R.space(id)`: `SPACE_MANAGER_FIELDS` (`name`, `publicLinks`) for space managers and org admins; `allMembersRole` for org admins. Every `publicLinks` change writes `space.public_links`.
- **Public links off (user decision, 2026-10-21 PM): it only blocks NEW links.**
  - One batch: the space update and the audit row. Nothing else: no artifact is rewritten to `team` and no socket is closed. Existing `/p/` links and their anonymous sockets keep working (the serving check never consults `public_links`).
  - New `public` on that space (PATCH or publish) is 403 `public_links_off`, enforced on the visibility route itself (pinned from the #367 review).
  - The move rule is separate (T10): a public artifact moved into a no-public-links space is rewritten to `team` in the move batch and its sockets close.
- **Lowering `allMembersRole`, removing or lowering a mapping (per-space or Every-space), or removing a member:** the job `revokeUsers(userIds)` runs in pages of 50, with no cap.
  - **Deviation, accepted for M1 (manager, 2026-10-24):** until T13's `DirectorySync` queue lands, T9 revokes in the request's `waitUntil` (`revokeUsersLive`), capped at 20 users on Free and 450 on Paid, so one invocation stays within its subrequest limit. The SQL reads at most cap + 1 ids, most recently seen first. Past the cap, `revoke_fanout_truncated` alerts the operator, and the remaining users' open sockets end at the 10-minute TTL (their next request and reconnect are refused by D1 at once). T13 moves the fan-out to its queue and removes the cap.
- **Peer managers (manager ruling, 2026-10-24):** a space manager who is not an org admin can't remove, demote or override another manager's row, manual or synced, frozen mode included: 403 `space_forbidden` `{ target: "member" }` (DELETE checks it before `member_synced`). Org owners and admins are unaffected.
- Admin self-add (`POST R.spaceMemberSelf(id)`, `SpaceMemberPut` → 201 `SpaceMember`, org admin): shared spaces only (else 400 `space_personal`); writes `space.admin_self_add` and emails the space managers.

- [ ] **Step 1: Failing tests**

```ts
it("public links off leaves existing public artifacts and /p/ links working (no rewrite, no revocation)", async () => {
  const before = await openAnonSockets(sixtyArtifactsInSpace);  // over the old 50 cap
  await patchSpace(admin, sid, { publicLinks: false });
  expect((await row(env, pubArt)).visibility).toBe("public");
  expect((await fetchP(pubArt)).status).toBe(200);
  for (const ws of before) expect(await ws.closed).toBe(false);
});
it("PATCH visibility=public, or publish with visibility public, on a no-public-links space → 403 public_links_off", async () => { /* 403 x2 */ });
it("per-user restricted flag caps a member and audits restricted.set", async () => { /* viewer; audit */ });
it("restricted group PUT while sync is frozen → 409 directory_sync_off; existing frozen restrictions still cap", async () => { /* 409; viewer */ });
it("restricted group DELETE while frozen lifts the restriction", async () => { /* 204; editor again */ });
it("manual restricted DELETE never lifts a group restriction", async () => { /* still viewer */ });
it("restricting an owner or admin → 400 restrict_admin", async () => { /* 400 x2 */ });
it("space manager may turn public links off; audited space.public_links", async () => { /* 200 */ });
it("mapping PUT while sync is off → 409 directory_sync_off", async () => { /* 409 */ });
it("PUT R.orgMapping writes one org_group_mappings row and no space_members rows; a space created later grants the role; personal spaces never do", async () => { /* 1 row; role in new space; personal 404 */ });
it("DELETE R.orgMapping revokes the group's members' live access", async () => { /* 4403 */ });
it("GET /api/v1/directory/org-mappings returns Page<GroupMapping>", async () => { /* items, nextCursor */ });
it("space manager maps a group as viewer on their space → 200, audited mapping.set", async () => { /* 200; audit */ });
it("space manager maps a group as manager → 403 space_forbidden", async () => { /* 403 */ });
it("space manager PUT over an existing manager-role row → 403 space_forbidden", async () => { /* 403 */ });
it("spaceManagerMappings off: manager PUT → 403 directory_mapping_off; GET and DELETE of a viewer row still work", async () => { /* 403; 200; 204 */ });
it("org admin may still map any role, setting on or off", async () => { /* 200 */ });
it("mapping GET on a personal space → 400 space_personal", async () => { /* 400 */ });
it("GET /spaces pages with nextCursor", async () => { /* items.length === limit; nextCursor set */ });
it("self-add to a shared space by an admin audits and emails managers", async () => { /* 1 audit, 1 email per manager */ });
it("self-add to a personal space → 400 space_personal", async () => { /* 400 */ });
it("spaces flag off → POST /spaces 404, authz unchanged", async () => { /* 404 */ });
```

- [ ] **Step 2: Run.** Expected: 22 failed. **Step 3: Implement.** **Step 4: Run** `pnpm -F @oa/server test spaces.api`. Expected: 22 passed.
- [ ] **Step 5: Commit** `feat(server): spaces API, public-links-off and space-wide revocation (P3)`.

### Task 10: Publish into spaces, move, transfer, MCP

**Files:** Modify `services/artifacts.ts`, `services/spaces.ts`, `routes/artifacts.ts`, `routes/members.ts`, `mcp/tools/artifacts.ts`, `mcp/tool-defs.ts`, `mcp/instructions.ts`; Test `apps/server/test/spaces.move.test.ts`, `apps/server/test/mcp.tools.test.ts`

**Interfaces:**
- Errors per the contract: a publish or move into a space the caller can't publish to, or any create by a capped caller, is 403 `space_forbidden`; a personal move target is 400 `space_personal`; `spaceId` on an existing artifact is 400 `use_move`; a bad successor is 400 `invalid_successor`; a departed-person transfer on an active member is 409 `member_active`.
- Fold `HostedPublishInputSchema` into `PublishInputSchema` (`spaceId?`, create only) in `packages/shared/src/schemas.ts` and delete the `Hosted*` schema. The MCP `publish_artifact` input and the generated skill change with it. The target is resolved by `loadSpace(..., "space.publish")`, so another user's personal space is a 404.
- `moveArtifact(env, user, id, toSpaceId, ctx)`:
  - Needs `can(level, "move")` and `orgCan("space.publish", { spaceRole: roleIn(to), cap })` on the target (pinned from the #367 review).
  - Moves into any personal space are 400 `space_personal` (company artifacts stay company-owned). Personal to shared is allowed (`can.move`).
  - Writes `space_id` and the audit row in one batch, then calls `closeRuntimeSockets([id])`.
  - **Moving a `public` artifact into a shared space with `publicLinks` off** rewrites its visibility to `team` in the same D1 batch as the move (contract #370), then closes its sockets, anonymous data and events included: the same mechanism as Task 9's toggle-off. This is belt and braces with `decide()` (public needs personal or `publicLinks`) and Task 11's content-host check.
- `transferArtifact(env, user, id, toUserId)` (`R.transferArtifact`, `TransferArtifactInput`): the personal owner only: it checks `level === "owner"` (via `requireAccess(..., "owner")`, which refuses managers), else 404. The target must be active, not a guest and not restricted, else 400 `invalid_successor` (contract wording updated in #359). It moves the artifact to the target's personal space and adds an editor share for the former owner.
- `transferPersonal(env, admin, fromUserId, input: TransferInput): Promise<TransferResult>`:
  - The source must be `suspended` or `removed` (else 409 `member_active`); a user target must be active, non-guest and non-restricted (else 400 `invalid_successor`), or the target must be a shared space.
  - It moves `TRANSFER_PAGE` (100) per call (`R.memberTransfer`; `GET` → `TransferSummary`).
  - The GET summary returns counts only.
- MCP: `publish_artifact.spaceId?` (from the folded `PublishInputSchema`), `list_artifacts`/`search_artifacts` `scope` and `spaceId` (Task 4), a new `list_spaces` tool (→ `MySpace[]` the caller can publish into), and `get_artifact` returning `space` and `can`. Instructions say "owner or space manager".
- Regeneration and counts: run `pnpm -F @oa/server gen` (tool manifest, `skill.generated.ts`, `upgrade.generated.ts`), update `test/mcp.tools.test.ts`'s tool list, and change `test/smoke/mcp.ts` from `toHaveLength(17)` to `toHaveLength(18)` in the same commit.

- [ ] **Step 1: Failing tests**

```ts
it("move shared → personal is 400 space_personal", async () => expect(await errCode(move(mgr, spaceArt, mgr.id))).toBe("space_personal"));
it("publish with spaceId = someone else's personal space → 403 space_forbidden", async () => { /* 403 */ });
it("any create by a restricted member → 403 space_forbidden", async () => { /* 403 */ });
it("spaceId on an existing artifact → 400 use_move", async () => { /* use_move */ });
it("transfer to a guest or restricted member → 400 invalid_successor", async () => { /* invalid_successor x2 */ });
it("departed transfer on an active member → 409 member_active", async () => { /* 409 */ });
it("departed transfer requires inactive source and pages 100 at a time", async () => {
  const r1 = await transfer(admin, gone, { to: { kind: "space", spaceId: sid } });
  expect(r1).toMatchObject({ moved: 100, remaining: 50 }); expect(r1.nextCursor).not.toBeNull();
});
it("MCP publish into a view-only space → 403 space_forbidden; list_spaces omits it", async () => { /* 403; absent */ });
it("smoke tool count is 18 and the skill lists list_spaces", () => { /* regenerated */ });
it("moving a public artifact into a no-public-links space: visibility team in the same batch", async () => {
  const anon = await openAnonSockets(pubArt); // data and events
  await move(owner, pubArt, noPublicSpace);
  expect((await row(env, pubArt)).visibility).toBe("team");
  expect((await fetchP(pubArt)).status).toBe(404);
  for (const ws of anon) expect(await ws.closed).toMatchObject({ code: 4403 });
});
```

- [ ] **Step 2: Run.** Expected: 11 failed. **Step 3: Implement**, then regenerate with `pnpm -F @oa/server gen`. **Step 4: Run** `pnpm -F @oa/server test spaces.move mcp.tools`. Expected: passes.
- [ ] **Step 5: Commit** `feat(server): publish into spaces, move, transfer, MCP (P3)`.

### Task 11: Content host revocation in D1

**Files:** Modify `content/signing.ts`, `content/app.ts` (`load`), `routes/artifacts.ts` (content-url); Test `apps/server/test/content-host.test.ts`, `apps/server/test/content-host.cpu.test.ts`

**Interfaces:**
- Token grammar: `{exp}.{sig}` (public and capture) or `{exp}.{uid}.{sig}` (signed for a signed-in viewer). `uid` is covered by the MAC.
- `load()` keeps one statement, cached path included:

```sql
select a.format, a.visibility, a.deleted_at, s.public_links,
       (select u.status from users u where u.id = ?2) as viewer_status   -- null when no uid
from artifacts a join spaces s on s.id = a.space_id where a.id = ?1
```

- Serving rules:
  - `/p/`: needs `visibility = 'public'` (the space's public-links toggle is not checked: it only blocks new links).
  - `/c/` with a `uid`: needs `viewer_status = 'active'` and, for a synced user, no `customer_mismatch` (Task 18's condition in the same statement). Access unchanged when stale; `staleAt` is informational.
  - Anything else returns 404.
- No KV. The `uid` status check runs when `FEATURES` has `content_revocation` (hosted sets it), as reworded in #359's flag table. The public-links toggle is deliberately absent here: turning it off never revokes an existing link.

- [ ] **Step 1: Failing tests**

```ts
it("signed token for a user suspended after minting → 404 on the next file", async () => { /* 404 */ });
it("/p/ on a space with public links off still serves an existing public row (the toggle blocks new links only)", async () => { /* forced row: 200 */ });
it("two-part tokens still verify for public and capture", async () => { /* 200 */ });
it("content host does one D1 statement per request", async () => { expect(statements).toBe(1); });
```

- [ ] **Step 2: Run.** Expected: 4 failed. **Step 3: Implement.** **Step 4: Run** `pnpm -F @oa/server test content-host && pnpm -F @oa/server test:cpu`. Expected: passes, within the existing CPU budgets.
- [ ] **Step 5: Commit** `feat(server): content host re-checks user status in D1 (P3)`.

### Task 12: Directory connection (broker or direct transport)

**Files:** Create `directory/transport.ts`, `directory/client.ts`, `directory/broker.ts`, `directory/direct.ts`, `directory/crypto.ts`, `directory/google.ts` (connect's calls; T13 extends it), `directory/store.ts`, `directory/binding.ts`, `directory/connect.ts`, `routes/directory.ts`; create `apps/directory-broker` (its own Worker) and `packages/broker-core` (shared with the sign-in broker); add `packages/auth-core` `box.ts` and the path-bound `signRequest`/`verifyRequest`; Modify `env.ts` (`DIRECTORY_TOKEN_KEY`, `DIRECTORY_TOKEN_KEY_VERSION`, `DIRECTORY_BROKER_URL`, the P2 install assertion key `BROKER_SIGNING_KEY`, optional `GOOGLE_DIRECTORY_CLIENT_ID` and `GOOGLE_DIRECTORY_CLIENT_SECRET`); Test `apps/server/test/directory.connect.test.ts`, `apps/server/test/directory.transport.test.ts`, `apps/directory-broker/test/broker.test.ts`

**Interfaces:**
- **Transport (decided by the manager and the user; mirrors P2's `GoogleTransport`):**
  - `directoryTransport(env): { kind: "broker"; brokerUrl: string; installId; signingKey } | { kind: "direct"; clientId: string; secret: string } | { kind: "none"; problem: string }`, resolved once from env.
  - `broker`: hosted, selected by `DIRECTORY_BROKER_URL` only (never `AUTH_BROKER_URL`). Required when `HOSTED=1`; the install never holds a Google client secret.
  - **The directory broker is a separate Worker** (manager decision, 2026-10-24): `apps/directory-broker`, `oa-s-directory-broker` / `oa-p-directory-broker` on `directory.<app domain>`, never a path on `auth.*`. It holds only the Directory client (`GOOGLE_DIRECTORY_CLIENT_ID`, secret `GOOGLE_DIRECTORY_CLIENT_SECRET`), so a compromise of either broker never yields both Google clients. Its registry is its own KV, `DIRECTORY_REGISTRY` (never `BROKER_REGISTRY`), read with `get` only. Vars `DIRECTORY_ORIGIN`; secret `DIRECTORY_STATE_KEY`; rate limits `RL_DIRECTORY_IP` / `RL_DIRECTORY_INSTALL`. Observability off. The install assertion, signed state and rate limits come from `packages/broker-core`, shared with the sign-in broker.
  - `direct`: self-hosted without our broker. The install uses its own Google app's `GOOGLE_DIRECTORY_CLIENT_ID` and `GOOGLE_DIRECTORY_CLIENT_SECRET` (their app, so the secret in their env is fine) and does the code exchange and refresh itself.
  - `HOSTED=1` with the direct variables set (or without a broker) resolves to `none` with a problem string ("hosted installs use the broker for directory sync"): fail closed, no directory. `R.directoryConnect` then answers 404, and `SyncStatus` shows `mode: "off"` with the problem for owners.
  - Both kinds implement one interface: `beginConsent(state, pkce): URL`, `completeConsent(callback): Promise<ConsentResult>` (`{ refreshToken, accessToken, grantedScopes, sub, hd }`), `accessToken(sealedRefresh): Promise<string>`. Everything after `completeConsent` (sealing, checks, binding, sync) is shared code.
  - Both keep the same AES-GCM sealed refresh token (`DIRECTORY_TOKEN_KEY`; hosted from P1 provisioning, self-host from the setup script), and both run the same callback checks below and fail closed on a mismatch.
- Flow (broker; direct is the same with the install doing steps 2 and 3 against Google itself):
  1. `GET /directory/connect` (org owner) records the one pending flow (single use, `directory_state`), sets a signed state cookie bound to the user, and redirects to `DIRECTORY_BROKER_URL/google/directory/start` with `install`, `state` and the PKCE challenge.
  2. The directory broker holds the Google client secret. Its redirect URI is exactly `${DIRECTORY_ORIGIN}/google/directory/callback`, never built from Host. It requests the scopes `openid email https://www.googleapis.com/auth/admin.directory.user.readonly https://www.googleapis.com/auth/admin.directory.group.readonly https://www.googleapis.com/auth/admin.directory.domain.readonly https://www.googleapis.com/auth/admin.reports.audit.readonly` with `access_type=offline`, `prompt=consent` and `hd` set to the install's domain.
  3. Google returns to the broker, which redirects to the install's registered origin only: `GET /directory/callback?code&state&bstate`, where `bstate` is the broker's signed state (install id, the install's `state`, the PKCE challenge, 10 min expiry, MACed under the `oa-dir-v1` domain).
  4. The install then POSTs `/google/directory/token`, signed with its install assertion over a path-bound transcript (a sign-in redeem signature never verifies there), carrying the code, the PKCE verifier, `bstate` and a fresh X25519 key. The broker checks the assertion, that `bstate` is this install's, and that `S256(verifier)` matches; exchanges the code; and returns every token sealed to that X25519 key only (`auth-core` `box.ts`), never raw, with the granted scopes inside the box. The refresh token itself is broker-wrapped for the install (manager ruling, #564): AES-GCM, AD `oa-dir-refresh-v1|` + install id, random IV, key HKDF over `DIRECTORY_STATE_KEY`; on refresh the broker unwraps with the asserting install's id, so another install's blob or a raw Google token is refused. The install re-seals the wrap with `DIRECTORY_TOKEN_KEY` and never holds Google's refresh token. `/start` and `/token` charge separate per-install buckets (`start:` and `token:` key prefixes in `RL_DIRECTORY_INSTALL`).
- The install verifies, in order. Any failure redirects to `/settings/directory?error=<DirectoryConnectError>` (`denied`, `expired`, `scopes`, `domain_mismatch`, `not_super_admin`, `customer_mismatch`, `failed`) and writes an audit row:
  - The state cookie (signature, this user, unexpired, `state` equal) and the single-use pending flow (`expired`); Google's own error (`denied`); the broker's checks of the install assertion and `bstate` (`failed`).
  - Granted scopes are a superset of the list above; `hd` equals the install domain.
  - `users.get(sub)` gives `isAdmin = true` (super admin; delegated admins are refused) and a `customerId`.
  - `domains.list(customerId)` contains the install domain.
- **Confirm step (manager decision, 2026-10-24).** On success the callback stores the `DirectoryBinding`, the sealed token and a pending confirmation (`directory_state` `connect.confirm`: who connected, expiry, count), counts active in-domain users over one page (500, else "500+"), writes nothing to users, identities or memberships, and redirects to `/settings/directory`. `SyncStatus.state` is `pending_confirm` with `pendingCount`, `pendingCountCapped` and `pendingExpiresAt` (contract). `POST R.directoryConfirm` (200 `SyncStatus`) runs the binding pass (`afterConsent`); `POST R.directoryCancel` (204) deletes the token and binding. Only the owner who connected, still the org owner, may call them; anyone else, or nothing pending, 404. Both audited (`directory.connect` confirmed, `directory.disconnect` cancelled). Unconfirmed for 24 h, the token and binding are deleted and audited (actor system): lazily on the next status read or confirm, and by the daily cron. An expired confirm answers 409 `conflict`. T13 must not sync while a confirmation is pending.
- **Reconnect (manager decision, 2026-10-24).** The consent is stored as pending rows (`directory_state` `pending.binding`, `pending.refresh`; no migration), so an existing confirmed binding, its token and its sync stay live until Confirm. Cancel and expiry (lazy and cron) delete only the pending rows. Confirm swaps pending into live in one D1 batch, every statement gated on the owned, unexpired confirmation row, then revokes the OLD grant at Google: through the directory broker's `POST /google/directory/revoke` (install-asserted like `/token`, path-bound, its own `revoke:` bucket, only a blob wrapped for the asserting install), or Google's revocation endpoint on the direct transport. Cancel and expiry revoke the pending grant the same way. A failed revoke never fails the request; it is audited (`directory.connect` outcome `revoked`, `revoke_failed` or `revoke_skipped`). A grant is never revoked while it shares its Google account (`grant.sub`, the consenting `sub`) with the token that stays, because Google revokes the whole grant. A first connect behaves as before.
- On confirm it runs the **initial binding**: a full `users.list` creates or links `identities('google', id)` (setting `directory_bound = 1`, a column P3 adds to P2's table in the spaces migration) and user rows, with email matching allowed only in this one pass, and sets `restricted` per `restricted_groups`.
- `crypto.ts`: `seal(token): string` and `open(sealed): string`. Both use AES-GCM with `DIRECTORY_TOKEN_KEY`, AD `install_id + ":" + key_version`, and a 96-bit random IV.
- `broker.ts`: `accessToken(sealedRefresh): Promise<string>` POSTs the unsealed refresh token to the directory broker `/google/directory/token`, authenticated with the install assertion; the access token comes back sealed to that request's X25519 key. The install never sees the client secret.
- The initial binding (T12, `directory/binding.ts`) is bounded to 4 pages of 500 per request; a remaining cursor is left in `directory_state` for T13 (`afterDirectoryConnect` seam). Email matching links only rows whose address is in `AUTH_DOMAINS` (in the plan and in SQL). New rows are created only for active users in `AUTH_DOMAINS`, and start restricted while any restricted group exists (T13's first reconcile recomputes). Every linked user suspended in Google on the page is suspended at once (`setUserStatus`, in batches of 25 until none remain).
- `direct.ts`: `beginConsent` builds Google's authorization URL with the install's own client id and the same scopes and `hd`; `completeConsent` exchanges the code at Google's token endpoint with the install's client secret; `accessToken` refreshes there directly.
- **Setup contract for Platform:** the self-host setup asks for `GOOGLE_DIRECTORY_CLIENT_ID` and `GOOGLE_DIRECTORY_CLIENT_SECRET` as optional prompts (skip = no directory sync), stores the secret with `wrangler secret put`, and generates `DIRECTORY_TOKEN_KEY` when either is set. Hosted provisioning never sets them.

- [ ] **Step 1: Failing tests**

```ts
it("callback refuses a delegated admin → ?error=not_super_admin", async () => { /* 302 */ });
it("callback refuses hd mismatch and domains.list without the domain → ?error=domain_mismatch", async () => { /* 302 x2 */ });
it("callback refuses missing scopes → ?error=scopes; accepts openid email plus the four → ?connected=1", async () => { /* 302; 302 */ });
it("refresh token at rest is AES-GCM with AD install:version; wrong AD fails", async () => { /* throws */ });
it("hosted env has no GOOGLE client secret binding", () => expect(Object.keys(hostedEnv)).not.toContain("GOOGLE_DIRECTORY_CLIENT_SECRET"));
// directory.transport.test.ts
it("direct: code exchange and refresh against the fake Google; the refresh token is sealed", async () => { /* token endpoint called with client id/secret; stored ciphertext */ });
it("HOSTED=1 with direct config resolves to none: connect 404, SyncStatus mode off with the problem", async () => { /* 404; problem */ });
it.each(["broker", "direct"])("%s: the same callback checks (super admin, customer, domain, scopes) fail closed", async (kind) => { /* each ?error= */ });
it("initial binding links existing users by email once, later passes never match by email", async () => { /* see Task 14 */ });
```

- [ ] **Step 2: Run.** Expected: 9 failed. **Step 3: Implement** against a fake broker and fake Google (`fetchMock`). **Step 4: Run** `pnpm -F @oa/server test directory.connect directory.transport`. Expected: passes.
- [ ] **Step 5: Commit** `feat(server): directory connection, broker or direct transport (P3)`.

### Task 13: `DirectorySync`: polling, reconcile, health

**Files:** Create `directory/google.ts`, `directory/sync-do.ts`; Modify `cron.ts`, `env.ts`, `wrangler.*.jsonc` (`RL_DIRECTORY` for `GET /directory/groups`); Test `apps/server/test/directory.sync.test.ts`, `directory.cpu.test.ts`, fixtures `test/fixtures/google/*.json`

**Interfaces:**
- `google.ts` takes its access token from the resolved transport (`broker` or `direct`; Task 12), so polling, reconcile and health are identical in both modes. Every call is scoped to the stored `customerId`:
  - `listUsers(ts, customerId, { query?, showDeleted?, pageToken? })`, with `fields=nextPageToken,users(id,primaryEmail,suspended,isAdmin,customerId)` and `maxResults=500`.
  - `listMembers(ts, groupKey, pageToken?)` returns direct members including `type=GROUP`; nesting is resolved locally through `directory_groups.parent_ids`.
  - `userGroups(ts, userKey)`.
  - `activities(ts, app: "admin" | "groups", startTime, pageToken?)`.
- `DirectorySync` RPCs: `kick(reason: "cron" | "mapping" | "manual" | "signin")`, `status(): SyncStatus` (served by `R.directory`; `R.directorySync` and `R.directoryHeldConfirm(groupId)` return 202 `SyncStatus`), `confirmHeld(groupId)`, plus `enqueue(job)` for access jobs (Task 9). `R.directoryGroups` (`DirectoryGroupsQuery` → `Page<DirectoryGroup>`) is limited by `RL_DIRECTORY`. `google.ts` returns the internal `GoogleUser`; `DirUser` is its contract projection.
- **Fast path (every 2 min):**
  - Reports `admin` events since the cursor (10 min overlap): `SUSPEND_USER`, `UNSUSPEND_USER`, `DELETE_USER`, `ADD_GROUP_MEMBER`, `REMOVE_GROUP_MEMBER`, `DELETE_GROUP` and `CHANGE_PRIMARY_EMAIL`.
  - Reports `groups` events: `add_user`, `remove_user`, `change_user_role`.
  - User events apply at once (suspend and delete always). Group events mark that group and all its ancestors dirty.
- **Reconcile** (hourly, plus `mapping`, `manual` and `signin`):
  - Full listings of active, suspended (`query=isSuspended=true`) and deleted (`showDeleted=true`) users.
  - Then every mapped or restricted group, plus descendants, page by page under `gen+1`.
  - While a run is paging, the alarm re-arms at once.
- **Sweep and hold rules:**
  - A group sweeps old-`gen` rows only after its last page.
  - A sweep removing over 50% of a group that had at least 5 members is held, unless `groups.get` shows `directMembersCount = 0`.
  - A group that returns 404 is held unless `DELETE_GROUP` was seen.
  - An active-user listing of 0 holds every user and group sweep.
  - Suspensions and deletions are never held.
- **Customer check:** on every run, a `customerId` that differs from the binding sets `SyncStatus.state = "customer_mismatch"` (`customerMismatch: true`). That fails closed (Task 18's denial applies at once), writes an audit row and emails the owners.
- **Health:**
  - `unhealthy_since` is set on the first failure and cleared on success.
  - Over 1 h unhealthy: `Me.instance.directory.banner` (owners and admins) and `tokensUnverified: true`; browser session age is capped at 24 h (Task 18).
  - At 24 h: one email to owners (`alertedAt`, reset on success).
  - 429 or 5xx: `state = "backoff"`, 2 to 30 min. `invalid_grant`: `state = "auth_failed"`, retried hourly. A 403 `insufficientPermissions` from the Admin SDK: `state = "scope_missing"` (contract #370), retried hourly, owners alerted. Before the first success: `state = "never"`.
  - `Me.instance.directory` carries `{ state, staleAt, heldSweeps }` (contract #370); `state` and `staleAt` for owners and admins only.
- **Frozen (Team, `DirectoryMode` `frozen`):** user-status polling and listings continue; only group sync stops, and sync rows stay `source = "sync"`.

- [ ] **Step 1: Failing tests**

```ts
it("Reports SUSPEND_USER on the next 2-min tick suspends and closes sockets", async () => { /* status suspended; 4403 */ });
it("5xx on page 2 of 3 removes nobody", async () => { /* member rows unchanged */ });
it("active listing of 0 holds every sweep", async () => { /* held */ });
it("group 404 without DELETE_GROUP is held", async () => { /* held */ });
it("child group change marks ancestor mapped group dirty", async () => { /* ancestor re-read */ });
it("groups-app remove_user is picked up", async () => { /* row removed after reconcile */ });
it("customerId mismatch → state customer_mismatch, synced users denied, owners emailed", async () => { /* 401 */ });
it("unhealthy 1 h → me.instance.directory.banner; 24 h → owners emailed exactly once (alertedAt); success resets", async () => { /* 1 email */ });
it("frozen still applies suspensions", async () => { /* suspended */ });
it("403 insufficientPermissions → state scope_missing; me.instance.directory.state for admins only", async () => { /* scope_missing; absent for members */ });
it("500-user page parse + diff under 10 ms CPU", async () => { /* cpu */ });
```

- [ ] **Step 2: Run** `pnpm -F @oa/server test directory.sync`. Expected: 10 failed.
- [ ] **Step 3: Implement.** **Step 4: Run** `pnpm -F @oa/server test directory && pnpm -F @oa/server test:cpu`. Expected: passes.
- [ ] **Step 5: Commit** `feat(server): DirectorySync polling, reconcile and health (P3)`.

### Task 14: Applying directory state, and recycled emails

**Files:** Create `directory/apply.ts`, `directory/signin.ts`; Test `apps/server/test/directory.apply.test.ts`

**Interfaces:**
- `applyGroupDiff(env, groupId, added: string[], removed: string[], actor: AuditActor): Promise<{ narrowed: string[] }>`. It works on user ids, keeps the group's flattened `directory_members` rows (nested groups resolved through `parent_ids`), recomputes `space_members(source='sync')` as the max over that space's per-space `group_mappings` only, recomputes `users.restricted_sync` (by `groupId`; owners and admins in a restricted group are logged and skipped, never restricted), and writes only the rows that changed. An Every-space mapping (`org_group_mappings`) is never expanded into `space_members` rows: its role is joined at read time (Tasks 3 and 4), so `applyGroupDiff` writes only the group's `directory_members` rows for it, and never touches a personal space. `narrowed` (users whose per-space or Every-space role dropped) goes to `revokeUserLive`.
- `applyUser(env, u: DirUser, run: string): Promise<void>` (status changes carry `AuditReason` `directory_suspend`, `directory_unsuspend`, `directory_delete` or `directory_new_id`). It matches only through `identities('google', u.id)`. An unknown id creates a new user row and identity (the trigger creates the personal space). Unsuspend sets `status = 'active'` only on a `suspended` row; a `removed` row is never revived. `getUser` returns only `active` rows (#368), so a suspension is refused on every surface by that check.
- `DELETE_USER`, or a `deleted` user in a listing:
  - `setUserStatus("removed")`.
  - `users.email` becomes the placeholder `removed+{userId}@invalid`.
  - Delete that address's shares and that user's sync and manual `space_members` rows, in one batch.
  - Then `revokeUserLive`.
- New directory id for an email still held by an old row: the old row gets the deletion treatment first, then the new row is created (decision 2).
- `CHANGE_PRIMARY_EMAIL` (Google's `RENAME_USER`): update `users.email` for that identity. Shares follow the person (manager ruling, #592): in the same batch, gated on the row having moved, every share on the old address is re-keyed to the new address (`shares` is keyed by address only; no `user_id` column, and invites are shares), the higher role winning on a conflict, alias or not. The person keeps their access and the freed address inherits nothing.
- `onGoogleSignIn(env, user: Member)` is called by P2 after admission (directory id from the user's bound Google identity):
  - It checks `users.get` (suspended means refuse) and `userGroups`, then `applyGroupDiff` for that user only.
  - If Google is unreachable, the sign-in proceeds (fail static) unless the install is in `customer_mismatch`. Access unchanged when stale; `staleAt` is informational.
- P2 verifies Google `sub == directory user id` on sign-in (the seam test lives in P2; this task asserts it).
- Every `users.email` change goes through one function, `services/email-move.ts` `moveUserEmail` (sign-in drift in `followDrift` and sync alike): one batch, with the share re-key gated on the row having moved and nobody holding the old address. The only other `users.email` write is the deletion placeholder, which drops the shares the user holds (those on their current address, the only address that holds them because every move re-keys) in its own batch.
- A new directory id at an address held by a row with no Google link: a pure invite (active, never signed in, no identity) is linked to that id; a row with sign-in history counts as recycled (deletion treatment, then a new row).
- Group diffs are applied in batches of 200 users (`DIFF_CHUNK`), so a big group never builds one oversized batch.
- **Accepted (manager, #592 security review):**
  - L5, consistency lag: a sign-in diff and the DirectorySync reconcile can briefly disagree; the next reconcile recomputes the rows.
  - L6, fail static at sign-in: with Google unreachable outside `customer_mismatch`, a synced user signs in on last-sync access.
  - No one-off cleanup for shares stranded on old addresses by email moves before #592: directory sync isn't live on any install, and the only direct-sign-in production install has one user.

- [ ] **Step 1: Failing tests**

```ts
it("recycled email: new Bob gets a new row and an empty personal space, no shares, no memberships", async () => {
  await deleteDirUser(oldBob); await addDirUser({ id: "g-new", email: "bob@co.com" }); await reconcile();
  const nb = await userByIdentity("g-new");
  expect(nb.id).not.toBe(oldBob.id); expect(await sharesFor("bob@co.com")).toEqual([]);
  expect(await listMine(nb)).toEqual([]); expect(await spaceRolesOf(nb.id)).toEqual([]);
});
it("two groups → max role; removal from one keeps the other, no revoke", async () => { /* editor stays */ });
it("an Every-space group writes directory_members only, no space_members rows, and nothing for personal spaces", async () => { /* 0 sync rows */ });
it("removal from an Every-space group narrows that user", async () => { /* narrowed contains user */ });
it("restricted group membership (by groupId) sets users.restricted_sync and caps", async () => { /* restricted_sync = 1 */ });
it("sign-in group diff adds and removes for that user only", async () => { /* one user's rows changed */ });
it("rows written equal changed rows only", async () => { /* d1 rows */ });
it("directory UNSUSPEND_USER sets status active, never revives a removed row", async () => { /* active; removed stays */ });
it("an owner or admin in a restricted group is skipped and logged", async () => { /* restricted_sync = 0; audit detail */ });
```

- [ ] **Step 2: Run.** Expected: 9 failed. **Step 3: Implement.** **Step 4: Run** `pnpm -F @oa/server test directory.apply`. Expected: passes.
- [ ] **Step 5: Commit** `feat(server): apply directory state by identity, never by email (P3)`.

### Task 15: Features and tier transitions

**Files:** Modify `packages/shared` (contract PR: `Features`), `env.ts`, `directory/sync-do.ts`; Test `apps/server/test/features.transitions.test.ts`

**Interfaces:**
- `FEATURES` env, set by P1 per tier, parsed by the contract's `parseFeatures` into `FeatureFlag[]`: `spaces`, `sync_google`, `sync_frozen`, `content_revocation`, `usage_off` (Task 19). `guests_read_only` is reported in `Me.instance.features` from `authConfig.guestsReadOnly` but can't be set through `FEATURES`. P3 uses only the single exported `parseFeatures` from `hosted/core.ts`, which drops `guests_read_only`; `ENV_FEATURE_FLAGS` lists the settable flags. `Me.instance.features` reports the array; `Me.instance.directory.mode` maps `sync_google` → `google`, `sync_frozen` → `frozen`, else `off`.
- `sync_frozen` keeps user-status polling and reads no groups; a run planned while sync was on skips its group steps (targets, walks, groups Reports, thaw), so a freeze mid-walk adds nobody. While frozen, a run's success never stamps `lastSuccessAt` (so `staleAt` counts from the last run that read groups) and an install with none stays `never`. Synced rows stay `source='sync'`; an admin's edit of one is the contract's manual override (T9). Every frozen hand edit is recorded in `frozen_edits` (migration 0013, same batch, first edit wins; accepted deviation from "edits stay source=sync"), by `kind`: `override` (a synced row changed; `manual_role` is the manual row from before it, null: none), `delete` (an explicit removal, which also turns an earlier record into `delete`) or `manual` (a manual write on a pair with no synced row). The first reconcile after returning to `sync_google` runs a `thaw` step after its walks (on fresh `directory_members`), one chunk of 50 per alarm (`directory/thaw.ts`). Manager rulings: an override's pre-freeze manual row is put back exactly (none: removed; never more; never for a removed user; stored values are checked against the enums); an explicit frozen DELETE is final (no manual row restored); a frozen manual add survives. Every pair's synced row is then derived again from `directory_members` and `group_mappings` (fresh membership can re-add it). Each outcome is audited by `sync`: `space.member.role` / `space.member.add` / `space.member.remove` with `{ thaw: true, role? }` for a restore or removal, `directory.sync` with `{ thaw: "removal_kept" }` or `{ thaw: "manual_kept", role }`. Anyone whose role in the space dropped, restored rows included, has their sockets closed (spec 4.5). Between the return to `sync_google` and the thaw, an admin's live manual write or removal on a pair with a pending record supersedes it (the record becomes `manual` or `delete`, only when the write applies), so the thaw never undoes a live edit. A frozen reconcile still moves `nextRunAt`. Any `lastSuccessAt`-age alert (T18's `directory.stale`) must skip frozen installs. Every thaw write is gated on the record still being the one its page read (`at`, `kind`, `manual_role`), so a live edit landing between the read and the batch is never undone; that record waits for the next thaw. Synced-row changes are audited too (`directory.sync`, `{ thaw: "sync", from?, to? }`). The socket closes are durable: the chunk's users are held in DirectorySync kv (`revoke.pending`) before the batch, narrowed to those whose role dropped after it, released once revoked, and retried at the start of the next alarm.
- Contract (additive): `EnvFeatureFlag`, `TIER_FEATURES` (trial and business `spaces, sync_google, content_revocation`; team `spaces, sync_frozen, content_revocation`; hosted adds `usage_off`), `directoryModeOf(features)` (the server's `directoryMode` uses it).
- Flags change UI and write routes only; `decide` reads only `cap` (from `authConfig` and the restricted flags), which can only lower access.

- [ ] **Step 1: Failing tests**

```ts
it("every downgrade A→B gives accessSet(B) ⊆ accessSet(A)", async () => {
  for (const [a, b] of DOWNGRADES) expect(isSubset(await accessSet(b), await accessSet(a))).toBe(true);
});
it("frozen edits stay source=sync and are replaced when sync returns", async () => { /* replaced */ });
it("frozen still suspends departed users", async () => { /* suspended */ });
```

- [ ] **Step 2: Run.** Expected: 3 failed. **Step 3: Implement.** **Step 4: Run** `pnpm -F @oa/server test features`. Expected: passes.
- [ ] **Step 5: Commit** `feat(server): feature flags; frozen never widens (P3)`.

### Task 16: Matrix over every surface, probe for P5

**Files:** Create `test/authz/fixture.ts`, `test/authz/expect.ts`, `test/authz/surfaces.ts`, `test/authz.surface-matrix.test.ts`, `scripts/authz-probe.ts`; Modify `package.json` (`"test:authz-probe"`)

**Interfaces:**
- **Callers (16):** `orgOwner, orgAdmin, spaceManager, spaceEditor, spaceViewer, allMembersOnly, personalOwner, otherMember, guestShared, guestMappedEditor, restrictedContractor, suspendedUser, removedUser, recycledEmailUser, staleSynced, anonymous` (`staleSynced` expects the same access as a fresh synced member). Each has a `Cred` (cookie, PAT, OAuth) where applicable.
- **Artifacts (9):** `personalPrivate, personalTeam, personalPublic, spacePrivate, spaceTeam, spacePublic, spaceLinksOff, deletedPersonal, deletedSpace`.
- **Attack seeds:** `otherPersonalSpaceId` (for publish, move and list `scope=space`).
- `expect.ts`: `EXPECTED: Record<Caller, Record<Artifact, AccessLevel | null>>`, a literal table independent of `policy.ts`.
- `surfaces.ts`, exported for P5: `SURFACES: readonly Surface[]`, where `Surface = { name; action: PolicyAction; routes: readonly string[]; probe(base: string, cred: Cred, artifactId: string): Promise<"allow" | "deny"> }`. The surfaces:
  - REST: get, patch, publish version, restore_version, list_versions, version file, version text PUT, thumbnail GET/PUT, uploads, share, unshare, visibility, delete, undelete, move, transfer.
  - List and search.
  - Every MCP tool (18).
  - Data: GET, PUT, query, count, data reset, storage, anon id.
  - Content: mint, `/c/` frame, `/c/?dl=1`, `/p/`.
  - Sockets: subscribe WS and events WS.
- `scripts/authz-probe.ts --base <url> --creds <file>`: credentials come only from the JSON file (`{ [caller]: Cred }`). It refuses any other flag, and refuses credentials in argv or env. It exits non-zero on a mismatch and re-exports `SURFACES`.
- **P5 hooks:** P5 imports `SURFACES` to run tenant A credentials against tenant B ids (deny everywhere), and asserts that the union of `SURFACES[].routes` covers every `ROUTE_POLICY` and `TOOL_POLICY` artifact entry.

- [ ] **Step 1: Write the tests**

```ts
it("SURFACES cover every artifact entry in ROUTE_POLICY and TOOL_POLICY", () => {
  expect(uncovered(SURFACES, ROUTE_POLICY, TOOL_POLICY)).toEqual([]);
});
it("authz-probe refuses credentials in argv", async () => {
  expect((await runProbe(["--base", u, "--pat", "x"])).code).toBe(2);
});
describe.each(SURFACES)("$name", (s) => {
  it.concurrent.each(cells(CALLERS, ARTIFACTS))("%s on %s", async (who, art) => {
    expect(await s.probe(base, creds[who], ids[art])).toBe(expected(who, art, s.action));
  });
});
```

- [ ] **Step 2: Run** `pnpm -F @oa/server test authz.surface-matrix`. Expected: passes once Tasks 1 to 15 are in. Any failure names a surface, and the fix goes in that surface's owning file.
- [ ] **Step 3: Run the probe** against `wrangler dev`: `pnpm -F @oa/server test:authz-probe --base http://localhost:8787 --creds .dev-creds.json`. Expected: exit code 0.
- [ ] **Step 4: Commit** `test(server): authz matrix over every surface; probe for P5 (P3)`.

### Task 17: Test session hook with spaces (P5 contract)

**Files:** Modify P2's `POST /__test/session` handler (body only); uses P2's `TEST_HOOKS_ALLOWED` build define (P2 Task 14 owns the hook mount); Test `apps/server/test/test-hooks.spaces.test.ts`

**Interfaces:** The body is the contract's `TestSessionInput`: `spaces?: { spaceId: string; role: SpaceRole }[]` (max 20). It creates any missing shared space and upserts manual `space_members` rows for the session user, in the session batch. P2 mounts the route only when `TEST_HOOKS_ALLOWED && env.TEST_HOOKS === "1"`; this task only extends its body. The build-time const is `false` in the hosted prod build, so the code path is dead and stripped even if the env var is set; Platform's provisioner also refuses `testHooks` in `oa-prod`.

- [ ] **Step 1: Failing tests:** `"session with spaces: the caller has that role"`, `"TEST_HOOKS unset → 404"`, `"TEST_HOOKS=1 but TEST_HOOKS_ALLOWED false → 404"`, `"unknown role → 400"`.
- [ ] **Step 2: Run.** Expected: 4 failed. **Step 3: Implement.** **Step 4: Run** `pnpm -F @oa/server test test-hooks`. Expected: passes. **Step 5: Commit** `test(server): test session hook seeds space roles (P3)`.

### Task 18: Informational staleness, the session cap and break-glass

**Files:** Modify `services/users.ts` (`getUser`), `http/middleware.ts` (session), `directory/sync-do.ts`, `routes/directory.ts`; Test `apps/server/test/directory.stale.test.ts`, matrix caller `staleSynced`

**Interfaces:**
- A **synced user** has an `identities(provider = 'google', subject)` row whose subject is bound to the connected directory (the binding from Task 12's initial pass and Task 14's `applyUser`, recorded as `identities.directory_bound = 1`; there is no `users.directory_id`), while a directory is connected (any tier, frozen included). `LIMITS.directoryStaleMs = 7 * 86_400_000` only decides when `staleAt` is reported.
- `getUser` keeps one statement and adds `and not (synced and state = 'customer_mismatch')`. The content `load()` statement adds the same condition. Access unchanged when stale; `staleAt` is informational.
- Session cap: if `unhealthy_since < now - 1h` and the cookie session's `iat < now - 24h` (P2's session payload carries `iat`, `p` (provider), `t` and `e`), the session resolves to null. PATs and MCP OAuth grants are exempt from this 24 h cap (decided). No stale cutoff applies to them: while unhealthy everyone keeps last-sync access; `staleAt` is informational. While unhealthy, `Me.instance.directory.health` (owners) carries `tokensUnverified: true` and the banner adds "agent tokens not re-verified".
- On the first alarm past `directoryStaleMs`, `DirectorySync` sets `staleAt` and writes the audit row `directory.stale` (informational). It revokes nothing: access unchanged when stale; `staleAt` is informational.
- **Break-glass:** a `customer_mismatch` org owner gets a restricted resolution only when all of these hold (otherwise 401 `reauth_required` on those routes):
  - The session's `p = 'google'`, with `hd` verified by P2.
  - `iat >= now - 10 min`.
  - The route is one of `R.directory` (GET), `R.directoryConnect`, `R.directoryCallback` or `R.directorySync`.

  Every use writes `directory.break_glass` and emails the owner. Every other route treats them as anonymous.
- Access returns on the next successful sync with no manual step.

- [ ] **Step 1: Failing tests**

```ts
it("7 days + 1 min since success: staleAt is reported but access is unchanged (no stale cutoff)", async () => { /* access 200, staleAt set */ });
it("stale: open sockets stay open and /c/ still serves (access unchanged)", async () => { /* open; 200 */ });
it("6 d 23 h: staleAt is null", async () => { /* null */ });
it("manual member and OTP guest unaffected", async () => { /* allow */ });
it("unhealthy 61 min: cookie session 25 h old → 401; 23 h old → 200", async () => { /* 401; 200 */ });
it("unhealthy: a 30-day-old PAT and MCP grant still work; me.instance.directory.health.tokensUnverified is true for owners", async () => { /* 200; true */ });
it("stale synced user's PAT and MCP OAuth grant keep access on every SURFACES entry", async () => { /* all allow */ });
it("break-glass: fresh Google sign-in (9 min) reaches R.directory; 11 min → 401 reauth_required", async () => { /* 200; 401 */ });
it("break-glass: OTP session refused; artifact, data and member routes refused", async () => { /* 401 x4 */ });
it("break-glass: each use audits and emails the owner", async () => { /* 1 audit, 1 email per use */ });
it("success after stale clears staleAt; access never changed", async () => { /* staleAt null; allow */ });
```

- [ ] **Step 2: Run** `pnpm -F @oa/server test directory.stale`. Expected: 11 failed.
- [ ] **Step 3: Implement.** **Step 4: Run** `pnpm -F @oa/server test directory.stale authz.surface-matrix`. Expected: passes.
- [ ] **Step 5: Commit** `feat(server): informational staleAt, session cap, break-glass (P3)`.

### Task 19: `usage_off` feature flag

**Files:** Modify `apps/server/src/routes/usage.ts`, `auth/route-policy.ts` (policy entry), `env.ts`; Test `apps/server/test/usage.test.ts`

**Interfaces:** When `FEATURES` contains `usage_off` (hosted sets it; there is no `ANALYTICS_TOKEN` there), `R.usage` returns 404 `not_found`, and `Me.instance.features` includes `"usage_off"`, so the dashboard hides the Usage page (P4). Self-hosted default: unchanged.

- [ ] **Step 1: Failing tests**

```ts
it("usage_off → GET /api/v1/usage 404 for the owner", async () => {
  expect((await api(withFeatures("usage_off"), R.usage, ownerCookie)).status).toBe(404);
});
it("usage_off → me.instance.features contains \"usage_off\"", async () => { /* true */ });
it("no flag → owner still gets usage", async () => { /* 200 */ });
```

- [ ] **Step 2: Run** `pnpm -F @oa/server test usage`. Expected: 2 failed. **Step 3: Implement.** **Step 4: Run.** Expected: passes. **Step 5: Commit** `feat(server): usage_off feature flag (P3)`.

---

## API contract (PR #359)

P3 implements the server side of PR #359's spaces, artifacts and directory sections (`HOSTED_CONTRACT.md`); P4 builds against the same PR. The table maps each contract item to its task.

| Contract item | Kind | Task |
|---|---|---|
| `AccessLevelSchema` + `manager`; `ArtifactSummary.space` (`SpaceRef`) and `.can` (`artifactCan`) | CHANGED | 2, 3, 4 |
| `R.spaces`, `R.space`, `R.spaceMembers`, `R.spaceMember`, `R.spaceMappings`, `R.spaceMapping` | NEW | 9 |
| `GET R.orgMappings` (`/api/v1/directory/org-mappings` → `Page<GroupMapping>`), `PUT R.orgMapping(groupId)` (`/api/v1/directory/org-mappings/:groupId`, `GroupMappingPut`), `DELETE R.orgMapping(groupId)`: the Every-space mapping (`org_group_mappings`, #408) | PENDING contract addition | 4, 9, 14 |
| Setting `spaceManagerMappings` (default true; audit action `settings.space_manager_mappings`); error `directory_mapping_off` (403); drop unused `AuditReason` `directory_stale` | PENDING contract addition | 9 |
| `R.restrictedGroups`, `R.restrictedGroup(groupId)` (`RestrictedGroup`), `R.memberRestricted(id)`, `R.spaceMemberSelf(id)`; `GroupRef`, `Restriction`, `Member.restriction` | NEW | 6, 9, 14 |
| `R.directory`, `R.directoryGroups`, `R.directoryConnect`, `R.directoryCallback`, `R.directorySync`, `R.directoryHeldConfirm` (`SyncStatus`, `DirectoryGroup`, `DirectoryConnectError`) | NEW | 12, 13 |
| `R.audit`, `R.auditExport` (`AuditEvent`) | NEW | 8 |
| `R.moveArtifact`, `R.transferArtifact`, `R.memberTransfer` (`MoveArtifactInput`, `TransferArtifactInput`, `TransferSummary`, `TransferInput`, `TransferResult`) | NEW | 10 |
| `HostedListQuery`, `HostedSearchQuery` folded into `ListQuerySchema` and `SearchQuerySchema` (MCP inputs and skill regenerate) | CHANGED | 4 |
| `HostedPublishInput` folded into `PublishInputSchema` (MCP `publish_artifact` and skill regenerate) | CHANGED | 10 |
| MCP `list_spaces` (smoke tool count 17 → 18) | NEW | 10 |
| `Member.status`, `Member.identities`, `Member.restriction`; `R.members?status=` (`MembersQuery`) | CHANGED | 6, 9 |
| `Me.personalSpaceId`, `Me.spaces` (`MySpace[]`), `Me.auth.cap`; `Me.instance.features`, `.directory` (`InstanceDirectory`) | CHANGED (P3 fills; P2 fills `hosted`, `tier`, `signIn`, `auth` method) | 6, 13, 15 |
| `TestSessionInput.spaces` | CHANGED | 17 |
| Errors `space_forbidden`, `public_links_off`, `space_personal`, `space_not_empty`, `use_move`, `invalid_successor`, `member_active`, `directory_sync_off`, `reauth_required` | NEW | 9, 10, 18 |
| `FeatureFlag` `spaces`, `sync_google`, `sync_frozen`, `content_revocation`, `usage_off` (set); `guests_read_only` (reported only, from `authConfig`) | NEW | 15, 11, 19 |

**Tests touched by shape changes:**
- Snapshots: `json-shapes.snapshot.test.ts` and its `.snap`.
- Smoke: `smoke/read.ts` and `smoke/html.ts` (same-release deploy only); `smoke/mcp.ts` (tool count 17 to 18).
- Server: `mcp.tools`, `artifacts.api`, `members`, `display-name`, `release`, `invite-email`, `authz.matrix`, `search.authz`, `search`, `d1-rows`, `query-plans`; regenerated `tool-manifest.json` and `skill.generated.ts`.
- Mocks: `packages/shared/src/mocks/{fixtures,handlers}.ts` (owned by the contract PR).
- Dashboard e2e: `cpu-limit`, `embed`, `display-name`, `renav-notice`, `library-layout`, `card-inset`, `invite-link`, `m1-a11y`, `m2-a11y`, `m2-hostile`, `settings-layout`, `share-layout`, `usage-layout`. Real-server: `fixtures.ts`, `share`, `consent`, `agent-journey`, `mcp-client.ts`.

## Sync design summary

- **Mechanism:** Admin SDK polling with read-only scopes through the broker; there is no SCIM for Google.
- **Signals:**
  - Reports `admin` and `groups` events every 2 min, the fast path for suspend and delete.
  - An hourly reconcile with full listings.
  - A per-user group refresh at sign-in.
- **Pagination:** one page per alarm, with immediate re-arm while paging. Sweeps use generation numbers and run only after the last page.
- **Failure:** fail static, with the exceptions in "Decided": suspensions and deletions always apply; a wrong customer fails closed; after 1 h unhealthy, a banner and the 24 h session cap; an email at 24 h; no stale cutoff (synced people keep last-sync access).
- **Token storage:** the broker exchanges and refreshes; the install holds only the sealed refresh token (key from P1).
- **Revocation path:**
  1. Detection: within 2 min for suspend and delete; within Reports lag or the hourly reconcile for group changes.
  2. The status or row write.
  3. Denial on the next HTTP request or content file.
  4. `UserPresence` closes sockets within 1 s, with queued retries.
  5. PATs and OAuth grants are revoked.

## Performance

- `authorize`: one statement, at most 4 rows read (from 2 today). `can` is pure.
- Content `load`: still one statement, plus 2 PK row reads (spaces, users).
- `getUser`: still one statement, plus 1 PK row read (`directory_state`) for synced users.
- List and search: one more `OR` branch; the level comes from a `CASE` in the same statement; plans are pinned.
- Rows written: publish 10 → 11; new version 5; move about 3; transfer about 3 per artifact; audit 2; public-links-off 1 per public artifact.
- Sync steady state: writes only on change. About 720 fast ticks and 24 reconciles a day. The initial binding costs about 5 rows per user once.
- Presence: one DO RPC per socket accept, awaited.

## Rollout

1. Tasks 1 to 5. Decisions are identical for today's installs; the trigger and create path close the rollout window. Release and watch CPU and D1.
2. Tasks 6 to 11, 17, 19. `FEATURES` is empty by default. Turn on `spaces` on our own install.
3. Tasks 12 to 16, 18. Connect our own Workspace through the broker for a week; measure Reports lag (decision 6).
4. FinQore: P1 hand-provisions with `FEATURES=spaces,sync_google,content_revocation,usage_off` and `DIRECTORY_TOKEN_KEY`. The FinQore super admin connects, the admin maps groups in P4, then the probe and the P5 suite run. Go-live is the user's gate.

Rollback: never downgrade; once a shared space exists, fix forward.

## Needs user

1. **Google OAuth app** for directory consent, in the broker's Google project: add the scopes above and pass Google verification for sensitive scopes. This is outward-facing.
2. **FinQore super admin consent** and the group-to-space mapping.
3. **FinQore go-live**, after the probe and the P5 suite pass.

(`DIRECTORY_TOKEN_KEY` now comes from P1 provisioning; fail static and content revocation are decided.)

## Open questions

1. Export of personal artifacts (review 23): M2 decides; P3 keeps `spaces.kind` so an export can exclude personal spaces without the owner's consent.
2. If the FinQore Reports lag exceeds 15 min, add `users.watch` push channels (decision).

## Review traceability (v3 → v4)

| Finding | Where |
|---|---|
| 1 Recycled email | T6 (P2 admission seam), T12 initial binding, T14 identity-only matching and deletion treatment, T16 `recycledEmailUser` |
| 2 Public links off and `/p/` | T9 refuses new links only (no rewrite, no socket close); T10 move rewrites+closes; T11 content statement ignores the toggle |
| 3 Rollout window | T1 create path, trigger, flag-off move |
| 4 Migration numbers | T1 takes the next free number at rebase (not hardcoded), `IF NOT EXISTS` |
| 5 Ad-hoc `ownerId` | T3 removals, T4 SQL level, T5 AST lint |
| 6 Policy enforcement | T5 middleware, `TOOL_POLICY`, generated cross-user test |
| 7 Contractors | T2 `cap`, T14 `restricted`, T16 caller |
| 8 Personal spaces targetable | T3 `loadSpace` (400 `space_personal`), T4 `kind='shared'`, attack seeds |
| 9 Transfer gaps | T10 |
| 10 Connect checks | T12 |
| 11 Broker secret | T12 |
| 12 Frozen departures | T13, T15 |
| 13 Frozen rows widen | T15 |
| 14 Presence race | T7 |
| 15 Space-wide narrowing | T9 jobs |
| 16 Content revocation in D1 | T11, decision |
| 17 Polling details | T13 |
| 18 Groups at sign-in | T14 `onGoogleSignIn` |
| 19 One guest cap | T2 `capOf` from P2's `authConfig.guestsReadOnly` only; T15 |
| 20 Viewer writes | T2 actions `thumbnail.write`, `version.text`, `anonId`; T5 gate kinds |
| 21 P2 seam | T6, T12, T14 (`identities`) |
| 22 `outside_sharing` | dropped from schema and contract until M4 (decided; T1) |
| 23 Export privacy | open question 2 |
| Decisions | "Decided" section; T13, T18 |
| Plan quality | test code in T8 to T18; T16 surface list; types defined; audit of shares, visibility and sign-ins (T8); artifact count fixed (9) |
