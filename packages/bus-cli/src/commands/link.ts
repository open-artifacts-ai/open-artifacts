import { statSync } from "node:fs";
import { resolve } from "node:path";
import {
  canonicalPath,
  credentialsFor,
  globalFile,
  MAIN_INSTANCE,
  remotesFile,
  resolveNamespace,
  shq,
} from "@oa/bus-daemon";
import { BUS_ROUTES } from "@oa/bus-protocol";
import { type Ctx, plain, say, sayErr } from "../context.ts";
import { readMachine } from "../machine.ts";
import { approvalsFileFor, approvalsInstance } from "./namespace.ts";

type Side = { dir: string; namespace: string; instance: string | undefined };

/** The folder's real path and the namespace its agents get (the daemon's own rules, #1525), or undefined when it is no directory. */
function side(ctx: Ctx, dir: string): Side | undefined {
  const given = resolve(ctx.cwd, dir);
  try {
    const real = canonicalPath(given);
    if (!statSync(real).isDirectory()) return undefined;
    const ns = resolveNamespace(real, {
      globalFile: globalFile(ctx.home),
      namespacesFile: approvalsFileFor(ctx, real),
      remotesFile: remotesFile(ctx.home),
      recordRemote: false,
    });
    return {
      dir: real,
      namespace: ns.namespace,
      instance: approvalsInstance(ctx, real),
    };
  } catch {
    return undefined;
  }
}

/**
 * #1567: `oa-bus link <dir> <dir>` and `unlink`. The machine token can only
 * record a proposal on the hub; nothing is linked until the member opens the
 * printed one-time URL in a browser and confirms (the role proposals' flow,
 * #1372). `link list` has no read path for a machine token, so it points at
 * the member's bus page.
 */
export async function link(
  opts: { sub: "add" | "rm"; dirs: [string, string] } | { sub: "list" },
  ctx: Ctx,
): Promise<number> {
  const c = ctx.copy;
  say(ctx, c.header(ctx.version), "");
  const m = readMachine(ctx.home);
  if (m.state !== "ok") {
    sayErr(ctx, c.linkNeedLogin());
    return 1;
  }
  if (opts.sub === "list") {
    say(ctx, c.linkList(new URL(BUS_ROUTES.page, m.hub).href));
    return 0;
  }
  const sides: Side[] = [];
  for (const d of opts.dirs) {
    const s = side(ctx, d);
    if (!s) {
      sayErr(ctx, c.linkNotDir(shq(resolve(ctx.cwd, d))));
      return 1;
    }
    sides.push(s);
  }
  const [a, b] = sides as [Side, Side];
  if (a.namespace === b.namespace) {
    sayErr(ctx, c.linkSame(shq(a.dir), shq(b.dir), plain(a.namespace)));
    return 1;
  }
  // #2793: a link is made on one instance's hub, with that instance's key. Both
  // folders must be tied to the same instance; the namespaces of one are never
  // sent to another's hub, and nothing is guessed for an unmapped folder.
  if (a.instance === undefined || b.instance === undefined) {
    sayErr(
      ctx,
      `Nothing changed: a folder isn't tied to an instance yet. Run ${ctx.busCmd} use there first.`,
    );
    return 1;
  }
  if (a.instance !== b.instance) {
    sayErr(
      ctx,
      `Nothing changed: these folders use different instances (${plain(a.instance)} and ${plain(b.instance)}). A link is made on one instance; put both folders on the same one with ${ctx.busCmd} use.`,
    );
    return 1;
  }
  let hubUrl = m.hub;
  let token = m.token;
  if (a.instance !== MAIN_INSTANCE) {
    try {
      const cred = credentialsFor(a.instance, ctx.home);
      hubUrl = cred.hub;
      token = cred.machine_token;
    } catch {
      sayErr(
        ctx,
        `Nothing changed: the instance ${plain(a.instance)} can't be used (its key is missing or was revoked). Run ${ctx.busCmd} add again.`,
      );
      return 1;
    }
  }
  const action = opts.sub === "add" ? "link" : "unlink";
  const res = await ctx.fetch(new URL(BUS_ROUTES.linkProposals, hubUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ action, a: a.namespace, b: b.namespace }),
  });
  if (res.status === 401) {
    sayErr(ctx, c.linkUnauthorized());
    return 1;
  }
  if (!res.ok) {
    let reason: string | undefined;
    try {
      const j = (await res.json()) as { details?: { reason?: unknown } };
      if (typeof j.details?.reason === "string") reason = j.details.reason;
    } catch {}
    sayErr(ctx, c.linkRefused(reason));
    return 1;
  }
  // Only the instance's own confirm page is ever printed.
  let url: string | undefined;
  try {
    const j = (await res.json()) as { confirmUrl?: unknown };
    if (typeof j.confirmUrl === "string") {
      const u = new URL(j.confirmUrl);
      if (
        u.origin === new URL(hubUrl).origin &&
        u.pathname === "/bus/links/confirm" &&
        !u.search &&
        /^#[A-Za-z0-9_-]{43}$/.test(u.hash)
      )
        url = u.href;
    }
  } catch {}
  if (!url) {
    sayErr(ctx, c.linkBadReply());
    return 1;
  }
  say(
    ctx,
    c.linkProposed(
      action,
      { dir: shq(a.dir), namespace: plain(a.namespace) },
      { dir: shq(b.dir), namespace: plain(b.namespace) },
      url,
    ),
  );
  return 0;
}
