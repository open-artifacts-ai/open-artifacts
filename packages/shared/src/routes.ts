const A = "/api/v1/artifacts";
// "." and ".." segments (even percent-encoded) are collapsed by URL parsers, so they cannot be
// represented safely; refuse them rather than emit a URL that resolves elsewhere.
const seg = (s: string): string => {
  if (s === "." || s === "..")
    throw new RangeError(`Unsafe path segment: ${JSON.stringify(s)}`);
  return encodeURIComponent(s);
};

export const R = {
  /** GET -> Me; PATCH MePatch (`{ displayName }`) -> Me. Any signed-in user, guests included. */
  me: "/api/v1/me",
  /** GET (ListQuery) -> Page<ArtifactSummary>; POST PublishInput (JSON) -> PublishResult. Inline content (content, text files and base64 together) is limited to LIMITS.inlineBytes (128 KB): over it, or a body over twice that plus 64 KB, 413 too_large (INLINE_TOO_LARGE_MESSAGE); larger files go through R.uploads then files: { path: { uploadId } }. Publishing to an uploaded/reserved id with no existing artifact requires title; the server returns 400 without it. Create only: an existing artifact's id is 400 bad_request (details { path: "id", reason: "not_reserved" }); publish a new version with POST R.versions(id). (MCP publish_artifact with an id does publish a new version.) */
  artifacts: A,
  /** GET -> ArtifactSummary; PATCH ArtifactPatch -> ArtifactPatchResult; DELETE soft-delete -> 204 */
  artifact: (id: string) => `${A}/${seg(id)}`,
  /** POST -> ArtifactSummary. The personal owner, or (shared space) an uncapped manager of that space by space role (an org admin only after self-adding as manager), within LIMITS.softDeleteDays. A shared space's trash restores only while the space is live and spaces are on. Anyone else, or otherwise, 404. */
  restoreDeleted: (id: string) => `${A}/${seg(id)}/undelete`,
  /**
   * GET TrashQuery (?spaceId=&cursor=&limit=) -> Page<TrashItem>, newest
   * deletedAt first. The caller's personal trash plus, with spaces on, the
   * trash of every shared space where their space role is manager (uncapped;
   * no org-admin shortcut). spaceId narrows it: a shared space the caller doesn't manage,
   * or can't see, is 404; another person's personal space is 404. With
   * spaces off, any spaceId but the caller's own id is 400. Capped callers
   * get an empty page (they can't restore).
   */
  trash: "/api/v1/trash",
  /**
   * GET -> VersionInfo[]: newest first with version < `before` (all versions when omitted).
   * A page holds at most VERSIONS_PAGE_SIZE (20) and stops early once its manifests pass
   * ~1 MiB (always at least one), so pages may be shorter than 20: page on with
   * `before` = the last version; only an empty array means the end.
   * POST PublishInput (new version) -> PublishResult
   */
  versions: (id: string, before?: number) => {
    if (before !== undefined && !(Number.isInteger(before) && before >= 1))
      throw new RangeError(`before must be an integer >= 1: ${before}`);
    return `${A}/${seg(id)}/versions${before === undefined ? "" : `?before=${before}`}`;
  },
  /** GET raw file bytes (auth), for diff */
  versionFile: (id: string, v: number, path: string) =>
    `${A}/${seg(id)}/versions/${v}/files/${path.split("/").map(seg).join("/")}`,
  /** POST -> PublishResult */
  restoreVersion: (id: string, v: number) =>
    `${A}/${seg(id)}/versions/${v}/restore`,
  /** PUT text/plain (PDF extraction) -> 204 */
  versionText: (id: string, v: number) => `${A}/${seg(id)}/versions/${v}/text`,
  /** GET -> image/webp; PUT image/webp -> 204 */
  thumbnail: (id: string) => `${A}/${seg(id)}/thumbnail`,
  /** GET -> ContentUrl */
  contentUrl: (id: string, v?: number) =>
    `${A}/${seg(id)}/content-url${v !== undefined ? `?v=${v}` : ""}`,
  /** GET -> Share[]; PUT ShareInput -> Share */
  shares: (id: string) => `${A}/${seg(id)}/shares`,
  /** DELETE -> 204 */
  share: (id: string, email: string) => `${A}/${seg(id)}/shares/${seg(email)}`,
  /** POST UploadCreateInput -> UploadCreated */
  uploads: "/api/v1/uploads",
  /** PUT raw body (signed: ?sig=...&exp=...) -> 204 */
  upload: (uploadId: string) => `/api/v1/uploads/${seg(uploadId)}`,
  /**
   * GET ?q=&cursor=&limit= -> Page<SearchHit>
   *
   * Body text is indexed asynchronously after publish, restore and undelete
   * (C3), within ~10 s (LIMITS.indexDebounceMs; a burst of versions indexes
   * only the newest; longer while retrying). Until then a new or undeleted
   * artifact matches on title/description only, and a new version still
   * matches the previous version's body. Title/description changes (PATCH)
   * apply immediately. Only the first 64 KB (LIMITS.indexTextBytes) of a
   * document's entry file is indexed: text past that never matches.
   */
  search: "/api/v1/search",
  /** GET -> Member[]; POST MemberInvite -> Member. Uncapped org owner or admin only (anyone else 404); space managers use spaceCandidates. */
  members: "/api/v1/members",
  /** PATCH MemberPatch -> Member; DELETE -> 204 */
  member: (id: string) => `/api/v1/members/${seg(id)}`,
  /** GET -> Token[]; POST TokenCreateInput -> TokenCreated */
  tokens: "/api/v1/tokens",
  /** PATCH TokenPatch -> Token; DELETE -> 204. Own tokens only (else 404). */
  token: (id: string) => `/api/v1/tokens/${seg(id)}`,
  /** GET -> OAuthClient[] */
  oauthClients: "/api/v1/oauth-clients",
  /** PATCH OAuthClientPatch -> OAuthClient; DELETE -> 204. Own grants only (else 404). */
  oauthClient: (grantId: string) => `/api/v1/oauth-clients/${seg(grantId)}`,
  /** GET -> Settings; PATCH SettingsPatch -> Settings (hosted: spaceManagerMappings, settings.manage, audited settings.space_manager_mappings) */
  settings: "/api/v1/settings",
  /**
   * GET -> Usage: today's (UTC) free-plan counts. Also `cpu_limit_hits`
   * (invocations ending exceededCpu or exceededResources; limit 0) and
   * `cpu_p99_ms` (p99 CPU time in ms; limit 10 on Free, 0 when not applicable),
   * both for this Worker's script, and `kv_writes` (OAUTH_KV write operations;
   * limit 1000). Each is omitted when unavailable.
   */
  usage: "/api/v1/usage",
  /** GET -> Page<DataDoc> */
  dataCollection: (id: string, col: string) =>
    `${A}/${seg(id)}/data/${seg(col)}`,
  /**
   * GET -> DataCount { count }: docs in the collection. Same access, "db"
   * capability and anonymous-read rules as dataCollection. A sibling of
   * /data (like data-subscribe) because any [A-Za-z0-9_-] segment under
   * /data/:col is a doc id.
   */
  dataCount: (id: string, col: string) =>
    `${A}/${seg(id)}/data-count/${seg(col)}`,
  /** POST DataQuery -> Page<DataDoc> */
  dataQuery: (id: string, col: string) =>
    `${A}/${seg(id)}/data/${seg(col)}/query`,
  /** GET -> DataDoc; PUT DataSetBody (raw JSON doc) -> DataDoc; PATCH DataPatchBody (merge) -> DataDoc; DELETE -> 204. A doc (after a merge too) is ≤ dataDocLimit(plan): 256 KB on Workers Free, 1 MB on Paid (env PLAN), counting the body's bytes as sent (whitespace included; a merge counts the merged doc serialized). Over it, 413 too_large with dataDocTooLargeMessage(plan), from Content-Length before the body is read when declared. */
  dataDoc: (id: string, col: string, doc: string) =>
    `${A}/${seg(id)}/data/${seg(col)}/${seg(doc)}`,
  /**
   * PUT DataResetBody -> DataResetResult. Owner only (404 otherwise, as for
   * other owner routes; 403 capability_denied without "db"). Atomically
   * replaces ALL of the artifact's data docs with the snapshot (collections
   * absent from it are emptied; per-viewer storage is untouched), in one DO
   * transaction: on any error the old data stays. Every doc gets updatedBy the
   * caller and one updatedAt. Live subscribers are then reconnected, so each
   * viewer gets db.resync and refetches. Body ≤ dataResetLimit(plan) (1 MB Free,
   * 8 MB Paid; 413 too_large, from Content-Length before the body is read);
   * ≤ LIMITS.dataResetCollections collections and dataResetDocLimit(plan)
   * docs (500 Free, 5000 Paid; 400); each doc ≤ dataDocLimit(plan) serialized (413). Idempotent.
   */
  dataReset: (id: string) => `${A}/${seg(id)}/data`,
  /**
   * GET Upgrade: websocket; frames are ArtifactEvent (hello, version, gone).
   * Live version updates for any artifact (no capability needed). Access as
   * for reading the artifact (404 otherwise), checked on every connect; a
   * browser Origin other than the app's is refused (403 csrf); `?embed=1`
   * (or X-OA-Embed: 1) connects anonymously. `gone` is followed by close 4403.
   */
  events: (id: string) => `${A}/${seg(id)}/events`,
  /** GET Upgrade: websocket; frames are DataChange */
  dataSubscribe: (id: string, col: string) =>
    `${A}/${seg(id)}/data-subscribe?collection=${seg(col)}`,
  /** GET -> AnonViewer ({ anonId }): an anonymous viewer's public id (runtime viewer.anonId()); artifacts with dataWriters "viewers" and the viewer capability only (401 signed in or otherwise). Verifies the ANON_ID_HEADER token or mints one (returned in that header), like anonymous writes; RL_ANON per IP. The id is per artifact. */
  anonId: (id: string) => `${A}/${seg(id)}/anon-id`,
  /** GET -> Page<StorageKey> */
  storage: (id: string) => `${A}/${seg(id)}/storage`,
  /** GET -> StorageEntry; PUT StorageSetBody { value } (strict; StorageSetBodySchema) -> StorageEntry; DELETE -> 204. `value` has the data-doc limit (dataDocLimit(plan), 413 too_large). */
  storageKey: (id: string, key: string) =>
    `${A}/${seg(id)}/storage/${seg(key)}`,

  // Hosted M1 (packages/shared/HOSTED_CONTRACT.md). No access is 404.
  /** POST MoveArtifactInput -> ArtifactSummary (shared target only: 400 space_personal; 403 space_forbidden). */
  moveArtifact: (id: string) => `${A}/${seg(id)}/move`,
  /** POST TransferArtifactInput -> ArtifactSummary (personal owner only; 400 invalid_successor). */
  transferArtifact: (id: string) => `${A}/${seg(id)}/transfer`,
  /** GET SpacesQuery -> Page<Space>; POST SpaceCreate -> 201 Space (org owner, admin). */
  spaces: "/api/v1/spaces",
  /** GET -> Space; PATCH SpacePatch -> Space; DELETE -> 204 (409 space_not_empty). Personal: 400 space_personal. */
  space: (id: string) => `/api/v1/spaces/${seg(id)}`,
  /** GET ?cursor&limit -> Page<SpaceMember>. */
  spaceMembers: (id: string) => `/api/v1/spaces/${seg(id)}/members`,
  /** PUT SpaceMemberPut -> SpaceMember; DELETE -> 204 (manual row only). Manager or org admin. */
  spaceMember: (id: string, userId: string) =>
    `/api/v1/spaces/${seg(id)}/members/${seg(userId)}`,
  /**
   * POST SpaceMemberPut -> 201 SpaceMember: an org admin adds themselves to a
   * shared space (personal: 400 space_personal). Audited space.admin_self_add;
   * the space's managers are notified.
   */
  spaceMemberSelf: (id: string) => `/api/v1/spaces/${seg(id)}/members/self`,
  /**
   * GET SpaceCandidatesQuery -> Page<SpaceCandidate>: the people a caller
   * who can manage this space may add (active org members, never guests).
   * Uncapped org admin or uncapped space manager; anyone else 404.
   * Personal: 400 space_personal.
   */
  spaceCandidates: (id: string) => `/api/v1/spaces/${seg(id)}/candidates`,
  /** GET -> GroupMapping[] (org admin, space manager; personal: 400 space_personal). Manager access pending server implementation (P3 T9/T14). */
  spaceMappings: (id: string) => `/api/v1/spaces/${seg(id)}/mappings`,
  /** PUT GroupMappingPut -> GroupMapping; DELETE -> 204. 409 directory_sync_off when sync is off or frozen. Keyed by Google group id. Org admin: any role; space manager: viewer|editor rows only (a manager role in the body or the existing row: 403 space_forbidden); manager PUT while Settings.spaceManagerMappings is off: 403 directory_mapping_off (DELETE always allowed). Manager access pending server implementation (P3 T9/T14). */
  spaceMapping: (id: string, groupId: string) =>
    `/api/v1/spaces/${seg(id)}/mappings/${seg(groupId)}`,
  /** GET -> RestrictedGroup[] (org admin). */
  restrictedGroups: "/api/v1/directory/restricted-groups",
  /**
   * PUT (no body) -> RestrictedGroup (409 directory_sync_off when sync is off
   * or frozen); DELETE -> 204 in any mode (frozen restrictions stay in force
   * until lifted). Keyed by Google group id. Audited restricted.set/remove.
   */
  restrictedGroup: (groupId: string) =>
    `/api/v1/directory/restricted-groups/${seg(groupId)}`,
  /** GET ?cursor&limit -> Page<GroupMapping> (org admin): "Every space" mappings, one row per group, never expanded into per-space rows. Pending server implementation (P3 T9/T14). */
  orgMappings: "/api/v1/directory/org-mappings",
  /** PUT GroupMappingPut -> GroupMapping (upsert); DELETE -> 204 (org admin). 409 directory_sync_off when sync is off or frozen. Keyed by Google group id. Never applies to personal spaces. */
  orgMapping: (groupId: string) =>
    `/api/v1/directory/org-mappings/${seg(groupId)}`,
  /** GET -> SyncStatus (org owner, admin); DELETE -> 204, the same disconnect as directoryDisconnect (org owner, cookie session). */
  directory: "/api/v1/directory",
  /**
   * POST -> 200 SyncStatus (state never; customer_mismatch when disconnected
   * during one): revokes the Google grant (best effort), deletes the binding,
   * tokens and any pending consent, and stops sync. Synced memberships stay
   * as they are (frozen). Nothing connected: 200, no change. The org owner
   * in a cookie session only (a PAT or grant: 404). Every owner is emailed.
   * Audited directory.disconnect.
   */
  directoryDisconnect: "/api/v1/directory/disconnect",
  /** GET DirectoryGroupsQuery -> Page<DirectoryGroup> (org admin; group picker). */
  directoryGroups: "/api/v1/directory/groups",
  /** GET -> 302 to Google consent (org owner). */
  directoryConnect: "/api/v1/directory/connect",
  /**
   * GET (OAuth) -> 302 /settings/directory (consent stored, SyncStatus.state
   * pending_confirm) or /settings/directory?error=DirectoryConnectError.
   */
  directoryCallback: "/api/v1/directory/callback",
  /**
   * POST -> 200 SyncStatus: runs the binding pass for the pending connection.
   * Only the owner who connected (still the org owner); anyone else 404; no
   * pending connection 404; expired (24 h) 409 conflict, and it is dropped.
   * A tenant change (SyncStatus.pendingCustomerChange) confirms the same
   * way; directory.connect records customerId and previousCustomerId.
   */
  directoryConfirm: "/api/v1/directory/confirm",
  /** POST -> 204: drops the pending connection (token and binding). Same callers as directoryConfirm. */
  directoryCancel: "/api/v1/directory/cancel",
  /** POST -> 202 SyncStatus (org owner; "Sync now"). */
  directorySync: "/api/v1/directory/sync",
  /** POST -> 202 SyncStatus (org owner; apply a held sweep). */
  directoryHeldConfirm: (groupId: string) =>
    `/api/v1/directory/held/${seg(groupId)}/confirm`,
  /** GET -> TransferSummary; POST TransferInput -> TransferResult (409 member_active). Org owner, admin. */
  memberTransfer: (id: string) => `/api/v1/members/${seg(id)}/transfer`,
  /**
   * PUT (no body) -> Member; DELETE -> Member: set or clear the MANUAL
   * restricted flag (org owner, admin; any sync mode). Audited
   * restricted.set / restricted.remove. DELETE never lifts a group restriction.
   * Org owners and admins can't be restricted: PUT on one is 400 restrict_admin.
   */
  memberRestricted: (id: string) => `/api/v1/members/${seg(id)}/restricted`,
  /** DELETE -> 204: reset a member's Google link (owner, admin; never the owner's link). */
  memberIdentity: (id: string, provider: "google") =>
    `/api/v1/members/${seg(id)}/identities/${seg(provider)}`,
  /**
   * POST -> 200 { auth, directory }, each { ok, reached, status, ms,
   * transport, skipped?, error?, cached? }: the install's transport reached
   * broker-core and was refused as expected (a signed junk request; the
   * 401 doesn't prove the signing key is registered). The org owner only
   * (anyone else 404). Within 30 s of the last check its result again
   * (cached); else 2 a minute (429). Audited auth.broker_check.
   */
  adminBrokerCheck: "/api/v1/admin/broker-check",
  /** GET ?cursor&limit -> Page<AuditEvent> (org owner, admin). */
  audit: "/api/v1/audit",
  /**
   * GET ?cursor -> NDJSON of AuditEvent, newest first, at most 5000 events
   * (10 pages of 500) per request. When more remain, the response carries
   * AUDIT_NEXT_CURSOR_HEADER; pass it back as ?cursor to continue.
   */
  auditExport: "/api/v1/audit/export",
} as const;

/** R.auditExport response header naming the cursor of the next request (absent when done). */
export const AUDIT_NEXT_CURSOR_HEADER = "X-OA-Next-Cursor";

export const AUTH = {
  login: "/auth/login",
  /** GET (Access OIDC) -> 302 next; a refusal goes to PAGES.noAccess on Access-only installs, else (direct mode) SIGN_IN_PAGE?error=no_access&next&via=access. */
  callback: "/auth/callback",
  logout: "/auth/logout",
  devLogin: "/auth/dev-login",
  // Hosted M1 (P2). JSON only; the SPA at SIGN_IN_PAGE renders sign-in.
  /** GET -> AuthProviders (public, no-store). */
  providers: "/auth/providers",
  /** GET ?next -> 302 to Google (404 when Google is off). */
  loginGoogle: "/auth/login/google",
  /** GET (OAuth) -> 302 next, or (any refusal) SIGN_IN_PAGE?error=SignInError&next; no_access adds &via=google (SignInVia). */
  callbackGoogle: "/auth/callback/google",
  /** POST CodeRequest -> 202 CodeRequested. */
  codeRequest: "/auth/code/request",
  /** POST CodeVerify -> 200 CodeVerified. */
  codeVerify: "/auth/code/verify",
} as const;

export const MCP_PATH = "/mcp";

export const diffPath = (id: string, from: number, to: number) =>
  `/a/${seg(id)}/diff/${from}/${to}`;

export const PAGES = { noAccess: "/no-access", search: "/search" } as const;
/** Hosted M1: the SPA sign-in page (?next=&error=SignInError). Kept out of PAGES, whose shape is pinned. */
export const SIGN_IN_PAGE = "/sign-in";

export const viewerPath = (id: string, v?: number) =>
  v !== undefined ? `/a/${seg(id)}/v/${v}` : `/a/${seg(id)}`;
