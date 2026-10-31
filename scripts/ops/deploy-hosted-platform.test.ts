import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, sandbox, write } from "../ci/stubs.ts";
// @ts-expect-error untyped .mjs
import { envSection } from "./wrangler-env.mjs";

// deploy-hosted-platform.sh: deploy through the allowlisted wrapper, secrets only
// after the Worker exists (Google secrets every run, state keys only when
// absent), then the deployed settings read back and checked. Secrets reach
// wrangler on stdin and the token reaches curl on stdin, never argv.
const SCRIPT = join(root, "scripts/ops/deploy-hosted-platform.sh");
const ACCT = "26ac346086d4405f7a976d48747a2a75";
const TOKEN = "cf-token-SHOULD-NEVER-APPEAR";
const REG = "126a6ed45b8842ccb42b8c55a9467760";
const DIRREG = "55d5f7d77ef240e5a2255fe43f2c5170";
const HOSTS = "32737a5cd6224418bf14e15fa2732bab";
const DB = "6ca9103e-507e-4541-b3bb-2485e699512b";
const ZONE = "eb90975c0a329d0c743fa4f33f917934";
const CLIENT =
  "206295999771-ntbp6nlf5ospa45ovc73aur4f05fpp5s.apps.googleusercontent.com";
const DCLIENT =
  "206295999771-6cr3mbfc7g2ejnvdoqhlf2v8v6sdm023.apps.googleusercontent.com";
const SECRET = "google-secret-SHOULD-NEVER-APPEAR";
const DSECRET = "directory-secret-SHOULD-NEVER-APPEAR";

// pnpm: `exec wrangler deploy` marks the app's Worker deployed (its next
// settings become live); `exec wrangler secret put NAME` records NAME and only
// the value's length (stdin).
const pnpm = `
p=p; case "$*" in *"--env staging"*) p=s ;; esac
w="oa-$p-$(basename "$PWD")"
for ((i = 1; i <= $#; i++)); do [ "\${!i}" = --name ] && { j=$((i + 1)); w="\${!j}"; }; done
case "$*" in
  "exec wrangler deploy"*)
    touch "$STATE/$w.exists"
    [ -f "$STATE/$w.next.json" ] && cp "$STATE/$w.next.json" "$STATE/$w.settings.json"
    ;;
  "exec wrangler secret put"*)
    v="$(cat)"
    echo "stdin-len $5 \${#v}" >> "$STUB_LOG"
    touch "$STATE/$w.secrets"; grep -qx "$5" "$STATE/$w.secrets" || echo "$5" >> "$STATE/$w.secrets"
    ;;
esac`;
// curl: the -K - config must carry the token; answers by path. Writes are
// logged as "WRITE <method> /<path> <body>".
const curl = `
cfg="$(cat)"
case "$cfg" in *"Bearer $EXPECT_TOKEN"*) ;; *) echo '{"success":false,"errors":[{"code":10000}]}'; exit 0 ;; esac
url="\${@: -1}"
m=GET; body=""; wcode=""
for ((i = 1; i <= $#; i++)); do
  case "\${!i}" in
    -X) j=$((i + 1)); m="\${!j}" ;;
    --data-binary) j=$((i + 1)); body="\${!j}" ;;
    -w) wcode=1 ;;
  esac
done
path="$(printf %s "$url" | sed -E 's#^.*/accounts/[0-9a-f]+/##')"
[ "$m" = GET ] || echo "WRITE $m /$path $body" >> "$STUB_LOG"
ok() { echo "{\\"success\\":true,\\"result\\":$1}"; }
bad() { echo '{"success":false,"errors":[{"code":1}]}'; }
case "$path" in
  queues\\?*) [ -f "$STATE/fail-queues" ] && { bad; exit 0; }; ok "$(cat "$STATE/queues.json" 2>/dev/null || echo '[]')"; exit 0 ;;
  queues)
    jq -c --argjson b "$body" '. + [{queue_name: $b.queue_name}]' "$STATE/queues.json" 2>/dev/null > "$STATE/q.new" || jq -nc --argjson b "$body" '[{queue_name: $b.queue_name}]' > "$STATE/q.new"
    mv "$STATE/q.new" "$STATE/queues.json"; ok '{}'; exit 0 ;;
  r2/buckets/*) n="\${path#r2/buckets/}"
    if [ -f "$STATE/fail-r2" ]; then bad; elif [ -f "$STATE/r2-$n" ]; then ok '{}'; else echo '{"success":false,"errors":[{"code":10006}]}'; fi; exit 0 ;;
  r2/buckets) touch "$STATE/r2-$(jq -r .name <<< "$body")"; ok '{}'; exit 0 ;;
  storage/kv/namespaces\\?*) [ -f "$STATE/fail-kvns" ] && { bad; exit 0; }; ok "$(cat "$STATE/kvns.json" 2>/dev/null || echo '[]')"; exit 0 ;;
  storage/kv/namespaces)
    jq -c --argjson b "$body" --arg id "$NEW_KV" '. + [{id: $id, title: $b.title}]' "$STATE/kvns.json" 2>/dev/null > "$STATE/k.new" || jq -nc --argjson b "$body" --arg id "$NEW_KV" '[{id: $id, title: $b.title}]' > "$STATE/k.new"
    mv "$STATE/k.new" "$STATE/kvns.json"; ok "{\\"id\\":\\"$NEW_KV\\"}"; exit 0 ;;
  storage/kv/namespaces/*/values/*)
    ns="\${path#storage/kv/namespaces/}"; ns="\${ns%%/*}"; key="\${path##*/values/}"; f="$STATE/kv-$ns-$key"
    if [ "$m" = PUT ]; then printf %s "$body" > "$f"; ok '{}'
    elif [ -f "$f" ]; then cat "$f"; [ -z "$wcode" ] || printf '\\n200'
    else echo '{"success":false,"errors":[{"code":10009}]}'; [ -z "$wcode" ] || printf '\\n404'; fi
    exit 0 ;;
  secrets_store/stores/*/secrets\\?*) [ -f "$STATE/fail-store" ] && { bad; exit 0; }; ok "$(cat "$STATE/store-secrets.json" 2>/dev/null || echo '[]')"; exit 0 ;;
  workers/scripts/*/content/v2) w="\${path#workers/scripts/}"; w="\${w%%/*}"; cat "$STATE/$w.content" 2>/dev/null || echo 'export default {};'; exit 0 ;;
esac
w="$(printf %s "$url" | sed -E 's#.*/workers/scripts/([^/]+)/.*#\\1#')"
kind="\${url##*/}"
case "$kind" in
  settings)
    if [ -f "$STATE/$w.exists" ] && [ -f "$STATE/$w.settings.json" ]; then cat "$STATE/$w.settings.json"
    elif [ -f "$STATE/$w.exists" ]; then echo '{"success":true,"result":{"bindings":[]}}'
    else echo '{"success":false,"errors":[{"code":10007,"message":"not found"}]}'; fi ;;
  secrets)
    if [ -f "$STATE/fail-secrets" ]; then echo '{"success":false,"errors":[{"code":1}]}'
    else touch "$STATE/$w.secrets"; jq -nR '{success: true, result: [inputs | select(length > 0) | {name: .}]}' < "$STATE/$w.secrets"; fi ;;
  schedules) cat "$STATE/$w.schedules.json" ;;
esac`;
const openssl = `echo "c3RhdGVrZXlzdGF0ZWtleXN0YXRla2V5c3RhdGVrZXk="`;
// The deploy wrapper has its own tests; here a stub records its argv and the
// values it was given, then marks the app's Worker deployed.
const wrapperStub = (dir: string) => {
  const p = join(dir, "wrapper.sh");
  writeFileSync(
    p,
    `#!/usr/bin/env bash
echo "wrapper $* reg=\${BROKER_REGISTRY_ID:-}\${DIRECTORY_REGISTRY_ID:-} client=\${GOOGLE_CLIENT_ID_PROD:-}\${GOOGLE_DIRECTORY_CLIENT_ID_PROD:-} hosts=\${HOSTS_KV_ID:-} db=\${PLATFORM_DB_ID:-}" >> "$STUB_LOG"
w="oa-$([ "$2" = staging ] && echo s || echo p)-$1"
touch "$STATE/$w.exists"
[ -f "$STATE/$w.next.json" ] && cp "$STATE/$w.next.json" "$STATE/$w.settings.json"
exit 0
`,
  );
  return p;
};

const settings = (bindings: Record<string, unknown>[], obs = false) =>
  JSON.stringify({
    success: true,
    result: { bindings, observability: { enabled: obs } },
  });
const NEXT: Record<string, string> = {
  "oa-p-auth-broker": settings([
    { type: "kv_namespace", name: "BROKER_REGISTRY", namespace_id: REG },
    { type: "plain_text", name: "GOOGLE_CLIENT_ID", text: CLIENT },
    {
      type: "plain_text",
      name: "BROKER_ORIGIN",
      text: "https://auth.open-artifacts.app",
    },
  ]),
  "oa-p-directory-broker": settings([
    { type: "kv_namespace", name: "DIRECTORY_REGISTRY", namespace_id: DIRREG },
    { type: "plain_text", name: "GOOGLE_DIRECTORY_CLIENT_ID", text: DCLIENT },
    {
      type: "plain_text",
      name: "DIRECTORY_ORIGIN",
      text: "https://directory.open-artifacts.app",
    },
  ]),
  "oa-p-dispatch": settings([
    { type: "kv_namespace", name: "HOSTS", namespace_id: HOSTS },
    { type: "dispatch_namespace", name: "DISPATCHER", namespace: "oa-prod" },
    { type: "service", name: "AUTH_BROKER", service: "oa-p-auth-broker" },
    {
      type: "service",
      name: "DIRECTORY_BROKER",
      service: "oa-p-directory-broker",
    },
    { type: "plain_text", name: "OA_ENV", text: "prod" },
  ]),
  "oa-p-inventory": settings([
    { type: "d1", name: "PLATFORM_DB", id: DB },
    { type: "kv_namespace", name: "HOSTS", namespace_id: HOSTS },
  ]),
  "oa-p-scheduler": settings(
    [
      { type: "d1", name: "PLATFORM_DB", id: DB },
      { type: "dispatch_namespace", name: "DISPATCHER", namespace: "oa-prod" },
      { type: "plain_text", name: "OA_ENV", text: "prod" },
      { type: "plain_text", name: "EMAIL_QUOTA_ZONES", text: ZONE },
      { type: "plain_text", name: "EMAIL_DAILY_LIMIT", text: "1000" },
    ],
    true,
  ),
};

// The Provisioning API Workers (design v7 10.2): vars and rate limits as the
// tag commits them, placeholders filled as the deploy fills them.
const STORE = "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";
const OAUTH = "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a";
const REPO_ID = "1012345678";
const FILLS = {
  SIGNUP_DAILY_CAP: "20",
  SIGNUPS_ENABLED: "false",
  WELCOME_FROM: "welcome@open-artifacts.app",
  ACCOUNT_ID: ACCT,
  GITHUB_REPOSITORY_ID: REPO_ID,
};
const committedVars = (app: string, env: "staging" | "prod") =>
  Object.entries(
    envSection(
      readFileSync(join(root, "apps", app, "wrangler.jsonc"), "utf8"),
      env,
      "vars",
      FILLS,
    ) as Record<string, string>,
  ).map(([name, text]) => ({ type: "plain_text", name, text }));
const ratelimits = (env: "staging" | "prod") =>
  (
    envSection(
      readFileSync(join(root, "apps/provisioning/wrangler.jsonc"), "utf8"),
      env,
      "ratelimits",
      {},
    ) as { name: string; namespace_id: string; limit: number; period: number }[]
  ).map((r) => ({
    type: "ratelimit",
    name: r.name,
    namespace_id: r.namespace_id,
    simple: { limit: r.limit, period: r.period },
  }));
const provisionerSettings = (p = "p", env: "staging" | "prod" = "prod") =>
  settings([
    { type: "d1", name: "PLATFORM_DB", id: DB },
    {
      type: "dispatch_namespace",
      name: "DISPATCHER",
      namespace: `oa-${env}`,
    },
    { type: "r2_bucket", name: "RELEASES", bucket_name: `oa-${p}-releases` },
    { type: "send_email", name: "WELCOME_EMAIL" },
    {
      type: "secrets_store_secret",
      name: "PROVISION_TOKEN",
      store_id: STORE,
      secret_name: `oa-${p}-provision-token`,
    },
    {
      type: "workflow",
      name: "PROVISION_INSTALL",
      workflow_name: `oa-${p}-provision-install`,
      class_name: "ProvisionInstall",
    },
    {
      type: "workflow",
      name: "MANAGE_INSTALL",
      workflow_name: `oa-${p}-manage-install`,
      class_name: "ManageInstall",
    },
    ...committedVars("provisioner", env),
  ]);
const provisioningBindings = (p = "p", env: "staging" | "prod" = "prod") => [
  { type: "d1", name: "PLATFORM_DB", id: DB },
  { type: "kv_namespace", name: "OAUTH_KV", namespace_id: OAUTH },
  {
    type: "service",
    name: "PROVISIONER",
    service: `oa-${p}-provisioner`,
    entrypoint: "ProvisionerRpc",
  },
  { type: "service", name: "AUTH_BROKER", service: `oa-${p}-auth-broker` },
  { type: "queue", name: "SIGNUPS", queue_name: `oa-${p}-signups` },
  { type: "assets", name: "ASSETS" },
  ...[
    "PROVISION_INSTALL:ProvisionInstall:provision",
    "MANAGE_INSTALL:ManageInstall:manage",
  ].map((w) => {
    const [name, cls, n] = w.split(":");
    return {
      type: "workflow",
      name,
      workflow_name: `oa-${p}-${n}-install`,
      class_name: cls,
      script_name: `oa-${p}-provisioner`,
    };
  }),
  ...ratelimits(env),
  ...committedVars("provisioning", env),
  { type: "secret_text", name: "ADMIN_SESSION_KEY" },
  { type: "secret_text", name: "ADMIN_BROKER_KEY" },
];
NEXT["oa-p-provisioner"] = provisionerSettings();
NEXT["oa-p-provisioning"] = settings(provisioningBindings());

const ENV = {
  // Not in CI by default (CI sets these, and prod there needs main).
  GITHUB_ACTIONS: "",
  GITHUB_REF: "",
  DEPLOY_ENVIRONMENT: "",
  CLOUDFLARE_API_TOKEN: TOKEN,
  EXPECT_TOKEN: TOKEN,
  CLOUDFLARE_ACCOUNT_ID: ACCT,
  BROKER_REGISTRY_ID: REG,
  GOOGLE_CLIENT_ID: CLIENT,
  GOOGLE_CLIENT_SECRET: SECRET,
  DIRECTORY_REGISTRY_ID: DIRREG,
  GOOGLE_DIRECTORY_CLIENT_ID: DCLIENT,
  GOOGLE_DIRECTORY_CLIENT_SECRET: DSECRET,
  HOSTS_KV_ID: HOSTS,
  PLATFORM_DB_ID: DB,
  EMAIL_ZONE_TAGS: ZONE,
  EMAIL_DAILY_LIMIT: "1000",
  INVENTORY_KEY: "k".repeat(64),
  SECRETS_STORE_ID: STORE,
  SIGNUP_DAILY_CAP: FILLS.SIGNUP_DAILY_CAP,
  SIGNUPS_ENABLED: FILLS.SIGNUPS_ENABLED,
  WELCOME_FROM: FILLS.WELCOME_FROM,
  GITHUB_REPOSITORY_ID: REPO_ID,
  NEW_KV: OAUTH,
};

const setup = (
  opts: {
    exists?: string[];
    secrets?: Record<string, string[]>;
    next?: Record<string, string>;
    failSecrets?: boolean;
    pins?: { staging?: string | null; prod?: string | null };
    /** Extra state files (name -> content). */
    files?: Record<string, string>;
    /** Stub node (logs its argv, exits $NODE_EXIT). */
    node?: boolean;
  } = {},
) => {
  const sb = sandbox({
    pnpm,
    curl,
    openssl,
    ...(opts.node ? { node: `exit "\${NODE_EXIT:-0}"` } : {}),
  });
  const state = join(sb.dir, "state");
  mkdirSync(state);
  for (const [w, s] of Object.entries({ ...NEXT, ...opts.next }))
    writeFileSync(join(state, `${w}.next.json`), s);
  writeFileSync(
    join(state, "oa-p-scheduler.schedules.json"),
    JSON.stringify({
      success: true,
      result: { schedules: [{ cron: "17 3 * * *" }, { cron: "*/2 * * * *" }] },
    }),
  );
  for (const w of opts.exists ?? []) {
    writeFileSync(join(state, `${w}.exists`), "");
    if (NEXT[w])
      writeFileSync(join(state, `${w}.settings.json`), NEXT[w] as string);
  }
  for (const [w, names] of Object.entries(opts.secrets ?? {}))
    writeFileSync(join(state, `${w}.secrets`), `${names.join("\n")}\n`);
  if (opts.failSecrets) writeFileSync(join(state, "fail-secrets"), "");
  for (const [f, v] of Object.entries(opts.files ?? {}))
    writeFileSync(join(state, f), v);
  // Provision's pin, as main's wfp.ts states it (stubbed: prod's real pin is
  // PR #875's).
  const pinFile = join(sb.dir, "wfp.ts");
  writeFileSync(
    pinFile,
    `export const BROKER_GOOGLE_CLIENT_ID: Readonly<Record<Env, string | null>> =\n  Object.freeze({\n    staging:\n      ${JSON.stringify(opts.pins?.staging === undefined ? CLIENT : opts.pins.staging)},\n    prod: ${JSON.stringify(opts.pins?.prod === undefined ? CLIENT : opts.pins.prod)},\n  });\n`,
  );
  const run = (
    target: string,
    env: Record<string, string> = {},
    envName = "prod",
  ) => {
    const r = sb.run(["bash", SCRIPT, envName, target], {
      env: {
        ...ENV,
        STATE: state,
        DEPLOY_WRAPPER: wrapperStub(sb.dir),
        BROKER_PIN_FILE: pinFile,
        ...env,
      },
    });
    const log = sb.log();
    return { ...r, log, writes: log.filter((l) => l.startsWith("WRITE")) };
  };
  return { run, state, sb };
};
// Nothing secret in any argv, stdout or stderr.
const clean = (r: { out: string; err: string; log: string[] }) => {
  const all = [r.out, r.err, ...r.log].join("\n");
  for (const s of [TOKEN, SECRET, DSECRET, "k".repeat(64), "c3RhdGVrZXlz"])
    expect(all).not.toContain(s);
};
const puts = (log: string[]) =>
  log.filter((l) => l.startsWith("stdin-len")).map((l) => l.split(" ")[1]);

describe("deploy-hosted-platform.sh", () => {
  it("auth-broker refuses a client that isn't provision's pin, or a null pin, before any wrangler call", () => {
    for (const [pins, msg] of [
      [
        { prod: "other.apps.googleusercontent.com" },
        "differs from provision's BROKER_GOOGLE_CLIENT_ID[prod]",
      ],
      [{ prod: null }, "BROKER_GOOGLE_CLIENT_ID[prod] is null in provision"],
    ] as const) {
      for (const verify of ["", "1"]) {
        const r = setup({ pins }).run("auth-broker", { VERIFY_ONLY: verify });
        expect(r.code, msg).toBe(1);
        expect(r.err).toContain(msg);
        expect(r.log.filter((l) => /^(pnpm|wrapper|curl) /.test(l))).toEqual(
          [],
        );
      }
    }
    // Staging's own pin, checked for staging only.
    const r = setup({ pins: { staging: "other" } }).run("auth-broker");
    expect(r.code, r.err).toBe(0);
  });
  it("auth-broker refuses when the pin can't be read", () => {
    for (const BROKER_PIN_FILE of ["/nonexistent/wfp.ts", ""]) {
      const r = setup().run("auth-broker", { BROKER_PIN_FILE });
      expect(r.code).not.toBe(0);
      expect(r.log.filter((l) => /^(pnpm|wrapper) /.test(l))).toEqual([]);
    }
  });
  it("auth-broker, first run: deploys prod, sets the Google secret and a new state key, verifies", () => {
    const s = setup();
    const r = s.run("auth-broker");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const w = r.log.find((l) => l.startsWith("wrapper auth-broker prod "));
    expect(w).toContain(`reg=${REG}`);
    expect(w).toContain(`client=${CLIENT}`);
    expect(puts(r.log)).toEqual(["GOOGLE_CLIENT_SECRET", "BROKER_STATE_KEY"]);
    expect(
      r.log
        .filter((l) => l.startsWith("stdin-len"))
        .every((l) => !l.endsWith(" 0")),
    ).toBe(true);
    expect(r.out).toContain("prod auth-broker: deployed and verified");
    clean(r);
  });
  it("a re-run keeps the state key (sets only the Google secret)", () => {
    const s = setup({
      secrets: {
        "oa-p-auth-broker": ["BROKER_STATE_KEY", "GOOGLE_CLIENT_SECRET"],
      },
    });
    const r = s.run("auth-broker");
    expect(r.code).toBe(0);
    expect(puts(r.log)).toEqual(["GOOGLE_CLIENT_SECRET"]);
  });
  it("a failed secrets listing stops before any state key is made", () => {
    const s = setup({ failSecrets: true });
    const r = s.run("auth-broker");
    expect(r.code).toBe(1);
    expect(puts(r.log)).toEqual([]);
    expect(r.err).toContain("list oa-p-auth-broker secrets failed");
    clean(r);
  });
  it("a deployed binding that doesn't match fails the run", () => {
    const bad = NEXT["oa-p-auth-broker"]?.replace(
      REG,
      "f".repeat(32),
    ) as string;
    const s = setup({ next: { "oa-p-auth-broker": bad } });
    const r = s.run("auth-broker");
    expect(r.code).toBe(1);
    expect(r.err).toContain("BROKER_REGISTRY: got");
  });
  it("directory-broker: its own secret and state key", () => {
    const s = setup();
    const r = s.run("directory-broker");
    expect(r.code).toBe(0);
    expect(puts(r.log)).toEqual([
      "GOOGLE_DIRECTORY_CLIENT_SECRET",
      "DIRECTORY_STATE_KEY",
    ]);
    clean(r);
  });
  it("dispatch and the scheduler refuse until both brokers exist, then deploy and verify", () => {
    for (const t of ["dispatch", "scheduler"]) {
      const none = setup().run(t);
      expect(none.code, t).toBe(1);
      expect(none.err).toContain("oa-p-auth-broker does not exist");
      expect(none.log.some((l) => l.startsWith("wrapper"))).toBe(false);
      const ok = setup({
        exists: ["oa-p-auth-broker", "oa-p-directory-broker"],
      }).run(t);
      expect(ok.err, t).toBe("");
      expect(ok.code, t).toBe(0);
      clean(ok);
    }
  });
  it("the scheduler checks its two schedules exactly", () => {
    const s = setup({ exists: ["oa-p-auth-broker", "oa-p-directory-broker"] });
    writeFileSync(
      join(s.state, "oa-p-scheduler.schedules.json"),
      JSON.stringify({
        success: true,
        result: { schedules: [{ cron: "17 3 * * *" }] },
      }),
    );
    const r = s.run("scheduler");
    expect(r.code).toBe(1);
    expect(r.err).toContain("schedules are '17 3 * * *'");
  });
  it("inventory-key: sets the key on the existing Worker over stdin; refuses a short key or a missing Worker", () => {
    const ok = setup({ exists: ["oa-p-inventory"] }).run("inventory-key");
    expect(ok.code).toBe(0);
    expect(ok.log).toContain(
      "pnpm exec wrangler secret put INVENTORY_KEY --env prod",
    );
    expect(puts(ok.log)).toEqual(["INVENTORY_KEY"]);
    clean(ok);
    expect(
      setup({ exists: ["oa-p-inventory"] }).run("inventory-key", {
        INVENTORY_KEY: "short",
      }).code,
    ).toBe(2);
    expect(setup().run("inventory-key").code).toBe(1);
  });
  it("missing inputs, a bad account id or an unknown target refuse before any call", () => {
    for (const [t, env] of [
      ["auth-broker", { GOOGLE_CLIENT_ID: "" }],
      ["auth-broker", { CLOUDFLARE_ACCOUNT_ID: "nope" }],
      ["platform-db", { PLATFORM_DB_ID: "" }],
      ["provision-token", { SECRETS_STORE_ID: "" }],
      ["provisioner", { WELCOME_FROM: "" }],
      ["provisioning", { GITHUB_REPOSITORY_ID: "" }],
      ["inventory", { GITHUB_REPOSITORY_ID: "" }],
      ["dispatch", { HOSTS_KV_ID: "" }],
      ["bogus", {}],
    ] as const) {
      const r = setup().run(t, env);
      expect(r.code, `${t} ${JSON.stringify(env)}`).toBe(2);
      expect(
        r.log.filter((l) => l.startsWith("pnpm") || l.startsWith("curl")),
      ).toEqual([]);
    }
  });
  it("staging: the oa-s names, the staging origin and --env staging", () => {
    const s = setup({
      next: {
        "oa-s-auth-broker": (NEXT["oa-p-auth-broker"] as string).replace(
          "https://auth.open-artifacts.app",
          "https://auth.open-artifacts-staging.app",
        ),
      },
    });
    const r = s.run("auth-broker", {}, "staging");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(
      r.log.some((l) => l.startsWith("wrapper auth-broker staging ")),
    ).toBe(true);
    expect(r.log).toContain(
      "pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET --env staging",
    );
    expect(r.out).toContain("staging auth-broker: deployed and verified");
    clean(r);
  });
  it("verify only: no deploy and no secret written, every check still runs", () => {
    const s = setup({
      exists: ["oa-p-auth-broker"],
      secrets: {
        "oa-p-auth-broker": ["BROKER_STATE_KEY", "GOOGLE_CLIENT_SECRET"],
      },
    });
    const r = s.run("auth-broker", {
      VERIFY_ONLY: "1",
      GOOGLE_CLIENT_SECRET: "",
    });
    expect(r.code).toBe(0);
    expect(
      r.log.filter((l) => l.startsWith("wrapper") || l.startsWith("pnpm")),
    ).toEqual([]);
    expect(r.out).toContain("prod auth-broker: verified (verify only)");
    const bad = setup({
      exists: ["oa-p-auth-broker"],
      next: {
        "oa-p-auth-broker": (NEXT["oa-p-auth-broker"] as string).replace(
          REG,
          "f".repeat(32),
        ),
      },
      secrets: {
        "oa-p-auth-broker": ["BROKER_STATE_KEY", "GOOGLE_CLIENT_SECRET"],
      },
    });
    writeFileSync(
      join(bad.state, "oa-p-auth-broker.settings.json"),
      (NEXT["oa-p-auth-broker"] as string).replace(REG, "f".repeat(32)),
    );
    expect(bad.run("auth-broker", { VERIFY_ONLY: "1" }).code).toBe(1);
  });
  it("inventory: deploys through the wrapper with its two ids and verifies exactly two bindings", () => {
    const r = setup().run("inventory");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const w = r.log.find((l) => l.startsWith("wrapper inventory prod "));
    expect(w).toContain(`hosts=${HOSTS}`);
    expect(w).toContain(`db=${DB}`);
    const extra = setup({
      next: {
        "oa-p-inventory": settings([
          { type: "d1", name: "PLATFORM_DB", id: DB },
          { type: "kv_namespace", name: "HOSTS", namespace_id: HOSTS },
          { type: "r2_bucket", name: "EXTRA", bucket_name: "x" },
        ]),
      },
    }).run("inventory");
    expect(extra.code).toBe(1);
    expect(extra.err).toContain("bindings: got 'EXTRA,HOSTS,PLATFORM_DB'");
  });
  it("in CI, prod runs only from main in hosted-prod-deploy; staging is not held to that", () => {
    const ci = {
      GITHUB_ACTIONS: "true",
      DEPLOY_ENVIRONMENT: "hosted-prod-deploy",
    };
    expect(
      setup().run("auth-broker", { ...ci, GITHUB_REF: "refs/heads/feature" })
        .code,
    ).toBe(2);
    expect(
      setup().run("auth-broker", {
        ...ci,
        GITHUB_REF: "refs/heads/main",
        DEPLOY_ENVIRONMENT: "hosted-staging-deploy",
      }).code,
    ).toBe(2);
    expect(
      setup().run("auth-broker", { ...ci, GITHUB_REF: "refs/heads/main" }).code,
    ).toBe(0);
  });
  it("refuses an env other than staging or prod", () => {
    expect(setup().run("auth-broker", {}, "dev").code).toBe(2);
  });
  it("deploys through the allowlisted wrapper by default; the token never in curl's argv", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toContain(
      'wrapper="${DEPLOY_WRAPPER:-$root/scripts/ops/deploy-platform-worker.sh}"',
    );
    expect(src).not.toMatch(/Bearer \$|-H "Authorization/);
  });

  describe("platform-db", () => {
    it("runs main's platform-db.mjs for the env, passing its exit code", () => {
      const r = setup({ node: true }).run("platform-db");
      expect(r.code).toBe(0);
      expect(r.log).toContain(
        `node ${join(root, "scripts/ops/platform-db.mjs")} prod`,
      );
      expect(r.out).toContain("prod platform-db: deployed and verified");
      const bad = setup({ node: true }).run("platform-db", { NODE_EXIT: "1" });
      expect(bad.code).toBe(1);
      expect(bad.out).not.toContain("verified");
    });
  });

  describe("provision-token", () => {
    const secret = (over: Record<string, unknown> = {}) =>
      JSON.stringify([
        {
          id: "x",
          name: "oa-p-provision-token",
          modified: "2026-10-30T10:00:00Z",
          ...over,
        },
      ]);
    it("reads back the secret's name and modified time, and writes nothing", () => {
      for (const verify of ["", "1"]) {
        const r = setup({ files: { "store-secrets.json": secret() } }).run(
          "provision-token",
          { VERIFY_ONLY: verify },
        );
        expect(r.err).toBe("");
        expect(r.code).toBe(0);
        expect(r.out).toContain(
          "oa-p-provision-token: present in Secrets Store, modified 2026-10-30T10:00:00Z",
        );
        expect(r.writes).toEqual([]);
        expect(r.log.filter((l) => /^(pnpm|wrapper) /.test(l))).toEqual([]);
        expect(
          r.log.some((l) =>
            l.includes(
              `/secrets_store/stores/${STORE}/secrets?search=oa-p-provision-token&`,
            ),
          ),
        ).toBe(true);
        clean(r);
      }
    });
    it("a missing secret fails with the Secrets Store link; a failed listing or a twin fails", () => {
      const none = setup().run("provision-token");
      expect(none.code).toBe(1);
      expect(none.err).toContain(
        "oa-p-provision-token is not in Secrets Store",
      );
      expect(none.err).toContain(
        "https://dash.cloudflare.com/?to=/:account/secrets-store",
      );
      // Another env's secret is not this one.
      expect(
        setup({
          files: {
            "store-secrets.json": secret({ name: "oa-s-provision-token" }),
          },
        }).run("provision-token").code,
      ).toBe(1);
      const failed = setup({ files: { "fail-store": "" } }).run(
        "provision-token",
      );
      expect(failed.code).toBe(1);
      expect(failed.err).toContain("list Secrets Store secrets failed");
      const two = JSON.stringify([
        ...JSON.parse(secret()),
        ...JSON.parse(secret()),
      ]);
      expect(
        setup({ files: { "store-secrets.json": two } }).run("provision-token")
          .code,
      ).toBe(1);
    });
  });

  describe("provisioner", () => {
    const ready = {
      "queues.json": JSON.stringify([
        { queue_name: "oa-p-signups" },
        { queue_name: "oa-p-signups-dlq" },
      ]),
      "r2-oa-p-releases": "",
    };
    it("first run: creates the queues and the releases bucket, deploys, reads every binding back", () => {
      const r = setup().run("provisioner");
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(r.writes).toEqual([
        'WRITE POST /queues {"queue_name":"oa-p-signups"}',
        'WRITE POST /queues {"queue_name":"oa-p-signups-dlq"}',
        'WRITE POST /r2/buckets {"name":"oa-p-releases"}',
      ]);
      const w = r.log.find((l) => l.startsWith("wrapper provisioner prod "));
      expect(w).toContain(`db=${DB}`);
      expect(r.out).toContain("prod provisioner: deployed and verified");
      clean(r);
    });
    it("a rerun creates nothing; verify only refuses a missing queue and writes nothing", () => {
      const again = setup({ files: ready }).run("provisioner");
      expect(again.code, again.err).toBe(0);
      expect(again.writes).toEqual([]);
      const v = setup({ exists: ["oa-p-provisioner"] }).run("provisioner", {
        VERIFY_ONLY: "1",
      });
      expect(v.code).toBe(1);
      expect(v.err).toContain("queue oa-p-signups does not exist");
      expect(v.writes).toEqual([]);
    });
    it("a failed queue or bucket read stops before any create or deploy", () => {
      for (const f of ["fail-queues", "fail-r2"]) {
        const r = setup({ files: { [f]: "" } }).run("provisioner");
        expect(r.code, f).toBe(1);
        expect(r.writes.filter((w) => w.includes("/r2/buckets "))).toEqual([]);
        expect(r.log.some((l) => l.startsWith("wrapper"))).toBe(false);
      }
    });
    it("refuses a deployed binding, var or secret that isn't the committed one", () => {
      const base = NEXT["oa-p-provisioner"] as string;
      for (const [label, next, msg] of [
        ["store", base.replace(STORE, "f".repeat(32)), "PROVISION_TOKEN: got"],
        [
          "workflow",
          base.replace("oa-p-manage-install", "oa-p-other"),
          "MANAGE_INSTALL: got",
        ],
        [
          "var",
          base.replace('"text":"20"', '"text":"21"'),
          "provisioner vars: got",
        ],
        [
          "extra",
          settings([
            ...JSON.parse(base).result.bindings,
            { type: "kv_namespace", name: "X", namespace_id: "y" },
          ]),
          "bindings: got",
        ],
        [
          "observability",
          settings(JSON.parse(base).result.bindings, true),
          "observability",
        ],
      ] as const) {
        const r = setup({
          files: ready,
          next: { "oa-p-provisioner": next },
        }).run("provisioner");
        expect(r.code, label).toBe(1);
        expect(r.err, label).toContain(msg);
      }
      const sec = setup({
        files: ready,
        secrets: { "oa-p-provisioner": ["LEAK"] },
      }).run("provisioner");
      expect(sec.code).toBe(1);
      expect(sec.err).toContain("oa-p-provisioner has secrets 'LEAK '");
    });
  });

  describe("provisioning", () => {
    const KEY = "install:i000000admin";
    const brokers = ["oa-p-provisioner", "oa-p-auth-broker"];
    const entry = (over: Record<string, unknown> = {}) =>
      JSON.stringify({
        installId: "i000000admin",
        origin: "https://admin.open-artifacts.app",
        keys: [{ kid: "k".repeat(16), x: "x".repeat(43) }],
        domains: [],
        ...over,
      });
    const live = {
      "kvns.json": JSON.stringify([
        { id: OAUTH, title: "oa-p-provisioning-oauth" },
      ]),
      [`kv-${REG}-${KEY}`]: entry(),
    };
    const liveSecrets = {
      "oa-p-provisioning": ["ADMIN_BROKER_KEY", "ADMIN_SESSION_KEY"],
    };
    it("first run: builds the SPA, creates the OAuth KV, deploys, makes both keys and the admin entry, reads back", () => {
      const r = setup({ exists: brokers }).run("provisioning");
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      const build = r.log.indexOf("pnpm --filter @oa/admin build");
      const wrap = r.log.findIndex((l) =>
        l.startsWith("wrapper provisioning prod "),
      );
      expect(build).toBeGreaterThanOrEqual(0);
      expect(build).toBeLessThan(wrap);
      expect(r.writes[0]).toBe(
        'WRITE POST /storage/kv/namespaces {"title":"oa-p-provisioning-oauth"}',
      );
      // The entry carries only the public half, and is written before the secret.
      const put = r.writes.find((w) =>
        w.startsWith(`WRITE PUT /storage/kv/namespaces/${REG}/values/${KEY} `),
      ) as string;
      const body = JSON.parse(put.slice(put.indexOf("{")));
      expect(Object.keys(body)).toEqual([
        "installId",
        "origin",
        "keys",
        "domains",
      ]);
      expect(body).toMatchObject({
        installId: "i000000admin",
        origin: "https://admin.open-artifacts.app",
        domains: [],
      });
      expect(Object.keys(body.keys[0])).toEqual(["kid", "x"]);
      expect(r.writes).toHaveLength(2);
      expect(puts(r.log)).toEqual(["ADMIN_SESSION_KEY", "ADMIN_BROKER_KEY"]);
      expect(
        r.log.indexOf(put) <
          r.log.findIndex(
            (l) =>
              l === "stdin-len ADMIN_BROKER_KEY" ||
              l.startsWith("stdin-len ADMIN_BROKER_KEY "),
          ),
      ).toBe(true);
      // An Ed25519 pkcs8 (base64url) never shows.
      expect([r.out, r.err, ...r.log].join("\n")).not.toContain(
        "MC4CAQAwBQYDK2Vw",
      );
      expect(r.out).toContain("prod provisioning: deployed and verified");
      clean(r);
    });
    it("a rerun writes nothing; a missing entry gets a new key, entry first", () => {
      const again = setup({
        exists: brokers,
        files: live,
        secrets: liveSecrets,
      }).run("provisioning");
      expect(again.err).toBe("");
      expect(again.code).toBe(0);
      expect(again.writes).toEqual([]);
      expect(puts(again.log)).toEqual([]);
      const { [`kv-${REG}-${KEY}`]: _, ...noEntry } = live;
      const r = setup({
        exists: brokers,
        files: noEntry,
        secrets: liveSecrets,
      }).run("provisioning");
      expect(r.code, r.err).toBe(0);
      expect(r.writes.map((w) => w.split(" ").slice(0, 3).join(" "))).toEqual([
        `WRITE PUT /storage/kv/namespaces/${REG}/values/${KEY}`,
      ]);
      expect(puts(r.log)).toEqual(["ADMIN_BROKER_KEY"]);
    });
    it("refuses until the provisioner and the auth broker exist", () => {
      const r = setup({ exists: ["oa-p-auth-broker"] }).run("provisioning");
      expect(r.code).toBe(1);
      expect(r.err).toContain("oa-p-provisioner does not exist");
      expect(r.writes).toEqual([]);
      expect(r.log.some((l) => l.startsWith("wrapper"))).toBe(false);
    });
    it("a failed KV listing stops before any create; two namespaces of the name refuse", () => {
      const f = setup({ exists: brokers, files: { "fail-kvns": "" } }).run(
        "provisioning",
      );
      expect(f.code).toBe(1);
      expect(f.err).toContain("list KV namespaces failed");
      expect(f.writes).toEqual([]);
      const two = setup({
        exists: brokers,
        files: {
          "kvns.json": JSON.stringify([
            { id: OAUTH, title: "oa-p-provisioning-oauth" },
            { id: "b".repeat(32), title: "oa-p-provisioning-oauth" },
          ]),
        },
      }).run("provisioning");
      expect(two.code).toBe(1);
      expect(two.err).toContain("want exactly one");
      expect(two.log.some((l) => l.startsWith("wrapper"))).toBe(false);
    });
    it("verify only: builds, creates and sets nothing, and still reads everything back", () => {
      const r = setup({
        exists: [...brokers, "oa-p-provisioning"],
        files: live,
        secrets: liveSecrets,
      }).run("provisioning", { VERIFY_ONLY: "1" });
      expect(r.code, r.err).toBe(0);
      expect(r.writes).toEqual([]);
      expect(r.log.filter((l) => /^(pnpm|wrapper) /.test(l))).toEqual([]);
      const none = setup({ exists: brokers }).run("provisioning", {
        VERIFY_ONLY: "1",
      });
      expect(none.code).toBe(1);
      expect(none.writes).toEqual([]);
    });
    it("refuses every read-back that differs", () => {
      const b = provisioningBindings();
      const swap = (name: string, over: Record<string, unknown>) =>
        settings(b.map((x) => (x.name === name ? { ...x, ...over } : x)));
      const cases: [string, Record<string, string>, string][] = [
        [
          "oauth kv",
          { next: swap("OAUTH_KV", { namespace_id: "f".repeat(32) }) },
          "OAUTH_KV: got",
        ],
        [
          "rate limit",
          {
            next: swap("RL_PV_OAUTH_IP", {
              simple: { limit: 999, period: 60 },
            }),
          },
          "rate limits: got",
        ],
        [
          "rate limit id",
          { next: swap("RL_PV_OAUTH_IP", { namespace_id: "1146" }) },
          "rate limits: got",
        ],
        [
          "redirects",
          {
            next: swap("MCP_REDIRECT_URIS", {
              text: "https://evil.example/cb",
            }),
          },
          "provisioning vars: got",
        ],
        [
          "identities",
          { next: swap("ADMIN_IDENTITIES", { text: "a@b.c:1" }) },
          "provisioning vars: got",
        ],
        [
          "entrypoint",
          { next: swap("PROVISIONER", { entrypoint: "Other" }) },
          "PROVISIONER: got",
        ],
        [
          "prod oidc",
          {
            next: settings([
              ...b,
              { type: "plain_text", name: "OIDC_AUDIENCE", text: "x" },
            ]),
          },
          "prod oa-p-provisioning binds OIDC_AUDIENCE",
        ],
        [
          "test-users",
          { next: swap("SIGNUPS_ENABLED", { text: "test-users" }) },
          "SIGNUPS_ENABLED (test-users is staging only)",
        ],
        [
          "bundle",
          { content: "x; fetch('/auth/test-signin')" },
          "bundle contains test-signin",
        ],
        [
          "directory",
          { [`kv-${DIRREG}-${KEY}`]: entry() },
          "is in oa-p-directory-registry",
        ],
        [
          "entry origin",
          { [`kv-${REG}-${KEY}`]: entry({ origin: "https://evil.example" }) },
          "is not the admin entry",
        ],
        [
          "entry domains",
          { [`kv-${REG}-${KEY}`]: entry({ domains: ["leourbina.com"] }) },
          "is not the admin entry",
        ],
        [
          "entry disabled",
          { [`kv-${REG}-${KEY}`]: entry({ disabled: true }) },
          "is not the admin entry",
        ],
      ];
      for (const [label, over, msg] of cases) {
        const { next, content, ...files } = over;
        const s = setup({
          exists: brokers,
          files: {
            ...live,
            ...files,
            ...(content ? { "oa-p-provisioning.content": content } : {}),
          },
          secrets: liveSecrets,
          ...(next ? { next: { "oa-p-provisioning": next } } : {}),
        });
        const r = s.run("provisioning");
        expect(r.code, label).toBe(1);
        expect(r.err, label).toContain(msg);
      }
      const extra = setup({
        exists: brokers,
        files: live,
        secrets: {
          "oa-p-provisioning": [...liveSecrets["oa-p-provisioning"], "X"],
        },
      }).run("provisioning");
      expect(extra.code).toBe(1);
      expect(extra.err).toContain(
        "secrets are 'ADMIN_BROKER_KEY ADMIN_SESSION_KEY X '",
      );
    });
    it("staging: the staging names and OIDC vars, the staging admin origin", () => {
      const s = setup({
        exists: ["oa-s-provisioner", "oa-s-auth-broker"],
        next: {
          "oa-s-provisioning": settings(provisioningBindings("s", "staging")),
        },
      });
      const r = s.run("provisioning", { NEW_KV: OAUTH }, "staging");
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      const put = r.writes.find((w) => w.includes(`/values/${KEY} `)) as string;
      expect(put).toContain(
        '"origin":"https://admin.open-artifacts-staging.app"',
      );
    });
  });

  it("auth-broker: the Google secret only when given or absent", () => {
    const keep = setup({
      secrets: {
        "oa-p-auth-broker": ["BROKER_STATE_KEY", "GOOGLE_CLIENT_SECRET"],
      },
    }).run("auth-broker", { GOOGLE_CLIENT_SECRET: "" });
    expect(keep.err).toBe("");
    expect(keep.code).toBe(0);
    expect(puts(keep.log)).toEqual([]);
    const absent = setup().run("auth-broker", { GOOGLE_CLIENT_SECRET: "" });
    expect(absent.code).toBe(1);
    expect(absent.err).toContain(
      "oa-p-auth-broker has no GOOGLE_CLIENT_SECRET",
    );
    expect(puts(absent.log)).toEqual([]);
  });

  describe("inventory read-back (W8's OIDC vars)", () => {
    const INV = readFileSync(
      join(root, "apps/inventory/wrangler.jsonc"),
      "utf8",
    );
    const W8 = INV.replace(
      '"name": "oa-p-inventory",',
      `"name": "oa-p-inventory", "vars": { "OIDC_AUDIENCE": "oa-p-inventory", "OIDC_REPOSITORY_ID": "{{GITHUB_REPOSITORY_ID_PROD}}", "OIDC_JOB_WORKFLOW_REFS": "o/r/.github/workflows/prodclean-monitor.yml@refs/heads/main" },`,
    );
    /** The repo's deploy script and wrangler-env.mjs beside our own inventory config. */
    const tree = (config: string) => {
      const t = mkdtempSync(join(tmpdir(), "oa-hosted-tree-"));
      for (const f of ["deploy-hosted-platform.sh", "wrangler-env.mjs"])
        write(
          join(t, "scripts/ops", f),
          readFileSync(join(root, "scripts/ops", f), "utf8"),
        );
      write(join(t, "apps/inventory/wrangler.jsonc"), config);
      return join(t, "scripts/ops/deploy-hosted-platform.sh");
    };
    const deployed = (
      vars: Record<string, string>,
      extra: Record<string, unknown>[] = [],
    ) =>
      settings([
        { type: "d1", name: "PLATFORM_DB", id: DB },
        { type: "kv_namespace", name: "HOSTS", namespace_id: HOSTS },
        ...Object.entries(vars).map(([name, text]) => ({
          type: "plain_text",
          name,
          text,
        })),
        ...extra,
      ]);
    const VARS = {
      OIDC_AUDIENCE: "oa-p-inventory",
      OIDC_REPOSITORY_ID: REPO_ID,
      OIDC_JOB_WORKFLOW_REFS:
        "o/r/.github/workflows/prodclean-monitor.yml@refs/heads/main",
    };
    const go = (next: string) => {
      const s = setup({ next: { "oa-p-inventory": next } });
      const r = s.sb.run(["bash", tree(W8), "prod", "inventory"], {
        env: {
          ...ENV,
          STATE: s.state,
          DEPLOY_WRAPPER: wrapperStub(s.sb.dir),
          BROKER_PIN_FILE: "/dev/null",
        },
      });
      return r;
    };
    it("the deployed OIDC vars equal the committed ones, the repository id filled", () => {
      const r = go(deployed(VARS));
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
    });
    it("refuses a var that differs, a missing one, or any secret", () => {
      for (const [label, next] of [
        [
          "refs",
          deployed({
            ...VARS,
            OIDC_JOB_WORKFLOW_REFS:
              "o/r/.github/workflows/x.yml@refs/heads/main",
          }),
        ],
        ["repo id", deployed({ ...VARS, OIDC_REPOSITORY_ID: "1" })],
        [
          "missing",
          deployed({
            OIDC_AUDIENCE: VARS.OIDC_AUDIENCE,
            OIDC_REPOSITORY_ID: REPO_ID,
          }),
        ],
        [
          "secret",
          deployed(VARS, [{ type: "secret_text", name: "INVENTORY_KEY" }]),
        ],
      ] as const) {
        const r = go(next);
        expect(r.code, label).toBe(1);
        expect(r.err, label).toMatch(/inventory vars: got|has secret bindings/);
      }
    });
  });
});
