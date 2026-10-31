// provapi-staging-spikes.yml and scripts/ci/provapi-spikes.sh: the staging
// spikes S1-S8 and the read-only token verify. The workflow's shape (one
// secret, a 0600 token file, staging only), the script's guards (prod, leo,
// the oa-s-spike- prefix, the 1 h leftover filter), and that S8, S6, S2 and
// S7 only read rl-a and rl-b. curl is a stub; the token reaches it in a
// config file on a pipe, never argv.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { root, sandbox, script } from "./stubs.ts";

const WF = ".github/workflows/provapi-staging-spikes.yml";
const SH = "provapi-spikes.sh";
const wfText = readFileSync(join(root, WF), "utf8");
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const wf: any = parse(wfText);
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const steps: any[] = wf.jobs.spikes.steps;
const sh = readFileSync(script(SH), "utf8");
const worker = readFileSync(
  join(root, "spikes/provapi-staging/src/index.ts"),
  "utf8",
);

const TOK = "cfut_TOKEN_never_printed_0123456789";
const ACCT = "26ac346086d4405f7a976d48747a2a75";
const RUN = "4242";
const ZAPP = "a".repeat(32);
const ZPAGE = "b".repeat(32);
const STORE = "c".repeat(32);
const TID = "7".repeat(32);
const NS = `/accounts/${ACCT}/workers/dispatch/namespaces/oa-staging/scripts`;

/** The body of a shell function in provapi-spikes.sh. */
const fn = (name: string): string => {
  const m = new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)\\n\\}$`, "m").exec(
    sh,
  );
  if (!m) throw new Error(`no ${name} in ${SH}`);
  return m[1] as string;
};
/** The body of an exported async function in the spike Worker. */
const wfn = (name: string): string => {
  const m = new RegExp(
    `^export async function ${name}\\([^)]*\\)[^{]*\\{\\n([\\s\\S]*?)\\n\\}$`,
    "m",
  ).exec(worker);
  if (!m) throw new Error(`no ${name} in the spike Worker`);
  return m[1] as string;
};

describe("provapi-staging-spikes.yml", () => {
  it("is dispatch only, with the spikes list input", () => {
    expect(Object.keys(wf.on)).toEqual(["workflow_dispatch"]);
    expect(wf.on.workflow_dispatch.inputs.spikes.default).toBe(
      "verify,s8,s6,s1,s2,s3,s4,s5,s7",
    );
  });

  it("runs in hosted-staging-deploy, from main only", () => {
    expect(wf.jobs.spikes.environment).toBe("hosted-staging-deploy");
    expect(wf.jobs.spikes.if).toContain("github.ref == 'refs/heads/main'");
    expect(wfText).not.toMatch(/hosted-prod|prod-deploy/);
  });

  it("has contents: read only, and its own concurrency group", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(wf.jobs.spikes.permissions).toBeUndefined();
    expect(wf.concurrency.group).toBe("provapi-spikes-staging");
    expect(wf.concurrency["cancel-in-progress"]).toBe(false);
  });

  it("uses one secret, CLOUDFLARE_API_TOKEN, in the token-file step only", () => {
    const secrets = [...wfText.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(
      (m) => m[1],
    );
    expect(secrets).toEqual(["CLOUDFLARE_API_TOKEN"]);
    const users = steps.filter((s) =>
      JSON.stringify(s).includes("secrets.CLOUDFLARE_API_TOKEN"),
    );
    expect(users.map((s) => s.name)).toEqual([
      "Write the Cloudflare token file",
    ]);
  });

  it("writes the token to a 0600 file under RUNNER_TEMP, masked, never echoed", () => {
    // runner.* is not available in job-level env: the first step sets it.
    expect(wf.jobs.spikes.env.TOKEN_FILE).toBeUndefined();
    expect(steps[0].name).toBe("Set the paths");
    expect(steps[0].run).toContain('echo "TOKEN_FILE=$RUNNER_TEMP/cf-token"');
    expect(steps[0].run).toContain('} >> "$GITHUB_ENV"');
    const w = steps.find((s) => s.name === "Write the Cloudflare token file");
    expect(w.run).toContain(
      "printf '::add-mask::%s\\n' \"$CLOUDFLARE_API_TOKEN\"",
    );
    expect(w.run).toContain("umask 077");
    expect(w.run).toContain(
      `printf '%s' "$CLOUDFLARE_API_TOKEN" > "$TOKEN_FILE"`,
    );
    expect(w.run).toContain('chmod 600 "$TOKEN_FILE"');
    expect(w.run).toContain('test "$(stat -c %a "$TOKEN_FILE")" = 600');
    for (const text of [wfText, sh]) {
      expect(text).not.toMatch(/echo[^\n]*CLOUDFLARE_API_TOKEN/);
      expect(text).not.toMatch(/echo[^\n]*TOKEN_FILE\)/);
      expect(text).not.toMatch(/cat "\$TOKEN_FILE"\s*$/m);
      expect(text).not.toMatch(/set -x|xtrace/);
    }
  });

  it("removes the token file in an always() step, after cleanup and results", () => {
    const names = steps.map((s) => s.name);
    const rm = steps.find((s) => s.name === "Remove the token file");
    expect(rm.if).toContain("always()");
    expect(rm.run).toBe('rm -f "$TOKEN_FILE"');
    expect(names.indexOf("Remove the token file")).toBeGreaterThan(
      names.indexOf("Results"),
    );
    expect(names.indexOf("Results")).toBeGreaterThan(names.indexOf("Cleanup"));
  });

  it("runs each spike continue-on-error, cleanup always, and uploads spike-results.json", () => {
    for (const cmd of ["verify", "s8", "s6", "s4", "deploy", "collect"]) {
      const s = steps.find(
        (x) => x.run === `bash scripts/ci/provapi-spikes.sh ${cmd}`,
      );
      expect(s, cmd).toBeDefined();
      expect(s["continue-on-error"], cmd).toBe(true);
    }
    const c = steps.find((s) => s.name === "Cleanup");
    expect(c.if).toContain("always()");
    expect(c.run).toBe("bash scripts/ci/provapi-spikes.sh cleanup");
    const up = steps.find((s) =>
      String(s.uses).startsWith("actions/upload-artifact"),
    );
    expect(up.if).toContain("always()");
    expect(up.with.path).toMatch(/spike-results\.json$/);
    expect(steps.at(-1).name).toBe("Every spike passed");
  });

  it("checks out without persisting credentials", () => {
    const co = steps.find((s) => String(s.uses).startsWith("actions/checkout"));
    expect(co.with["persist-credentials"]).toBe(false);
  });
});

describe("provapi-spikes.sh guards (static)", () => {
  it("pins leo, rl-a, rl-b and the oa-s-spike- prefix", () => {
    expect(sh).toContain("LEO=i2ab26lvciok");
    expect(sh).toContain("RLA=ijzbmraouh5r");
    expect(sh).toContain("RLB=i42fdk7ahvs2");
    expect(sh).toContain("SPIKE_NAME_RE='^oa-s-spike-[a-z0-9-]+$'");
  });

  it("S8 and S6 only GET (cf_get), never cf_write or a raw curl", () => {
    for (const f of ["spike_s8", "spike_s6"]) {
      const b = fn(f);
      expect(b, f).toContain("cf_get");
      expect(b, f).not.toMatch(/cf_write|curl|-X |\b(POST|PUT|PATCH|DELETE)\b/);
    }
  });

  it("every write is cf_write, which refuses the namespace, rl-a and rl-b", () => {
    const w = fn("cf_write");
    expect(w).toContain('spike_name_ok "$n" || refuse');
    expect(w).toContain(
      '*dispatch/namespaces* | *"$RLA"* | *"$RLB"* | *..* | *%*) refuse',
    );
    // Only cf_get and cf_write call curl.
    const curls = sh.split("\n").filter((l) => /\bcurl -sS\b/.test(l));
    expect(curls).toHaveLength(2);
    expect(fn("cf_get")).toMatch(/curl -sS -K <\(_auth\) -w/);
    expect(fn("cf_get")).not.toContain("-X");
  });

  it("the provisioning token secret is read from the list (metadata) endpoint only", () => {
    const st = fn("store_id");
    const uses = [fn("spike_verify"), st]
      .join("\n")
      .split("\n")
      .filter((l) => l.includes("PROVISION_TOKEN_SECRET") && l.includes("cf_"));
    expect(uses).toEqual([
      '    cf_get "$ACCT/secrets_store/stores/$sid/secrets?search=$PROVISION_TOKEN_SECRET&per_page=100"',
    ]);
    expect(fn("spike_verify")).not.toMatch(/cf_write/);
    expect(st).not.toMatch(/cf_write/);
    expect(st).toContain("{name, scopes, modified}");
  });

  it("the staging store is the one holding oa-s-provision-token, never the first", () => {
    const st = fn("store_id");
    expect(st).toContain('[ "$hits" = 1 ] || {');
    expect(st).not.toMatch(/first/);
  });

  it("every id from Cloudflare is checked before it reaches a path", () => {
    expect(sh).toContain("ID_RE='^[0-9a-f-]{32,36}$'");
    expect(sh).toContain('know_id "$D1_ID" "D1 $name"');
    expect(sh).toContain('know_id "$sid" "secret $name"');
    expect(fn("guarded_delete")).toContain('know_id "$4"');
    expect(fn("cf_write")).toContain("*..* | *%*) refuse");
  });

  it("cleanup filters by the prefix and a 1 h age, and every delete is guarded", () => {
    const d = fn("doomed");
    expect(d).toContain("startswith($pre)");
    expect(d).toContain('--argjson cutoff "$(($(date +%s) - 3600))"');
    expect(d).toContain(".c < $cutoff");
    expect(fn("guarded_delete")).toContain(
      'spike_name_ok "$2" || refuse "cleanup: refusing to delete',
    );
    const c = fn("spike_cleanup");
    expect(c).not.toMatch(/cf_write/);
    expect(c.match(/guarded_delete \w+/g)).toEqual([
      "guarded_delete worker",
      "guarded_delete workflow",
      "guarded_delete d1",
      "guarded_delete secret",
    ]);
  });
});

describe("the spike Worker", () => {
  it("S2 and S7 fetch rl-b and rl-a with GETs and no body", () => {
    for (const f of ["s2", "s7"]) {
      const b = wfn(f);
      expect(b, f).not.toMatch(
        /\bmethod\b|\bbody:|\b(POST|PUT|PATCH|DELETE)\b/,
      );
    }
    expect(wfn("s2")).toContain(
      "env.DISPATCHER.get(env.RLB_SCRIPT).fetch(`https://x${p}`)",
    );
    expect(wfn("s7")).toContain(
      'fetch(env.RLA_HEALTHZ, { redirect: "manual" })',
    );
  });

  it("after its first run, every cron tick returns at the done row", () => {
    const b = wfn("runOnce");
    const first = b.indexOf(
      'SELECT 1 AS d FROM done LIMIT 1").first()) return;',
    );
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(b.indexOf("CREATE TABLE IF NOT EXISTS results"));
    expect(
      b
        .trimEnd()
        .endsWith('"INSERT OR IGNORE INTO done (id) VALUES (1)").run();'),
    ).toBe(true);
    const cfg = readFileSync(
      join(root, "spikes/provapi-staging/wrangler.jsonc"),
      "utf8",
    );
    expect(cfg).toContain('"crons": ["* * * * *"]');
  });

  it("S3 records what a missing get and a duplicate create throw", () => {
    const b = wfn("s3");
    expect(b).toContain('env.WF.get("does-not-exist")');
    expect(b).toContain("d.get_missing = errOf(e)");
    expect(b).toContain("d.create_duplicate = errOf(e)");
  });

  it("both configs are routeless, staging and oa-s-spike- named", () => {
    for (const f of ["wrangler.jsonc", "wrangler.workflow.jsonc"]) {
      const t = readFileSync(join(root, "spikes/provapi-staging", f), "utf8");
      expect(t, f).toContain('"workers_dev": false');
      expect(t, f).toContain('"preview_urls": false');
      expect(t, f).not.toMatch(/"routes"|"route"|custom_domain|oa-p-|oa-prod/);
      for (const m of t.matchAll(/"name": "([^"]+)"/g))
        expect(m[1], f).toMatch(/^oa-s-spike-\{\{RUN_ID\}\}(-wf)?$/);
    }
  });
});

// ---- behaviour, with a stub curl ----

const key = (m: string, path: string) =>
  `${m} ${path}`.replace(/[^A-Za-z0-9]/g, "_");
const ok = (result: unknown) =>
  `200\n${JSON.stringify({ success: true, errors: [], result })}`;

const curl = `cfg=""; m=GET; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -K) cfg="$(cat "$2")"; shift 2 ;;
    -X) m="$2"; shift 2 ;;
    -w | -H) shift 2 ;;
    --data-binary) cat >> "$STATE/bodies"; shift 2 ;;
    -sS) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$cfg" in *"$TOK_EXPECT"*) ;; *) echo "NOAUTH" >> "$STUB_LOG" ;; esac
path="\${url#https://api.cloudflare.com/client/v4}"
echo "REQ $m $path" >> "$STUB_LOG"
k="$(printf '%s %s' "$m" "$path" | tr -c 'A-Za-z0-9' '_')"
f="$STATE/fx/$k"
if [ -f "$f" ]; then st="$(head -n1 "$f")"; body="$(tail -n +2 "$f")"; else st=404; body='{"success":false,"errors":[]}'; fi
printf '%s\\n%s' "$body" "$st"`;

const setup = (
  fx: Record<string, string>,
  hosted?: Record<string, unknown>,
) => {
  const sb = sandbox({ curl });
  mkdirSync(join(sb.dir, "fx"));
  for (const [k, v] of Object.entries(fx))
    writeFileSync(join(sb.dir, "fx", k), v);
  const hostedDir = join(sb.dir, "hosted");
  mkdirSync(hostedDir);
  const real = JSON.parse(
    readFileSync(join(root, ".github/hosted/staging.json"), "utf8"),
  );
  writeFileSync(
    join(hostedDir, "staging.json"),
    JSON.stringify({ ...real, deploy_token_id: TID, ...hosted }),
  );
  const tokenFile = join(sb.dir, "cf-token");
  writeFileSync(tokenFile, TOK, { mode: 0o600 });
  const env = {
    STATE: sb.dir,
    TOK_EXPECT: TOK,
    TOKEN_FILE: tokenFile,
    RESULTS_DIR: join(sb.dir, "results"),
    STATE_DIR: join(sb.dir, "state"),
    RESULTS_OUT: join(sb.dir, "spike-results.json"),
    RUN_ID: RUN,
    HOSTED_DIR: hostedDir,
    GITHUB_STEP_SUMMARY: join(sb.dir, "summary.md"),
  };
  const run = (cmd: string, extra: Record<string, string> = {}) =>
    sb.run(["bash", script(SH), cmd], { env: { ...env, ...extra } });
  const results = (spike: string) => {
    const f = join(env.RESULTS_DIR, `${spike}.jsonl`);
    return existsSync(f)
      ? readFileSync(f, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  };
  const reqs = () =>
    sb
      .log()
      .filter((l) => l.startsWith("REQ "))
      .map((l) => l.slice(4));
  return { sb, env, run, results, reqs };
};

const iso = (msAgo: number) =>
  new Date(Date.now() - msAgo).toISOString().replace(/\.\d+Z$/, "Z");

/** One store holding oa-s-provision-token (how store_id picks staging's). */
const storeFx = (): Record<string, string> => ({
  [key("GET", `/accounts/${ACCT}/secrets_store/stores`)]: ok([{ id: STORE }]),
  [key(
    "GET",
    `/accounts/${ACCT}/secrets_store/stores/${STORE}/secrets?search=oa-s-provision-token&per_page=100`,
  )]: ok([
    {
      id: "d".repeat(32),
      name: "oa-s-provision-token",
      scopes: ["workers"],
      modified: "2026-10-30T00:00:00Z",
      created: "2026-10-30T00:00:00Z",
    },
  ]),
});

const verifyFx = (days: number): Record<string, string> => {
  const A = `/accounts/${ACCT}`;
  const fx: Record<string, string> = {
    [key("GET", "/user/tokens/verify")]: ok({
      id: TID,
      status: "active",
      expires_on: iso(-days * 86400_000 - 3600_000),
    }),
    [key("GET", `/zones?name=open-artifacts-staging.app&account.id=${ACCT}`)]:
      ok([
        { id: ZAPP, name: "open-artifacts-staging.app", account: { id: ACCT } },
      ]),
    [key("GET", `/zones?name=open-artifacts-staging.page&account.id=${ACCT}`)]:
      ok([
        {
          id: ZPAGE,
          name: "open-artifacts-staging.page",
          account: { id: ACCT },
        },
      ]),
    [key("GET", A)]: ok({ id: ACCT }),
    [key("GET", `${A}/secrets_store/stores`)]: ok([{ id: STORE }]),
    [key(
      "GET",
      `${A}/secrets_store/stores/${STORE}/secrets?search=oa-s-provision-token&per_page=100`,
    )]: ok([
      {
        id: "d".repeat(32),
        name: "oa-s-provision-token",
        scopes: ["workers"],
        modified: "2026-10-30T00:00:00Z",
        created: "2026-10-30T00:00:00Z",
      },
    ]),
    [key("GET", `/zones/${ZAPP}/email/sending/subdomains`)]: ok([]),
  };
  for (const p of [
    `${A}/workers/scripts`,
    `${A}/storage/kv/namespaces?per_page=1`,
    `${A}/d1/database?per_page=1`,
    `${A}/r2/buckets?per_page=1`,
    `${A}/queues`,
    `${A}/challenges/widgets?per_page=5`,
  ])
    fx[key("GET", p)] = ok([]);
  for (const z of [ZAPP, ZPAGE])
    for (const p of [
      `/zones/${z}`,
      `/zones/${z}/settings`,
      `/zones/${z}/dns_records?per_page=1`,
      `/zones/${z}/workers/routes`,
    ])
      fx[key("GET", p)] = ok([]);
  return fx;
};

describe("provapi-spikes.sh verify", () => {
  it("passes a token 365 days out with every group readable, GETs only", () => {
    const t = setup(verifyFx(365));
    const r = t.run("verify");
    expect(r.code, r.err + r.out).toBe(0);
    const res = t.results("verify");
    expect(
      res.every((x) => x.pass),
      JSON.stringify(res),
    ).toBe(true);
    const checks = res.map((x) => x.check);
    for (const g of [
      "token",
      "zone open-artifacts-staging.app",
      "zone open-artifacts-staging.page",
      "account",
      "Workers Scripts",
      "Workers KV Storage",
      "D1",
      "Workers R2 Storage",
      "Queues",
      "Turnstile",
      "Secrets Store",
      "Email Sending (open-artifacts-staging.app)",
      "Zone Read (open-artifacts-staging.page)",
      "Zone Settings Read (open-artifacts-staging.app)",
      "DNS Read (open-artifacts-staging.app)",
      "Workers Routes Read (open-artifacts-staging.page)",
      "secret oa-s-provision-token",
    ])
      expect(checks).toContain(g);
    expect(
      res.find((x) => x.check === "secret oa-s-provision-token").detail,
    ).toEqual({
      name: "oa-s-provision-token",
      scopes: ["workers"],
      modified: "2026-10-30T00:00:00Z",
    });
    expect(t.reqs().every((q) => q.startsWith("GET "))).toBe(true);
    // The provisioning token secret: the list endpoint only.
    expect(
      t
        .reqs()
        .filter(
          (q) => q.includes("/secrets_store/stores/") && q.includes("/secrets"),
        ),
    ).toEqual([
      `GET /accounts/${ACCT}/secrets_store/stores/${STORE}/secrets?search=oa-s-provision-token&per_page=100`,
    ]);
    const log = t.sb.log().join("\n");
    expect(log).not.toContain(TOK);
    expect(log).not.toContain("NOAUTH");
    expect(
      readFileSync(join(t.env.RESULTS_DIR, "verify.jsonl"), "utf8"),
    ).not.toContain(TOK);
  });

  it("fails the token check 30 days out, and a secret without the workers scope", () => {
    const fx = verifyFx(30);
    fx[
      key(
        "GET",
        `/accounts/${ACCT}/secrets_store/stores/${STORE}/secrets?search=oa-s-provision-token&per_page=100`,
      )
    ] = ok([
      { name: "oa-s-provision-token", scopes: ["ai-gateway"], modified: "x" },
    ]);
    const t = setup(fx);
    expect(t.run("verify").code).toBe(1);
    const res = t.results("verify");
    expect(res.find((x) => x.check === "token").pass).toBe(false);
    expect(
      res.find((x) => x.check === "secret oa-s-provision-token").pass,
    ).toBe(false);
    expect(res.find((x) => x.check === "account").pass).toBe(true);
  });

  it("fails when the token id is not the pinned one, or the pin is unset (and prints the id)", () => {
    const other = setup(verifyFx(365), { deploy_token_id: "8".repeat(32) });
    expect(other.run("verify").code).toBe(1);
    expect(
      other.results("verify").find((x) => x.check === "token id"),
    ).toMatchObject({
      pass: false,
      observed: `id=${TID}; pinned=${"8".repeat(32)}`,
    });
    const unset = setup(verifyFx(365), {
      deploy_token_id: "UNSET-printed-by-the-first-spikes-run",
    });
    const r = unset.run("verify");
    expect(r.code).toBe(1);
    expect(r.out).toContain(`this token's id is ${TID}`);
  });

  it("picks the store holding oa-s-provision-token, and refuses 0 or 2 matches", () => {
    const A = `/accounts/${ACCT}`;
    const S2 = "9".repeat(32);
    const search = (id: string) =>
      key(
        "GET",
        `${A}/secrets_store/stores/${id}/secrets?search=oa-s-provision-token&per_page=100`,
      );
    const hit = ok([
      { name: "oa-s-provision-token", scopes: ["workers"], modified: "m" },
    ]);
    // The second store holds it: the first is never taken by default.
    const fx = verifyFx(365);
    fx[key("GET", `${A}/secrets_store/stores`)] = ok([
      { id: S2 },
      { id: STORE },
    ]);
    fx[search(S2)] = ok([{ name: "oa-p-provision-token" }]);
    fx[search(STORE)] = hit;
    const t = setup(fx);
    expect(t.run("verify").code).toBe(0);
    expect(
      t.results("verify").find((x) => x.check === "secret oa-s-provision-token")
        .observed,
    ).toContain(`store ${STORE}`);
    // Both stores hold it: refused.
    fx[search(S2)] = hit;
    const two = setup(fx);
    expect(two.run("verify").code).toBe(1);
    expect(
      two
        .results("verify")
        .find((x) => x.check === "secret oa-s-provision-token").observed,
    ).toBe("oa-s-provision-token is in 2 stores, want exactly 1");
    // A store id that is not an id: refused, never used in a path.
    fx[key("GET", `${A}/secrets_store/stores`)] = ok([{ id: "../../x" }]);
    const bad = setup(fx);
    expect(bad.run("verify").code).toBe(1);
    expect(bad.reqs().some((q) => q.includes("../"))).toBe(false);
  });
});

describe("provapi-spikes.sh refuses prod and leo", () => {
  for (const [what, hosted] of [
    ["the prod namespace", { dispatch_namespace: "oa-prod" }],
    ["the prod app zone", { app_zone: "open-artifacts.app" }],
    ["the prod content zone", { content_zone: "open-artifacts.page" }],
    ["the prod email zone", { email_zone: "open-artifacts.app" }],
  ] as const)
    it(`refuses ${what} before any call`, () => {
      const t = setup(verifyFx(365), hosted);
      const r = t.run("verify");
      expect(r.code).toBe(3);
      expect(r.err).toMatch(/refused/);
      expect(t.reqs()).toEqual([]);
    });

  it("refuses names from a provision that resolves to prod", () => {
    const t = setup(verifyFx(365));
    const js = join(t.sb.dir, "names.mjs");
    writeFileSync(
      js,
      `export const names = (id) => ({ script: "oa-p-" + id });
       export const platformNames = () => ({ provisionToken: "oa-p-provision-token" });`,
    );
    const r = t.run("s8", { PROVISION_NAMES_JS: js });
    expect(r.code).toBe(3);
    expect(t.reqs()).toEqual([]);
  });

  it("cf_get and cf_write refuse any path naming leo", () => {
    for (const call of [
      "cf_get /accounts/x/workers/dispatch/namespaces/oa-staging/scripts/oa-s-i2ab26lvciok/settings",
      "cf_write DELETE /accounts/x/workers/scripts/oa-s-spike-1-i2ab26lvciok oa-s-spike-1-i2ab26lvciok",
    ]) {
      const t = setup({});
      const r = t.sb.run(
        ["bash", "-c", `set -euo pipefail; . "${script(SH)}"; ${call}`],
        { env: t.env },
      );
      expect(r.code, call).toBe(3);
      expect(r.err).toContain("leo (i2ab26lvciok) is never touched");
      expect(t.reqs()).toEqual([]);
    }
  });
});

describe("provapi-spikes.sh S8 and S6", () => {
  it("S8 writes rl-a and rl-b names and types only, from GETs", () => {
    const fx: Record<string, string> = {};
    for (const id of ["ijzbmraouh5r", "i42fdk7ahvs2"]) {
      fx[key("GET", `${NS}/oa-s-${id}/secrets`)] = ok([
        { name: "SESSION_KEY", type: "secret_text" },
      ]);
      fx[key("GET", `${NS}/oa-s-${id}/bindings`)] = ok([
        {
          name: "OA_ENV",
          type: "plain_text",
          text: "PLAIN_VALUE_NEVER_WRITTEN",
        },
        { name: "DB", type: "d1", id: "x" },
      ]);
    }
    const t = setup(fx);
    const r = t.run("s8");
    expect(r.code, r.err).toBe(0);
    const res = t.results("s8");
    expect(res.map((x) => x.check)).toEqual([
      "rl-a (oa-s-ijzbmraouh5r)",
      "rl-b (oa-s-i42fdk7ahvs2)",
    ]);
    expect(res[0].detail).toEqual({
      secrets: [{ name: "SESSION_KEY", type: "secret_text" }],
      bindings: [
        { name: "DB", type: "d1" },
        { name: "OA_ENV", type: "plain_text" },
      ],
    });
    expect(JSON.stringify(res)).not.toContain("PLAIN_VALUE_NEVER_WRITTEN");
    expect(t.reqs().every((q) => q.startsWith("GET "))).toBe(true);
    expect(t.reqs().some((q) => q.includes("i2ab26lvciok"))).toBe(false);
  });

  it("S6 reads rl-b's versions with GETs", () => {
    const t = setup({
      [key("GET", `${NS}/oa-s-i42fdk7ahvs2/versions`)]: ok({
        items: [{ id: "v1" }, { id: "v2" }],
      }),
    });
    const r = t.run("s6");
    expect(r.code, r.err).toBe(0);
    expect(t.results("s6")[0].observed).toContain(
      "namespace path HTTP 200 (2 versions)",
    );
    expect(t.reqs().every((q) => q.startsWith("GET "))).toBe(true);
  });
});

describe("provapi-spikes.sh S4", () => {
  it("writes the value on stdin, reads metadata back, deletes, and never writes the value", () => {
    const A = `/accounts/${ACCT}`;
    const name = `oa-s-spike-${RUN}`;
    const t = setup({
      ...storeFx(),
      [key("POST", `${A}/secrets_store/stores/${STORE}/secrets`)]: ok([
        { id: "e".repeat(32) },
      ]),
      [key(
        "GET",
        `${A}/secrets_store/stores/${STORE}/secrets?search=${name}&per_page=100`,
      )]: ok([
        {
          id: "e".repeat(32),
          name,
          created: iso(1000),
          modified: iso(1000),
          scopes: ["workers"],
        },
      ]),
      [key(
        "DELETE",
        `${A}/secrets_store/stores/${STORE}/secrets/${"e".repeat(32)}`,
      )]: ok(null),
    });
    const r = t.run("s4");
    expect(r.code, r.err + r.out).toBe(0);
    expect(t.results("s4").every((x) => x.pass)).toBe(true);
    const body = JSON.parse(readFileSync(join(t.sb.dir, "bodies"), "utf8"));
    expect(body[0].name).toBe(name);
    expect(body[0].value).toMatch(/^[0-9a-f]{64}$/);
    const value = body[0].value as string;
    expect(t.sb.log().join("\n")).not.toContain(value);
    expect(r.out + r.err).not.toContain(value);
    expect(
      readFileSync(join(t.env.RESULTS_DIR, "s4.jsonl"), "utf8"),
    ).not.toContain(value);
    expect(existsSync(join(t.env.STATE_DIR, "s4-value"))).toBe(false);
  });

  it("fails the create check when the write is refused", () => {
    const t = setup(storeFx());
    expect(t.run("s4").code).toBe(1);
    const c = t.results("s4").find((x) => x.check.startsWith("create"));
    expect(c).toMatchObject({ pass: false, observed: "HTTP 404" });
  });

  it("records no store and creates nothing when the account has none", () => {
    const t = setup({
      [key("GET", `/accounts/${ACCT}/secrets_store/stores`)]: ok([]),
    });
    expect(t.run("s4").code).toBe(1);
    expect(t.results("s4")[0].observed).toMatch(/^no store/);
    expect(t.reqs()).toEqual([`GET /accounts/${ACCT}/secrets_store/stores`]);
  });

  for (const bad of ["../../workers/scripts/oa-s-dispatch", "..%2F..%2Fx"])
    it(`refuses a returned secret id ${bad} before any delete`, () => {
      const A = `/accounts/${ACCT}`;
      const name = `oa-s-spike-${RUN}`;
      const t = setup({
        ...storeFx(),
        [key("POST", `${A}/secrets_store/stores/${STORE}/secrets`)]: ok([]),
        [key(
          "GET",
          `${A}/secrets_store/stores/${STORE}/secrets?search=${name}&per_page=100`,
        )]: ok([{ id: bad, name, modified: "m" }]),
      });
      const r = t.run("s4");
      expect(r.code).toBe(3);
      expect(r.err).toContain("not an id");
      expect(t.reqs().some((q) => q.startsWith("DELETE "))).toBe(false);
    });
});

describe("provapi-spikes.sh S4 delete status", () => {
  const A = `/accounts/${ACCT}`;
  const name = `oa-s-spike-${RUN}`;
  const sid = "e".repeat(32);
  const fx = (del: string): Record<string, string> => ({
    ...storeFx(),
    [key("POST", `${A}/secrets_store/stores/${STORE}/secrets`)]: ok([
      { id: sid },
    ]),
    [key(
      "GET",
      `${A}/secrets_store/stores/${STORE}/secrets?search=${name}&per_page=100`,
    )]: ok([{ id: sid, name, modified: iso(1000) }]),
    [key("DELETE", `${A}/secrets_store/stores/${STORE}/secrets/${sid}`)]: del,
  });
  const body = (success: boolean) =>
    JSON.stringify({ success, errors: [], result: null });
  for (const [del, pass] of [
    [`200\n${body(true)}`, true],
    [`202\n${body(true)}`, true],
    ["204\n", true],
    [`202\n${body(false)}`, false],
    [`403\n${body(false)}`, false],
    [`500\n${body(true)}`, false],
  ] as const)
    it(`records the delete as ${pass ? "passed" : "failed"} on HTTP ${del.split("\n")[0]}${del.includes("false") ? " success false" : ""}`, () => {
      const t = setup(fx(del));
      expect(t.run("s4").code).toBe(pass ? 0 : 1);
      expect(t.results("s4").find((x) => x.check === "delete")).toMatchObject({
        pass,
        observed: `HTTP ${del.split("\n")[0]}`,
      });
    });
});

describe("provapi-spikes.sh cleanup", () => {
  const A = `/accounts/${ACCT}`;
  const mine = `oa-s-spike-${RUN}`;
  const UMINE = "11111111-2222-4333-8444-555555555555";
  const UOLD = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const SOLD = "4".repeat(32);
  const fx = (): Record<string, string> => ({
    ...storeFx(),
    [key("GET", `${A}/workers/scripts`)]: ok([
      { id: mine, created_on: iso(60_000) },
      { id: `${mine}-wf`, created_on: iso(60_000) },
      { id: "oa-s-spike-1000", created_on: iso(2 * 3600_000) },
      { id: "oa-s-spike-1001", created_on: iso(10 * 60_000) },
      { id: "oa-s-dispatch", created_on: iso(90 * 86400_000) },
      { id: "oa-s-spike-1002", created_on: "not a time" },
    ]),
    [key("GET", `${A}/workflows?per_page=100`)]: ok([
      { name: mine, created_on: iso(60_000) },
      { name: "oa-s-provision-install", created_on: iso(9 * 86400_000) },
    ]),
    [key("GET", `${A}/d1/database?name=oa-s-spike-&per_page=100`)]: ok([
      { name: mine, uuid: UMINE, created_at: iso(60_000) },
      { name: "oa-s-spike-999", uuid: UOLD, created_at: iso(5 * 3600_000) },
      {
        name: "oa-s-spike-996",
        uuid: "../../workers/scripts/oa-s-dispatch",
        created_at: iso(5 * 3600_000),
      },
      {
        name: "oa-s-platform",
        uuid: "0".repeat(32),
        created_at: iso(99 * 86400_000),
      },
    ]),
    [key(
      "GET",
      `${A}/secrets_store/stores/${STORE}/secrets?search=oa-s-spike-&per_page=100`,
    )]: ok([
      { id: SOLD, name: "oa-s-spike-998", created: iso(3 * 3600_000) },
      { id: "..%2F..%2Fx", name: "oa-s-spike-995", created: iso(3 * 3600_000) },
      { id: "5".repeat(32), name: "oa-s-spike-997", created: iso(5 * 60_000) },
      {
        id: "6".repeat(32),
        name: "oa-s-provision-token",
        created: iso(99 * 86400_000),
      },
    ]),
    [key("DELETE", `${A}/workers/scripts/${mine}?force=true`)]: ok(null),
    [key("DELETE", `${A}/workers/scripts/${mine}-wf?force=true`)]: ok(null),
    [key("DELETE", `${A}/workers/scripts/oa-s-spike-1000?force=true`)]:
      ok(null),
    [key("DELETE", `${A}/workflows/${mine}`)]: ok(null),
    [key("DELETE", `${A}/d1/database/${UMINE}`)]: ok(null),
    [key("DELETE", `${A}/d1/database/${UOLD}`)]: ok(null),
    [key("DELETE", `${A}/secrets_store/stores/${STORE}/secrets/${SOLD}`)]:
      ok(null),
  });

  it("deletes this run's resources and oa-s-spike-* over 1 h old, nothing else, logging each name", () => {
    const t = setup(fx());
    const r = t.run("cleanup");
    // 1: two leftovers had ids that are not ids (refused, recorded).
    expect(r.code, r.err + r.out).toBe(1);
    expect(t.reqs().filter((q) => !q.startsWith("GET "))).toEqual([
      `DELETE ${A}/workers/scripts/oa-s-spike-1000?force=true`,
      `DELETE ${A}/workers/scripts/${mine}?force=true`,
      `DELETE ${A}/workers/scripts/${mine}-wf?force=true`,
      `DELETE ${A}/workflows/${mine}`,
      `DELETE ${A}/d1/database/${UMINE}`,
      `DELETE ${A}/d1/database/${UOLD}`,
      `DELETE ${A}/secrets_store/stores/${STORE}/secrets/${SOLD}`,
    ]);
    for (const n of [
      mine,
      `${mine}-wf`,
      "oa-s-spike-1000",
      "oa-s-spike-999",
      "oa-s-spike-998",
    ])
      expect(r.out).toContain(n);
    expect(t.results("cleanup").map((x) => x.check)).toEqual([
      "worker oa-s-spike-1000",
      `worker ${mine}`,
      `worker ${mine}-wf`,
      `workflow ${mine}`,
      `d1 ${mine}`,
      "d1 oa-s-spike-999",
      "d1 oa-s-spike-996",
      "secret oa-s-spike-998",
      "secret oa-s-spike-995",
    ]);
    for (const c of ["d1 oa-s-spike-996", "secret oa-s-spike-995"])
      expect(t.results("cleanup").find((x) => x.check === c)).toMatchObject({
        pass: false,
        observed: "refused: its id is not an id",
      });
    expect(t.reqs().some((q) => q.includes("..") || q.includes("%2F"))).toBe(
      false,
    );
  });

  it("passes a cleanup delete answered 202 or 204", () => {
    const f = fx();
    f[key("DELETE", `${A}/workers/scripts/${mine}?force=true`)] =
      `202\n${JSON.stringify({ success: true, errors: [], result: null })}`;
    f[key("DELETE", `${A}/d1/database/${UMINE}`)] = "204\n";
    const t = setup(f);
    t.run("cleanup");
    for (const c of [`worker ${mine}`, `d1 ${mine}`])
      expect(t.results("cleanup").find((x) => x.check === c)).toMatchObject({
        pass: true,
      });
  });

  it("guarded_delete and cf_write refuse a name without oa-s-spike-", () => {
    for (const call of [
      `guarded_delete worker oa-s-dispatch ${A}/workers/scripts/oa-s-dispatch`,
      `guarded_delete d1 oa-s-spike ${A}/d1/database/u`,
      `cf_write DELETE ${A}/workers/scripts/oa-s-platform oa-s-platform`,
      `cf_write POST ${NS}/oa-s-spike-1/secrets oa-s-spike-1`,
      // A guarded name with a foreign path.
      `cf_write DELETE ${A}/workers/scripts/oa-s-dispatch oa-s-spike-1`,
      `cf_write DELETE ${A}/d1/database/${UOLD} oa-s-spike-1`,
      `cf_write DELETE ${A}/d1/database/${UOLD} oa-s-spike-1 ${UOLD}x`,
      `cf_write POST ${A}/workers/scripts/oa-s-spike-1 oa-s-spike-1`,
      `cf_write POST ${A}/d1/database/${UOLD}/query oa-s-spike-1 ${UOLD}`,
      `cf_write DELETE ${A}/workers/scripts/oa-s-spike-1/../oa-s-dispatch oa-s-spike-1`,
      `guarded_delete d1 oa-s-spike-1 ${A}/d1/database/x ../x`,
    ]) {
      const t = setup({});
      const r = t.sb.run(
        [
          "bash",
          "-c",
          `set -euo pipefail; . "${script(SH)}"; ACCT=/accounts/${ACCT}; ${call} < /dev/null`,
        ],
        { env: t.env },
      );
      expect(r.code, call).toBe(3);
      expect(r.err, call).toMatch(/refus/);
      expect(t.reqs(), call).toEqual([]);
    }
  });
});

describe("provapi-spikes.sh summary", () => {
  it("writes one line per spike and one results file, and withholds a leaked token", () => {
    const t = setup({});
    mkdirSync(t.env.RESULTS_DIR, { recursive: true });
    writeFileSync(
      join(t.env.RESULTS_DIR, "s1.jsonl"),
      `${JSON.stringify({ spike: "s1", check: "run", pass: true, observed: "verify=true" })}\n`,
    );
    writeFileSync(
      join(t.env.RESULTS_DIR, "s5.jsonl"),
      `${JSON.stringify({ spike: "s5", check: "run", pass: false, observed: "rows after=1" })}\n`,
    );
    const r = t.run("summary", { SPIKES: "s1,s5,s7" });
    expect(r.code).toBe(1);
    const out = JSON.parse(readFileSync(t.env.RESULTS_OUT, "utf8"));
    expect(
      out.spikes.map((s: { spike: string; pass: boolean }) => [
        s.spike,
        s.pass,
      ]),
    ).toEqual([
      ["s1", true],
      ["s5", false],
      ["s7", false],
    ]);
    const md = readFileSync(t.env.GITHUB_STEP_SUMMARY, "utf8");
    expect(md).toContain("- **s1**: pass: run: verify=true");
    expect(md).toContain("- **s5**: FAIL: run: rows after=1");
    expect(md).toContain("- **s7**: FAIL: no result");
    expect(md).toContain("not edit rights");

    writeFileSync(
      join(t.env.RESULTS_DIR, "s1.jsonl"),
      `${JSON.stringify({ spike: "s1", check: "run", pass: true, observed: TOK })}\n`,
    );
    const r2 = t.run("summary", { SPIKES: "s1" });
    expect(r2.code).toBe(3);
    expect(readFileSync(t.env.RESULTS_OUT, "utf8")).not.toContain(TOK);
  });
});

describe("the spike Workers bundle", () => {
  it("wrangler deploy --dry-run accepts both rendered configs", () => {
    const dir = join(root, "spikes/provapi-staging");
    for (const f of ["wrangler.workflow", "wrangler"]) {
      const out = join(dir, `${f}.test-${process.pid}.rendered.jsonc`);
      const t = readFileSync(join(dir, `${f}.jsonc`), "utf8")
        .replaceAll("{{RUN_ID}}", "1")
        .replaceAll("{{SPIKES}}", "s1,s2,s3,s5,s7")
        .replaceAll("{{RLB_SCRIPT}}", "oa-s-i42fdk7ahvs2")
        .replaceAll(
          "{{RLA_HEALTHZ}}",
          "https://rl-a.open-artifacts-staging.app/healthz",
        )
        .replaceAll("{{NAMESPACE}}", "oa-staging")
        .replaceAll("{{D1_ID}}", "00000000-0000-0000-0000-000000000000");
      writeFileSync(out, t);
      try {
        const env = { ...process.env };
        delete env.CLOUDFLARE_API_TOKEN;
        const r = spawnSync(
          "pnpm",
          [
            "--dir",
            join(root, "apps/dispatch"),
            "exec",
            "wrangler",
            "deploy",
            "--dry-run",
            "-c",
            out,
          ],
          { encoding: "utf8", env, timeout: 120_000 },
        );
        expect(r.status, r.stderr + r.stdout).toBe(0);
        expect(r.stdout).toContain("SpikeWorkflow");
      } finally {
        spawnSync("/bin/rm", ["-f", out]);
      }
    }
  }, 180_000);
});

describe("provapi-spikes.sh deploy render", () => {
  const dir = join(root, "spikes/provapi-staging");
  const files = ["wrangler.workflow.jsonc", "wrangler.jsonc"];

  it("render fills every placeholder in both configs", () => {
    const keys = /for k in ([A-Z0-9_ ]+); do/.exec(fn("render"))?.[1];
    expect(keys).toBeTruthy();
    const filled = new Set((keys as string).trim().split(/\s+/));
    for (const f of files) {
      const t = readFileSync(join(dir, f), "utf8");
      // Only {{KEY}} placeholders, none in a comment or any other form.
      const all = [...t.matchAll(/\{\{/g)].length;
      const ph = [...t.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]);
      expect(ph.length, f).toBe(all);
      for (const k of ph)
        expect(filled.has(k as string), `${f}: ${k}`).toBe(true);
    }
  });

  it("deploy renders both configs with the workflow's env and leaves no {{", () => {
    // The env the workflow's job sets before the deploy step, with a run's values.
    const jobEnv = Object.keys(wf.jobs.spikes.env);
    expect(jobEnv).toEqual(expect.arrayContaining(["RUN_ID", "SPIKES"]));
    const runId = "41237293557";
    const d1 = "11111111-2222-4333-8444-555555555555";
    const t = setup({
      [key("POST", `/accounts/${ACCT}/d1/database`)]: ok({ uuid: d1 }),
    });
    // wrangler (through pnpm) keeps a copy of each config it is given.
    const pnpm = `while [ $# -gt 0 ]; do [ "$1" = -c ] && cp "$2" "$STATE/deployed-$(basename "$2")"; shift; done`;
    writeFileSync(
      join(t.sb.dir, "bin", "pnpm"),
      `#!/usr/bin/env bash\n${pnpm}\n`,
      { mode: 0o755 },
    );
    try {
      const r = t.run("deploy", {
        RUN_ID: runId,
        SPIKES: "s1,s2,s3,s4,s5,s6,s7,s8",
      });
      expect(r.code, r.err + r.out).toBe(0);
      for (const f of files) {
        const out = join(
          t.sb.dir,
          `deployed-${f.replace(/\.jsonc$/, ".rendered.jsonc")}`,
        );
        const txt = readFileSync(out, "utf8");
        expect(txt, f).not.toContain("{{");
        expect(txt, f).toContain(`oa-s-spike-${runId}`);
      }
      const caller = readFileSync(
        join(t.sb.dir, "deployed-wrangler.rendered.jsonc"),
        "utf8",
      );
      expect(caller).toContain(`"database_id": "${d1}"`);
      expect(caller).toContain('"SPIKES": "s1,s2,s3,s5,s7"');
      expect(caller).toContain('"namespace": "oa-staging"');
    } finally {
      spawnSync("/bin/rm", [
        "-f",
        ...files.map((f) =>
          join(dir, f.replace(/\.jsonc$/, ".rendered.jsonc")),
        ),
      ]);
    }
  });

  it("refuses a config with a placeholder render does not fill", () => {
    const t = setup({});
    const src = join(t.sb.dir, "in.jsonc");
    writeFileSync(src, '{ "a": "{{RUN_ID}}", "b": "{{NOPE}}" }');
    const r = t.sb.run(
      [
        "bash",
        "-c",
        `set -euo pipefail; . "${script(SH)}"; RUN_ID=1 SPIKES=s1 RLB_SCRIPT=oa-s-x RLA_HEALTHZ=https://x/healthz NAMESPACE=oa-staging D1_ID=u render "${src}" "${t.sb.dir}/out.jsonc"`,
      ],
      { env: t.env },
    );
    expect(r.code).toBe(3);
    expect(r.err).toContain("placeholder left (line 1)");
  });
});

describe("provapi-spikes.sh collect", () => {
  it("reads each worker spike's row from the throwaway D1, and fails a missing one", () => {
    const A = `/accounts/${ACCT}`;
    const row = (spike: string, pass: boolean, observed: string) => ({
      spike,
      json: JSON.stringify({ spike, pass, observed }),
    });
    const t = setup({
      [key(
        "POST",
        `${A}/d1/database/99999999-8888-4777-8666-555555555555/query`,
      )]: ok([
        {
          results: [
            row("s1", true, "verify=true"),
            row("s3", true, "get(missing) -> Error: instance.not_found"),
          ],
        },
      ]),
    });
    mkdirSync(t.env.STATE_DIR, { recursive: true });
    writeFileSync(
      join(t.env.STATE_DIR, "d1_id"),
      "99999999-8888-4777-8666-555555555555",
    );
    const r = t.run("collect", {
      SPIKES: "verify,s1,s3,s7",
      COLLECT_DEADLINE_S: "0",
      COLLECT_POLL_S: "0",
    });
    expect(r.code, r.err + r.out).toBe(1);
    expect(t.results("s1")[0]).toMatchObject({
      pass: true,
      observed: "verify=true",
    });
    expect(t.results("s3")[0].observed).toContain("instance.not_found");
    expect(t.results("s7")[0]).toMatchObject({ pass: false });
    expect(t.results("s7")[0].observed).toMatch(
      /^no result before the deadline/,
    );
    expect(t.reqs()).toEqual([
      `POST ${A}/d1/database/99999999-8888-4777-8666-555555555555/query`,
    ]);
  });
});
