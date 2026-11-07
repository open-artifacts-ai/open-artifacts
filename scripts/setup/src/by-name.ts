import { parseArgs } from "node:util";
import { type Deps, makeApi, makeWrangler } from "./cf.ts";
import { readOnlyDeps } from "./readonly.ts";
import type { State } from "./state.ts";
import { NeedInput } from "./step.ts";
import { scriptBindings } from "./worker.ts";

export type Sources = Record<
  "appHost" | "contentHost" | "ownerEmail",
  "worker" | "flag" | "state"
>;
export type Deployed = {
  accountId: string;
  appHost?: string;
  contentHost?: string;
  ownerEmail?: string;
  sources: Sources;
  /** The deployed values, to restore over a flag when the run is refused. */
  live: Partial<Record<keyof Sources, string>>;
  notes: string[];
};

const FIELDS = [
  ["appHost", "app-host", "APP_HOST"],
  ["contentHost", "content-host", "CONTENT_HOST"],
  ["ownerEmail", "owner-email", "OWNER_EMAIL"],
] as const;

/**
 * `--upgrade --name <n>` with no saved state: the install's hosts and owner
 * come from the deployed Worker's plain-text vars (secrets are never read).
 * Its team, email, browser and plan choices seed `state`, where flags still
 * win. Undefined when the mode does not apply.
 */
export async function fromWorker(
  argv: string[],
  deps: Deps,
  root: string,
  state: State,
): Promise<Deployed | undefined> {
  const { values: v } = parseArgs({
    args: argv,
    strict: false,
    options: {
      name: { type: "string" },
      upgrade: { type: "boolean" },
      check: { type: "boolean" },
      "account-id": { type: "string" },
      "app-host": { type: "string" },
      "content-host": { type: "string" },
      "owner-email": { type: "string" },
    },
  });
  const name = v.name;
  if (!v.upgrade || state.name || typeof name !== "string") return undefined;
  if (!/^[a-z0-9-]+$/.test(name)) return undefined;
  // With every value passed there is nothing to read: setup runs as before.
  if (FIELDS.every(([, flag]) => v[flag] !== undefined)) return undefined;
  const d = v.check ? readOnlyDeps(deps) : deps;
  let accountId =
    (v["account-id"] as string | undefined) ?? d.env.CLOUDFLARE_ACCOUNT_ID;
  const wrangler = makeWrangler(d, root, () => accountId);
  if (!accountId) {
    const who = JSON.parse(await wrangler(["whoami", "--json"])) as {
      accounts?: { id: string; name: string }[];
    };
    const accounts = who.accounts ?? [];
    if (accounts.length !== 1)
      throw new NeedInput(
        accounts.length
          ? `several accounts (${accounts.map((a) => `${a.id} (${a.name})`).join(", ")}); pass --account-id`
          : "`wrangler whoami` lists no accounts; run `wrangler login`",
      );
    accountId = accounts[0].id;
  }
  const bindings = await scriptBindings(
    makeApi(d, wrangler),
    name,
    accountId,
  ).catch((e) => {
    if ([401, 403].includes((e as { status?: number }).status ?? 0))
      throw new NeedInput(
        `could not read Worker ${name}'s settings (${(e as Error).message}); the token needs Workers Scripts Read`,
      );
    throw e;
  });
  if (!bindings)
    throw new NeedInput(
      `no Worker named ${name} on account ${accountId}; check --name (the Worker name from setup) or --account-id`,
    );
  const vars = new Map(
    bindings
      .filter((b) => b.type === "plain_text")
      .map((b) => [b.name, b.text?.trim()]),
  );
  const out: Deployed = {
    accountId,
    sources: {} as Sources,
    live: {},
    notes: [],
  };
  for (const [key, flag, varName] of FIELDS) {
    const given = v[flag];
    const live = vars.get(varName) || undefined;
    out.live[key] = live;
    if (given === true)
      throw new NeedInput(
        `pass --${flag} <value> (the flag was given without one)`,
      );
    if (given === undefined && !live)
      throw new NeedInput(
        `pass --${flag} (the deployed Worker has no ${varName})`,
      );
    if (typeof given === "string") {
      out.sources[key] = "flag";
      if (live && given.toLowerCase() !== live.toLowerCase())
        out.notes.push(
          `--${flag} ${given} differs from the deployed ${varName} ${live}; using the flag`,
        );
    } else {
      out.sources[key] = "worker";
      out[key] = live;
    }
  }
  if (out.notes.length === 0 || Object.values(out.sources).includes("worker"))
    out.notes.unshift(`read the install's settings from Worker ${name}`);
  // Choices read from the Worker seed the in-memory state: flags still win.
  const has = (type: string) => bindings.some((b) => b.type === type);
  const plan = vars.get("PLAN");
  const domain = vars.get("EMAIL_FROM")?.split("@")[1];
  Object.assign(state, {
    singleHost: vars.get("CONTENT_ROUTING") === "path",
    team: has("send_email"),
    ...(has("send_email") ? { email: true } : {}),
    ...(domain ? { emailDomain: domain } : {}),
    browser: has("browser"),
    ...(plan === "paid" || plan === "free" ? { planVar: plan } : {}),
  });
  return out;
}
