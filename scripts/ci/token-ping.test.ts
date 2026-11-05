// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal workflow expressions
// token-ping.yml and token-ping-prod.yml: one manual job per Cloudflare token
// secret, from main only; token-ping.sh prints only id, status and kind.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { root, sandbox, script } from "./stubs.ts";

const FILES = {
  "token-ping.yml": [
    "hosted-staging-deploy/CLOUDFLARE_API_TOKEN",
    "repo/CLOUDFLARE_API_TOKEN",
    "repo/ANALYTICS_TOKEN",
    "redline-staging/REDLINE_PROD_SCRIPTS_TOKEN",
    "redline-staging/REDLINE_PROD_R2_TOKEN",
  ],
  "token-ping-prod.yml": [
    "hosted-prod-deploy/CLOUDFLARE_API_TOKEN",
    "repo/PROD_CLOUDFLARE_API_TOKEN",
  ],
};
const load = (f: string) =>
  // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
  parse(readFileSync(join(root, ".github/workflows", f), "utf8")) as any;

describe.each(Object.entries(FILES))("%s", (file, choices) => {
  const w = load(file);
  // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
  const jobs = Object.values(w.jobs) as any[];

  it("is dispatch-only with one fixed choice list", () => {
    expect(Object.keys(w.on)).toEqual(["workflow_dispatch"]);
    const t = w.on.workflow_dispatch.inputs.target;
    expect(Object.keys(w.on.workflow_dispatch.inputs)).toEqual(["target"]);
    expect(t.type).toBe("choice");
    expect(t.options).toEqual(choices);
  });

  it("has one job per choice, each `if` matching its choice exactly", () => {
    expect(jobs.map((j) => j.if)).toEqual(
      choices.map(
        (c) => `github.ref == 'refs/heads/main' && inputs.target == '${c}'`,
      ),
    );
  });

  it("is main-only in every job", () => {
    for (const j of jobs)
      expect(j.if).toContain("github.ref == 'refs/heads/main'");
  });

  it("references exactly the one secret of its choice, in its environment", () => {
    jobs.forEach((j, i) => {
      const [loc, secret] = (choices[i] as string).split("/");
      const refs = [
        ...JSON.stringify(j).matchAll(/secrets\.([A-Za-z0-9_]+)/g),
      ].map((m) => m[1]);
      expect(refs).toEqual([secret]);
      expect(j.environment).toBe(loc === "repo" ? undefined : loc);
    });
    expect(JSON.stringify({ ...w, jobs: undefined })).not.toContain("secrets.");
  });

  it("has minimal permissions, a sparse checkout, no installs or caches", () => {
    expect(w.permissions).toEqual({ contents: "read" });
    for (const j of jobs) {
      expect(j.permissions).toBeUndefined();
      expect(j.steps).toHaveLength(2);
      expect(j.steps[0].uses).toMatch(/^actions\/checkout@/);
      expect(j.steps[0].with["sparse-checkout"]).toBe(
        "scripts/ci\n.github/hosted\n",
      );
      expect(j.steps[1].run).toMatch(
        /^bash scripts\/ci\/token-ping\.sh (staging|prod)$/,
      );
      expect(JSON.stringify(j)).not.toMatch(/cache|setup-|install/);
    }
  });
});

describe("token-ping.sh", () => {
  const TOK = "cfut_PING_token_never_printed_0123";
  const ID = "0123456789abcdef0123456789abcdef";
  const ACCT = "26ac346086d4405f7a976d48747a2a75";
  // The stub answers by URL; the config (stdin-less, on /dev/fd) holds the header.
  const curl = `cfg=""
for ((i = 1; i <= $#; i++)); do
  if [ "\${!i}" = -K ]; then j=$((i + 1)); cfg="$(cat "\${!j}")"; fi
done
url="\${@: -1}"
echo "cfg: $cfg" >> "$STUB_LOG"
case "$cfg" in *"Authorization: Bearer $TOK_EXPECT"*) ;; *) printf '{"success":false}\\n401'; exit 0 ;; esac
case "$url" in
  */user/tokens/verify) cat "$STATE/user" ;;
  */accounts/*/tokens/verify) cat "$STATE/account" ;;
esac`;
  const ok = (id = ID, status = "active") =>
    `{"success":true,"result":{"id":"${id}","status":"${status}"}}\n200`;
  const run = (opts: {
    user: string;
    account?: string;
    token?: string;
    curl?: string;
  }) => {
    const sb = sandbox({ curl: opts.curl ?? curl });
    writeFileSync(join(sb.dir, "user"), opts.user);
    writeFileSync(join(sb.dir, "account"), opts.account ?? "{}\n500");
    const hosted = join(sb.dir, "hosted");
    sb.run(["mkdir", hosted]);
    writeFileSync(
      join(hosted, "prod.json"),
      JSON.stringify({ account_id: ACCT }),
    );
    const r = sb.run(["bash", script("token-ping.sh"), "prod"], {
      env: {
        STATE: sb.dir,
        TOKEN: opts.token ?? TOK,
        TOK_EXPECT: TOK,
        HOSTED_DIR: hosted,
      },
    });
    // The token never reaches argv (the log holds each call's argv) or output.
    const argv = sb.log().filter((l) => l.startsWith("curl "));
    for (const l of argv) expect(l).not.toContain(TOK);
    expect(sb.log().join("\n").replaceAll(`Bearer ${TOK}`, "")).not.toContain(
      TOK,
    );
    expect([r.out, r.err].join("\n")).not.toContain(TOK);
    return { ...r, log: sb.log(), argv, all: sb.log().join("\n") };
  };

  it("prints only id, status and kind for a user token, sending the header", () => {
    const r = run({ user: ok() });
    expect(r.code).toBe(0);
    expect(r.out).toBe(`id=${ID} status=active kind=user\n`);
    expect(
      r.log.some((l) => l === `cfg: header = "Authorization: Bearer ${TOK}"`),
    ).toBe(true);
    expect(r.argv[0]).toContain("--max-time 30");
    expect(r.all).toContain("/user/tokens/verify");
  });

  it("falls back to the account verify on an auth error", () => {
    const r = run({ user: '{"success":false}\n401', account: ok() });
    expect(r.code).toBe(0);
    expect(r.out).toBe(`id=${ID} status=active kind=account\n`);
    expect(r.all).toContain(`/accounts/${ACCT}/tokens/verify`);
  });

  it("fails closed, printing only the HTTP code", () => {
    const r = run({
      user: '{"success":false}\n401',
      account: '{"success":false}\n403',
    });
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toBe("http=403\n");
  });

  it("does not fall back on a server error", () => {
    const r = run({ user: "oops\n500" });
    expect(r.code).toBe(1);
    expect(r.err).toBe("http=500\n");
    expect(r.argv).toHaveLength(1);
  });

  it("fails closed on a curl failure", () => {
    const r = run({ user: "", curl: "exit 28" });
    expect(r.code).toBe(1);
    expect(r.err).toBe("http=000\n");
  });

  it("refuses a 200 without a well-formed id or status, never echoing it", () => {
    for (const body of [
      ok("not-an-id"),
      ok(ID, "ac tive; $(x)"),
      `{"success":false,"result":{"id":"${ID}","status":"active"}}\n200`,
      "not json\n200",
    ]) {
      const r = run({ user: body });
      expect(r.code).toBe(1);
      expect(r.out).toBe("");
      expect(r.err).toBe("http=200\n");
    }
  });

  it("refuses a token with unexpected characters without printing it", () => {
    const bad = 'abc"def';
    const r = run({ user: ok(), token: bad });
    expect(r.code).toBe(1);
    expect(r.err).not.toContain(bad);
    expect(r.argv).toHaveLength(0);
  });
});
