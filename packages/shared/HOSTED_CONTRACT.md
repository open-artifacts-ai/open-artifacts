# Hosted M1 contract (index)

The one contract P2 (sign-in), P3 (spaces and RBAC) and P4 (UI) cite. Source:
`src/hosted/*.ts` (re-exported from `@oa/shared`), the hosted additions in
`schemas.ts`, `routes.ts` and `errors.ts`, and the mocks in `src/mocks/hosted.ts`.
Every change to an existing shape is optional and appended last, so older
servers parse and `json-shapes.snapshot.test.ts` stays byte-identical with
hosted off.

## Ground rules

- **The SPA owns sign-in.** The chooser and code forms live at `SIGN_IN_PAGE`
  (`/sign-in`). The server is JSON-only; every refused redirect sign-in
  (`no_access` included) lands on `/sign-in?error=<SignInError>&next=…`, never
  `PAGES.noAccess`.
- **No access is 404**, never 403. The exceptions are explicit codes:
  `space_forbidden` (403) on publish or move into a space the caller can't
  publish to, or on a member or mapping change the caller's role can't make
  (details `SpaceForbiddenDetails { target: member | mapping }`), `owner_only`
  (an admin acting on an org owner or admin), `public_links_off`, `turnstile_failed`, `csrf`, `capability_denied`.
- **Groups are keyed by `groupId`** (Google's stable group id, never the email)
  in every route and shape (`GroupRef { groupId, email, name }`).
- **Owner checks are exact.** `manager` has the owner's rank but never passes
  an owner check (server `meetsLevel`); single transfer requires
  `level === "owner"`.
- **Lists are cursor pages** (`Page<T>` = `{ items, nextCursor }`) when unbounded:
  spaces, space members (`SpaceMembersPage` = `Page<SpaceMember>` plus
  `total`), directory groups, audit. Bounded lists are arrays: org members,
  mappings, restricted groups.
- **Identity linking** is `identities(provider = "google", subject)`; the
  Google sign-in `sub` equals `DirUser.id`. No shape carries `users.directory_id`.
- **`instance.hosted` exists once**, on `Me.instance`.
- **The list, search and publish extensions are folded in** (P3 T4, T10):
  `ListQuerySchema` and `SearchQuerySchema` carry the space scopes and
  `spaceId`, and `PublishInputSchema` carries `spaceId` (create only), so the
  MCP `list_artifacts`, `search_artifacts` and `publish_artifact` inputs and
  the generated skill have them too. `HostedPublishInputSchema` is gone.

## FEATURES flags (`FeatureFlagSchema`, `Me.instance.features`)

`FEATURES` env: comma list set per tier by provisioning; self-hosted default
empty = today's behaviour. `parseFeatures(raw)` (the only parser, in
`hosted/core.ts`) drops unknown entries and `guests_read_only`;
`ENV_FEATURE_FLAGS` lists the settable ones. `Me.instance.features` reports
every flag that is on.

| Flag | Source | Meaning |
|---|---|---|
| `spaces` | FEATURES | Spaces and roles on; space routes 404 without it (authz identical either way) |
| `sync_google` | FEATURES | Directory sync running |
| `sync_frozen` | FEATURES | Team after trial: synced rows kept (`source: "sync"`), edited by hand, replaced on return to Business |
| `guests_read_only` | **reported only** | Guests capped at viewer, no data writes. One source: P2's `authConfig.guestsReadOnly`, true whenever the google or email provider is enabled (not configurable; no `GUEST_ACCESS` var). Access-only installs keep today's guest behaviour. FEATURES can't set it |
| `content_revocation` | FEATURES | uid-bound `/c/` content tokens re-check the user's status. A space's `publicLinks` is never part of the `/p/` check: off only refuses new public links |
| `usage_off` | FEATURES | Hosted: the Usage page and `R.usage` are 404 |

## Shared building blocks (`hosted/core.ts`)

| Name | Meaning |
|---|---|
| `AccessLevelSchema` (CHANGED) | `owner \| editor \| viewer \| manager`. `owner` = personal owner only; `manager` = space manager on a shared-space artifact (owner's actions minus transfer) |
| `RoleSchema` (unchanged) | Org role `owner \| admin \| member \| guest` |
| `SpaceRoleSchema` | `viewer \| editor \| manager` in one space |
| `SpaceKindSchema` | `personal \| shared`; personal space id = user id |
| `SpaceRefSchema` | `{ id, kind, name, publicLinks }` on summaries |
| `MySpaceSchema` | `SpaceRef + myRole` (Me.spaces) |
| `MemberStatusSchema` | `active \| suspended \| removed` |
| `IdentityProviderSchema` | `google` (Member.identities) |
| `CapReasonSchema` | `guest \| restricted`: why access is capped at viewer |
| `GroupRefSchema` | `{ groupId, email, name }`: a directory group, keyed by Google's group id |
| `RestrictionSchema` | `{ manual, groups: GroupRef[] }` (Member.restriction): restricted if either applies; frozen group restrictions stay in force |
| `TierSchema` | `trial \| team \| business` (null = self-hosted) |
| `DirectoryModeSchema` | `off \| google \| frozen` |
| `InstanceDirectorySchema` | `{ mode, healthy, unhealthySince, banner, tokensUnverified, state, staleAt, heldSweeps }`. `banner`: unhealthy ≥ 1 h (owner/admin only). `tokensUnverified`: true while unhealthy, since PATs and MCP grants aren't capped at 24 h. `state` (`SyncState`) and `staleAt` (lastSuccessAt + 7 d, informational only - no access effect): owner/admin only, null for others; `heldSweeps`: held sweeps waiting, 0 for non-admins |
| `SyncStateSchema` | `ok \| backoff \| auth_failed \| customer_mismatch \| scope_missing \| never`. `scope_missing`: a granted scope was revoked (Admin SDK 403 insufficientPermissions); fix copy "reconnect and grant all scopes" |
| `InstanceSignInSchema` | `{ mode: access \| direct, providers: (access \| google \| email)[] }` |
| `AuthMethodSchema` | `access \| google \| code \| pat \| oauth \| dev \| test` |
| `MeAuthSchema` | `{ method, readOnly, cap, expiresAt }` |
| `ArtifactCanSchema`, `ARTIFACT_ACTIONS`, `ArtifactAction` | `{ edit, share, setVisibility, delete, transfer, move, dataWrite }`. P3's internal superset is `PolicyAction`, so the names don't clash |
| `artifactCan(level, { personal, cap })` | The P3 action table as one function (server and mocks). `dataWrite` is false for guests and restricted members; ordinary viewers keep it (the artifact still needs the `db`/`storage` capability) |

## CHANGED existing shapes (all fields optional, appended last)

| Shape | Added |
|---|---|
| `ArtifactSummary` (so `SearchHit`) | `space?: SpaceRef`, `can?: ArtifactCan`. Signed-in callers with spaces on. `space` is absent for a shared space where the caller has no role (a share or link alone), so its id and name never leak; `can` is always set |
| `Member` | `status?: MemberStatus` (absent = active), `identities?: ("google")[]`, `restriction?: Restriction \| null` |
| `Me.instance` | `hosted?`, `tier?`, `signIn?`, `features?: FeatureFlag[]`, `directory?: InstanceDirectory` |
| `Me` | `auth?: MeAuth`, `personalSpaceId?` (= user.id), `spaces?: MySpace[]` (shared, by name, ≤ 200) |
| `Settings` (so `SettingsPatch`) | `spaceManagerMappings?: boolean` (hosted; default true, absent self-hosted). PATCH needs `settings.manage` (org owner, admin); audited `settings.space_manager_mappings` |
| `Space` | `can?: SpaceCan` (`{ manageMappings }`) |
| `AuditActionSchema` | `settings.space_manager_mappings`, `user.role` (a member role change: `detail { from, to }`, written only when the role changes) |
| `ERROR_CODES` / `STATUS_FOR` | the codes below |

## Sign-in (`hosted/auth.ts`, P2)

| Route | Contract |
|---|---|
| `GET AUTH.providers` `/auth/providers` | `AuthProviders` (public, no-store, no D1) |
| `GET AUTH.loginGoogle` `/auth/login/google?next&reauth` | 302 to Google or the broker; 404 when Google is off. `reauth=1` forces a fresh Google authentication (`max_age=0`) for break-glass |
| `GET R.me` (break-glass) | 401 `break_glass_required` details `BreakGlassRequiredDetails { fresh }` when the session is the org owner's and a directory customer_mismatch refuses them. `fresh: true`: the session already meets break-glass, so open the directory settings; `false`: sign in with `AUTH.loginGoogle?reauth=1` first. Any other refusal stays a plain 401 `unauthorized` |
| `GET AUTH.callbackGoogle` `/auth/callback/google` | 302 `next`; any refusal (incl. `no_access`) 302 `SIGN_IN_PAGE?error=SignInError&next` only |
| `POST AUTH.codeRequest` `/auth/code/request` | `CodeRequest` → 202 `CodeRequested` |
| `POST AUTH.codeVerify` `/auth/code/verify` | `CodeVerify` → 200 `CodeVerified` |
| `DELETE R.memberIdentity(id, "google")` | 204; owner/admin reset a member's Google link (never the owner's: the owner on themselves is 404). An admin or owner target needs the uncapped OWNER: an admin acting on an admin or the owner gets 403 `owner_only` whether or not they are linked (checked by role before the link, so it reveals no link), also when the target is promoted to admin mid-request (enforced in the write; nothing changes). For any other target, no link is 404. A capped admin gets 404, as on every members route. |

| Schema | Meaning |
|---|---|
| `AuthProvidersSchema` | `{ mode, providers: (access{start} \| google{start, domains} \| email{domainCodes, guests, turnstileSiteKey?})[] }`; only fully configured providers; `turnstileSiteKey` whenever Turnstile is configured |
| `SignInErrorSchema` | `tenant \| identity_conflict \| removed \| no_access \| expired \| failed` |
| `CODE_POLICY` | `{ length: 8, ttlSec: 600, resendAfterSec: 60, maxAttempts: 5 }` |
| `CodeRequestSchema` | `{ email, next?, turnstileToken? }` |
| `CodeRequestedSchema` | `{ maskedEmail, expiresIn, resendAfter, codeLength }`; same 202 for every well-formed address, and when the email pool is full (the pool never 429s) |
| `TurnstileRequiredDetailsSchema` | 400 `turnstile_required` details `{ field: "turnstile", required: true }` |
| `BreakGlassRequiredDetailsSchema` | 401 `break_glass_required` details `{ fresh: boolean }` (GET `R.me`) |
| `CodeRateLimitedDetailsSchema` | 429 `rate_limited` details `{ retryAfter, scope: email \| ip }` |
| `CodeVerifySchema`, `normalizeCode` | `{ code }`; whitespace and hyphens stripped, then 8 digits |
| `CodeVerifiedSchema` | `{ next, user: Member, readOnly }` |
| `CodeVerifyFailureDetailsSchema` | 401 details: `invalid_code{attemptsLeft} \| expired \| no_pending`; locked: 429 `{ retryAfter, scope: "ip" }` (a per-address lock would enable victim lockout) |
| `SessionPayload` (type, reference) | `{ uid, exp, iat, p: access \| google \| code \| dev \| test, t?: tenant (verified Google hd, or the email domain of a domain-code session), e: session epoch, a?: Google auth_time (ms) of a forced re-authentication within 10 min (break-glass) }` |

## Spaces (`hosted/spaces.ts`, P3)

| Route | Body → response | Who |
|---|---|---|
| `GET R.spaces` | `SpacesQuery` → `Page<Space>` | signed in (org admins also see every shared space, `myRole: null`) |
| `POST R.spaces` | `SpaceCreate` → 201 `Space` | org owner, admin |
| `GET R.space(id)` | → `Space` | member, org admin |
| `PATCH R.space(id)` | `SpacePatch` → `Space` | `name`, `publicLinks`: space manager or org admin (`publicLinks` audited `space.public_links`; off blocks new public links only - existing links and sockets keep working, nothing is rewritten). `allMembersRole`: org admin |
| `DELETE R.space(id)` | 204; 409 `space_not_empty` | org owner, admin |
| `GET R.spaceMembers(id)` | `SpaceMembersQuery { q?, group?, cursor?, limit? }` → `SpaceMembersPage` (`Page<SpaceMember>` + `total`, the count matching `q`/`group`) | member, org admin; personal: 400 `space_personal`. `q`: case-insensitive prefix of the email or of any word of the name; `group`: a groupId (either `via`) |
| `PUT R.spaceMember(id, userId)` | `SpaceMemberPut` → `SpaceMember` | space manager, org admin. The target must be an existing, active member (else 404). Only an org admin grants Manager or changes a peer manager (a member with a manager row, by hand or synced; the frozen override included): else 403 `space_forbidden` `{ target: "member" }`. **Sync frozen**, on a row with a `syncRole`: any role, raise or lower, is a manual grant under the rules above (admins any role; managers up to editor) and becomes a manual override (`source: "manual"`, `syncRole: null`, `groups: []`) that the next reconcile after unfreezing replaces. Audited `space.member.add` / `space.member.role` (frozen override: detail `{ syncFrozen: true, role }`) |
| `DELETE R.spaceMember(id, userId)` | 204 | space manager, org admin. Removes the manual row. Only an org admin removes a peer manager (a manager row, by hand or synced, frozen included): else 403 `space_forbidden` `{ target: "member" }`, checked before `member_synced`. A synced-only row while sync is live: 409 `member_synced`. **Sync frozen**: also removes a synced row (removing access is always allowed). Audited `space.member.remove` (frozen: detail `{ syncFrozen: true }`) |
| `POST R.spaceMemberSelf(id)` `/spaces/:id/members/self` | `SpaceMemberPut` → 201 `SpaceMember` | org admin adds themselves; shared spaces only (400 `space_personal`); audited `space.admin_self_add`; managers notified |
| `GET R.spaceMappings(id)` | → `GroupMapping[]` (per-space rows only); personal: 400 `space_personal` | org admin; space manager (any setting). **Manager access pending server implementation (P3 T9/T14)** |
| `PUT/DELETE R.spaceMapping(id, groupId)` | `GroupMappingPut` → `GroupMapping` / 204; 409 `directory_sync_off` when sync is off or frozen | org admin (any role); space manager for rows that are and stay `viewer \| editor` (`SPACE_MANAGER_MAPPING_ROLES`). Order: personal 400 `space_personal`; no role 404; manager PUT while `spaceManagerMappings` is off 403 `directory_mapping_off` (DELETE always allowed: removing access); a `manager` role (PUT body, or the existing row on PUT or DELETE) 403 `space_forbidden` `{ target: "mapping" }`; sync off 409. **Manager access pending server implementation (P3 T9/T14)** |
| `GET R.orgMappings` `/directory/org-mappings` | `?cursor&limit` → `Page<GroupMapping>` | org admin. **Pending server implementation (P3 T9/T14)** |
| `PUT/DELETE R.orgMapping(groupId)` | `GroupMappingPut` → `GroupMapping` (upsert) / 204; 409 `directory_sync_off` when off or frozen | org admin; audited `mapping.set` / `mapping.remove` with `spaceId: null`. **Pending server implementation (P3 T9/T14)** |
| `GET R.restrictedGroups` | → `RestrictedGroup[]` | org admin |
| `PUT R.restrictedGroup(groupId)` | (no body) → `RestrictedGroup`; 409 `directory_sync_off` when off or frozen | org admin; audited `restricted.set` |
| `DELETE R.restrictedGroup(groupId)` | 204, in any mode (lifts a frozen restriction) | org admin; audited `restricted.remove` |
| `PUT/DELETE R.memberRestricted(id)` `/members/:id/restricted` | (no body) → `Member` | org owner, admin; the MANUAL restricted flag, any sync mode (Team, manual and frozen installs); audited `restricted.set` / `restricted.remove`; never lifts a group restriction. Org owners and admins can't be restricted: PUT on one is 400 `restrict_admin` |

Personal spaces are never created, patched, deleted or given members here: 400 `space_personal`.

**"Every space" mappings** (`GroupMapping` rows under `R.orgMappings`): one row per group, applied to every
shared space (including ones created later) and NEVER to a personal space. They
are never expanded into per-space rows: a member's effective role in a shared
space is the read-time max of the space's own rows (manual, sync,
`allMembersRole`) and the org mappings of their groups, surfaced as
`SpaceMember.syncRole` / `groups` and `Space.myRole`. `R.spaceMappings` lists
only per-space rows.

| Schema | Meaning |
|---|---|
| `SpaceSchema` | `SpaceRef + { owner, allMembersRole, myRole, memberCount, artifactCount, createdAt }` (`outsideSharing` dropped until M4) |
| `SpacesQuerySchema` | `{ kind?, cursor?, limit? }` |
| `SpaceCreateSchema` / `SpacePatchSchema` | `{ name, allMembersRole, publicLinks }` (patch: partial); `SPACE_MANAGER_FIELDS` = name, publicLinks. `name` is `SpaceNameSchema`: C0 controls, DEL, bidi controls (U+061C, U+200E/F, U+202A-U+202E, U+2066-U+2069) and zero-width characters (U+200B-U+200D, U+FEFF) are stripped, then trimmed, 1-80 characters (only such characters: 400); `stripNameControls` is the same rule |
| `SpaceMemberSchema` | userId-keyed: `{ userId, user, status, role, source: manual \| sync, manualRole, syncRole, groups: SpaceMemberGroup[], cap, allMembers }`. `allMembers`: the space's `allMembersRole` when it applies to this person, null for guests and capped users (or when none is set) |
| `SpaceMemberGroupSchema` | `GroupRef + { role, via: space \| every }`: one entry per mapping granting `syncRole` (`every` = an Every-space org mapping); a group mapped both ways appears twice |
| `SpaceMembersQuerySchema` / `SpaceMembersPageSchema` | `{ q?, group?, cursor?, limit? }` (strict) / `Page<SpaceMember> + { total }` |
| `SpaceForbiddenDetailsSchema` | `{ target: member \| mapping }` on `space_forbidden` from `R.spaceMember` PUT and `R.spaceMapping` PUT/DELETE (publish/move carry none) |

**Per-row reason line** (UI): built from `manualRole`, `groups[].role`/`via` and
`allMembers`, strongest first, e.g. "Manager by hand, Editor via eng@",
"Viewer via All members"; via `every`: "Editor via eng@ (every space)". A group
mapped both per-space and every space shows only its stronger entry in the
line, never twice. A non-null `cap` still limits access to viewer.
| `SpaceMemberPutSchema` | `{ role }` |
| `GroupMappingSchema` / `GroupMappingPutSchema` | `GroupRef + { role, memberCount, lastSyncedAt }` / `{ role }` |
| `SpaceCanSchema` | `{ manageMappings }`: may add or change mappings. True for org admins, and for the space's managers while `spaceManagerMappings` is on; false on personal spaces. Managers can always list and remove `viewer`/`editor` rows |
| `SPACE_MANAGER_MAPPING_ROLES` | `viewer`, `editor`: the roles a space manager may map |
| `RestrictedGroupSchema` | `GroupRef + { memberCount, createdAt }`. Restricted members (a restricted group or the manual flag) are viewer everywhere: no `allMembersRole`, no create (personal space included), no data writes, on REST, MCP and the data API |

## Artifacts, move and transfer (`hosted/artifacts.ts`, P3)

| Route | Body → response | Rules |
|---|---|---|
| `GET R.artifacts` | `ListQuery` | `scope` adds `space` (needs `spaceId`) and `spaces`; `mine` = personal space; `spaceId` narrows any scope (another user's personal space: 400 `space_personal`; unknown, or a shared space where the caller has no role: 404, never an empty page) |
| `GET R.search` | `SearchQuery` | optional `spaceId`, as the list's |
| `POST R.artifacts` | `PublishInput` (`spaceId?`) | `spaceId` on create only (existing id: 400 `use_move`); default personal space; unknown, another user's personal space, or a shared space the caller can't see: 404; seen but not allowed: 403 `space_forbidden` (also any create by a capped caller); `visibility: "public"` where the space's publicLinks is off: 403 `public_links_off` (echoing it on an already public artifact passes). A visibility change is compare-and-set: a concurrent change or move is 409 `conflict` |
| `PATCH R.artifact(id)` | `ArtifactPatch` | `visibility: "public"` where publicLinks is off: 403 `public_links_off` |
| `POST R.moveArtifact(id)` | `MoveArtifactInput {spaceId}` → `ArtifactSummary` | manager/owner on the artifact (else 404); shared target only (the caller's own personal space: 400 `space_personal`; anyone else's: 404); editor+ in target (else 403 `space_forbidden`). A public artifact moved into a space with publicLinks off becomes `team` in the same batch and its anonymous sockets close (the toggle itself never rewrites or revokes); the returned summary shows `visibility: "team"`. Compare-and-set on the space and visibility read: a concurrent change is 409 `conflict`. Audited `artifact.move` |
| `POST R.transferArtifact(id)` | `TransferArtifactInput {userId}` → `ArtifactSummary` | `level === "owner"` only, personal (else 404; a manager can't); successor active, non-guest, non-restricted (400 `invalid_successor`); former owner keeps an editor share; audited `artifact.transfer` |
| `GET R.members?status=` | `MembersQuery` → `Member[]` | comma list, default `active`; other statuses org owner/admin |
| `PATCH R.member(id)` | `MemberPatch` → `Member` | uncapped org owner, admin (else 404; a capped admin, e.g. a code session outside the verified domains, is 404 on every members route). An org owner or admin target needs the uncapped owner: an admin gets 403 `owner_only` (#475). The owner on themselves stays 400. Enforced in the write: a target promoted to admin mid-request is 403 `owner_only`, nothing changes or is audited |
| `DELETE R.member(id)` | 204 | uncapped org owner, admin (else 404); spaces on: status `removed` (suspension and removal share this rule). An org owner or admin target needs the uncapped owner: an admin gets 403 `owner_only` (#475). The owner on themselves stays 400. Enforced in the write, as PATCH |
| `GET R.memberTransfer(id)` | → `TransferSummary {live, deleted}` | counts only; org owner, admin |
| `POST R.memberTransfer(id)` | `TransferInput {to: user\|space, cursor?}` → `TransferResult {moved, remaining, nextCursor}` | 409 `member_active`; user target active, non-guest, non-restricted (400 `invalid_successor`); ≤ `TRANSFER_PAGE` (100) per call; repeat with `cursor` until `nextCursor` is null (each call moves the next page still in the departed person's space; the cursor is a continuation marker only, so a forged one moves no more). Into a space with publicLinks off, public artifacts become `team` and their sockets close, and a page is at most 50 so the closes fit one request. The target (and a user target's eligibility) is re-checked in the write: if it changed, nothing moves and the call is 409 `conflict`. One `artifact.transfer` audit row per call (`detail: { moved, teamed, to }`) |
| MCP `list_spaces` | → `{ items: MySpace[] }` | the spaces the caller can publish into: their personal space first, then shared spaces where they are editor or manager; empty for a capped caller |

Accepted disclosure: `scope=space` (or any `spaceId`) naming another user's personal space returns 400 `space_personal`, not 404, so it reveals that the id is a user's. Accepted because ids are random and already visible to members on Members (a personal space's id is its owner's user id).

## Directory and audit (`hosted/directory.ts`, P3)

| Route | Response | Who |
|---|---|---|
| `GET R.directory` | `SyncStatus` | org owner, admin |
| `DELETE R.directory` | 204 (disconnect; memberships freeze) | org owner |
| `GET R.directoryGroups` | `DirectoryGroupsQuery` → `Page<DirectoryGroup>` (group picker) | org admin |
| `GET R.directoryConnect` | 302 to Google consent | org owner |
| `GET R.directoryCallback` | 302 `/settings/directory` (consent and binding stored, `SyncStatus.state` `pending_confirm`; nothing linked yet) or `?error=DirectoryConnectError` | OAuth |
| `POST R.directoryConfirm` `/directory/confirm` | 200 `SyncStatus`: runs the binding pass (links and creates members). 404 when nothing is pending; 409 `conflict` when the confirmation expired (24 h after consent; the token and binding are then dropped) | the owner who connected, still org owner; anyone else 404. Audited `directory.connect` |
| `POST R.directoryCancel` `/directory/cancel` | 204: drops the pending token and binding | same as confirm. Audited `directory.disconnect` |
| `POST R.directorySync` | 202 `SyncStatus` ("Sync now") | org owner |
| `POST R.directoryHeldConfirm(groupId)` | 202 `SyncStatus` | org owner |
| `GET R.audit` / `R.auditExport` | `Page<AuditEvent>` / NDJSON | org owner, admin. Export takes `?cursor` and returns at most 5000 events (10 pages of 500) per request, newest first; when more remain, header `X-OA-Next-Cursor` (`AUDIT_NEXT_CURSOR_HEADER`) holds the cursor for the next request |

Break-glass: a stale org owner reaches only the directory status, connect and
sync routes, after a fresh Google sign-in (10 min); else 401 `reauth_required`.

| Schema | Meaning |
|---|---|
| `SyncStatusSchema` | `{ mode, binding, healthy, state, unhealthySince, lastSuccessAt, lastError, nextRunAt, staleAt, alertedAt, customerMismatch, held }` |
| `DirectoryBindingSchema` | `{ provider, customerId, domain, connectedBy, connectedAt }` |
| `SyncStatusSchema` pending fields | `pendingCount: number \| null` (active in-domain users the pass would link or create, over at most one page of 500), `pendingCountCapped: boolean` (true: show "500+"), `pendingExpiresAt: string \| null` (ISO, consent + 24 h). Set only while `state` is `pending_confirm` (`SyncState` gains `pending_confirm`). Defaults `null` / `false` / `null` when absent, so a payload from before the confirm step still parses |
| `HeldSweepSchema` | `GroupRef + { wouldRemove, members, since }` |
| `DirUserSchema` | `{ id (= Google sub), primaryEmail, suspended, deleted }` |
| `DirectoryGroupSchema` | `{ groupId, email, name, memberCount }` |
| `DirectoryConnectErrorSchema` | `not_super_admin \| domain_mismatch \| customer_mismatch \| scopes \| denied \| expired \| failed` |
| `AuditReasonSchema` | why a status changed: `directory_suspend \| directory_unsuspend \| directory_delete \| directory_new_id \| directory_stale \| admin_suspend \| admin_remove \| admin_restore` |
| `AuditActionSchema`, `AuditEventSchema` | audited actions (incl. `auth.signin`, `artifact.share`/`unshare`/`visibility`, `space.public_links`, `space.admin_self_add`, `restricted.set`/`restricted.remove`, `directory.break_glass`, `user.status` with `reason` and `detail { status }`, written only when the status changes, `user.role`) and the event row (target types add `group`, a Google group id) |

## Error codes (appended to `ERROR_CODES`)

These are the names P2 and P3 use; the contract wins. There is no
`space_publish_forbidden` (it is `space_forbidden`) and no `forbidden_identity`
(identity conflicts are the `identity_conflict` sign-in redirect error).

| Code | Status | Meaning |
|---|---|---|
| `space_forbidden` | 403 | publish or move into a space you can't publish to; any create by a capped caller; a member or mapping change your role can't make (details `{ target: member \| mapping }`). UI copy (space managers only; admins are never refused this): `member` "Only an admin can make someone a manager." (also when a manager tries to change or remove another manager); `mapping` "Only an admin can make a group a manager." |
| `space_personal` | 400 | a personal space as a move/transfer target or a spaces-route target |
| `space_not_empty` | 409 | delete a space that still holds artifacts (trash counts) |
| `public_links_off` | 403 | make an artifact public in a space whose publicLinks is off |
| `use_move` | 400 | `spaceId` on publish to an existing artifact |
| `invalid_successor` | 400 | transfer target isn't an active, non-guest, non-restricted member |
| `member_active` | 409 | departed-person transfer on an active member |
| `directory_sync_off` | 409 | mapping or restricted-group change while sync is off or frozen (also Sync now) |
| `turnstile_required` | 400 | code request with no Turnstile token while Turnstile is configured |
| `turnstile_failed` | 403 | Turnstile token rejected |
| `code_unavailable` | 503 | code sign-in can't run: `SESSION_SECRET` is under 32 characters, so the code keys can't be derived, or the `RL_AUTH` rate-limit binding is missing |
| `reauth_required` | 401 | break-glass routes need a fresh Google sign-in |
| `break_glass_required` | 401 | `GET R.me` for the org owner refused by a directory customer_mismatch; details `{ fresh }` (see Sign-in) |
| `restrict_admin` | 400 | `PUT R.memberRestricted(id)` on an org owner or admin |
| `owner_only` | 403 | an admin (or a capped owner) acting on an org owner or admin: `PATCH`/`DELETE R.member(id)`, `DELETE R.memberIdentity(id, "google")` (#475). Admins keep managing members and guests |
| `directory_mapping_off` | 403 | a space manager (not an org admin) adds or changes a space mapping (PUT) while `Settings.spaceManagerMappings` is off; list and DELETE stay allowed |
| `member_synced` | 409 | `DELETE R.spaceMember` on a synced-only row while sync is live. UI copy: "This person comes from a Google group. Remove them from the group in Google, or change their role here." |

## Test hooks (`hosted/test-hooks.ts`, types only)

| Name | Meaning |
|---|---|
| `TEST_HOOKS` | paths `/__test/session`, `/__test/otp/latest`, `/__test/oauth-client` |
| `TestSessionInputSchema` / `TestSessionResultSchema` | `{ email, role, spaces?: {spaceId, role}[] }` → `{ cookie }` (a real session, `p: "test"`). `spaces`: at most 20, each `spaceId` matching `test-[A-Za-z0-9_-]{1,59}`; a missing space is created (shared). Refused (404, nothing written): any other id, a personal or deleted space, or a space with a member outside `TEST_DOMAIN` |
| `OtpLatestInputSchema` / `OtpLatestResultSchema` | `{ email }` → `{ code }` (404 when none) |
| `OAuthClientHookResultSchema` | `{ clientId, accessToken }` |
| `HealthzSchema` | `/healthz` `{ ok, plan, version, testHooks?, installId? }`: `installId` only when the hosted install has a non-empty trimmed `INSTALL_ID` (opaque, non-secret, last key; self-host omits it). It proves routing, not authenticity: never use it as an authorization signal. `testHooks`: true only on staging installs. Prod is built separately (the staging bundle is never promoted) and the release asserts `testHooks: false` |
| `TEST_HOOKS_ALLOWED` | **build-time guard**: false unless the bundler defines `__OA_TEST_HOOKS_ALLOWED__` as true (test and staging wrangler `define` only). The release template defines it as `false` explicitly, so hooks need this AND `TEST_HOOKS=1` with a 32+ char key. The release check is behavioural: the release bundle with `TEST_HOOKS=1` plus a key answers 404 on every hook path |

## Mocks (`@oa/shared/mocks`)

`createHandlers({ hosted: true | HostedMockOptions })`, off by default (existing
FE tests unchanged). Options: `mode`, `providers`, `turnstile`, `tier`,
`directory`, `unhealthy`, `unhealthyState`, `breakGlass` (`"fresh" | "stale"`: `GET R.me` answers 401 `break_glass_required`), `features` (`guests_read_only` ignored). Store:
personal space per member, Engineering (caller manager, allMembersRole viewer,
"Meeting notes" lives there), Exec (caller viewer, publicLinks off), Clients
(admin view); groups `gEng01`, `gExec02`, `gSales03`, `gCon04` (restricted
"Contractors", member Dan: `cap: "restricted"`, no allMembersRole); a suspended
member Carol with `{ live: 2, deleted: 1 }` to transfer; a held sweep
(`gSales03`); `can` from `artifactCan` on every request; `public_links_off`
on PATCH and publish; `owner_only` when an admin changes, removes or resets
the Google link of the owner or an admin (`actAs: "admin"`; Erin is the seeded
admin); `Settings.spaceManagerMappings` (default on, PATCH
admin-only and audited); space managers map `viewer`/`editor` only (never over a manager row); org
mappings (none seeded) merge into shared spaces at read time, never personal. Code flow: `HOSTED_MOCK_CODE` (`24681357`) verifies the last
requested address; 5 wrong tries expire it; 6+ requests per address 429.
Verify signs the mock in as that address (member for `MOCK_DOMAIN`, else a
read-only guest).
