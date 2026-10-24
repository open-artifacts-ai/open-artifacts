import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  providersOf,
  resolveSignin,
  SIGNIN,
  type Signin,
  setOnly,
  signinProblems,
} from "../signin.ts";
import type { State } from "../state.ts";
import { type Ctx, NeedInput, type Step } from "../step.ts";
import { resolveVars, TUNABLES } from "../tunables.ts";
import { repoVersion } from "../version-guard.ts";
import { currentVersion, deployedVars, workerBindings } from "../worker.ts";
import {
  applyTunables,
  names,
  renderedConfig,
  stripComments,
} from "./resources.ts";
import { ACCESS_SECRET, listSecrets } from "./secrets.ts";

const CONFIG = "apps/server/wrangler.jsonc";
const REQUIRED = [ACCESS_SECRET, "SESSION_SECRET", "CONTENT_SIGNING_KEY"];

/** The rendered config's vars, refusing anything that isn't a complete production config. */
function renderedVars(ctx: Ctx): Record<string, string> {
  const text = ctx.fs.read(join(ctx.root, CONFIG));
  if (text === null) throw new Error(`missing ${CONFIG}; rerun setup`);
  const vars = JSON.parse(stripComments(text)).vars ?? {};
  if (vars.ENVIRONMENT !== "production")
    throw new Error(
      `refusing to deploy: ${CONFIG} has ENVIRONMENT=${JSON.stringify(vars.ENVIRONMENT)}, expected "production"`,
    );
  const empty = ["ACCESS_TEAM_DOMAIN", "ACCESS_CLIENT_ID"].filter(
    (k) => !vars[k],
  );
  if (empty.length)
    throw new Error(
      `refusing to deploy: ${CONFIG} has empty ${empty.join(", ")}; rerun setup without --upgrade so the access step fills them`,
    );
  return vars;
}

type Rendered = {
  browser?: unknown;
  send_email?: { name: string }[];
  vars?: Record<string, string>;
};

/**
 * Live bindings the rendered config would drop without the matching opt-out
 * flag: a deploy never removes EMAIL, BROWSER or SERVER_THUMBNAILS silently.
 * A failed read only warns.
 */
async function readLive(ctx: Ctx, accountId: string): Promise<Live> {
  try {
    return await workerBindings(ctx, accountId);
  } catch (e) {
    ctx.notes.push(
      `warning: could not read the live Worker's bindings (${(e as Error).message}); deploying without the binding check`,
    );
    return "unreadable";
  }
}

function drops(ctx: Ctx, live: Live, cfg: Rendered) {
  if (live === "unreadable") return [];
  const has = (type: string, name: string) =>
    live?.some((b) => b.type === type && b.name === name) ?? false;
  const out: string[] = [];
  if (
    has("send_email", "EMAIL") &&
    !cfg.send_email?.some((b) => b.name === "EMAIL") &&
    !ctx.opts.noEmail
  )
    out.push(
      "EMAIL (send_email): pass --team (and --yes-paid unless the plan reads paid) to keep it, or --no-email to remove it",
    );
  const lost = [
    has("browser", "BROWSER") && !cfg.browser && "BROWSER",
    has("plain_text", "SERVER_THUMBNAILS") &&
      !cfg.vars?.SERVER_THUMBNAILS &&
      "SERVER_THUMBNAILS",
  ].filter(Boolean);
  if (lost.length && ctx.opts.browserFlag !== false)
    out.push(
      `${lost.join(" and ")} (thumbnails): pass --browser to keep them, or --no-browser to remove them`,
    );
  return out;
}

/** The live Worker version id before a deploy; unreadable or split reads as none, with a note. */
async function readVersion(ctx: Ctx, state: State) {
  try {
    return await currentVersion(ctx.api, ctx.opts.name, state.accountId ?? "");
  } catch (e) {
    ctx.notes.push(
      `warning: could not read the live Worker version (${(e as Error).message}); previousWorkerVersion left unset, so --rollback has no target`,
    );
    return undefined;
  }
}

/**
 * Settles the tunable vars (flag, saved state, live value) and sets them in the
 * rendered config, so a value set in the dashboard survives the deploy.
 */
function settleVars(state: State, ctx: Ctx, live: Live) {
  const bindings = live === "unreadable" ? [] : (live ?? []);
  const { values, kept, ignored, ignoredSaved } = resolveVars({
    flags: ctx.opts.varFlags,
    state: state.vars ?? {},
    live: Object.fromEntries(
      bindings
        .filter((b) => b.type === "plain_text")
        .map((b) => [b.name, b.text]),
    ),
  });
  ctx.tunables = values;
  for (const k of kept) ctx.notes.push(`kept live ${k}`);
  for (const k of ignoredSaved) ctx.notes.push(`ignored invalid saved ${k}`);
  for (const k of ignored) ctx.notes.push(`ignored invalid live ${k}`);
  if (live === "unreadable") {
    const at = Object.keys(TUNABLES).filter(
      (k) =>
        state.vars?.[k] === undefined && ctx.opts.varFlags[k] === undefined,
    );
    if (at.length)
      ctx.notes.push(
        `could not read live vars; dashboard-set ${at.join(", ")} may be overwritten`,
      );
  }
  if (!ctx.opts.check) {
    const file = join(ctx.root, CONFIG);
    const text = ctx.fs.read(file);
    if (text !== null) {
      const next = applyTunables(text, values);
      if (next !== text) ctx.fs.write(file, next);
    }
  }
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ""));
}

type Live = Awaited<ReturnType<typeof workerBindings>> | "unreadable";

/**
 * The live bindings sign-in is settled from, or why there are none to trust.
 * An existing Worker is never deployed without them: an unreadable read, or a
 * 200 with no bindings from a Worker known to be deployed (saved state,
 * --upgrade), refuses in every mode. Unreadable with no Worker yet
 * (deployments 404) is a fresh install: nothing to keep.
 */
async function signinLive(
  state: State,
  ctx: Ctx,
  live: Live,
): Promise<Binding[] | string> {
  const never =
    "setup never deploys an existing Worker without its sign-in vars; rerun once the Worker's settings are readable (the token needs Workers Scripts Read)";
  const known = Boolean(
    state.workerVersion || state.deployedVersion || ctx.opts.upgrade,
  );
  if (live === "unreadable") {
    const exists =
      known ||
      (await currentVersion(ctx.api, ctx.opts.name, state.accountId ?? "").then(
        (v) => v !== undefined,
        () => true,
      ));
    return exists
      ? `refusing to deploy: could not read the live Worker's settings; ${never}`
      : [];
  }
  // A deployed Worker always has bindings (D1, KV, secrets): none is a partial read.
  if (live && known && live.length === 0)
    return `refusing to deploy: the live Worker's settings came back with no bindings; ${never}`;
  return live ?? [];
}

type Binding = NonNullable<Awaited<ReturnType<typeof workerBindings>>>[number];

/**
 * Settles the direct sign-in vars (the flag, then the live Worker's value as
 * deployed) and sets them in the rendered config: the template has none, so a
 * deploy would drop them. Throws, before any deploy call, on a live value
 * that can't be carried or a combination the server would not serve; returns
 * the unreadable-settings refusal for the caller to raise.
 */
async function settleSignin(
  state: State,
  ctx: Ctx,
  live: Live,
): Promise<{ values: Signin; refuse?: string }> {
  const bindings = await signinLive(state, ctx, live);
  if (typeof bindings === "string") {
    ctx.signin = undefined;
    return {
      values: resolveSignin({ flags: ctx.opts.signinFlags, live: [] }).values,
      refuse: bindings,
    };
  }
  const { values, changed, kept, problems } = resolveSignin({
    flags: ctx.opts.signinFlags,
    live: bindings,
  });
  if (problems.length)
    throw new Error(`refusing to deploy: ${problems.join("; ")}`);
  for (const [k, was, now] of changed)
    ctx.notes.push(
      `--${SIGNIN[k]} ${now || '""'} differs from the deployed ${k} ${was || "(unset)"}; using the flag`,
    );
  if (kept.length)
    ctx.notes.push(
      `kept the deployed ${kept.map(([k, v]) => `${k}=${v}`).join(", ")}`,
    );
  ctx.signin = values;
  if (!ctx.opts.check) {
    const file = join(ctx.root, CONFIG);
    const text = ctx.fs.read(file);
    if (text !== null) {
      const has = JSON.parse(stripComments(text)).vars ?? {};
      // Set values, and unset ones still in the file (to drop them).
      const touch = Object.fromEntries(
        Object.entries(values).filter(([k, v]) => v !== "" || k in has),
      );
      const next = applyTunables(text, touch);
      if (next !== text) ctx.fs.write(file, next);
    }
  }
  return { values };
}

/** Sign-in that needs a secret the Worker lacks: a warning, never a refusal. */
function secretWarnings(ctx: Ctx, s: Signin, have: Set<string>) {
  const put = (n: string) => `wrangler secret put ${n} --name ${ctx.opts.name}`;
  if (providersOf(s).includes("google") && !have.has("GOOGLE_CLIENT_SECRET"))
    ctx.notes.push(
      `warning: google is in AUTH_PROVIDERS but the Worker has no GOOGLE_CLIENT_SECRET secret; Google sign-in stays off until \`${put("GOOGLE_CLIENT_SECRET")}\``,
    );
  if (s.TURNSTILE_SITE_KEY && !have.has("TURNSTILE_SECRET"))
    ctx.notes.push(
      `warning: TURNSTILE_SITE_KEY is set but the Worker has no TURNSTILE_SECRET secret; Turnstile stays off until \`${put("TURNSTILE_SECRET")}\``,
    );
}

/**
 * A deploy never turns a live (or last-deployed) paid PLAN into free unless
 * asked with --plan free: an unreadable plan must not downgrade prod. The live
 * PLAN var wins; with an unreadable Worker only the saved value (written after
 * a successful deploy) counts, and with neither, refuse (a 404 is "no Worker", not unreadable).
 */
function planGuard(
  state: State,
  ctx: Ctx,
  vars: Record<string, string>,
  live: Live,
): string | undefined {
  if (vars.PLAN === "paid" || ctx.opts.planFlag === "free") return undefined;
  const fix =
    "Pass --plan paid to keep it, or --plan free to downgrade on purpose";
  const why =
    state.plan === "unknown"
      ? "from a plan setup could not confirm"
      : `plan read as ${state.plan}`;
  const refuse = (what: string) =>
    `refusing to deploy: ${what} but this run would render PLAN ${JSON.stringify(vars.PLAN)} (${why}). ${fix}`;
  if (live === "unreadable") {
    if (state.planVar === "paid")
      return refuse(
        "the saved PLAN is paid and the live Worker could not be read",
      );
    if (state.planVar === undefined)
      return refuse(
        "the live Worker's PLAN could not be read and none is saved",
      );
    return undefined;
  }
  const lp = live?.find((b) => b.type === "plain_text" && b.name === "PLAN");
  if (lp?.text?.trim().toLowerCase() === "paid" || state.planVar === "paid")
    return refuse("the Worker's PLAN is paid");
  return undefined;
}

/**
 * Hash of what `wrangler deploy` would upload: a dry-run build of the Worker
 * (so @oa/shared, dependencies and the lockfile are all in it) plus the
 * rendered config, the wrangler version and the repo version. Built twice: a
 * non-deterministic bundle, a failed dry run or any missing piece gives
 * undefined, and an unknown hash never skips a deploy.
 */
async function deployHash(ctx: Ctx): Promise<string | undefined> {
  const fs = ctx.fs;
  const config = fs.read(join(ctx.root, CONFIG));
  if (config === null || !fs.hashTree || !fs.tempDir) return undefined;
  const bundle = async () => {
    const dir = fs.tempDir?.() as string;
    try {
      await ctx.wrangler(["deploy", "--dry-run", "--outdir", dir]);
      // Only the code: source maps embed the outdir and README.md a timestamp.
      return fs.hashTree?.(dir, ["."], (rel) => /\.(m?js|wasm)$/.test(rel));
    } finally {
      fs.removeTree?.(dir);
    }
  };
  try {
    const wrangler = (await ctx.wrangler(["--version"])).trim();
    const first = await bundle();
    if (!first || !wrangler || (await bundle()) !== first) return undefined;
    return createHash("sha256")
      .update(`${config}\0${wrangler}\0${repoVersion(ctx)}\0${first}`)
      .digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * OA_CHECK_NO_TEST_HOOKS=1 (deploy-prod's upgrade, T3b L10): a dry-run build
 * of exactly the config and sources about to be deployed, checked by
 * scripts/ci/check-no-test-hooks.ts right before `wrangler deploy` (deployHash
 * already requires that build to be deterministic). A failure refuses the deploy.
 */
async function checkNoTestHooks(ctx: Ctx): Promise<void> {
  if (ctx.deps.env.OA_CHECK_NO_TEST_HOOKS !== "1") return;
  const dir = ctx.fs.tempDir?.();
  if (!dir)
    throw new Error("refusing to deploy: no temp dir for the test-hooks check");
  try {
    await ctx.wrangler(["deploy", "--dry-run", "--outdir", dir]);
    const script = join(ctx.root, "scripts/ci/check-no-test-hooks.ts");
    const r = await ctx.deps.exec("node", [
      "--experimental-strip-types",
      "--no-warnings",
      script,
      dir,
    ]);
    if (r.code !== 0)
      throw new Error(
        `refusing to deploy: check-no-test-hooks failed on the bundle to deploy: ${(r.stdout || r.stderr).trim()}`,
      );
    ctx.notes.push((r.stdout || "check-no-test-hooks: ok").trim());
  } finally {
    ctx.fs.removeTree?.(dir);
  }
}

export const deploy: Step = {
  name: "deploy",
  always: true,
  async check(state, ctx) {
    // Under --check, a never-deployed Worker is real drift, not the every-run deploy.
    if (ctx.opts.check && !(await deployedVars(ctx, state.accountId ?? ""))) {
      ctx.mustRun = true;
      ctx.notes.push(`Worker ${ctx.opts.name} never deployed`);
    }
    if (ctx.opts.check) {
      const live = await readLive(ctx, state.accountId ?? "");
      const vars = settleVars(state, ctx, live);
      const settled = await settleSignin(state, ctx, live);
      if (settled.refuse) throw new NeedInput(settled.refuse);
      const signin = setOnly(settled.values);
      ctx.data = {
        ...ctx.version,
        ...(Object.keys(vars).length ? { vars } : {}),
        ...(Object.keys(signin).length ? { signin } : {}),
      };
    }
    // A pending downgrade refusal is drift too: report it instead of a clean check.
    if (ctx.opts.check) {
      try {
        const vars = JSON.parse(stripComments(renderedConfig(state, ctx))).vars;
        const g = planGuard(
          state,
          ctx,
          vars,
          await readLive(ctx, state.accountId ?? ""),
        );
        if (g) {
          ctx.mustRun = true;
          ctx.notes.push(g);
        }
      } catch {}
    }
    return "todo";
  },
  async apply(state, ctx) {
    const live = await readLive(ctx, state.accountId ?? "");
    const tuned = settleVars(state, ctx, live);
    const { values: signin, refuse } = await settleSignin(state, ctx, live);
    const vars = renderedVars(ctx);
    const shown = Object.keys(tuned).length ? { vars: tuned } : {};
    // The version guard ran in prereqs, before anything had a side effect.
    const ver = ctx.version;
    if (ver?.downgrade)
      ctx.notes.push(
        `downgrading ${ver.liveVersion} → ${ver.repoVersion}; D1 is not rolled back`,
      );
    const cfg = JSON.parse(
      stripComments(ctx.fs.read(join(ctx.root, CONFIG)) ?? "{}"),
    ) as Rendered;
    const dropped = drops(ctx, live, cfg);
    if (dropped.length)
      throw new Error(
        `refusing to deploy: the live Worker has bindings this config would drop: ${dropped.join("; ")}`,
      );
    const guard = planGuard(state, ctx, vars, live);
    if (guard) return { status: "action_required", message: guard };
    if (refuse) return { status: "action_required", message: refuse };
    const have = await listSecrets(ctx);
    const missing = REQUIRED.filter((n) => !have.has(n));
    if (missing.length)
      throw new Error(
        `refusing to deploy: Worker secrets missing: ${missing.join(", ")}; rerun setup without --upgrade`,
      );
    secretWarnings(ctx, signin, have);
    const build = ["--dir", ctx.root, "--filter", "@oa/server...", "build"];
    const b = await ctx.deps.exec("pnpm", build);
    if (b.code !== 0)
      throw new Error(`pnpm build failed: ${(b.stderr || b.stdout).trim()}`);
    // A secret with a var's name makes `wrangler deploy` fail: drop the secret.
    for (const n of Object.keys(vars).filter((k) => have.has(k))) {
      await ctx.wrangler(["secret", "delete", n, "--name", ctx.opts.name], {
        input: "y\n",
      });
      ctx.notes.push(`deleted Worker secret ${n} (shadowed the var)`);
    }
    const d1 = names(ctx.opts.name).d1;
    await ctx.wrangler(["d1", "migrations", "apply", d1, "--remote"]);
    const replaced = await readVersion(ctx, state);
    // An identical deploy is a no-op: same rendered config, repo version and built bundle as the
    // live version. An unknown hash (no bundle to read, no live version) never skips.
    const hash = await deployHash(ctx);
    if (
      hash &&
      state.deployHash === hash &&
      replaced &&
      replaced === state.workerVersion
    ) {
      ctx.notes.push(`already deployed ${state.deployedVersion}`);
      ctx.skipped = true;
      ctx.data = {
        deployedVersion: state.deployedVersion,
        deploySkipped: true,
        ...ver,
        ...shown,
      };
      state.vars = Object.keys(tuned).length ? tuned : undefined;
      return undefined;
    }
    await checkNoTestHooks(ctx);
    const out = await ctx.wrangler(["deploy"]);
    state.previousWorkerVersion = replaced;
    state.workerVersion = out.match(/Current Version ID:\s*(\S+)/)?.[1];
    if (!state.workerVersion)
      ctx.notes.push(
        "warning: could not read the new version id from wrangler's output; --rollback will refuse until the next deploy",
      );
    state.deployedVersion = repoVersion(ctx);
    state.deployHash = hash;
    state.planVar = ctx.opts.planVar;
    state.vars = Object.keys(tuned).length ? tuned : undefined;
    ctx.notes.push(`deployed ${state.deployedVersion}`);
    ctx.data = { deployedVersion: state.deployedVersion, ...ver, ...shown };
    return undefined;
  },
};
