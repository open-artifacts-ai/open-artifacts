/** Local presentation data only: never artifact content, credentials or permissions. */
export type Shortcut = {
  id: string;
  url: string;
  title: string;
  publishedVersion: number;
  publishedAt: number;
  lastCheckedCurrentVersion: number | null;
  lastCheckedAt: number | null;
};

export const LIMIT = 10;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const version = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const time = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export function originOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    if (
      (u.protocol !== "https:" &&
        !(u.protocol === "http:" && u.hostname === "localhost")) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !["/", "/mcp"].includes(u.pathname)
    )
      return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function viewerUrl(
  value: unknown,
  id: unknown,
  origin: string,
): string | null {
  if (typeof value !== "string" || typeof id !== "string" || !ID.test(id))
    return null;
  try {
    const u = new URL(value);
    if (
      u.origin !== origin ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== `/a/${id}`
    )
      return null;
    return `${origin}/a/${id}`;
  } catch {
    return null;
  }
}

export function titleOf(value: unknown): string {
  return typeof value === "string"
    ? Array.from(
        value
          .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, " ")
          .replace(/\s+/g, " ")
          .trim(),
      )
        .slice(0, 160)
        .join("")
    : "";
}

/** Decode protocol wrappers, not arbitrary fields such as an artifact's content. */
function candidates(result: unknown): Record<string, unknown>[] {
  const queue: { value: unknown; depth: number }[] = [
    { value: result, depth: 0 },
  ];
  const out: Record<string, unknown>[] = [];
  for (let n = 0; n < queue.length && n < 32; n++) {
    const { value, depth } = queue[n];
    if (depth > 5) continue;
    const add = (v: unknown) => queue.push({ value: v, depth: depth + 1 });
    if (typeof value === "string" && value.length <= 2_000_000) {
      try {
        add(JSON.parse(value));
      } catch {
        /* Non-JSON tool text is not a receipt. */
      }
    } else if (record(value)) {
      if (value.isError === true || typeof value.deny === "string") return [];
      out.push(value);
      for (const key of ["result", "structuredContent", "text"])
        if (key in value) add(value[key]);
      if (Array.isArray(value.content))
        for (const block of value.content.slice(0, 16))
          if (record(block) && block.type === "text") add(block.text);
    }
  }
  return out;
}

export function published(result: unknown, origin: string) {
  for (const data of candidates(result)) {
    const url = viewerUrl(data.url, data.id, origin);
    if (url && version(data.version))
      return { id: data.id as string, url, version: data.version };
  }
  return null;
}

export function checked(result: unknown) {
  for (const data of candidates(result)) {
    const a = data.artifact;
    if (
      record(a) &&
      typeof a.id === "string" &&
      ID.test(a.id) &&
      version(a.currentVersion)
    )
      return { id: a.id, version: a.currentVersion };
  }
  return null;
}

export function restore(value: unknown, origin: string): Shortcut[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, Shortcut>();
  for (const a of value.slice(0, LIMIT)) {
    if (!record(a)) continue;
    const url = viewerUrl(a.url, a.id, origin);
    if (!url || !version(a.publishedVersion) || !time(a.publishedAt)) continue;
    const row: Shortcut = {
      id: a.id as string,
      url,
      title: titleOf(a.title) || `Artifact ${a.id}`,
      publishedVersion: a.publishedVersion,
      publishedAt: a.publishedAt,
      lastCheckedCurrentVersion:
        version(a.lastCheckedCurrentVersion) && time(a.lastCheckedAt)
          ? a.lastCheckedCurrentVersion
          : null,
      lastCheckedAt:
        version(a.lastCheckedCurrentVersion) && time(a.lastCheckedAt)
          ? a.lastCheckedAt
          : null,
    };
    const old = byId.get(row.id);
    if (!old || row.publishedVersion > old.publishedVersion)
      byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) => b.publishedAt - a.publishedAt);
}

export function applyPublish(
  rows: Shortcut[],
  receipt: NonNullable<ReturnType<typeof published>>,
  title: unknown,
  now: number,
): Shortcut[] {
  const old = rows.find((a) => a.id === receipt.id);
  // Concurrent completions must not replace a newer successful version with an older one.
  if (old && old.publishedVersion > receipt.version) return rows;
  return [
    {
      id: receipt.id,
      url: receipt.url,
      title: titleOf(title) || old?.title || `Artifact ${receipt.id}`,
      publishedVersion: receipt.version,
      publishedAt: now,
      lastCheckedCurrentVersion: old?.lastCheckedCurrentVersion ?? null,
      lastCheckedAt: old?.lastCheckedAt ?? null,
    },
    ...rows.filter((a) => a.id !== receipt.id),
  ].slice(0, LIMIT);
}
