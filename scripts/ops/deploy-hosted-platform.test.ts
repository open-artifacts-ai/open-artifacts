import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, sandbox } from "../ci/stubs.ts";

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
const ALERT_TO = "ops-alerts@example.com";
const ALERT_FROM = "alerts@mail.open-artifacts.app";
const CAP = "250";

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
// curl: the -K - config must carry the token; answers by path.
const curl = `
cfg="$(cat)"
case "$cfg" in *"Bearer $EXPECT_TOKEN"*) ;; *) echo '{"success":false,"errors":[{"code":10000}]}'; exit 0 ;; esac
url="\${@: -1}"
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
  queues\\?*)
    if [ -f "$STATE/queues.json" ]; then cat "$STATE/queues.json"
    else echo '{"success":false,"errors":[{"code":1}]}'; fi ;;
esac`;
const openssl = `echo "c3RhdGVrZXlzdGF0ZWtleXN0YXRla2V5c3RhdGVrZXk="`;
// The deploy wrapper has its own tests; here a stub records its argv and the
// values it was given, then marks the app's Worker deployed.
const wrapperStub = (dir: string) => {
  const p = join(dir, "wrapper.sh");
  writeFileSync(
    p,
    `#!/usr/bin/env bash
echo "wrapper $* reg=\${BROKER_REGISTRY_ID:-}\${DIRECTORY_REGISTRY_ID:-} client=\${GOOGLE_CLIENT_ID_PROD:-}\${GOOGLE_DIRECTORY_CLIENT_ID_PROD:-} hosts=\${HOSTS_KV_ID:-} db=\${PLATFORM_DB_ID:-} alert_to=\${ALERT_TO:-} alert_from=\${ALERT_FROM:-} cap=\${SIGNUP_DAILY_CAP:-}" >> "$STUB_LOG"
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
// The scheduler's bindings as Cloudflare reads them back (apps/scheduler
// wrangler.jsonc, per env).
function schedulerBindings(p: "s" | "p"): Record<string, unknown>[] {
  return [
    { type: "d1", name: "PLATFORM_DB", id: DB },
    {
      type: "dispatch_namespace",
      name: "DISPATCHER",
      namespace: p === "s" ? "oa-staging" : "oa-prod",
    },
    {
      type: "plain_text",
      name: "OA_ENV",
      text: p === "s" ? "staging" : "prod",
    },
    { type: "plain_text", name: "EMAIL_QUOTA_ZONES", text: ZONE },
    { type: "plain_text", name: "EMAIL_DAILY_LIMIT", text: "1000" },
    { type: "plain_text", name: "ALERT_TO", text: ALERT_TO },
    { type: "plain_text", name: "ALERT_FROM", text: ALERT_FROM },
    { type: "plain_text", name: "SIGNUP_DAILY_CAP", text: CAP },
    { type: "plain_text", name: "SIGNUPS_ENABLED", text: "false" },
    {
      type: "service",
      name: "PROVISIONER",
      service: `oa-${p}-provisioner`,
      entrypoint: "ProvisionerRpc",
    },
    { type: "queue", name: "SIGNUPS", queue_name: `oa-${p}-signups` },
    { type: "workflow", name: "PROVISION_INSTALL" },
    { type: "workflow", name: "MANAGE_INSTALL" },
    {
      type: "send_email",
      name: "ALERT_EMAIL",
      destination_address: ALERT_TO,
    },
  ];
}
// A queue listing (GET /accounts/{id}/queues) of these names.
const queueList = (names: string[], total = names.length, pages = 1) =>
  JSON.stringify({
    success: true,
    result: names.map((queue_name) => ({ queue_name })),
    result_info: {
      page: 1,
      per_page: 100,
      count: names.length,
      total_count: total,
      total_pages: pages,
    },
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
    { type: "secret_text", name: "INVENTORY_KEY" },
  ]),
  "oa-p-scheduler": settings(schedulerBindings("p"), true),
  "oa-s-scheduler": settings(schedulerBindings("s"), true),
};

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
  ALERT_TO,
  ALERT_FROM,
  SIGNUP_DAILY_CAP: CAP,
  INVENTORY_KEY: "k".repeat(64),
};

// What the scheduler needs deployed first.
const SCHED_DEPS = (p: "s" | "p") => [
  `oa-${p}-auth-broker`,
  `oa-${p}-directory-broker`,
  `oa-${p}-provisioner`,
];

const setup = (
  opts: {
    exists?: string[];
    secrets?: Record<string, string[]>;
    next?: Record<string, string>;
    failSecrets?: boolean;
    pins?: { staging?: string | null; prod?: string | null };
    // The account's queue listing; null: the listing fails.
    queues?: string | null;
  } = {},
) => {
  const sb = sandbox({ pnpm, curl, openssl });
  const state = join(sb.dir, "state");
  mkdirSync(state);
  for (const [w, s] of Object.entries({ ...NEXT, ...opts.next }))
    writeFileSync(join(state, `${w}.next.json`), s);
  for (const p of ["s", "p"])
    writeFileSync(
      join(state, `oa-${p}-scheduler.schedules.json`),
      JSON.stringify({
        success: true,
        result: {
          schedules: [{ cron: "17 3 * * *" }, { cron: "*/2 * * * *" }],
        },
      }),
    );
  const queues =
    opts.queues === undefined
      ? queueList(["oa-p-signups", "oa-s-signups", "other"])
      : opts.queues;
  if (queues !== null) writeFileSync(join(state, "queues.json"), queues);
  for (const w of opts.exists ?? []) {
    writeFileSync(join(state, `${w}.exists`), "");
    if (NEXT[w])
      writeFileSync(join(state, `${w}.settings.json`), NEXT[w] as string);
  }
  for (const [w, names] of Object.entries(opts.secrets ?? {}))
    writeFileSync(join(state, `${w}.secrets`), `${names.join("\n")}\n`);
  if (opts.failSecrets) writeFileSync(join(state, "fail-secrets"), "");
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
    return { ...r, log: sb.log() };
  };
  return { run, state, sb };
};
// Nothing secret in any argv, stdout or stderr.
const clean = (r: { out: string; err: string; log: string[] }) => {
  const all = [r.out, r.err, ...r.log].join("\n");
  for (const s of [TOKEN, SECRET, DSECRET, "k".repeat(64), "c3RhdGVrZXlz"])
    expect(all).not.toContain(s);
};
// Nothing deployed or set: no wrapper, pnpm or wrangler call.
const noDeploy = (log: string[]) =>
  log.filter((l) => /^(pnpm|wrapper|wrangler) /.test(l));
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
    expect(puts(r.log)).toEqual(["GOOGLE_CLIENT_SECRET"]);
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
      const ok = setup({ exists: SCHED_DEPS("p") }).run(t);
      expect(ok.err, t).toBe("");
      expect(ok.code, t).toBe(0);
      expect(ok.out).toContain(`prod ${t}: deployed and verified`);
      clean(ok);
    }
  });
  it("the scheduler refuses before any deploy until the provisioner exists", () => {
    for (const verify of ["", "1"]) {
      const r = setup({
        exists: ["oa-p-auth-broker", "oa-p-directory-broker"],
      }).run("scheduler", { VERIFY_ONLY: verify });
      expect(r.code, verify).toBe(1);
      expect(r.err).toContain(
        "oa-p-provisioner does not exist: deploy it first",
      );
      expect(noDeploy(r.log)).toEqual([]);
    }
  });
  // One case per mode, each under the 30 s budget on a loaded machine.
  for (const verify of ["", "1"])
    it(`the scheduler refuses before any deploy unless exactly one oa-<p>-signups queue is listed, on one page${verify ? " (verify only)" : ""}`, () => {
      const missing = "oa-p-signups queue does not exist: create it first";
      const paged = "more than one page of queues; refusing";
      for (const [queues, msg] of [
        [queueList(["other"]), missing],
        [queueList([]), missing],
        // Staging's queue is not prod's.
        [queueList(["oa-s-signups"]), missing],
        [queueList(["oa-p-signups", "oa-p-signups"]), missing],
        [queueList(["oa-p-signups"], 101), paged],
        [queueList(["oa-p-signups"], 1, 2), paged],
        // No result_info: can't tell the listing is whole.
        [
          JSON.stringify({
            success: true,
            result: [{ queue_name: "oa-p-signups" }],
          }),
          paged,
        ],
        [null, "list queues failed"],
      ] as const) {
        const r = setup({ exists: SCHED_DEPS("p"), queues }).run("scheduler", {
          VERIFY_ONLY: verify,
        });
        expect(r.code, `${msg} ${verify}`).toBe(1);
        expect(r.err).toContain(msg);
        expect(noDeploy(r.log)).toEqual([]);
        clean(r);
      }
      if (verify) return;
      const ok = setup({ exists: SCHED_DEPS("p") }).run("scheduler");
      expect(ok.code, ok.err).toBe(0);
      expect(ok.log).toContain(
        `curl -sS -K - https://api.cloudflare.com/client/v4/accounts/${ACCT}/queues?per_page=100`,
      );
    });
  // Each case's binding changed (null: removed) fails the run, deployed or
  // verify only (the same check against the live Worker).
  const mismatches = (
    cases: readonly (readonly [
      string,
      Record<string, unknown> | null,
      string,
    ])[],
  ) => {
    const with_ = (name: string, v: Record<string, unknown> | null) =>
      settings(
        schedulerBindings("p").flatMap((b) =>
          b.name !== name ? [b] : v === null ? [] : [{ ...b, ...v }],
        ),
        true,
      );
    for (const [name, v, msg] of cases) {
      const bad = with_(name, v);
      const r = setup({
        exists: SCHED_DEPS("p"),
        next: { "oa-p-scheduler": bad },
      }).run("scheduler");
      expect(r.code, msg).toBe(1);
      expect(r.err).toContain(msg);
      const live = setup({ exists: SCHED_DEPS("p") });
      writeFileSync(join(live.state, "oa-p-scheduler.exists"), "");
      writeFileSync(join(live.state, "oa-p-scheduler.settings.json"), bad);
      const vr = live.run("scheduler", { VERIFY_ONLY: "1" });
      expect(vr.code, `verify ${msg}`).toBe(1);
      expect(vr.err).toContain(msg);
      expect(noDeploy(vr.log)).toEqual([]);
    }
  };
  it("the scheduler fails on a readback mismatch in each provisioning binding, deployed or verify only", () => {
    mismatches([
      ["PROVISIONER", { service: "oa-s-provisioner" }, "PROVISIONER: got"],
      ["PROVISIONER", { entrypoint: "default" }, "PROVISIONER entrypoint: got"],
      ["PROVISIONER", { type: "plain_text" }, "PROVISIONER type: got"],
      ["PROVISIONER", null, "PROVISIONER type: got ''"],
      ["SIGNUPS", { queue_name: "oa-s-signups" }, "SIGNUPS: got"],
      ["SIGNUPS", { type: "service" }, "SIGNUPS type: got"],
      ["SIGNUPS", null, "SIGNUPS type: got ''"],
      ["PROVISION_INSTALL", { type: "service" }, "PROVISION_INSTALL: got"],
      ["PROVISION_INSTALL", null, "PROVISION_INSTALL: got ''"],
      ["MANAGE_INSTALL", { type: "queue" }, "MANAGE_INSTALL: got"],
      ["MANAGE_INSTALL", null, "MANAGE_INSTALL: got ''"],
      ["ALERT_EMAIL", { type: "plain_text" }, "ALERT_EMAIL: got"],
      ["ALERT_EMAIL", null, "ALERT_EMAIL: got ''"],
    ]);
  });
  it("the scheduler fails on a readback mismatch in its alert and signup wiring, deployed or verify only", () => {
    mismatches([
      [
        "ALERT_EMAIL",
        { destination_address: "other@example.com" },
        `ALERT_EMAIL destination_address: got 'other@example.com', want '${ALERT_TO}'`,
      ],
      [
        "ALERT_EMAIL",
        { destination_address: undefined },
        "ALERT_EMAIL destination_address: got 'null'",
      ],
      [
        "ALERT_TO",
        { text: "other@example.com" },
        `ALERT_TO: got 'other@example.com', want '${ALERT_TO}'`,
      ],
      ["ALERT_TO", null, "ALERT_TO: got ''"],
      [
        "ALERT_FROM",
        { text: "other@example.com" },
        `ALERT_FROM: got 'other@example.com', want '${ALERT_FROM}'`,
      ],
      ["ALERT_FROM", null, "ALERT_FROM: got ''"],
      [
        "SIGNUP_DAILY_CAP",
        { text: "251" },
        `SIGNUP_DAILY_CAP: got '251', want '${CAP}'`,
      ],
      ["SIGNUP_DAILY_CAP", null, "SIGNUP_DAILY_CAP: got ''"],
      [
        "SIGNUPS_ENABLED",
        { text: "true" },
        "SIGNUPS_ENABLED: got 'true', want 'false'",
      ],
      ["SIGNUPS_ENABLED", null, "SIGNUPS_ENABLED: got ''"],
    ]);
  });
  it("the scheduler refuses a missing or malformed ALERT_TO, ALERT_FROM or SIGNUP_DAILY_CAP before any call", () => {
    const bad: [string, string][] = [
      ["ALERT_TO", ""],
      ["ALERT_TO", "ops"],
      ["ALERT_TO", "ops@example"],
      ["ALERT_TO", "@example.com"],
      ["ALERT_TO", "ops@@example.com"],
      ["ALERT_TO", "ops @example.com"],
      ["ALERT_TO", "ops@example.com,x@example.com"],
      ["ALERT_TO", "{{ALERT_TO_PROD}}"],
      ["ALERT_FROM", ""],
      ["ALERT_FROM", "alerts"],
      ["ALERT_FROM", "alerts@"],
      ["ALERT_FROM", "Alerts <alerts@example.com>"],
      ["SIGNUP_DAILY_CAP", ""],
      ["SIGNUP_DAILY_CAP", "0"],
      ["SIGNUP_DAILY_CAP", "-5"],
      ["SIGNUP_DAILY_CAP", "05"],
      ["SIGNUP_DAILY_CAP", "1.5"],
      ["SIGNUP_DAILY_CAP", "ten"],
      ["SIGNUP_DAILY_CAP", "1234567890"],
    ];
    for (const [name, value] of bad) {
      for (const verify of ["", "1"]) {
        const r = setup({ exists: SCHED_DEPS("p") }).run("scheduler", {
          [name]: value,
          VERIFY_ONLY: verify,
        });
        const what = `${name}=${JSON.stringify(value)} ${verify}`;
        expect(r.code, what).toBe(2);
        expect(r.err, what).toContain(name);
        expect(
          r.log.filter((l) => /^(pnpm|curl|wrapper|wrangler) /.test(l)),
          what,
        ).toEqual([]);
      }
    }
  });
  it("the scheduler, verify only: no deploy, every check passes on a matching live Worker", () => {
    const s = setup({ exists: SCHED_DEPS("p") });
    writeFileSync(join(s.state, "oa-p-scheduler.exists"), "");
    writeFileSync(
      join(s.state, "oa-p-scheduler.settings.json"),
      NEXT["oa-p-scheduler"] as string,
    );
    const r = s.run("scheduler", { VERIFY_ONLY: "1" });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(noDeploy(r.log)).toEqual([]);
    expect(r.out).toContain("prod scheduler: verified (verify only)");
  });
  it("the scheduler, staging: the oa-s provisioner, queue and bindings", () => {
    const r = setup({ exists: SCHED_DEPS("s") }).run(
      "scheduler",
      {},
      "staging",
    );
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const w = r.log.find((l) => l.startsWith("wrapper scheduler staging "));
    expect(w).toContain(`alert_to=${ALERT_TO}`);
    expect(w).toContain(`alert_from=${ALERT_FROM}`);
    expect(w).toContain(`cap=${CAP}`);
    expect(r.out).toContain("staging scheduler: deployed and verified");
    clean(r);
    // Prod's provisioner or queue don't stand in for staging's.
    const noProv = setup({
      exists: [...SCHED_DEPS("p"), "oa-s-auth-broker", "oa-s-directory-broker"],
    }).run("scheduler", {}, "staging");
    expect(noProv.code).toBe(1);
    expect(noProv.err).toContain("oa-s-provisioner does not exist");
    expect(noDeploy(noProv.log)).toEqual([]);
    const noQueue = setup({
      exists: SCHED_DEPS("s"),
      queues: queueList(["oa-p-signups"]),
    }).run("scheduler", {}, "staging");
    expect(noQueue.code).toBe(1);
    expect(noQueue.err).toContain(
      "oa-s-signups queue does not exist: create it first",
    );
    expect(noDeploy(noQueue.log)).toEqual([]);
    // A staging Worker bound to prod's provisioner fails the readback.
    const cross = setup({
      exists: SCHED_DEPS("s"),
      next: {
        "oa-s-scheduler": (NEXT["oa-s-scheduler"] as string).replace(
          '"service":"oa-s-provisioner"',
          '"service":"oa-p-provisioner"',
        ),
      },
    }).run("scheduler", {}, "staging");
    expect(cross.code).toBe(1);
    expect(cross.err).toContain(
      "PROVISIONER: got 'oa-p-provisioner', want 'oa-s-provisioner'",
    );
    // Staging's own alert inputs: a live staging Worker wired to another
    // address fails, deployed or verify only.
    const stagingTo = "staging-ops@example.com";
    for (const verify of ["", "1"]) {
      const s = setup({ exists: SCHED_DEPS("s") });
      if (verify) {
        writeFileSync(join(s.state, "oa-s-scheduler.exists"), "");
        writeFileSync(
          join(s.state, "oa-s-scheduler.settings.json"),
          NEXT["oa-s-scheduler"] as string,
        );
      }
      const r2 = s.run(
        "scheduler",
        { ALERT_TO: stagingTo, VERIFY_ONLY: verify },
        "staging",
      );
      expect(r2.code, verify).toBe(1);
      expect(r2.err).toContain(
        `ALERT_EMAIL destination_address: got '${ALERT_TO}', want '${stagingTo}'`,
      );
    }
  });
  it("the scheduler checks its two schedules exactly", () => {
    const s = setup({ exists: SCHED_DEPS("p") });
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
      ["auth-broker", { GOOGLE_CLIENT_SECRET: "" }],
      ["auth-broker", { CLOUDFLARE_ACCOUNT_ID: "nope" }],
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
});
