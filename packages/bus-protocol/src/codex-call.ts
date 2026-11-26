/**
 * #3108: the arguments of a Codex tool call, in one canonical form, so the
 * server (which gets them parsed, from Codex's request) and the daemon (which
 * reads them as JSON text, from the rollout) hash the same bytes. Object keys
 * are sorted; arrays keep their order; numbers and strings are written as
 * JSON.stringify writes them. Undefined when the value is not plain JSON
 * (a function, a cycle, a non-finite number, or deeper than 64 levels).
 */
export function canonicalArgs(value: unknown): string | undefined {
  const seen = new Set<object>();
  const walk = (v: unknown, depth: number): string | undefined => {
    if (depth > 64) return undefined;
    if (v === null || typeof v === "boolean" || typeof v === "string")
      return JSON.stringify(v);
    if (typeof v === "number")
      return Number.isFinite(v) ? JSON.stringify(v) : undefined;
    if (typeof v !== "object") return undefined;
    if (seen.has(v)) return undefined;
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        const parts: string[] = [];
        for (const x of v) {
          const p = walk(x, depth + 1);
          if (p === undefined) return undefined;
          parts.push(p);
        }
        return `[${parts.join(",")}]`;
      }
      const parts: string[] = [];
      for (const k of Object.keys(v).sort()) {
        const p = walk((v as Record<string, unknown>)[k], depth + 1);
        if (p === undefined) return undefined;
        parts.push(`${JSON.stringify(k)}:${p}`);
      }
      return `{${parts.join(",")}}`;
    } finally {
      seen.delete(v);
    }
  };
  return walk(value, 0);
}

/** The sha256 hex of canonicalArgs(value); undefined when it has none. Web Crypto, so it runs in Workers and Node alike. */
export async function canonicalArgsSha256(
  value: unknown,
): Promise<string | undefined> {
  const text = canonicalArgs(value);
  if (text === undefined) return undefined;
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
