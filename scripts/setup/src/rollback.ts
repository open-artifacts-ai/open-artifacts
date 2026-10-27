import { parseArgs } from "node:util";
import { type Deps, makeApi, makeWrangler, realFs } from "./cf.ts";
import { readState, writeState } from "./state.ts";
import { NeedInput } from "./step.ts";
import { withTokenFiles } from "./token-files.ts";
import { currentVersion } from "./worker.ts";

const PAT_RE = /oa_pat_[1-9A-HJ-NP-Za-km-z]+/g;

/** --rollback: wrangler rollback to the version the last deploy replaced; touches nothing else. */
export async function rollbackCommand(
  argv: string[],
  deps: Deps,
  root: string,
): Promise<number> {
  const { values: v } = parseArgs({
    args: argv,
    strict: false,
    options: {
      name: { type: "string" },
      "account-id": { type: "string" },
      "token-file": { type: "string" },
      json: { type: "boolean" },
    },
  });
  const json = Boolean(v.json);
  const report = (
    status: "ok" | "action_required" | "error",
    step: string,
    message: string,
    data?: unknown,
  ) => {
    const secrets = [
      deps.env.CLOUDFLARE_API_TOKEN,
      deps.env.OA_ACCESS_TOKEN,
      deps.env.ANALYTICS_TOKEN,
    ].filter((s): s is string => Boolean(s));
    let safe = message.replace(PAT_RE, "[redacted]");
    for (const s of secrets) safe = safe.split(s).join("[redacted]");
    deps.out(
      json
        ? JSON.stringify({ step, status, message: safe, data })
        : `${{ ok: "✓", action_required: "!", error: "✗" }[status]} ${step}: ${safe}`,
    );
  };
  const clash = ["--upgrade", "--check", "--ci"].filter((f) =>
    argv.includes(f),
  );
  if (clash.length) {
    report(
      "error",
      "args",
      `--rollback runs on its own; drop ${clash.join(", ")}`,
    );
    return 1;
  }
  const fs = deps.fs ?? realFs;
  const state = readState(fs, root);
  const name = state.name ?? (v.name as string | undefined) ?? "open-artifacts";
  const accountId =
    state.accountId ??
    (v["account-id"] as string | undefined) ??
    deps.env.CLOUDFLARE_ACCOUNT_ID;
  if (v.name !== undefined && v.name !== name) {
    report(
      "error",
      "args",
      `--name ${v.name} differs from saved --name ${name}`,
    );
    return 1;
  }
  if (v["account-id"] !== undefined && v["account-id"] !== accountId) {
    report("error", "args", "--account-id differs from the saved account");
    return 1;
  }
  // The same deploy token as setup: env, --token-file, then the saved file.
  try {
    deps = withTokenFiles(argv, deps, state);
  } catch (e) {
    const ar = e instanceof NeedInput;
    report(ar ? "action_required" : "error", "args", (e as Error).message);
    return ar ? 2 : 1;
  }
  const to = state.previousWorkerVersion;
  const dashboard = `roll back in the dashboard: Workers → ${name} → Deployments`;
  if (!to) {
    report(
      "action_required",
      "rollback",
      `no previous version is recorded; ${dashboard}`,
    );
    return 2;
  }
  const wrangler = makeWrangler(deps, root, () => accountId);
  let live: string | undefined;
  let readError: string | undefined;
  try {
    live = await currentVersion(makeApi(deps, wrangler), name, accountId ?? "");
  } catch (e) {
    readError = (e as Error).message;
  }
  if (!live || live !== state.workerVersion) {
    const why = readError
      ? ` (${readError}${/\b40[13]\b/.test(readError) ? "; the token needs Workers Scripts Read" : ""})`
      : "";
    report(
      "action_required",
      "rollback",
      `the live Worker (${live ?? "unreadable"}${why}) isn't the one setup last deployed; ${dashboard}`,
    );
    return 2;
  }
  try {
    await wrangler([
      "rollback",
      to,
      "--name",
      name,
      "--message",
      "oa:setup --rollback",
      "-y",
    ]);
  } catch (e) {
    report("error", "rollback", (e as Error).message);
    return 1;
  }
  state.workerVersion = to;
  state.previousWorkerVersion = live;
  // The live code is no longer what the hash describes: the next run must deploy.
  state.deployHash = undefined;
  writeState(fs, root, state);
  report("ok", "rollback", `rolled ${name} back to ${to}`, { from: live, to });
  return 0;
}
