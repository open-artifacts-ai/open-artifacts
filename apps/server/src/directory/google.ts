// Google Admin SDK Directory API, read-only. P3 T12 adds what connect needs
// (users.get, domains.list, a users.list page); T13 extends it with the
// polling calls. Every call takes the access token from the resolved
// transport (broker or direct), and every listing is scoped to the binding's
// customer id. Errors carry the HTTP status only: never a URL, token or email.

export const ADMIN_API = "https://admin.googleapis.com/admin/directory/v1";

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

export class GoogleApiError extends Error {
  constructor(public status: number) {
    super(`google admin api: http ${status}`);
    this.name = "GoogleApiError";
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

/** One users.list page for the customer (active and suspended; not deleted). */
export async function listUsers(
  token: string,
  customerId: string,
  pageToken?: string,
): Promise<{ users: GoogleUser[]; nextPageToken: string | null }> {
  const q = new URLSearchParams({
    customer: customerId,
    maxResults: String(USERS_PAGE),
    fields: `nextPageToken,users(${USER_FIELDS})`,
  });
  if (pageToken) q.set("pageToken", pageToken);
  const out = (await get(token, `${ADMIN_API}/users?${q}`)) as {
    users?: unknown;
    nextPageToken?: unknown;
  } | null;
  const users = (Array.isArray(out?.users) ? out.users : []).flatMap((u) => {
    const g = userOf(u);
    return g ? [g] : [];
  });
  return { users, nextPageToken: str(out?.nextPageToken) };
}
