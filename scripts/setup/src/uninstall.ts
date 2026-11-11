import { parseArgs } from "node:util";
import { type Deps, realFs } from "./cf.ts";
import { homeOf, patTokenFile } from "./secret-file.ts";
import { readState } from "./state.ts";

type Item = {
  /** Order to remove in: access, dns, worker, then data. */
  order: number;
  kind: string;
  resource: string;
  how: string;
  /** Deleting this destroys data. */
  destroysData?: boolean;
};

/**
 * --uninstall --check: a dry run. Reads only the saved state file and which token
 * files exist, then lists what setup created and how to remove each piece.
 * It makes no network call and runs no process.
 */
export async function uninstallCommand(
  argv: string[],
  deps: Deps,
  root: string,
): Promise<number> {
  const { values: v } = parseArgs({
    args: argv,
    strict: false,
    options: { name: { type: "string" }, json: { type: "boolean" } },
  });
  const json = Boolean(v.json);
  const out = (status: "ok" | "error", message: string, data?: unknown) =>
    deps.out(
      json
        ? JSON.stringify({ step: "uninstall", status, message, data })
        : message,
    );
  if (!argv.includes("--check")) {
    out(
      "error",
      "--uninstall only has a dry run so far: add --check. Nothing was changed.",
    );
    return 1;
  }
  const clash = ["--upgrade", "--rollback", "--ci"].filter((f) =>
    argv.includes(f),
  );
  if (clash.length) {
    out(
      "error",
      `--uninstall --check runs on its own; drop ${clash.join(", ")}`,
    );
    return 1;
  }
  const fs = deps.fs ?? realFs;
  const s = readState(fs, root);
  const name = s.name ?? (v.name as string | undefined);
  if (!name) {
    out("error", "no saved state: pass --name <install name>");
    return 1;
  }
  const w = `pnpm --dir apps/server exec wrangler`;
  const acct = s.accountId ? ` (account ${s.accountId})` : "";
  const items: Item[] = [];
  if (s.accessAppId)
    items.push({
      order: 1,
      kind: "Access app",
      resource: `${name} (${s.accessAppId})`,
      how: 'Zero Trust dashboard: Access, Applications, the app, Delete. Its policy "Open Artifacts – everyone" can go with it if nothing else uses it.',
    });
  if (s.emailDomain)
    items.push({
      order: 2,
      kind: "Email Sending domain and DNS records",
      resource: s.emailDomain,
      how: `Dashboard: Compute, Email Service, Email Sending, remove ${s.emailDomain}. Then delete the TXT and MX records it added under cf-bounce.${s.emailDomain} and _dmarc.${s.emailDomain} in the zone's DNS page.`,
    });
  const hosts = [s.appHost, s.contentHost].filter(Boolean) as string[];
  if (hosts.length)
    items.push({
      order: 3,
      kind: "Custom domains (DNS)",
      resource: hosts.join(", "),
      how: "Removed with the Worker. To free them first: dashboard, Workers & Pages, the Worker, Settings, Domains & Routes, delete each.",
    });
  items.push({
    order: 4,
    kind: "Worker (and its Durable Objects)",
    resource: name,
    how: `${w} delete --name ${name}`,
  });
  if (s.kvId)
    items.push({
      order: 5,
      kind: "KV namespace",
      resource: `${name}-oauth (${s.kvId})`,
      how: `${w} kv namespace delete --namespace-id ${s.kvId}`,
      destroysData: true,
    });
  if (s.d1Id)
    items.push({
      order: 6,
      kind: "D1 database",
      resource: `${name} (${s.d1Id})`,
      how: `${w} d1 delete ${name}`,
      destroysData: true,
    });
  if (s.r2Bucket)
    items.push({
      order: 7,
      kind: "R2 bucket",
      resource: s.r2Bucket,
      how: `Empty it first (dashboard, R2, the bucket, Objects, select all, delete), then ${w} r2 bucket delete ${s.r2Bucket}`,
      destroysData: true,
    });
  const home = homeOf(deps.env);
  const files = [
    ...["cloudflare", "access", "analytics"].map(
      (k) => `${home}/.open-artifacts/${name}-${k}-token`,
    ),
    ...(s.appHost ? [patTokenFile(home, s.appHost)] : []),
  ].filter((p) => fs.readToken?.(p) != null);
  items.push({
    order: 8,
    kind: "Local files",
    resource: [...files, `${root}/.openartifacts/state.json`].join(", "),
    how: "Delete them last, since later commands read them. Revoke the Cloudflare API tokens in the dashboard (My Profile, API Tokens) too.",
  });
  items.sort((a, b) => a.order - b.order);
  if (json) {
    out("ok", `dry run: ${items.length} things to remove; nothing changed`, {
      name,
      accountId: s.accountId,
      items,
    });
    return 0;
  }
  const lines = [
    `Uninstall dry run for ${name}${acct}. Nothing was changed. Remove in this order:`,
    ...items.map(
      (i, n) =>
        `${n + 1}. ${i.kind}: ${i.resource}\n   ${i.how}${i.destroysData ? "\n   DESTROYS DATA: export first." : ""}`,
    ),
    "Full guide: /docs/uninstall/",
  ];
  out("ok", lines.join("\n"));
  return 0;
}
