import { join } from "node:path";
import { homeOf, patTokenFile } from "../secret-file.ts";
import { type Ctx, NeedInput, type Step } from "../step.ts";
import { workerBindings } from "../worker.ts";
import { accessInUse } from "./access.ts";
import { tokenHash } from "./owner-token.ts";

const TITLE = "Welcome to Open Artifacts";
const WELCOME = "scripts/setup/welcome.md";
/** Backoff in seconds between attempts: ~60s in all, for DNS/cert/deploy propagation. */
const DELAYS = [1, 2, 4, 8, 15, 15, 15];
/** A host that doesn't resolve is retried this long (a fresh record can take minutes). */
const DNS_WAIT_MS = 5 * 60_000;
/** After this long without resolving, ask public DNS whether the record is live. */
const DNS_PROBE_MS = 60_000;
const DOH_TIMEOUT_MS = 5000;
const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);

/** undici hides the reason (ENOTFOUND, ECONNREFUSED, ...) in `cause.code`. */
const causeCode = (e: unknown): string | undefined => {
  const c = (e as { cause?: { code?: unknown } })?.cause?.code;
  return typeof c === "string" ? c : undefined;
};

/** Is `host` one of this install's own hostnames (app, content or a subdomain of it)? */
const ownHost = (ctx: Ctx, host: string) =>
  [ctx.opts.appHost, ctx.opts.contentHost].some(
    (h) => host === h || host.endsWith(`.${h}`),
  );

type Public = "live" | "missing" | "unknown";
const DOH_LIVE = new Set([1, 28, 5]); // A, AAAA, CNAME

/** One DoH question: live (an A, AAAA or CNAME answer), missing (NODATA or NXDOMAIN) or unknown (SERVFAIL, bad body, timeout). */
async function ask(
  ctx: Ctx,
  host: string,
  type: "A" | "AAAA",
): Promise<Public> {
  try {
    const res = await ctx.deps.fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
      {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
      },
    );
    if (!res.ok) return "unknown";
    const body = (await res.json()) as {
      Status?: unknown;
      Answer?: { type?: unknown }[];
    };
    if (body.Status !== 0 && body.Status !== 3) return "unknown";
    // NXDOMAIN is missing, even with a dangling CNAME in the Answer.
    if (body.Status === 3) return "missing";
    const live =
      Array.isArray(body.Answer) &&
      body.Answer.some((a) => DOH_LIVE.has(a?.type as number));
    return live ? "live" : "missing";
  } catch {
    return "unknown";
  }
}

/** Does public DNS have a record for `host`? Either family counts. */
async function publicState(ctx: Ctx, host: string): Promise<Public> {
  const a = await ask(ctx, host, "A");
  if (a === "live") return "live";
  const aaaa = await ask(ctx, host, "AAAA");
  if (aaaa === "live") return "live";
  return a === "unknown" || aaaa === "unknown" ? "unknown" : "missing";
}

function flushHint(ctx: Ctx): string {
  const p = ctx.deps.platform ?? process.platform;
  if (p === "darwin")
    return "Wait a few minutes or run `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder` (macOS)";
  if (p === "linux")
    return "Wait a few minutes or run `sudo resolvectl flush-caches` (systemd-resolved)";
  if (p === "win32")
    return "Wait a few minutes or run `ipconfig /flushdns` (Windows)";
  return "Flush your OS DNS cache or wait a few minutes";
}

const stale = (ctx: Ctx, host: string) =>
  new NeedInput(
    `Your machine's DNS cache has a stale miss for ${host}; the record is live. ${flushHint(ctx)}, then rerun.`,
  );

/** The wait is over: say whose fault it is. */
async function dnsFailure(
  ctx: Ctx,
  host: string,
  code: string,
): Promise<never> {
  const state = await publicState(ctx, host);
  if (state === "live") throw stale(ctx, host);
  throw new Error(
    state === "missing"
      ? `DNS: ${host} has no public A, AAAA or CNAME record (${code}); add the missing record, then rerun`
      : `DNS: ${host} does not resolve (${code}) and public DNS could not be checked; wait 2 minutes and rerun`,
  );
}

/**
 * Fetches until 200, retrying failures with bounded backoff. A host of this
 * install that doesn't resolve gets up to 5 minutes (wall clock) unless --ci
 * (no stale local cache there): after 1 minute public DNS is asked, and a live
 * record stops the wait at once.
 */
async function until200(
  ctx: Ctx,
  label: string,
  url: string,
  init?: RequestInit,
  shown = url,
  verify?: (res: Response) => Promise<string | undefined>,
) {
  const sleep =
    ctx.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = ctx.deps.now ?? Date.now;
  const host = new URL(url).hostname;
  const dnsWait = ctx.deps.dnsWaitMs ?? DNS_WAIT_MS;
  let dnsSince: number | undefined;
  let probed = false;
  for (let i = 0; ; i++) {
    let last: string;
    let wrong = false;
    let dns: string | undefined;
    try {
      const res = await ctx.deps.fetch(url, init);
      if (res.status === 200) {
        const bad = await verify?.(res.clone());
        if (!bad) return res;
        last = bad;
        wrong = true;
      } else last = `HTTP ${res.status}`;
    } catch (e) {
      const code = causeCode(e);
      const isDns = code !== undefined && DNS_CODES.has(code);
      last = !code
        ? (e as Error).message
        : isDns
          ? `${(e as Error).message} (${code} ${(e as { cause?: { hostname?: string } }).cause?.hostname ?? host})`
          : `${(e as Error).message} (${code})`;
      if (isDns && !ctx.opts.ci && ownHost(ctx, host)) dns = code;
    }
    let delay = DELAYS[i];
    if (dns) {
      dnsSince ??= now();
      const elapsed = now() - dnsSince;
      if (elapsed >= DNS_PROBE_MS && !probed) {
        probed = true;
        if ((await publicState(ctx, host)) === "live") throw stale(ctx, host);
      }
      delay ??= 15;
      if (elapsed + delay * 1000 > dnsWait) return dnsFailure(ctx, host, dns);
    } else {
      dnsSince = undefined;
      if (delay === undefined && wrong)
        throw new Error(`${label}: ${shown} answered 200 but ${last}`);
      if (delay === undefined)
        throw new Error(
          `${label}: ${shown} not 200 after ~60s (last: ${last})`,
        );
    }
    await sleep(delay * 1000);
  }
}

/** A JSON-RPC body, plain JSON or the matching SSE `data:` event. */
async function rpcResult(res: Response, id: number, method: string) {
  const text = await res.text();
  const msgs = res.headers.get("content-type")?.includes("event-stream")
    ? text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => JSON.parse(l.slice(5)))
    : [JSON.parse(text)];
  const msg = msgs.find((m) => m.id === id);
  if (!msg || msg.error)
    throw new Error(`MCP ${method}: ${msg?.error?.message ?? "no response"}`);
  return msg.result;
}

/** tools/list, then publish (or update) the welcome page; returns its id. */
async function mcp(ctx: Ctx, token: string, prev?: string, prevHash?: string) {
  const url = `https://${ctx.opts.appHost}/mcp`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  let id = 0;
  const post = async (method: string, params: unknown, retry = false) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params });
    const init = { method: "POST", headers, body };
    const res = retry
      ? await until200(ctx, `MCP ${method}`, url, init)
      : await ctx.deps.fetch(url, init);
    if (!res.ok) throw new Error(`MCP ${method}: HTTP ${res.status}`);
    return rpcResult(res, id, method);
  };
  await post(
    "initialize",
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "oa-setup", version: "1" },
    },
    true,
  );
  await ctx.deps.fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });
  const { tools } = await post("tools/list", {});
  if (!tools?.some((t: { name: string }) => t.name === "publish_artifact"))
    throw new Error("MCP tools/list has no publish_artifact");
  const content = ctx.fs.read(join(ctx.root, WELCOME));
  if (content === null) throw new Error(`missing ${WELCOME}`);
  // The page is published only when its text changed since the last publish.
  const hash = tokenHash(`${TITLE}\n${content}`);
  if (prev && prevHash === hash)
    return { id: prev, url: undefined, hash, unchanged: true };
  const publish = (id?: string) =>
    post("tools/call", {
      name: "publish_artifact",
      arguments: {
        ...(id ? { id } : {}),
        title: TITLE,
        format: "markdown",
        content,
      },
    });
  const text = (r: { content?: { text?: string }[] }) =>
    r?.content?.[0]?.text ?? "no id";
  const has = (name: string) =>
    tools.some((t: { name: string }) => t.name === name);
  const exact = (
    r: { structuredContent?: { items?: unknown } } | undefined,
  ) => {
    const items = r?.structuredContent?.items;
    if (!Array.isArray(items)) return undefined;
    // Only the caller's own page: search and list also return team and shared
    // artifacts, and a member's same-title page must not be used or published to.
    const hit = items.find(
      (a: { title?: string; id?: string; access?: string }) =>
        a?.title === TITLE && typeof a?.id === "string" && a.access === "owner",
    );
    return typeof hit?.id === "string" ? hit.id : undefined;
  };
  /**
   * No saved id (--ci, or a by-name --upgrade from a fresh clone): find the
   * owner's page by exact title, never a fixed
   * page of the list (a 100-item page can hide it and publish a duplicate).
   * search_artifacts when the server has it, otherwise every page of
   * list_artifacts.
   */
  const findWelcome = async (): Promise<string | undefined> => {
    if (!has("search_artifacts") && !has("list_artifacts")) return undefined;
    const tool = has("search_artifacts")
      ? "search_artifacts"
      : "list_artifacts";
    const base =
      tool === "search_artifacts"
        ? { q: TITLE }
        : { scope: "mine", limit: 100 };
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await post("tools/call", {
        name: tool,
        arguments: { ...base, ...(cursor ? { cursor } : {}) },
      });
      const hit = exact(r);
      if (hit) return hit;
      cursor = r?.structuredContent?.nextCursor ?? undefined;
      if (!cursor) return undefined;
    }
    return undefined;
  };
  /** The page's latest text, so an unchanged page is never republished. */
  const latestIsCurrent = async (id: string) => {
    if (!has("get_artifact")) return false;
    const r = await post("tools/call", {
      name: "get_artifact",
      arguments: { id },
    });
    const text_ = r?.structuredContent?.content;
    return (
      typeof text_ === "string" && tokenHash(`${TITLE}\n${text_}`) === hash
    );
  };
  if (!prev) {
    const found = await findWelcome();
    if (found) {
      if (await latestIsCurrent(found))
        return { id: found, url: undefined, hash, unchanged: true };
      prev = found;
    }
  }
  let r = await publish(prev);
  // The saved welcome artifact was deleted: publish a fresh one instead.
  if (prev && r?.isError && /^not_found\b/.test(text(r))) {
    ctx.notes.push(`welcome artifact ${prev} was deleted; published a new one`);
    r = await publish();
  }
  const out = r?.structuredContent?.id;
  if (r?.isError || typeof out !== "string")
    throw new Error(`MCP publish_artifact: ${text(r)}`);
  const view = r?.structuredContent?.url;
  return {
    id: out,
    url: typeof view === "string" ? view : undefined,
    hash,
    unchanged: false,
  };
}

/** The private artifact's signed content URL must serve the welcome text; returns the redacted URL. */
async function content(
  ctx: Ctx,
  token: string,
  id: string,
  once = false,
): Promise<string> {
  const api = `https://${ctx.opts.appHost}/api/v1/artifacts/${encodeURIComponent(id)}/content-url`;
  const init = { headers: { authorization: `Bearer ${token}` } };
  // One try for an unchanged page: a deleted one answers 404 and is published again.
  const res = once
    ? await ctx.deps.fetch(api, init)
    : await until200(ctx, "content-url", api, init);
  if (!res.ok) throw new Error(`content-url: HTTP ${res.status}`);
  const { url } = (await res.json()) as { url?: string };
  if (typeof url !== "string") throw new Error("content-url: no url");
  // The signed URL is a bearer capability: report only its origin.
  const shown = `${new URL(url).origin}/…`;
  const res2 = await until200(ctx, "welcome content", url, undefined, shown);
  let body = await res2.text();
  // Markdown is served as a render shell that loads its entry file next to
  // the view URL (packages/render entryUrl); check that file instead.
  const entry = body.match(/<meta name="oa-entry" content="([^"]+)">/)?.[1];
  if (entry) {
    const file = entry.split("/").map(encodeURIComponent).join("/");
    const res3 = await until200(
      ctx,
      "welcome content",
      new URL(file, url).href,
      undefined,
      shown,
    );
    body = await res3.text();
  }
  if (!body.includes(TITLE))
    throw new Error(`welcome content at ${shown} lacks "${TITLE}"`);
  return shown;
}

/** The publish result's view URL, only as an app-host `/a/…` link without search or hash. */
function viewUrl(ctx: Ctx, raw?: string): string | undefined {
  let u: URL | undefined;
  try {
    u = raw ? new URL(raw) : undefined;
  } catch {}
  if (
    u?.origin === `https://${ctx.opts.appHost}` &&
    u.pathname.startsWith("/a/")
  )
    return u.origin + u.pathname;
  ctx.notes.push("welcome URL ignored (not an app-host /a/ link)");
  return undefined;
}

/** Healthz (with the PLAN check), OIDC discovery and the EMAIL binding: needs no token, so it runs before owner-token. */
export const healthcheck: Step = {
  name: "healthcheck",
  always: true,
  check: async () => "todo",
  async apply(state, ctx) {
    const app = `https://${ctx.opts.appHost}`;
    // The plan is checked inside the wait: the old version may still serve for a moment.
    await until200(
      ctx,
      "healthz",
      `${app}/healthz`,
      undefined,
      undefined,
      async (r) => {
        const served = (
          (await r.json().catch(() => ({}))) as { plan?: unknown }
        ).plan;
        return served === ctx.opts.planVar
          ? undefined
          : `plan ${JSON.stringify(served)} but setup rendered PLAN ${JSON.stringify(ctx.opts.planVar)}; the deployed Worker does not match, rerun setup (or pass --plan paid|free)`;
      },
    );
    const accessOn = await accessInUse(ctx, state.accountId ?? "");
    if (accessOn) {
      const oidc = `https://${state.teamDomain}/cdn-cgi/access/sso/oidc/${state.accessClientId}/.well-known/openid-configuration`;
      await until200(ctx, "OIDC discovery", oidc);
    }
    if (ctx.opts.email) {
      const b = await workerBindings(ctx, state.accountId ?? "");
      if (!b?.some((x) => x.type === "send_email" && x.name === "EMAIL"))
        throw new Error(
          `the deployed Worker ${ctx.opts.name} has no EMAIL (send_email) binding; rerun setup`,
        );
      ctx.notes.push("EMAIL binding deployed");
    }
    ctx.notes.push(accessOn ? "healthz and OIDC discovery ok" : "healthz ok");
    return undefined;
  },
};

/** The PAT saved by owner-token on an earlier run, when it still looks like one. */
function savedPat(ctx: Ctx): string | undefined {
  const file = patTokenFile(homeOf(ctx.deps.env), ctx.opts.appHost);
  const text = ctx.fs.read(file)?.trim();
  return text && /^oa_pat_\S+$/.test(text) ? text : undefined;
}

/** After owner-token: the MCP connection and the Welcome publish, with this run's PAT or the saved one. */
export const selftest: Step = {
  name: "selftest",
  always: true,
  check: async () => "todo",
  async apply(state, ctx) {
    const fromFile = !ctx.pat && !ctx.opts.ci;
    const token = ctx.pat ?? (fromFile ? savedPat(ctx) : undefined);
    // --ci always mints a token for this step (also with --upgrade): never pass without the MCP check.
    if (!token && ctx.opts.ci)
      throw new Error(
        "selftest: no CI token was minted, so the MCP check could not run",
      );
    if (!token) {
      ctx.notes.push(
        "MCP check skipped: no saved token (rerun with --new-owner-token to test it)",
      );
      ctx.data = { mcp: "skipped" };
      return undefined;
    }
    let welcome: Awaited<ReturnType<typeof mcp>>;
    let shown: string;
    try {
      welcome = await mcp(
        ctx,
        token,
        state.welcomeArtifactId,
        state.welcomeHash,
      );
      try {
        shown = await content(ctx, token, welcome.id, welcome.unchanged);
      } catch (e) {
        if (!welcome.unchanged) throw e;
        // The unchanged page is gone (deleted?): publish it again.
        welcome = await mcp(ctx, token, state.welcomeArtifactId, undefined);
        shown = await content(ctx, token, welcome.id);
      }
    } catch (e) {
      if (!fromFile || !/HTTP 40[13]\b/.test((e as Error).message)) throw e;
      return {
        status: "action_required",
        message:
          "your saved agent token was rejected; rerun with --new-owner-token to rotate it, then update your client",
        data: { mcp: "skipped", tokenRejected: true },
      };
    }
    const artifactId = welcome.id;
    ctx.welcomeUrl = welcome.unchanged
      ? `https://${ctx.opts.appHost}/a/${encodeURIComponent(artifactId)}`
      : viewUrl(ctx, welcome.url);
    state.welcomeArtifactId = artifactId;
    state.welcomeHash = welcome.hash;
    ctx.notes.push(
      welcome.unchanged
        ? "Welcome page unchanged; MCP and content ok"
        : fromFile
          ? "MCP publish and content ok (with the saved agent token)"
          : "MCP publish and content ok",
    );
    ctx.data = {
      mcp: "ok",
      artifactId,
      content: shown,
      welcomeUrl: ctx.welcomeUrl,
    };
    return undefined;
  },
};
