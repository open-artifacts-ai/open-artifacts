import { statSync } from "node:fs";
import { resolve } from "node:path";
import {
  canonicalPath,
  globalFile,
  namespacesFile,
  resolveNamespace,
  shq,
} from "@oa/bus-daemon";
import { BUS_ROUTES } from "@oa/bus-protocol";
import { type Ctx, plain, say, sayErr } from "../context.ts";
import { readMachine } from "../machine.ts";

type Side = { dir: string; namespace: string };

/** The folder's real path and the namespace its agents get (the daemon's own rules, #1525), or undefined when it is no directory. */
function side(ctx: Ctx, dir: string): Side | undefined {
  const given = resolve(ctx.cwd, dir);
  try {
    const real = canonicalPath(given);
    if (!statSync(real).isDirectory()) return undefined;
    const ns = resolveNamespace(real, {
      globalFile: globalFile(ctx.home),
      namespacesFile: namespacesFile(ctx.home),
    });
    return { dir: real, namespace: ns.namespace };
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
  const action = opts.sub === "add" ? "link" : "unlink";
  const res = await ctx.fetch(new URL(BUS_ROUTES.linkProposals, m.hub), {
    method: "POST",
    headers: {
      authorization: `Bearer ${m.token}`,
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
        u.origin === new URL(m.hub).origin &&
        /^\/bus\/links\/confirm\/[A-Za-z0-9_-]{43}$/.test(u.pathname) &&
        !u.search &&
        !u.hash
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
