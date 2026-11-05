import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../src/steps/resources.ts";
import { core, envelope, ROOT, STATE } from "./fakes.ts";

const TEMPLATE = "apps/server/wrangler.template.jsonc";
const WELCOME = "scripts/setup/welcome.md";
const realRoot = join(import.meta.dirname, "../../..");

// Recorded shape of `wrangler whoami --json`.
export const WHOAMI = (ids: string[]) =>
  JSON.stringify({
    loggedIn: true,
    authType: "OAuth Token",
    email: "owner@example.com",
    accounts: ids.map((id) => ({ id, name: `Account ${id}` })),
  });
// Staging's real resources (apps/server/wrangler.staging.jsonc).
export const STAGING = {
  d1: [
    {
      uuid: "5155e2d4-d9bf-4900-b4ab-1febd480377a",
      name: "open-artifacts-staging",
    },
  ],
  r2: [{ name: "open-artifacts-staging" }],
  kv: [
    {
      id: "886a49c875024e8ab5262928d75f85b7",
      title: "open-artifacts-staging-oauth",
    },
  ],
};
/** Unrelated namespaces that push real ones past the first KV page. */
export const filler = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `f${i}`, title: `other-${i}` }));

type World = {
  /** App and content hosts the fake serves (default app.example.com and a.b.usercontent.example.com). */
  appHost?: string;
  contentHost?: string;
  /** Extra files (token files) and their modes. */
  files?: Record<string, string>;
  fileModes?: Record<string, number>;
  accounts?: string[];
  zones?: string[];
  /** Zone id per zone name (default "z"). */
  zoneIds?: Record<string, string>;
  /** GET /user/tokens/verify: token id per bearer value (default `id-<value>`). */
  tokenIds?: Record<string, string>;
  d1?: { uuid: string; name: string }[];
  r2?: { name: string }[];
  kv?: { id: string; title: string }[];
  answers?: string[];
  /** Access organization: 403s for the wrangler token, or none at all. */
  org?: "forbidden" | "none" | "404";
  policies?: Obj[];
  /** GET Access policies/apps answer with this status (checked per request, so it may be set after an install). */
  accessReadStatus?: number;
  /** GET Access policies/apps fail at the network with this message (a timeout, ECONNRESET). */
  accessReadThrows?: string;
  /** Worker secret names `secret list` hides (checked per call). */
  hideSecrets?: string[];
  apps?: Obj[];
  /** Worker secret names; undefined means the Worker does not exist yet. */
  secrets?: string[];
  putFails?: string;
  deleteFails?: boolean;
  /** Preloaded .openartifacts/state.json. */
  state?: Obj;
  /** Omit result_info from list pages (paging must stop on a short page). */
  noResultInfo?: boolean;
  /** /healthz answers 503 this many times first (propagation). */
  healthFails?: number;
  /** The first /healthz answers report these plans (an old version still serving). */
  healthPlanFirst?: (string | undefined)[];
  /** /healthz reports this plan instead of the deployed PLAN var. */
  healthPlan?: string;
  /** Artifacts already on the install (welcome lookup tests). */
  existingArtifacts?: {
    id: string;
    title: string;
    /** The caller's level (default "owner"); a team or shared artifact is "viewer"/"editor". */
    access?: "owner" | "editor" | "viewer" | "manager";
  }[];
  /** Called with each D1 statement before it runs (e.g. to delete a row mid-run). */
  onSql?: (sql: string) => void;
  /** The content get_artifact answers with (defaults to the last publish). */
  welcomeContent?: string;
  /** tools/list omits search_artifacts. */
  noSearchTool?: boolean;
  /** tools/list omits publish_artifact. */
  noPublishTool?: boolean;
  /** The token INSERT fails, or silently writes nothing. */
  d1Fails?: boolean;
  dropTokenInsert?: boolean;
  /** tools/list answers by throwing this (a client library echoing URL and headers). */
  mcpThrows?: (token: string) => string;
  /** Called with each MCP method the app host sees. */
  onMcp?: (method: string) => void;
  /** Any statement matching this fails (earlier statements keep their effects). */
  failOn?: RegExp;
  /** The first d1 command answers with one result fewer than statements. */
  shortResult?: boolean;
  /** Preloaded users and tokens (token user_id refers to a seeded user id). */
  seed?: {
    users?: { id: string; email: string; role: string; status?: string }[];
    tokens?: Obj[];
  };
  /** The signed content URL serves this body instead of the published content. */
  contentBody?: string;
  /** Body of the render shell's entry file (defaults to the published content). */
  entryBody?: string;
  /** The signed content URL answers with this status. */
  contentStatus?: number;
  /** Artifact ids that no longer exist (publish with that id → not_found). */
  deletedArtifacts?: string[];
  /** Every publish fails with this tool error text. */
  publishError?: string;
  /** The publish result's view url, overriding the default. */
  viewUrl?: string;
  /** The live Worker's plain-text vars (before any deploy in this world). */
  worker?: Record<string, string>;
  /** OIDC discovery answers with this issuer instead of the real one. */
  issuer?: string;
  /** OIDC discovery answers 503 this many times first. */
  discoveryFails?: number;
  /** POST /access/apps answers 403 (a token without Access: Apps Edit). */
  appsPostForbidden?: boolean;
  /** Public DNS records, served by the zone dns_records API and by DoH. */
  dns?: Dns[];
  /** The dns_records API answers 403 (wrangler's OAuth has no DNS Read). */
  dnsForbidden?: boolean;
  /** Account subscriptions; absent means 403 (wrangler's OAuth has no Billing Read). */
  subscriptions?: Obj[];
  /** The deployed Worker's settings omit the send_email binding. */
  dropSendEmail?: boolean;
  /** GET worker settings answers 403 (a token without Workers Scripts Read). */
  settingsForbidden?: boolean;
  /** GET worker settings answers 500. */
  settingsFail?: boolean;
  /** GET worker settings answers 200 with no bindings (a partial response). */
  settingsPartial?: boolean;
  /** Process env handed to the setup run. */
  env?: Record<string, string>;
  /** The live Worker's current version id before any deploy in this world. */
  workerVersion?: string;
  /** `wrangler deploy` fails with this stderr. */
  deployFails?: string;
  /** A stable `wrangler deploy --dry-run` build with this content (a different value is a different bundle). Unset: every build differs, so the deploy is never skipped. */
  stableBundle?: string;
  /** Each dry run also writes a varying source map and README (like real wrangler); they must not matter. */
  noisyDryRun?: boolean;
  /** `wrangler deploy --dry-run` fails. */
  dryRunFails?: boolean;
  /** scripts/ci/check-no-test-hooks.ts fails on the bundle (OA_CHECK_NO_TEST_HOOKS=1). */
  checkHooksFails?: boolean;
  /** scripts/ci/check-no-fake-idp.ts fails on the bundle (OA_CHECK_NO_TEST_HOOKS=1). */
  checkFakeIdpFails?: boolean;
  /** `wrangler rollback` fails with this stderr. */
  rollbackFails?: string;
  /** /healthz reports this `version` (absent: an install without it). */
  healthVersion?: string;
  /** /healthz fails with a network error. */
  healthzDown?: boolean;
  /** /healthz answers 200 with this raw HTML body (an Access login page). */
  healthzBody?: string;
  /** The live deployment splits traffic 50/50 across two versions. */
  splitDeployment?: boolean;
  /** Extra bindings on the live Worker's settings (send_email, browser, secret_text with a text canary). */
  workerBindings?: { type: string; name: string; text?: string }[];
  /** GET deployments answers 403 (a token without Workers Scripts Read). */
  deploymentsForbidden?: boolean;
  /** GET deployments answers 500. */
  deploymentsFail?: boolean;
};
type Dns = { name: string; type: string; content: string };

/** The records Email Sending's "Onboard Domain" adds for `d`. */
export const onboarded = (d: string): Dns[] => [
  ...[1, 2, 3].map((i) => ({
    name: `cf-bounce.${d}`,
    type: "MX",
    content: `route${i}.mx.cloudflare.net`,
  })),
  {
    name: `cf-bounce.${d}`,
    type: "TXT",
    content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"',
  },
  {
    name: `cf-bounce._domainkey.${d}`,
    type: "TXT",
    content: '"v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBg"',
  },
  { name: `_dmarc.${d}`, type: "TXT", content: '"v=DMARC1; p=reject;"' },
];
// biome-ignore lint/suspicious/noExplicitAny: loose API fixtures
type Obj = any;

export const POLICY = {
  id: "pol1",
  name: "Open Artifacts \u2013 everyone",
  decision: "allow",
  include: [{ everyone: {} }],
  exclude: [],
  require: [],
};
export const app = (name: string, policies = [{ id: "pol1" }]) => ({
  id: `app-${name}`,
  name,
  policies,
  type: "saas",
  saas_app: {
    auth_type: "oidc",
    client_id: `cid-${name}`,
    redirect_uris: ["https://app.example.com/auth/callback"],
  },
});
const paged = (
  items: Obj[],
  q: (k: string) => string | null,
  noInfo?: boolean,
) => {
  const per = Math.min(100, Number(q("per_page") ?? 20)); // API max
  const page = Number(q("page") ?? 1);
  const total_pages = Math.max(1, Math.ceil(items.length / per));
  const result = items.slice((page - 1) * per, page * per);
  const info = { page, per_page: per, total_pages };
  return new Response(
    JSON.stringify({
      success: true,
      errors: [],
      result,
      ...(noInfo ? {} : { result_info: info }),
    }),
  );
};

/** A stateful fake account: wrangler creates mutate it, the API reads it. */
export function world(w: World = {}) {
  const acct = {
    accounts: ["acc1"],
    zones: ["example.com"],
    d1: [],
    r2: [],
    kv: [],
    ...w,
  };
  const dns: Dns[] = [...(w.dns ?? [])];
  let subscriptions = w.subscriptions;
  const policies: Obj[] = [...(w.policies ?? [])];
  const apps: Obj[] = [...(w.apps ?? [])];
  let secrets = w.secrets && [...w.secrets];
  let deployedConfig: string | undefined;
  /** Live version ids, newest first; deploys add `ver-<n>`, rollbacks re-promote one. */
  const versions: string[] = w.workerVersion ? [w.workerVersion] : [];
  let deployCount = 0;
  let published = 0;
  let dryRuns = 0;
  /** The content of the last publish (kept when a test clears mcpCalls). */
  let lastPublished = "";
  const pubs: { id: string; title: string; access?: string }[] = [
    ...(w.existingArtifacts ?? []),
  ];
  const deleted = [...(w.deletedArtifacts ?? [])];
  /** Every mutation, in order. `values` holds every secret value seen. */
  const ops: string[] = [];
  const values: string[] = [];
  const creates: string[] = [];
  const auths: string[] = [];
  const zoneQueries: string[] = [];
  /** Every exec argv and env, for leak scans. */
  const argv: string[] = [];
  /** App-host and Access requests, e.g. "GET /healthz", "mcp tools/list". */
  const hits: string[] = [];
  const mcpCalls: Obj[] = [];
  /** Every bearer token the app host saw (how tests learn a never-printed PAT). */
  const bearers = new Set<string>();
  const sqls: string[] = [];
  const db = {
    users: [...(w.seed?.users ?? [])] as {
      id: string;
      email: string;
      role: string;
      /** Absent means 'active' (the column default). */
      status?: string;
    }[],
    tokens: [...(w.seed?.tokens ?? [])] as Obj[],
  };
  let healthFails = w.healthFails ?? 0;
  let discoveryFails = w.discoveryFails ?? 0;
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const unq = (x: string) => x.replaceAll("''", "'");
  const isActive = (u?: { status?: string }) =>
    !!u && (u.status ?? "active") === "active";
  /** demoteStatements' guard: the target is an active owner. */
  const ready = (st: string, me: string) =>
    !st.includes(" AND EXISTS (") ||
    db.users.some((u) => u.email === me && u.role === "owner" && isActive(u));
  /** Runs each statement in order (a failure keeps earlier effects, as D1 does without a transaction). */
  const d1 = (sql: string) => {
    sqls.push(sql);
    const out: {
      results: unknown[];
      success: boolean;
      meta: { changes: number };
    }[] = [];
    for (const st of sql
      .replace(/;\s*$/, "")
      .split(/;\s+(?=SELECT|UPDATE|INSERT)/)) {
      let results: unknown[] = [];
      let changes = 0;
      let m: string[] = [];
      const is = (re: RegExp) => {
        m = st.match(re) ?? [];
        return m.length > 0;
      };
      w.onSql?.(st);
      if (w.d1Fails && st.includes("INSERT INTO tokens"))
        throw new Error("D1 down");
      if (w.failOn?.test(st)) throw new Error("D1 statement failed");
      if (is(/^SELECT id FROM tokens WHERE id = '([^']*)'/)) {
        const id = m[1];
        results = db.tokens.filter((t) => t.id === id && !t.revoked_at);
      } else if (
        is(
          /^SELECT email FROM users WHERE role = 'owner' AND email <> '((?:[^']|'')*)'/,
        )
      ) {
        const me = unq(m[1]).toLowerCase();
        results = ready(st, me)
          ? db.users
              .filter((u) => u.role === "owner" && u.email !== me)
              .map((u) => ({ email: u.email }))
          : [];
      } else if (
        is(
          /^SELECT email FROM users WHERE role = 'owner' AND email = '((?:[^']|'')*)'$/,
        )
      ) {
        const me = unq(m[1]).toLowerCase();
        results = db.users.filter((u) => u.role === "owner" && u.email === me);
      } else if (
        is(
          /^UPDATE users SET role = 'admin' WHERE role = 'owner' AND email <> '((?:[^']|'')*)'/,
        )
      ) {
        const me = unq(m[1]).toLowerCase();
        for (const u of db.users)
          if (u.role === "owner" && u.email !== me && ready(st, me)) {
            u.role = "admin";
            changes++;
          }
      } else if (
        is(
          /^INSERT INTO users \(id, email, name, role, created_at\) VALUES \('(\w+)', '((?:[^']|'')*)'/,
        )
      ) {
        const email = unq(m[2]).toLowerCase();
        const existing = db.users.find((x) => x.email === email);
        // ON CONFLICT(email) DO NOTHING (--upgrade) leaves the row untouched.
        if (st.includes("ON CONFLICT(email) DO NOTHING")) {
          if (!existing) db.users.push({ id: m[1], email, role: "owner" });
        } else {
          const user = existing ?? { id: m[1], email, role: "owner" };
          if (!db.users.includes(user)) db.users.push(user);
          // DO UPDATE ... WHERE users.status = 'active'
          if (isActive(user)) user.role = "owner";
        }
      } else if (
        is(/^SELECT status FROM users WHERE email = '((?:[^']|'')*)'$/)
      ) {
        const email = unq(m[1]).toLowerCase();
        results = db.users
          .filter((u) => u.email === email)
          .map((u) => ({ status: u.status ?? "active" }));
      } else if (is(/^SELECT id FROM users WHERE email = '((?:[^']|'')*)'$/)) {
        const email = unq(m[1]).toLowerCase();
        results = db.users.filter((u) => u.email === email);
      } else if (
        is(
          /^UPDATE tokens SET revoked_at = (\d+) WHERE user_id = \(SELECT id FROM users WHERE email = '((?:[^']|'')*)'\) AND label = 'setup-ci' AND revoked_at IS NULL$/,
        )
      ) {
        const uid = db.users.find(
          (x) => x.email === unq(m[2]).toLowerCase(),
        )?.id;
        for (const x of db.tokens)
          if (x.user_id === uid && x.label === "setup-ci" && !x.revoked_at) {
            x.revoked_at = Number(m[1]);
            changes++;
          }
      } else if (
        is(
          /^UPDATE tokens SET revoked_at = (\d+) WHERE id = '(\w+)' AND revoked_at IS NULL$/,
        )
      ) {
        for (const x of db.tokens)
          if (x.id === m[2] && !x.revoked_at) {
            x.revoked_at = Number(m[1]);
            changes++;
          }
      } else if (
        is(
          /^UPDATE tokens SET revoked_at = (\d+) WHERE user_id = \(SELECT id FROM users WHERE email = '((?:[^']|'')*)'\) AND label = '(setup(?:-ci)?)' AND revoked_at IS NULL AND id <> '(\w+)' AND EXISTS \(SELECT 1 FROM tokens WHERE id = '\w+'\)$/,
        )
      ) {
        const [, at, em, lbl, keep] = m;
        const uid = db.users.find((x) => x.email === unq(em).toLowerCase())?.id;
        for (const x of db.tokens)
          if (
            db.tokens.some((t) => t.id === keep) &&
            x.user_id === uid &&
            x.label === lbl &&
            !x.revoked_at &&
            x.id !== keep
          ) {
            x.revoked_at = Number(at);
            changes++;
          }
      } else if (
        is(
          /^INSERT INTO tokens \(id, user_id, label, token_hash, created_at\) SELECT '(\w+)', id, '(setup(?:-ci)?)', '([0-9a-f]{64})', \d+ FROM users WHERE email = '((?:[^']|'')*)'( AND status = 'active')? AND \(SELECT count\(\*\) FROM tokens WHERE user_id = users\.id AND revoked_at IS NULL\) < (\d+)$/,
        )
      ) {
        const [, id, label, hash, em, onlyActive, cap] = m;
        const found = db.users.find((x) => x.email === unq(em).toLowerCase());
        const user = !onlyActive || isActive(found) ? found : undefined;
        const active = db.tokens.filter(
          (x) => x.user_id === user?.id && !x.revoked_at,
        ).length;
        if (user && active < Number(cap)) {
          changes = 1;
          if (!w.dropTokenInsert)
            db.tokens.push({
              id,
              user_id: user.id,
              label,
              token_hash: hash,
            });
        }
      } else throw new Error(`fake d1: unexpected SQL ${st}`);
      out.push({ results, success: true, meta: { changes } });
    }
    if (sql.includes("INSERT INTO tokens")) ops.push("d1 owner+token");
    if (w.shortResult && sql.includes("INSERT INTO tokens")) out.pop();
    return out;
  };
  const c = core({
    answers: w.answers,
    env: w.env,
    modes: w.fileModes,
    files: {
      ...w.files,
      [join(ROOT, TEMPLATE)]: readFileSync(join(realRoot, TEMPLATE), "utf8"),
      [join(ROOT, WELCOME)]: readFileSync(join(realRoot, WELCOME), "utf8"),
      [join(ROOT, "package.json")]:
        '{ "name": "open-artifacts", "version": "0.1.0" }',
      ...(w.state ? { [STATE]: JSON.stringify(w.state) } : {}),
    },
    exec: async (cmd, args, opts) => {
      argv.push(`${cmd} ${args.join(" ")} ${JSON.stringify(opts ?? {})}`);
      if (
        cmd === "pnpm" &&
        !args.includes("wrangler") &&
        args.at(-1) === "build"
      ) {
        ops.push("build");
        return { code: 0, stdout: "built", stderr: "" };
      }
      if (
        cmd === "node" &&
        args.some((x) => x.endsWith("check-no-test-hooks.ts"))
      ) {
        ops.push(`check-no-test-hooks ${args.at(-1)}`);
        return w.checkHooksFails
          ? {
              code: 1,
              stdout:
                "check-no-test-hooks: FAIL: POST /__test/session -> 200 (want 404)\n",
              stderr: "",
            }
          : {
              code: 0,
              stdout:
                "check-no-test-hooks: ok: 8 /__test/* requests all 404 with TEST_HOOKS=1\n",
              stderr: "",
            };
      }
      if (
        cmd === "node" &&
        args.some((x) => x.endsWith("check-no-fake-idp.ts"))
      ) {
        ops.push(`check-no-fake-idp ${args.at(-1)}`);
        return w.checkFakeIdpFails
          ? {
              code: 1,
              stdout:
                "check-no-fake-idp: FAIL: index.js holds the shim's file name\n",
              stderr: "",
            }
          : {
              code: 0,
              stdout: "check-no-fake-idp: ok: no fake IdP in 1 file\n",
              stderr: "",
            };
      }
      if (cmd === "pnpm" && args[0] === "--version")
        return { code: 0, stdout: "10.11.1\n", stderr: "" };
      const a = args.slice(args.indexOf("wrangler") + 1).join(" ");
      let stdout = "";
      const [, kind, rest] =
        a.match(/^(d1 create|r2 bucket create|kv namespace create) (.+)$/) ??
        [];
      const put = a.match(/^secret put (\w+) --name [\w-]+$/);
      const del = a.match(/^secret delete (\w+) --name [\w-]+$/);
      const exe = a.match(
        /^d1 execute ([\w-]+) --remote --json --command (.+)$/s,
      );
      const rollback = a.match(
        /^rollback (\S+) --name [\w-]+ --message oa:setup --rollback -y$/,
      );
      const mig = a.match(/^d1 migrations apply ([\w-]+) --remote$/);
      if (a.startsWith("secret list ")) {
        if (!secrets)
          return { code: 1, stdout: "", stderr: 'Worker "x" not found.' };
        stdout = `wrangler 4.151.1 [x]\n${JSON.stringify(secrets.filter((n) => !w.hideSecrets?.includes(n)).map((name) => ({ name })))}`;
      } else if (put) {
        values.push(opts?.input ?? "");
        if (put[1] === w.putFails)
          return {
            code: 1,
            stdout: opts?.input ?? "",
            stderr: `put failed: ${JSON.stringify(opts?.input)}`,
          };
        ops.push(`put ${put[1]}`);
        secrets = [...(secrets ?? []), put[1]];
      } else if (del) {
        ops.push(`delete secret ${del[1]}`);
        secrets = secrets?.filter((n) => n !== del[1]);
      } else if (exe) {
        try {
          stdout = `wrangler 4.151.1 (update available [4.152])\n${JSON.stringify(d1(exe[2]))}`;
        } catch (e) {
          return { code: 1, stdout: "", stderr: (e as Error).message };
        }
      } else if (mig) ops.push(`migrate ${mig[1]}`);
      else if (rollback) {
        if (w.rollbackFails)
          return { code: 1, stdout: "", stderr: w.rollbackFails };
        ops.push(`rollback ${rollback[1]}`);
        versions.unshift(rollback[1]);
      } else if (a === "--version") {
        stdout = " ⛅️ wrangler 4.151.1\n";
      } else if (a.startsWith("deploy --dry-run --outdir ")) {
        if (w.dryRunFails)
          return { code: 1, stdout: "", stderr: "dry run failed" };
        const out = a.slice("deploy --dry-run --outdir ".length);
        const body = w.stableBundle ?? `unstable#${++dryRuns}`;
        c.files.set(`${out}/index.js`, body);
        if (w.noisyDryRun) {
          c.files.set(`${out}/index.js.map`, `{"sourceRoot":"${out}"}`);
          c.files.set(`${out}/README.md`, `built ${++dryRuns}`);
        }
        stdout = `--dry-run: exiting now.\n`;
      } else if (a === "deploy") {
        if (w.deployFails)
          return { code: 1, stdout: "", stderr: w.deployFails };
        ops.push("deploy");
        versions.unshift(`ver-${++deployCount}`);
        stdout = `Uploaded x\nDeployed x triggers\nCurrent Version ID: ${versions[0]}\n`;
        deployedConfig = c.files.get(join(ROOT, "apps/server/wrangler.jsonc"));
      } else if (a === "whoami --json") stdout = WHOAMI(acct.accounts);
      else if (a === "auth token --json")
        stdout = '{"type":"oauth","token":"t"}';
      else if (kind === "d1 create")
        acct.d1.push({ uuid: `d1-${acct.d1.length}`, name: rest });
      else if (kind === "r2 bucket create") acct.r2.push({ name: rest });
      else if (kind === "kv namespace create")
        acct.kv.push({ id: `kv-${acct.kv.length}`, title: rest });
      else return { code: 1, stdout: "", stderr: `unknown: ${a}` };
      if (kind) creates.push(a);
      return { code: 0, stdout, stderr: "" };
    },
    fetch: async (input, init) => {
      const appHost = w.appHost ?? "app.example.com";
      const contentHost = w.contentHost ?? "a.b.usercontent.example.com";
      const u = new URL(String(input));
      const m = init?.method ?? "GET";
      const auth = new Headers(init?.headers).get("authorization");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const q = (k: string) => u.searchParams.get(k);
      if (u.host === appHost) {
        if (u.pathname === "/healthz") {
          hits.push("GET /healthz");
          if (w.healthzDown) throw new Error("fetch failed");
          if (w.healthzBody !== undefined)
            return new Response(w.healthzBody, {
              headers: { "content-type": "text/html" },
            });
          if (healthFails-- > 0)
            return new Response("starting", { status: 503 });
          const live = deployedConfig
            ? JSON.parse(stripComments(deployedConfig)).vars?.PLAN
            : undefined;
          const early = w.healthPlanFirst?.length ? 1 : 0;
          const first = w.healthPlanFirst?.shift();
          return Response.json({
            ok: true,
            plan: early ? first : (w.healthPlan ?? live),
            version: w.healthVersion,
          });
        }
        if (u.pathname === "/mcp") {
          const tok = auth?.replace(/^Bearer /, "") ?? "";
          if (tok) bearers.add(tok);
          if (
            !db.tokens.some((t) => t.token_hash === sha(tok) && !t.revoked_at)
          )
            return Response.json({ error: "unauthorized" }, { status: 401 });
          hits.push(`mcp ${body.method}`);
          w.onMcp?.(body.method);
          if (w.mcpThrows && body.method === "tools/list")
            throw new Error(w.mcpThrows(tok));
          const reply = (result: unknown, sse = false) => {
            const msg = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
            return sse
              ? new Response(`event: message\ndata: ${msg}\n\n`, {
                  headers: { "content-type": "text/event-stream" },
                })
              : new Response(msg, {
                  headers: {
                    "content-type": "application/json",
                    "mcp-session-id": "s1",
                  },
                });
          };
          if (body.method === "initialize")
            return reply({ protocolVersion: "2025-06-18", capabilities: {} });
          if (body.method === "notifications/initialized")
            return new Response(null, { status: 202 });
          if (body.method === "tools/list")
            return reply({
              tools: [
                ...(w.noPublishTool ? [] : [{ name: "publish_artifact" }]),
                { name: "get_artifact" },
                ...(w.noSearchTool ? [] : [{ name: "search_artifacts" }]),
                { name: "list_artifacts" },
              ],
            });
          if (body.method === "tools/call") {
            mcpCalls.push(body.params);
            const prev = body.params.arguments.id;
            const err = (text: string) =>
              reply({ isError: true, content: [{ type: "text", text }] }, true);
            if (body.params.name === "list_artifacts") {
              const from = Number(body.params.arguments.cursor ?? 0);
              const limit = Number(body.params.arguments.limit ?? 25);
              const items = pubs
                .slice(from, from + limit)
                .map((x) => ({ access: "owner", ...x }));
              const next =
                from + limit < pubs.length ? `${from + limit}` : null;
              return reply(
                { structuredContent: { items, nextCursor: next } },
                true,
              );
            }
            if (body.params.name === "search_artifacts") {
              const q = String(body.params.arguments.q ?? "").toLowerCase();
              const items = pubs
                .filter((x) => x.title.toLowerCase().includes(q))
                .map((x) => ({ access: "owner", ...x }));
              return reply(
                { structuredContent: { items, nextCursor: null } },
                true,
              );
            }
            if (body.params.name === "get_artifact") {
              const a = pubs.find((x) => x.id === prev);
              if (!a || deleted.includes(a.id))
                return err("not_found: Artifact not found");
              return reply(
                {
                  structuredContent: {
                    id: a.id,
                    title: a.title,
                    version: 1,
                    content: w.welcomeContent ?? lastPublished,
                  },
                },
                true,
              );
            }
            if (w.publishError) return err(w.publishError);
            if (prev && deleted.includes(prev))
              return err("not_found: Artifact not found");
            const target = pubs.find((x) => x.id === prev);
            if (target && (target.access ?? "owner") === "viewer")
              return err("forbidden: you can only view this artifact");
            lastPublished = body.params.arguments.content ?? "";
            const id = prev ?? `art${++published}`;
            if (!pubs.some((x) => x.id === id))
              pubs.push({ id, title: body.params.arguments.title });
            return reply(
              {
                content: [{ type: "text", text: "Published" }],
                structuredContent: {
                  id,
                  version: 1,
                  url: w.viewUrl ?? `https://${appHost}/a/${id}`,
                },
              },
              true,
            );
          }
        }
        const cu = u.pathname.match(
          /^\/api\/v1\/artifacts\/([\w-]+)\/content-url$/,
        );
        if (cu) {
          hits.push("GET content-url");
          if (deleted.includes(cu[1]))
            return new Response("{}", { status: 404 });
          const tok = auth?.replace(/^Bearer /, "") ?? "";
          if (tok) bearers.add(tok);
          if (
            !db.tokens.some((t) => t.token_hash === sha(tok) && !t.revoked_at)
          )
            return Response.json({ error: "unauthorized" }, { status: 401 });
          return Response.json({
            url: `https://${contentHost}/s/sig/${cu[1]}/1/__view`,
            expiresAt: "2026-10-18T00:00:00.000Z",
          });
        }
        return new Response("nf", { status: 404 });
      }
      if (u.host === contentHost) {
        hits.push(`GET content ${auth ? "with auth" : "no auth"}`);
        const last = lastPublished;
        if (w.contentStatus)
          return new Response("denied", { status: w.contentStatus });
        if (w.contentBody !== undefined) return new Response(w.contentBody);
        // Like the real content host: markdown is a render shell whose
        // entry file sits next to the signed view URL.
        if (u.pathname.endsWith("/README.md"))
          return new Response(w.entryBody ?? last, {
            headers: { "content-type": "text/markdown; charset=utf-8" },
          });
        return new Response(
          `<!doctype html><html><head><meta name="oa-entry" content="README.md"><meta name="oa-format" content="markdown"></head><body></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      if (u.host === "cloudflare-dns.com" && u.pathname === "/dns-query") {
        hits.push(`DoH ${q("name")} ${q("type")}`);
        const code = { MX: 15, TXT: 16 }[q("type") ?? ""];
        const Answer = dns
          .filter((r) => r.name === q("name") && r.type === q("type"))
          .map((r) => ({
            name: `${r.name}.`,
            type: code,
            data: r.type === "MX" ? `10 ${r.content}.` : r.content,
          }));
        return Response.json({
          Status: 0,
          ...(Answer.length ? { Answer } : {}),
        });
      }
      if (u.host.endsWith(".cloudflareaccess.com")) {
        hits.push(`GET ${u.pathname}`);
        if (discoveryFails-- > 0)
          return new Response("unavailable", { status: 503 });
        const base = u.pathname.replace(
          /\/\.well-known\/openid-configuration$/,
          "",
        );
        return Response.json({
          issuer: w.issuer ?? `https://${u.host}${base}`,
        });
      }
      const p = u.pathname.replace("/client/v4", "");
      auths.push(`${p} ${auth}`);
      if (p === "/user/tokens/verify") {
        const b = (auth ?? "").replace(/^Bearer /, "");
        return envelope({ id: w.tokenIds?.[b] ?? `id-${b}`, status: "active" });
      }
      const r2 = p.match(/\/r2\/buckets\/([^/]+)$/);
      const acc = p.match(/\/access\/(organizations|policies|apps)\/?(.*)$/);
      if (acc?.[1] === "organizations") {
        if (w.org === "forbidden" && auth === "Bearer t")
          return envelope(null, 403, [
            { code: 10000, message: "Authentication error" },
          ]);
        if (w.org === "404")
          return envelope(null, 404, [{ code: 7003, message: "not found" }]);
        return envelope(
          w.org === "none"
            ? null
            : { auth_domain: "team.cloudflareaccess.com" },
        );
      }
      if (acc && m === "GET" && w.accessReadThrows)
        throw new Error(w.accessReadThrows);
      if (acc && m === "GET" && w.accessReadStatus)
        return envelope(null, w.accessReadStatus, [
          { code: 10000, message: "gateway timeout" },
        ]);
      if (acc && m === "GET")
        return paged(acc[1] === "apps" ? apps : policies, q, w.noResultInfo);
      if (acc) ops.push(`${m} ${acc[1]}${acc[2] ? `/${acc[2]}` : ""}`);
      if (acc?.[1] === "policies" && m === "POST") {
        policies.push({ ...body, id: "pol1" });
        return envelope({ ...body, id: "pol1" });
      }
      if (acc?.[1] === "policies" && m === "PUT") {
        policies[policies.findIndex((x) => x.id === acc[2])] = {
          ...body,
          id: acc[2],
        };
        return envelope({ ...body, id: acc[2] });
      }
      if (acc?.[1] === "apps" && m === "POST" && w.appsPostForbidden)
        return envelope(null, 403, [
          { code: 10000, message: "Authentication error" },
        ]);
      if (acc?.[1] === "apps" && m === "POST") {
        const made = {
          ...app(body.name, body.policies),
          saas_app: {
            ...body.saas_app,
            client_id: "cid-new",
            client_secret: "CLIENT-SECRET-xyz",
          },
        };
        values.push("CLIENT-SECRET-xyz");
        apps.push(made);
        return envelope({ ...made, created_body: body });
      }
      if (acc?.[1] === "apps" && m === "DELETE") {
        if (w.deleteFails) return envelope(null, 500, [{ message: "boom" }]);
        apps.splice(
          apps.findIndex((x) => x.id === acc[2]),
          1,
        );
        return envelope({ id: acc[2] });
      }
      if (p === "/zones") {
        zoneQueries.push(u.search);
        const ok =
          q("status") === "active" && acct.zones.includes(q("name") ?? "");
        const id = w.zoneIds?.[q("name") ?? ""] ?? "z";
        return envelope(ok ? [{ id, name: q("name") }] : []);
      }
      // DNS, billing and email are read-only here: a write is a bug.
      if (m !== "GET" && /\/dns_records|\/subscriptions|\/email/.test(p)) {
        ops.push(`WRITE ${m} ${p}`);
        return envelope(null, 405, [{ message: "method not allowed" }]);
      }
      if (/^\/zones\/[^/]+\/dns_records$/.test(p)) {
        if (w.dnsForbidden)
          return envelope(null, 403, [
            { code: 10000, message: "Authentication error" },
          ]);
        return paged(
          dns
            .filter((r) => r.name === q("name") && r.type === q("type"))
            .map((r, i) => ({ id: `r${i}`, ...r })),
          q,
        );
      }
      if (p.endsWith("/subscriptions")) {
        if (!subscriptions)
          return envelope(null, 403, [
            { code: 10000, message: "Authentication error" },
          ]);
        return Array.isArray(subscriptions)
          ? paged(subscriptions, q)
          : envelope(subscriptions);
      }
      // The real ?name= filter is a fuzzy match, so exact names may sit past page 1.
      if (p.endsWith("/d1/database"))
        return paged(
          acct.d1.filter((d) => d.name.includes(q("name") ?? "")),
          q,
        );
      if (p.match(/\/workers\/scripts\/[^/]+\/deployments$/) && m === "GET") {
        if (w.deploymentsForbidden)
          return envelope(null, 403, [{ message: "Authentication error" }]);
        if (w.deploymentsFail)
          return envelope(null, 500, [{ message: "internal error" }]);
        if (!versions.length)
          return envelope(null, 404, [
            {
              code: 10007,
              message: "This Worker does not exist on your account.",
            },
          ]);
        return envelope({
          deployments: versions.map((v, i) => ({
            id: `dep-${i}`,
            versions: w.splitDeployment
              ? [
                  { version_id: v, percentage: 50 },
                  { version_id: `${v}-b`, percentage: 50 },
                ]
              : [{ version_id: v, percentage: 100 }],
          })),
        });
      }
      const settings = p.match(/\/workers\/scripts\/([^/]+)\/settings$/);
      if (settings && m === "GET" && w.settingsForbidden)
        return envelope(null, 403, [{ message: "Authentication error" }]);
      if (settings && m === "GET" && w.settingsFail)
        return envelope(null, 500, [{ message: "internal error" }]);
      if (settings && m === "GET" && w.settingsPartial) return envelope({});
      if (settings && m === "GET") {
        const full = deployedConfig
          ? JSON.parse(stripComments(deployedConfig))
          : undefined;
        const cfg = full ? full.vars : w.worker;
        if (!cfg && !secrets)
          return envelope(null, 404, [
            {
              code: 10007,
              message: "This Worker does not exist on your account.",
            },
          ]);
        const bindings = [
          ...Object.entries(cfg ?? {}).map(([name, text]) => ({
            type: "plain_text",
            name,
            text,
          })),
          ...(secrets ?? []).map((name) => ({ type: "secret_text", name })),
          ...(w.workerBindings ?? []),
          ...(w.dropSendEmail ? [] : (full?.send_email ?? [])).map(
            (b: { name: string }) => ({ type: "send_email", name: b.name }),
          ),
          ...(full?.browser
            ? [{ type: "browser", name: full.browser.binding }]
            : []),
        ];
        return envelope({ bindings });
      }
      if (r2) {
        const b = acct.r2.find((x) => x.name === r2[1]);
        return b
          ? envelope(b)
          : envelope(null, 404, [
              { code: 10006, message: "The specified bucket does not exist." },
            ]);
      }
      if (p.endsWith("/storage/kv/namespaces")) return paged(acct.kv, q);
      return envelope(null, 404, [{ message: "no route" }]);
    },
  });
  /** Every exec result's stdout and stderr, for leak scans. */
  const execOut: string[] = [];
  const innerExec = c.deps.exec;
  c.deps.exec = async (...a) => {
    const r = await innerExec(...a);
    execOut.push(r.stdout, r.stderr);
    return r;
  };
  return {
    ...c,
    execOut,
    argv,
    hits,
    mcpCalls,
    bearers,
    deleted,
    sqls,
    db,
    deployed: () => deployedConfig,
    auths,
    creates,
    zoneQueries,
    dns,
    setSubscriptions: (x: Obj[] | undefined) => {
      subscriptions = x;
    },
    acct,
    ops,
    values,
    policies,
    apps,
  };
}

export const HOSTS = [
  ...["--name", "open-artifacts"],
  ...[
    "--app-host",
    "app.example.com",
    "--content-host",
    "a.b.usercontent.example.com",
  ],
  ...["--owner-email", "owner@example.com", "--yes", "--json"],
  "--solo",
];
/** HOSTS without --solo: for --team runs and the no-choice cases. */
export const BASE = HOSTS.filter((a) => a !== "--solo");
