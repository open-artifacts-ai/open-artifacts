// Google Admin SDK Directory and Reports APIs, read-only. P3 T12 added what
// connect needs (users.get, domains.list, a users.list page); T13 adds the
// polling calls (listings with query and showDeleted, group members, groups,
// a user's groups, Reports activities). Every call takes the access token
// from the resolved transport (broker or direct), and every listing is
// scoped to the binding's customer id. Errors carry the HTTP status and
// Google's reason code only: never a URL, token or email.

export const ADMIN_API = "https://admin.googleapis.com/admin/directory/v1";
export const REPORTS_API = "https://admin.googleapis.com/admin/reports/v1";

/** Server-internal: the contract's DirUser plus what connect and sync check. */
export type GoogleUser = {
  id: string;
  primaryEmail: string;
  suspended: boolean;
  deleted: boolean;
  /** Super admin only (delegated admins read false; isDelegatedAdmin is separate). */
  isAdmin: boolean;
  customerId: string | null;
};

/**
 * An Admin SDK failure: `status` (0 for a network error) and, when Google
 * sent one, its reason code (e.g. "insufficientPermissions"), never text.
 */
export class GoogleApiError extends Error {
  constructor(
    public status: number,
    public reason: string | null = null,
  ) {
    super(`google admin api: http ${status}${reason ? ` ${reason}` : ""}`);
    this.name = "GoogleApiError";
  }
}

const REASON = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Google's error reason code from an error body, or null. */
async function reasonOf(res: Response): Promise<string | null> {
  try {
    const b = (await res.json()) as {
      error?: { errors?: { reason?: unknown }[]; status?: unknown };
    } | null;
    const r = b?.error?.errors?.[0]?.reason ?? b?.error?.status;
    return typeof r === "string" && REASON.test(r) ? r : null;
  } catch {
    return null;
  }
}

async function get(token: string, url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "manual",
    });
  } catch {
    throw new GoogleApiError(0);
  }
  if (!res.ok) {
    if (res.status === 403 || res.status === 400)
      throw new GoogleApiError(res.status, await reasonOf(res));
    await res.body?.cancel();
    throw new GoogleApiError(res.status);
  }
  return res.json().catch(() => {
    throw new GoogleApiError(res.status);
  });
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

function userOf(raw: unknown): GoogleUser | null {
  const u = raw as Record<string, unknown> | null;
  const id = str(u?.id);
  const primaryEmail = str(u?.primaryEmail);
  if (!u || !id || !primaryEmail) return null;
  return {
    id,
    primaryEmail,
    suspended: u.suspended === true,
    deleted: false,
    isAdmin: u.isAdmin === true,
    customerId: str(u.customerId),
  };
}

const USER_FIELDS = "id,primaryEmail,suspended,isAdmin,customerId";

/** users.get(userKey): null when the response has no usable user. */
export async function getUser(
  token: string,
  userKey: string,
): Promise<GoogleUser | null> {
  return userOf(
    await get(
      token,
      `${ADMIN_API}/users/${encodeURIComponent(userKey)}?fields=${USER_FIELDS}`,
    ),
  );
}

/** domains.list(customer): the customer's verified domain names, lowercase. */
export async function verifiedDomains(
  token: string,
  customerId: string,
): Promise<string[]> {
  const out = (await get(
    token,
    `${ADMIN_API}/customer/${encodeURIComponent(customerId)}/domains`,
  )) as { domains?: unknown } | null;
  const list = Array.isArray(out?.domains) ? out.domains : [];
  return list.flatMap((d) => {
    const x = d as { domainName?: unknown; verified?: unknown } | null;
    return typeof x?.domainName === "string" && x.verified === true
      ? [x.domainName.toLowerCase()]
      : [];
  });
}

export const USERS_PAGE = 500;

export type ListUsersOpts = {
  /** Admin SDK search query, e.g. "isSuspended=true". */
  query?: string;
  /** Deleted users only (users.list returns only those with showDeleted). */
  showDeleted?: boolean;
  pageToken?: string;
};

/** Parses one users.list response body (exported for the CPU budget). */
export function parseUsersPage(
  out: unknown,
  deleted = false,
): { users: GoogleUser[]; nextPageToken: string | null } {
  const o = out as { users?: unknown; nextPageToken?: unknown } | null;
  const users = (Array.isArray(o?.users) ? o.users : []).flatMap((u) => {
    const g = userOf(u);
    return g ? [deleted ? { ...g, deleted: true } : g] : [];
  });
  return { users, nextPageToken: str(o?.nextPageToken) };
}

/**
 * One users.list page for the customer: active and suspended by default,
 * deleted users only with `showDeleted` (each read `deleted: true`).
 */
export async function listUsers(
  token: string,
  customerId: string,
  o: ListUsersOpts = {},
): Promise<{ users: GoogleUser[]; nextPageToken: string | null }> {
  const q = new URLSearchParams({
    customer: customerId,
    maxResults: String(USERS_PAGE),
    fields: `nextPageToken,users(${USER_FIELDS})`,
  });
  if (o.query) q.set("query", o.query);
  if (o.showDeleted) q.set("showDeleted", "true");
  if (o.pageToken) q.set("pageToken", o.pageToken);
  return parseUsersPage(
    await get(token, `${ADMIN_API}/users?${q}`),
    o.showDeleted === true,
  );
}

export const MEMBERS_PAGE = 200;

/** A direct member of a group: a user, a nested group, or the whole customer. */
export type GroupMember = {
  id: string;
  type: "USER" | "GROUP" | "CUSTOMER" | "OTHER";
  email: string | null;
};

const MEMBER_TYPES = new Set(["USER", "GROUP", "CUSTOMER"]);

/**
 * One members.list page of `groupKey`: direct members only, nested groups
 * included as type GROUP (resolved locally through directory_groups.parent_ids).
 */
export async function listMembers(
  token: string,
  groupKey: string,
  pageToken?: string,
): Promise<{ members: GroupMember[]; nextPageToken: string | null }> {
  const q = new URLSearchParams({
    maxResults: String(MEMBERS_PAGE),
    fields: "nextPageToken,members(id,email,type)",
  });
  if (pageToken) q.set("pageToken", pageToken);
  const out = (await get(
    token,
    `${ADMIN_API}/groups/${encodeURIComponent(groupKey)}/members?${q}`,
  )) as { members?: unknown; nextPageToken?: unknown } | null;
  const members = (Array.isArray(out?.members) ? out.members : []).flatMap(
    (m) => {
      const x = m as Record<string, unknown> | null;
      const id = str(x?.id);
      if (!id) return [];
      const t = str(x?.type) ?? "";
      return [
        {
          id,
          type: (MEMBER_TYPES.has(t) ? t : "OTHER") as GroupMember["type"],
          email: str(x?.email)?.toLowerCase() ?? null,
        },
      ];
    },
  );
  return { members, nextPageToken: str(out?.nextPageToken) };
}

/** A Google group as groups.list and groups.get return it. */
export type GoogleGroup = {
  id: string;
  email: string;
  name: string;
  directMembersCount: number | null;
};

function groupOf(raw: unknown): GoogleGroup | null {
  const g = raw as Record<string, unknown> | null;
  const id = str(g?.id);
  const email = str(g?.email);
  if (!g || !id || !email) return null;
  const n = Number(g.directMembersCount);
  return {
    id,
    email: email.toLowerCase(),
    name: str(g.name) ?? email,
    directMembersCount:
      g.directMembersCount !== undefined && Number.isFinite(n) ? n : null,
  };
}

const GROUP_FIELDS = "id,email,name,directMembersCount";
export const GROUPS_PAGE = 200;

/** groups.get(groupKey). */
export async function getGroup(
  token: string,
  groupKey: string,
): Promise<GoogleGroup | null> {
  return groupOf(
    await get(
      token,
      `${ADMIN_API}/groups/${encodeURIComponent(groupKey)}?fields=${GROUP_FIELDS}`,
    ),
  );
}

export type GroupsPage = {
  groups: GoogleGroup[];
  nextPageToken: string | null;
};

async function groupsPage(
  token: string,
  q: URLSearchParams,
): Promise<GroupsPage> {
  q.set("fields", `nextPageToken,groups(${GROUP_FIELDS})`);
  const out = (await get(token, `${ADMIN_API}/groups?${q}`)) as {
    groups?: unknown;
    nextPageToken?: unknown;
  } | null;
  const groups = (Array.isArray(out?.groups) ? out.groups : []).flatMap((g) => {
    const x = groupOf(g);
    return x ? [x] : [];
  });
  return { groups, nextPageToken: str(out?.nextPageToken) };
}

/** One groups.list page for the customer; `query` is an Admin SDK group query. */
export function listGroups(
  token: string,
  customerId: string,
  o: { query?: string; pageToken?: string; maxResults?: number } = {},
): Promise<GroupsPage> {
  const q = new URLSearchParams({
    customer: customerId,
    maxResults: String(o.maxResults ?? GROUPS_PAGE),
  });
  if (o.query) q.set("query", o.query);
  if (o.pageToken) q.set("pageToken", o.pageToken);
  return groupsPage(token, q);
}

/** The groups `userKey` is a direct member of (sign-in refresh, T14). */
export function userGroups(
  token: string,
  userKey: string,
  pageToken?: string,
): Promise<GroupsPage> {
  const q = new URLSearchParams({ userKey, maxResults: String(GROUPS_PAGE) });
  if (pageToken) q.set("pageToken", pageToken);
  return groupsPage(token, q);
}

/** One Reports event: its name, time (ms) and string parameters. */
export type Activity = {
  name: string;
  at: number;
  params: Record<string, string>;
};

export const ACTIVITIES_PAGE = 1000;

/**
 * One Reports activities page for `app` since `startTime` (ms), scoped to
 * the customer. Parameter names are kept as Google sends them (USER_EMAIL,
 * GROUP_EMAIL for admin; user_email, group_email for groups).
 */
export async function activities(
  token: string,
  customerId: string,
  app: "admin" | "groups",
  startTime: number,
  pageToken?: string,
): Promise<{ events: Activity[]; nextPageToken: string | null }> {
  const q = new URLSearchParams({
    customerId,
    startTime: new Date(startTime).toISOString(),
    maxResults: String(ACTIVITIES_PAGE),
  });
  if (pageToken) q.set("pageToken", pageToken);
  const out = (await get(
    token,
    `${REPORTS_API}/activity/users/all/applications/${app}?${q}`,
  )) as { items?: unknown; nextPageToken?: unknown } | null;
  const events: Activity[] = [];
  for (const it of Array.isArray(out?.items) ? out.items : []) {
    const item = it as { id?: { time?: unknown }; events?: unknown } | null;
    const at = Date.parse(str(item?.id?.time) ?? "");
    if (!Number.isFinite(at)) continue;
    for (const e of Array.isArray(item?.events) ? item.events : []) {
      const ev = e as { name?: unknown; parameters?: unknown } | null;
      const name = str(ev?.name);
      if (!name) continue;
      const params: Record<string, string> = {};
      for (const p of Array.isArray(ev?.parameters) ? ev.parameters : []) {
        const x = p as { name?: unknown; value?: unknown } | null;
        const k = str(x?.name);
        const v = str(x?.value);
        if (k && v !== null) params[k] = v;
      }
      events.push({ name, at, params });
    }
  }
  return { events, nextPageToken: str(out?.nextPageToken) };
}

/**
 * groups.hasMember(groupKey, memberKey): true when the user is a member,
 * directly or through nested groups (sign-in confirms a removal with it).
 */
export async function hasMember(
  token: string,
  groupKey: string,
  memberKey: string,
): Promise<boolean> {
  const out = (await get(
    token,
    `${ADMIN_API}/groups/${encodeURIComponent(groupKey)}/hasMember/${encodeURIComponent(memberKey)}`,
  )) as { isMember?: unknown } | null;
  return out?.isMember === true;
}
