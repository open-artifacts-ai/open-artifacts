// Self-contained (no imports) so scripts/setup can run it under node's type
// stripping and @oa/provision can import it from @oa/shared.
// Same pattern as ids.ts isId (kept in sync by packages/shared tests).
const ID_RE = /^[1-9A-HJ-NP-Za-km-z]{16}$/;
const isId = (s: string) => ID_RE.test(s);

export type Tunable = {
  /** Why a value is invalid; undefined when it is fine. The empty value (clear) is always allowed. */
  check: (value: string) => string | undefined;
};

const ORIGIN =
  /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?::(\d{1,5}))?$/i;
const portOk = (p?: string) =>
  p === undefined || (Number(p) >= 1 && Number(p) <= 65535);
const originOk = (o: string) => {
  const m = ORIGIN.exec(o);
  return Boolean(m) && portOk(m?.[2]);
};
const int =
  (min: number, max = Number.MAX_SAFE_INTEGER) =>
  (v: string) => {
    const n = /^[1-9]\d*$/.test(v) ? Number(v) : Number.NaN;
    if (!(n >= min && n <= max))
      return max === Number.MAX_SAFE_INTEGER
        ? `expected a positive integer`
        : `expected an integer from ${min} to ${max}`;
  };

/** The optional Worker vars setup keeps across deploys: one validator per name. */
export const TUNABLES: Record<string, Tunable> = {
  PUBLIC_HOME: {
    check: (v) => (v === "" || isId(v) ? undefined : "expected an artifact id"),
  },
  EMBED_ORIGINS: {
    check: (v) =>
      v === "" || v.split(",").every(originOk)
        ? undefined
        : "expected comma-separated https://host[:port] origins (port 1-65535; no paths, wildcards or spaces)",
  },
  EMBED_ALLOW_SAME_SITE: {
    check: (v) => (v === "1" ? undefined : 'expected "1" (or empty to clear)'),
  },
  ANON_WRITES_PER_MIN: { check: int(1, 600) },
  DATA_DOC_BYTES: { check: int(1) },
  DATA_DAILY_WRITES: { check: int(1) },
  // Hosted free-plan caps (self-serve billing): unset means off.
  FREE_STORAGE_BYTES: { check: int(1) },
  FREE_DATA_DOCS: { check: int(1) },
  FREE_DATA_DAILY_WRITES: { check: int(1) },
};

/** The canonical form of a valid value: EMBED_ORIGINS gets lowercase hosts, no :443, no duplicates. */
export function normalizeVar(name: string, value: string): string {
  if (name !== "EMBED_ORIGINS" || value === "") return value;
  const seen = new Set<string>();
  for (const o of value.split(",")) {
    const m = ORIGIN.exec(o);
    if (!m) return value;
    const port = m[2] === undefined ? "" : String(Number(m[2]));
    seen.add(
      `https://${(m[1] as string).toLowerCase()}${port && port !== "443" ? `:${port}` : ""}`,
    );
  }
  return [...seen].join(",");
}
