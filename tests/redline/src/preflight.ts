import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  adminCreds,
  type Cred,
  HttpError,
  hook,
  readBody,
  withCred,
} from "./http.ts";
import { CAPTURE_FLOWS, googleUrlOf, startGoogle } from "./signin.ts";
import {
  loadTargets,
  secretFileName,
  secretsOf,
  type Target,
  type Targets,
} from "./targets.ts";

// The capture's preflight (scripts/signin-capture.ts, before the first
// prompt). Read-only checks of everything that would leave a case unproven or
// failing for setup reasons; each gap is named. Green means only the Google
// sign-ins are left to the human. Secret files are checked by existence and
// mode only here; values are never printed.

/** "unchecked": not verifiable yet, explicitly allowed (never green by itself). */
export type CheckStatus = "ok" | "gap" | "ci-only" | "unchecked";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** The release the suite was written against: the repo's release-please version. */
export function suiteVersion(): string {
  const f = join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    ".release-please-manifest.json",
  );
  const v = (JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>)[
    "."
  ];
  if (typeof v !== "string") throw new Error("no release version in the repo");
  return v;
}

/** -1, 0 or 1; null when either isn't x.y.z. */
export function compareVersions(a: string, b: string): number | null {
  const p = (s: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(s);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const x = p(a);
  const y = p(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++)
    if ((x[i] as number) !== (y[i] as number))
      return (x[i] as number) < (y[i] as number) ? -1 : 1;
  return 0;
}

/** A secret file's existence and mode only (lstat; never read). */
export function fileGap(path: string | undefined, what: string): string | null {
  if (!path) return `${what}: no file configured`;
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return `${what}: ${path} is missing`;
  }
  if (!st.isFile()) return `${what}: ${path} is not a regular file`;
  if ((st.mode & 0o077) !== 0)
    return `${what}: ${path} must be mode 0600 (chmod 600 ${path})`;
  if (st.size === 0) return `${what}: ${path} is empty`;
  return null;
}

/** The red-line tenants' letters (docs/ops/redline-signin.md): rl-a is A, rl-b is C. */
const TENANT = { a: "A", b: "C" } as const;

const CREDS_CMD = (installId: string) =>
  `pnpm oa:hosted redline-creds --install ${installId} --confirm ${installId}`;

interface RawTarget {
  name?: unknown;
  installId?: unknown;
  patFile?: unknown;
  turnstileFile?: unknown;
}

/**
 * File checks from REDLINE_TARGETS itself, before anything is loaded (a
 * missing explicit file would stop loadTargets at the first one).
 */
export function fileChecks(env: Record<string, string | undefined>): Check[] {
  const out: Check[] = [];
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(env.REDLINE_TARGETS ?? "");
  } catch {
    return [
      {
        name: "targets",
        status: "gap",
        detail: "REDLINE_TARGETS is not set or not JSON",
      },
    ];
  }
  const mode = raw.mode ?? "staging";
  const dir =
    typeof raw.secretsDir === "string" && raw.secretsDir !== ""
      ? raw.secretsDir
      : undefined;
  for (const k of ["a", "b"] as const) {
    const t = (raw[k] ?? {}) as RawTarget;
    const name = typeof t.name === "string" ? t.name : k;
    const id = typeof t.installId === "string" ? t.installId : "<install id>";
    if (mode === "staging") {
      const pat =
        typeof t.patFile === "string" && t.patFile !== ""
          ? t.patFile
          : dir
            ? join(dir, secretFileName(name, "PAT"))
            : undefined;
      const g = fileGap(pat, `${name} admin PAT`);
      out.push(
        g
          ? {
              name: `${name} PAT file`,
              status: "gap",
              detail: `${g}; run \`${CREDS_CMD(id)}\` (writes the 0600 copy)`,
            }
          : { name: `${name} PAT file`, status: "ok", detail: "0600" },
      );
      const ts = typeof t.turnstileFile === "string" ? t.turnstileFile : "";
      const tg = fileGap(ts || undefined, `${name} Turnstile token`);
      out.push(
        tg
          ? {
              name: `${name} Turnstile token`,
              status: "gap",
              detail: `${tg}; set turnstileFile on ${name} in REDLINE_TARGETS to a 0600 file the installs' Turnstile secret accepts`,
            }
          : { name: `${name} Turnstile token`, status: "ok", detail: "0600" },
      );
    }
  }
  if (mode === "staging") {
    out.push(
      typeof raw.strayHost === "string" && raw.strayHost !== ""
        ? { name: "strayHost", status: "ok", detail: raw.strayHost }
        : {
            name: "strayHost",
            status: "gap",
            detail:
              "strayHost is not set in REDLINE_TARGETS (the kit's targets.json)",
          },
    );
    const inv = raw.inventory as { url?: unknown; keyFile?: unknown } | null;
    const url =
      (inv && typeof inv.url === "string" && inv.url) ||
      env.REDLINE_STG_INVENTORY_URL;
    const keyFile =
      inv && typeof inv.keyFile === "string"
        ? inv.keyFile
        : dir
          ? join(dir, "REDLINE_STG_INVENTORY_KEY")
          : undefined;
    const kg = url ? fileGap(keyFile, "inventory key") : "no inventory URL";
    // The key is a GitHub secret only: a laptop run can't prove the
    // inventory cases. Not a refusal; those cases report unproven.
    out.push(
      kg
        ? {
            name: "inventory",
            status: "ci-only",
            detail: `CI-only (not-local): ${kg}; the inventory cases report unproven in this run and never count as a pass`,
          }
        : { name: "inventory", status: "ok", detail: "URL and 0600 key" },
    );
  }
  return out;
}

async function getJson(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { redirect: "manual", ...init });
  const text = await readBody(res);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

/** GET /auth/providers: Google on, and its verified domains. */
async function googleOf(t: Target) {
  const { status, body } = await getJson(`${t.app}/auth/providers`);
  if (status !== 200) return { status, google: null };
  const g = (
    body as { providers?: { id?: unknown; domains?: unknown }[] }
  )?.providers?.find((p) => p?.id === "google");
  return {
    status,
    google: g
      ? {
          domains: Array.isArray(g.domains)
            ? (g.domains as unknown[]).filter(
                (d): d is string => typeof d === "string",
              )
            : [],
        }
      : null,
  };
}

/** The admin PAT: the configured one; on the local pair, minted via hooks. */
async function adminPat(T: Targets, t: Target): Promise<Cred | null> {
  const pat = secretsOf(t).pat;
  if (pat) return { kind: "pat", token: pat };
  if (T.mode === "local") return (await adminCreds(t)).pat;
  return null;
}

export const BROKER_PROBE_HOOK = "/__test/broker-probe";
export const UNCHECKED_BROKER =
  "broker reachability from the install: unchecked (hook not deployed)";

/**
 * The install's own server-side path to its broker: POST /__test/broker-probe
 * makes the install send a signed redeem with a junk code to its broker and
 * answer {status} (the hook comes with the next server PR). Green only on
 * the broker's own refusal, 401. Any other status, a timeout or an error is
 * "<install>: install can't reach the auth broker (status N)". A 404 from the
 * hook route means the hook isn't deployed: a gap, unless `allowUnchecked`.
 */
export async function brokerProbeCheck(
  t: Target,
  o: { allowUnchecked?: boolean; call?: typeof hook; timeoutMs?: number } = {},
): Promise<Check> {
  const name = `${t.name} broker from the install`;
  const cant = (s: string): Check => ({
    name,
    status: "gap",
    detail: `${t.name}: install can't reach the auth broker (status ${s})`,
  });
  let out: unknown;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    out = await Promise.race([
      (o.call ?? hook)(t, BROKER_PROBE_HOOK, {}),
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error("broker probe timeout")),
          o.timeoutMs ?? 30_000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  } catch (e) {
    if (e instanceof HttpError && e.status === 404)
      return o.allowUnchecked
        ? {
            name,
            status: "unchecked",
            detail: `${UNCHECKED_BROKER}; allowed by REDLINE_ALLOW_UNCHECKED_BROKER=1`,
          }
        : {
            name,
            status: "gap",
            detail: `${UNCHECKED_BROKER}; upgrade the installs to a release with the broker-probe hook first`,
          };
    if (e instanceof HttpError) return cant(`hook ${e.status}`);
    return cant(
      e instanceof Error && /abort|timeout/i.test(`${e.name} ${e.message}`)
        ? "timeout"
        : "error",
    );
  }
  const st = (out as { status?: unknown } | null)?.status;
  if (st === 401)
    return {
      name,
      status: "ok",
      detail: "the broker refused a junk redeem (401): reachable",
    };
  return cant(
    typeof st === "number" ||
      (typeof st === "string" && /^[a-z0-9_]{1,20}$/i.test(st))
      ? String(st)
      : "unknown",
  );
}

export interface PreflightOpts {
  /** Accept an undeployed broker-probe hook (REDLINE_ALLOW_UNCHECKED_BROKER=1). */
  allowUncheckedBroker?: boolean;
  /** The hook caller (tests). */
  call?: typeof hook;
  /** The suite's release (default the repo's). */
  expectVersion?: string;
  /** The IdP's authorize origin (the rehearsal's fake IdP). */
  idp?: string;
  map?: (u: URL) => URL;
}

/** Every network check (read-only), on loaded targets. */
export async function networkChecks(
  T: Targets,
  o: PreflightOpts = {},
): Promise<Check[]> {
  const out: Check[] = [];
  const want = o.expectVersion ?? suiteVersion();
  const versions: Record<string, string> = {};
  for (const t of [T.a, T.b]) {
    const h = await getJson(`${t.app}/healthz`).catch(() => null);
    const v = (h?.body as { version?: unknown } | undefined)?.version;
    if (typeof v === "string") versions[t.name] = v;
    const cmp = typeof v === "string" ? compareVersions(v, want) : null;
    out.push(
      typeof v !== "string"
        ? {
            name: `${t.name} version`,
            status: "gap",
            detail: "/healthz has no version",
          }
        : cmp === null || cmp < 0
          ? {
              name: `${t.name} version`,
              status: "gap",
              detail: `${v} is older than the suite's ${want}: upgrade ${t.name} first`,
            }
          : { name: `${t.name} version`, status: "ok", detail: v },
    );
  }
  const [va, vb] = [versions[T.a.name], versions[T.b.name]];
  if (va && vb && va !== vb)
    out.push({
      name: "same version",
      status: "gap",
      detail: `${T.a.name} runs ${va}, ${T.b.name} runs ${vb}: upgrade both to the same release`,
    });

  // Google on, TEST_DOMAIN outside AUTH_DOMAINS, each user's tenant verified.
  const tenantOf = { a: "", b: "" };
  for (const s of Object.values(CAPTURE_FLOWS))
    if (!("foreign" in s && s.foreign))
      tenantOf[s.at] ||= s.user.split("@")[1] ?? "";
  for (const k of ["a", "b"] as const) {
    const t = T[k];
    const g = await googleOf(t).catch(() => ({ status: 0, google: null }));
    if (!g.google) {
      out.push({
        name: `${t.name} Google sign-in`,
        status: "gap",
        detail:
          g.status === 200
            ? "Google sign-in is off (not in /auth/providers)"
            : `/auth/providers answered ${g.status || "nothing"}`,
      });
      continue;
    }
    out.push({ name: `${t.name} Google sign-in`, status: "ok", detail: "on" });
    out.push(
      g.google.domains.includes(t.testDomain)
        ? {
            name: `${t.name} TEST_DOMAIN`,
            status: "gap",
            detail: `TEST_DOMAIN ${t.testDomain} is in AUTH_DOMAINS: in-domain addresses never get codes on a google+email install, so the code cases fail; use a TEST_DOMAIN outside AUTH_DOMAINS`,
          }
        : {
            name: `${t.name} TEST_DOMAIN`,
            status: "ok",
            detail: `${t.testDomain} outside AUTH_DOMAINS`,
          },
    );
    if (!g.google.domains.includes(tenantOf[k]))
      out.push({
        name: `${t.name} AUTH_DOMAINS`,
        status: "gap",
        detail: `AUTH_DOMAINS lacks ${tenantOf[k]}: its own users can't sign in with Google`,
      });
  }

  // Each signing-in user is invited or a member (admin PAT, GET only).
  const users = { a: new Set<string>(), b: new Set<string>() };
  for (const s of Object.values(CAPTURE_FLOWS))
    if (!("foreign" in s && s.foreign)) users[s.at].add(s.user);
  for (const k of ["a", "b"] as const) {
    const t = T[k];
    let pat: Cred | null = null;
    try {
      pat = await adminPat(T, t);
    } catch {
      pat = null;
    }
    if (!pat) {
      out.push({
        name: `${t.name} members`,
        status: "gap",
        detail: `no admin PAT to read members: run \`${CREDS_CMD(t.installId)}\``,
      });
      continue;
    }
    const m = await getJson(`${t.app}/api/v1/members`, withCred(pat)).catch(
      () => ({ status: 0, body: undefined }),
    );
    if (m.status !== 200 || !Array.isArray(m.body)) {
      out.push({
        name: `${t.name} members`,
        status: "gap",
        detail: `GET /api/v1/members with the admin PAT answered ${m.status || "nothing"}`,
      });
      continue;
    }
    const emails = new Set(
      (m.body as { email?: unknown }[]).map((x) =>
        String(x?.email ?? "").toLowerCase(),
      ),
    );
    for (const u of users[k]) {
      // The role, not the address: "alice (tenant A user)".
      const who = `${u.split("@")[0]} (tenant ${TENANT[k]} user)`;
      out.push(
        emails.has(u)
          ? {
              name: `${t.name} ${who}`,
              status: "ok",
              detail: "invited or member",
            }
          : {
              name: `${t.name} ${who}`,
              status: "gap",
              detail: `${t.name}: ${who} not invited: invite them (Members) first`,
            },
      );
    }
  }

  // The broker: each install's start reaches the IdP through it.
  for (const t of [T.a, T.b]) {
    try {
      const s = await startGoogle(t);
      if (!s) continue; // already a gap above
      const viaBroker = s.location.pathname === "/google/authorize";
      await googleUrlOf(s, {
        ...(o.idp ? { idp: o.idp } : {}),
        ...(o.map ? { map: o.map } : {}),
      });
      out.push({
        name: `${t.name} broker`,
        status: "ok",
        detail: viaBroker
          ? "reachable, redirects to the IdP"
          : "direct to the IdP",
      });
      // The browser reaches the broker; can the install's server reach it?
      if (viaBroker)
        out.push(
          await brokerProbeCheck(t, {
            ...(o.allowUncheckedBroker ? { allowUnchecked: true } : {}),
            ...(o.call ? { call: o.call } : {}),
          }),
        );
    } catch (e) {
      out.push({
        name: `${t.name} broker`,
        status: "gap",
        detail: `the sign-in start doesn't reach the IdP (${e instanceof Error ? e.message.slice(0, 120) : "error"})`,
      });
    }
  }
  return out;
}

/** The whole preflight: file checks, then (if the targets load) network checks. */
export async function preflight(
  env: Record<string, string | undefined> = process.env,
  o: PreflightOpts = {},
): Promise<{ checks: Check[]; targets: Targets | null }> {
  const checks = fileChecks(env);
  let T: Targets | null = null;
  try {
    T = await loadTargets(env);
  } catch (e) {
    checks.push({
      name: "targets",
      status: "gap",
      detail: `REDLINE_TARGETS doesn't load: ${e instanceof Error ? e.message : "error"}`,
    });
  }
  if (T)
    checks.push(
      ...(await networkChecks(T, {
        allowUncheckedBroker: env.REDLINE_ALLOW_UNCHECKED_BROKER === "1",
        ...o,
      })),
    );
  return { checks, targets: T };
}

export const gaps = (c: readonly Check[]) =>
  c.filter((x) => x.status === "gap");

export function formatPreflight(c: readonly Check[]): string {
  const tag = {
    ok: "ok  ",
    gap: "GAP ",
    "ci-only": "CI  ",
    unchecked: "SKIP",
  } as const;
  const lines = c.map((x) => `  ${tag[x.status]} ${x.name}: ${x.detail}`);
  const g = gaps(c).length;
  lines.push(
    g
      ? `Preflight refused: ${g} gap${g === 1 ? "" : "s"} above. Fix them, then run this again.`
      : "Preflight green: only the Google sign-ins are left to you.",
  );
  return `${lines.join("\n")}\n`;
}
