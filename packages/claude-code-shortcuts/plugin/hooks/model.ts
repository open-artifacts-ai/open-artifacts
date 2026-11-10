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

const failed = (value: Record<string, unknown>) =>
  value.isError === true || typeof value.deny === "string";

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    if (value.length > 2_000_000) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return record(value) ? value : null;
}

/**
 * One Claude tool.call result, then one MCP envelope. Once a payload is
 * reached it is terminal: never follow its result/text/structuredContent or
 * artifact content. server.ok supplies structuredContent plus a human summary;
 * MCP clients may instead serialize the payload in content[].text. Claude also
 * exposes a structured payload directly as result (a JSON string on the tested
 * clients). Conflicting representations fail closed rather than picking one.
 */
function payloads(result: unknown): Record<string, unknown>[] {
  if (!record(result) || failed(result)) return [];
  let envelope = result;
  if ("result" in result) {
    if ("structuredContent" in result || "content" in result) return [];
    const body = object(result.result);
    if (!body || failed(body)) return [];
    if ("artifact" in body || "id" in body || "version" in body) return [body];
    envelope = body;
  }
  const out: Record<string, unknown>[] = [];
  if ("structuredContent" in envelope) {
    if (
      !record(envelope.structuredContent) ||
      failed(envelope.structuredContent)
    )
      return [];
    out.push(envelope.structuredContent);
  }
  if ("content" in envelope) {
    if (!Array.isArray(envelope.content) || envelope.content.length > 16)
      return [];
    for (const block of envelope.content) {
      if (
        !record(block) ||
        block.type !== "text" ||
        typeof block.text !== "string"
      )
        continue;
      const data = object(block.text);
      // The normal text is a human-readable summary, not receipt metadata.
      if (!data) continue;
      if (failed(data)) return [];
      out.push(data);
    }
  }
  return out;
}

function consistent<T>(
  result: unknown,
  parse: (data: Record<string, unknown>) => T | null,
): T | null {
  let receipt: T | null = null;
  for (const data of payloads(result)) {
    const value = parse(data);
    if (
      !value ||
      (receipt && JSON.stringify(receipt) !== JSON.stringify(value))
    )
      return null;
    receipt = value;
  }
  return receipt;
}

export function published(result: unknown, origin: string) {
  return consistent(result, (data) => {
    const url = viewerUrl(data.url, data.id, origin);
    return url && version(data.version)
      ? { id: data.id as string, url, version: data.version }
      : null;
  });
}

export function checked(result: unknown) {
  return consistent(result, (data) => {
    const a = data.artifact;
    return record(a) &&
      typeof a.id === "string" &&
      ID.test(a.id) &&
      version(a.currentVersion) &&
      record(data.version) &&
      version(data.version.version) &&
      (data.content === undefined || typeof data.content === "string") &&
      (data.downloadUrl === undefined || typeof data.downloadUrl === "string")
      ? { id: a.id, version: a.currentVersion }
      : null;
  });
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
