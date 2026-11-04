// The canary smoke (#1343): once the canary has settled on a release, a short
// active check against it, as a dedicated smoke member (smoke, its PAT in
// the scheduler secret FLEET_SMOKE_TOKEN), replaces the passive soak. A pass
// lets leo and then the fleet move; a failure halts the version (fleet.ts).
//
// What it does, in order, every call over the canary's public route with
// smoke's PAT and a short timeout:
// - health: /healthz says ok, this install, the release under test, no test
//   hooks.
// - sign-in: /api/v1/me is smoke, active, a plain member; /auth/providers
//   answers; when Google is offered, /auth/login/google starts at this env's
//   broker for this install. Not covered: finishing an OAuth round trip, a
//   session cookie, and email codes (a code would send mail: never asked).
// - sweep: deletes smoke's own artifacts titled SMOKE_TITLE_PREFIX, left by
//   an earlier run. smoke lists only what it may see as "mine".
// - publish a private markdown artifact, read its file back exactly.
// - share it with the share target (FLEET_SMOKE_SHARE_TO, an existing member;
//   on prod the owner's own canary account), read the share back. The server
//   mails no existing member, so `emailed` must be false. The target must be
//   in smoke's domain, checked before any share: a wrong address could
//   otherwise mail an outsider. Unset, the share is skipped with a note. The
//   unshare is in the finally, before the delete.
// - MCP: tools/list names publish_artifact and get_artifact; tools/call
//   get_artifact returns the smoke artifact's title.
// - bus: skipped until the hub is bound, with a note in the result.
// - finally, whatever happened: unshare, then delete the artifact.
//
// Never logged or stored: the PAT, any response body, the target's address.
// Results name a check and a kind only.
import { within } from "./env.js";

/** Every smoke artifact's title starts with this; the sweep deletes only these. */
export const SMOKE_TITLE_PREFIX = "fleet-smoke-";
/** One call's timeout. */
export const SMOKE_CALL_MS = 3_000;
/** The whole smoke's budget, cleanup aside. */
export const SMOKE_BUDGET_MS = 10_000;
/** The bus check's note while the hub is unbound. */
export const SMOKE_BUS_SKIPPED = "bus: skipped, hub not bound";
/** The share check's note with no share target set. */
export const SMOKE_SHARE_SKIPPED = "share: skipped, no FLEET_SMOKE_SHARE_TO";

export type SmokeCheck =
  /** config: no FLEET_SMOKE_TOKEN. */
  | "token"
  /** config: /me refused the token (revoked, or a PAT auth regression). */
  | "token_rejected"
  /** config: smoke isn't an active plain member. */
  | "smoke_a"
  | "health"
  | "signin"
  | "sweep"
  | "publish"
  | "read"
  | "share"
  | "mcp"
  | "delete";

/**
 * - pass: every check passed.
 * - assert: the canary answered wrongly: halts the version at once.
 * - transport: a timeout, a network error, a 5xx or a 429: counts once.
 * - config: the smoke can't run as set up (no token, a token /me refuses,
 *   smoke not a plain member, a bad share target): never a halt, never a pass.
 * - budget: the scheduler ran out of time: neither; the next tick reruns.
 */
export type SmokeResult =
  | { ok: true; notes: string[] }
  | {
      ok: false;
      kind: "assert" | "transport" | "config" | "budget";
      check: SmokeCheck;
    };

export type SmokeFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface SmokeInput {
  fetch: SmokeFetch;
  installId: string;
  appHost: string;
  /** smoke's PAT (FLEET_SMOKE_TOKEN). */
  token: string | undefined;
  /** The share target's address (FLEET_SMOKE_SHARE_TO); empty skips the share. */
  shareTo: string | undefined;
  /** This env's auth broker origin (AUTH_BROKER_ORIGIN). */
  brokerOrigin: string | undefined;
  /** The release under test, X.Y.Z, for the title. */
  version: string;
  /** Wall clock (ms); tests pin it. */
  clock?: () => number;
  callMs?: number;
  budgetMs?: number;
  /** A random suffix; tests pin it. */
  nonce?: () => string;
}

class Fail extends Error {
  constructor(
    readonly kind: "assert" | "transport" | "config" | "budget",
    readonly check: SmokeCheck,
  ) {
    super(`${kind}:${check}`);
  }
}

const SHARE_TO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const randomNonce = () => {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
};

/** One smoke run against the canary. Never throws. */
export async function smoke(o: SmokeInput): Promise<SmokeResult> {
  const clock = o.clock ?? Date.now;
  const callMs = o.callMs ?? SMOKE_CALL_MS;
  const deadline = clock() + (o.budgetMs ?? SMOKE_BUDGET_MS);
  const token = o.token?.trim() ?? "";
  const shareTo = o.shareTo?.trim().toLowerCase() ?? "";
  if (token === "") return { ok: false, kind: "config", check: "token" };
  if (shareTo !== "" && !SHARE_TO.test(shareTo))
    return { ok: false, kind: "config", check: "share" };
  const origin = `https://${o.appHost}`;
  let broker: string | null = null;
  try {
    broker = o.brokerOrigin ? new URL(o.brokerOrigin).origin : null;
  } catch {}

  /** One call; transport failures and the budget throw Fail. */
  const call = async (
    check: SmokeCheck,
    path: string,
    init: RequestInit = {},
    o2: { auth?: boolean; noBudget?: boolean } = {},
  ): Promise<Response> => {
    if (!o2.noBudget && clock() + callMs > deadline)
      throw new Fail("budget", check);
    const headers = new Headers(init.headers);
    if (o2.auth !== false) headers.set("authorization", `Bearer ${token}`);
    let res: Response;
    try {
      res = await within(
        o.fetch(`${origin}${path}`, {
          ...init,
          headers,
          redirect: "manual",
        }),
        callMs,
      );
    } catch {
      // A Stall (timeout) or a network error.
      throw new Fail("transport", check);
    }
    if (res.status >= 500 || res.status === 429) {
      await res.body?.cancel();
      throw new Fail("transport", check);
    }
    return res;
  };
  const json = async (check: SmokeCheck, res: Response): Promise<unknown> => {
    try {
      return await res.json();
    } catch {
      throw new Fail("assert", check);
    }
  };
  const expect = (check: SmokeCheck, ok: boolean) => {
    if (!ok) throw new Fail("assert", check);
  };
  const drop = async (res: Response) => {
    await res.body?.cancel().catch(() => undefined);
  };

  let artifactId: string | null = null;
  let shared = false;
  const notes: string[] = [];
  let result: SmokeResult = { ok: true, notes };
  try {
    // The canary runs the release: /healthz, public, as the fleet probes it.
    const hz = await call("health", "/healthz", {}, { auth: false });
    expect("health", hz.status === 200);
    const h = (await json("health", hz)) as Record<string, unknown> | null;
    expect(
      "health",
      h?.ok === true &&
        h.installId === o.installId &&
        h.version === o.version &&
        h.testHooks === undefined,
    );

    // sign-in
    const me = await call("signin", "/api/v1/me");
    if (me.status === 401 || me.status === 403) {
      await drop(me);
      // A revoked token, or PAT auth broken by this release: never a pass.
      throw new Fail("config", "token_rejected");
    }
    expect("signin", me.status === 200);
    const user = (
      (await json("signin", me)) as { user?: Record<string, unknown> }
    )?.user;
    expect(
      "signin",
      typeof user?.id === "string" && typeof user.email === "string",
    );
    if (user?.status !== undefined && user.status !== "active")
      throw new Fail("config", "smoke_a");
    // Least privilege: a plain member, never an admin or owner.
    if (user?.role !== "member") throw new Fail("config", "smoke_a");
    const mine = String(user.email).toLowerCase();
    if (shareTo !== "") {
      if (mine === shareTo) throw new Fail("config", "share");
      // No mail to an outsider: the target must share smoke's domain,
      // checked before any share is made (the server mails a non-member).
      if (
        mine.slice(mine.lastIndexOf("@")) !==
        shareTo.slice(shareTo.lastIndexOf("@"))
      )
        throw new Fail("config", "share");
    }
    const prov = await call("signin", "/auth/providers", {}, { auth: false });
    expect("signin", prov.status === 200);
    const providers = (
      (await json("signin", prov)) as { providers?: { id?: unknown }[] }
    )?.providers;
    expect("signin", Array.isArray(providers) && providers.length > 0);
    if (providers?.some((p) => p?.id === "google")) {
      const g = await call("signin", "/auth/login/google", {}, { auth: false });
      await drop(g);
      expect("signin", g.status === 302);
      const loc = g.headers.get("location") ?? "";
      let url: URL | null = null;
      try {
        url = new URL(loc);
      } catch {}
      expect(
        "signin",
        url !== null &&
          broker !== null &&
          url.origin === broker &&
          url.pathname === "/google/authorize" &&
          url.searchParams.get("install") === o.installId,
      );
    }

    // sweep: smoke's own leftovers only.
    const list = await call("sweep", "/api/v1/artifacts?scope=mine&limit=100");
    expect("sweep", list.status === 200);
    const items = ((await json("sweep", list)) as { items?: unknown[] })?.items;
    expect("sweep", Array.isArray(items));
    for (const it of items as {
      id?: unknown;
      title?: unknown;
      owner?: { id?: unknown };
    }[]) {
      if (
        typeof it?.id !== "string" ||
        typeof it.title !== "string" ||
        !it.title.startsWith(SMOKE_TITLE_PREFIX) ||
        it.owner?.id !== user.id
      )
        continue;
      const d = await call(
        "sweep",
        `/api/v1/artifacts/${encodeURIComponent(it.id)}`,
        { method: "DELETE" },
      );
      await drop(d);
      expect("sweep", d.status === 204 || d.status === 200 || d.status === 404);
    }

    // publish
    const nonce = (o.nonce ?? randomNonce)();
    const title = `${SMOKE_TITLE_PREFIX}${o.version.replaceAll(".", "_")}-${nonce}`;
    const content = `# ${title}\n\nfleet smoke ${nonce}\n`;
    const pub = await call("publish", "/api/v1/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title,
        format: "markdown",
        content,
        visibility: "private",
      }),
    });
    expect("publish", pub.status === 201);
    const made = (await json("publish", pub)) as {
      id?: unknown;
      version?: unknown;
    };
    expect("publish", typeof made?.id === "string" && made.id !== "");
    artifactId = made.id as string;
    const art = `/api/v1/artifacts/${encodeURIComponent(artifactId)}`;

    // read
    const vs = await call("read", `${art}/versions`);
    expect("read", vs.status === 200);
    const vj = (await json("read", vs)) as
      | { items?: { version?: unknown; entry?: unknown }[] }
      | { version?: unknown; entry?: unknown }[];
    const v0 = (Array.isArray(vj) ? vj : vj?.items)?.[0];
    expect(
      "read",
      typeof v0?.version === "number" && typeof v0.entry === "string",
    );
    const file = await call(
      "read",
      `${art}/versions/${v0?.version}/files/${String(v0?.entry)
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
    );
    expect("read", file.status === 200);
    expect("read", (await file.text()) === content);

    // share, with no email: the target is a member, so the server sends
    // none. The unshare is in the finally.
    if (shareTo === "") notes.push(SMOKE_SHARE_SKIPPED);
    else {
      const put = await call("share", `${art}/shares`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: shareTo, role: "viewer" }),
      });
      expect("share", put.status === 200 || put.status === 201);
      shared = true;
      const sj = (await json("share", put)) as { emailed?: unknown };
      expect("share", sj?.emailed === false);
      const ls = await call("share", `${art}/shares`);
      expect("share", ls.status === 200);
      const lj = (await json("share", ls)) as
        | { email?: unknown }[]
        | { items?: { email?: unknown }[]; shares?: { email?: unknown }[] };
      const rows = Array.isArray(lj) ? lj : (lj?.items ?? lj?.shares ?? []);
      expect(
        "share",
        rows.some((r) => String(r?.email ?? "").toLowerCase() === shareTo),
      );
    }

    // MCP
    const rpc = async (method: string, params: unknown) => {
      const r = await call("mcp", "/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      expect("mcp", r.status === 200);
      const text = await r.text();
      let msg: unknown;
      try {
        msg = JSON.parse(text);
      } catch {
        for (const line of text.split(/\r?\n/))
          if (line.startsWith("data:"))
            try {
              msg = JSON.parse(line.slice(5).trim());
            } catch {}
      }
      const m = msg as { result?: unknown; error?: unknown } | undefined;
      expect("mcp", m?.result !== undefined && m.error === undefined);
      return m?.result as Record<string, unknown>;
    };
    const tools = (await rpc("tools/list", {}))?.tools as
      | { name?: unknown }[]
      | undefined;
    const names = new Set((tools ?? []).map((t) => t?.name));
    expect("mcp", names.has("publish_artifact") && names.has("get_artifact"));
    const got = await rpc("tools/call", {
      name: "get_artifact",
      arguments: { id: artifactId },
    });
    expect(
      "mcp",
      got?.isError !== true &&
        (
          got?.structuredContent as
            | { artifact?: { id?: unknown; title?: unknown } }
            | undefined
        )?.artifact?.title === title &&
        (got?.structuredContent as { artifact?: { id?: unknown } })?.artifact
          ?.id === artifactId,
    );

    // bus: not until the hub is bound.
    notes.push(SMOKE_BUS_SKIPPED);
  } catch (e) {
    result =
      e instanceof Fail
        ? { ok: false, kind: e.kind, check: e.check }
        : // Not the canary's answer: an error of ours counts once, never a halt.
          { ok: false, kind: "transport", check: "signin" };
  } finally {
    // Cleanup runs whatever happened, past the budget too. A failed cleanup
    // fails a passing run (delete); the next run's sweep catches it.
    try {
      if (artifactId !== null) {
        const art = `/api/v1/artifacts/${encodeURIComponent(artifactId)}`;
        // Unshare first, so the target never keeps a share of a deleted
        // artifact; a failed unshare fails a passing run (share).
        if (shared) {
          try {
            const un = await call(
              "share",
              `${art}/shares/${encodeURIComponent(shareTo)}`,
              { method: "DELETE" },
              { noBudget: true },
            );
            await drop(un);
            if (result.ok && !(un.status === 204 || un.status === 200))
              result = { ok: false, kind: "assert", check: "share" };
          } catch (e) {
            if (result.ok)
              result = {
                ok: false,
                kind: e instanceof Fail ? e.kind : "transport",
                check: "share",
              };
          }
        }
        const d = await call(
          "delete",
          art,
          { method: "DELETE" },
          {
            noBudget: true,
          },
        );
        await drop(d);
        if (result.ok && !(d.status === 204 || d.status === 200))
          result = { ok: false, kind: "assert", check: "delete" };
      }
    } catch (e) {
      if (result.ok)
        result = {
          ok: false,
          kind: e instanceof Fail ? e.kind : "transport",
          check: "delete",
        };
    }
  }
  return result;
}
