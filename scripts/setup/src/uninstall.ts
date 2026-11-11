import { parseArgs } from "node:util";
import { type Deps, realFs } from "./cf.ts";
import { homeOf, patTokenFile } from "./secret-file.ts";
import { readState } from "./state.ts";
import { names } from "./steps/resources.ts";
import { DASH_SENDING, records } from "./steps/email.ts";

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
  const given = v.name as string | undefined;
  const name = s.name ?? given;
  if (!name) {
    out("error", "no saved state: pass --name <install name>");
    return 1;
  }
  if (s.name && given !== undefined && given !== s.name) {
    out(
      "error",
      `--name ${given} differs from the saved name ${s.name}; drop --name or run from the right clone`,
    );
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
  if (s.emailDomain) {
    const d = s.emailDomain;
    const recs = records(d)
      .filter((r) => !r.name.startsWith("_dmarc"))
      .map((r) => `${r.type} ${r.name}`)
      .join(", ");
    items.push({
      order: 2,
      kind: "Email Sending domain and DNS records",
      resource: d,
      how: `Dashboard (${DASH_SENDING}): Email Service, Email Sending, remove ${d}. Then in the zone's DNS page delete ${recs}. Delete TXT _dmarc.${d} only if onboarding created it: on an apex sending domain it may be your own policy.`,
    });
  }
  if (s.pendingAccessAppId)
    items.push({
      order: 1,
      kind: "Orphaned Access app (a setup run was interrupted)",
      resource: `${name} (${s.pendingAccessAppId})`,
      how: "Zero Trust dashboard: Access, Applications, the app with this id, Delete.",
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
  // Names come from setup's own naming (resources.ts), so they hold without saved ids.
  const n = names(name);
  items.push({
    order: 0,
    kind: "Backup (do this first)",
    resource: `D1 ${n.d1}, R2 ${n.r2}`,
    how: `${w} d1 export ${n.d1} --remote --output backup.sql ; for R2 copy every object out, e.g. rclone copy r2:${n.r2} ./backup-r2 with R2 S3 credentials (dashboard, R2, Manage API Tokens), or ${w} r2 object get ${n.r2}/<key> --file <path> per key. Lighter option: ask any AI agent to save the latest version of each artifact (latest versions only).`,
  });
  items.push({
    order: 5,
    kind: "KV namespace",
    resource: s.kvId ? `${n.kv} (${s.kvId})` : n.kv,
    how: s.kvId
      ? `${w} kv namespace delete --namespace-id ${s.kvId}`
      : `Find the id: ${w} kv namespace list (the entry titled ${n.kv}), then ${w} kv namespace delete --namespace-id <id>`,
    destroysData: true,
  });
  items.push({
    order: 6,
    kind: "D1 database",
    resource: s.d1Id ? `${n.d1} (${s.d1Id})` : n.d1,
    how: `${w} d1 delete ${n.d1}`,
    destroysData: true,
  });
  items.push({
    order: 7,
    kind: "R2 bucket",
    resource: n.r2,
    how: `Empty it first. The dashboard's select all clears only the listed page, so for a bulk path add a lifecycle rule that expires all objects (R2, the bucket, Settings, Object lifecycle rules) and wait for it to run, or run rclone purge r2:${n.r2}. Then ${w} r2 bucket delete ${n.r2}`,
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
    resource: [
      ...files,
      `${root}/.openartifacts/state.json`,
      `${root}/apps/server/wrangler.jsonc`,
    ].join(", "),
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
