// platform-tags.sh (#1040): every platform Worker of an env runs exactly the
// release tag (the "workers/tag" annotation on the one version its newest
// deployment serves at 100%). Read-only; fails closed on any API error. curl
// is a stub; the token reaches it on stdin only.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sandbox, script } from "./stubs.ts";

const TOK = "cfut_TOKEN_never_printed_0123456789";
const ACCT = "26ac346086d4405f7a976d48747a2a75";
const TAG = "v0.90.3";
const APPS = [
  "auth-broker",
  "directory-broker",
  "provisioner",
  "dispatch",
  "scheduler",
  "inventory",
  "provisioning",
];
const vid = (i: number) =>
  `${String(i).repeat(8)}-0000-4000-8000-${String(i).repeat(12)}`;

// curl: answers GET .../workers/scripts/<w>/deployments and
// .../versions/<id> from $STATE/<w>/{deployments,version-<id>}; NETERR fails.
const curl = `cfg="$(cat)"
case "$cfg" in *"Bearer $TOK_EXPECT"*) ;; *) echo '{"success":false,"errors":[{"message":"bad token"}]}'; exit 0 ;; esac
url="\${@: -1}"; path="\${url#https://api.cloudflare.com/client/v4}"
case "$path" in
  "/accounts/$STUB_ACCT/workers/scripts/"*/deployments) w="\${path#/accounts/$STUB_ACCT/workers/scripts/}"; f="$STATE/\${w%%/*}/deployments" ;;
  "/accounts/$STUB_ACCT/workers/scripts/"*/versions/*) w="\${path#/accounts/$STUB_ACCT/workers/scripts/}"; f="$STATE/\${w%%/*}/version-\${path##*/}" ;;
  *) echo "UNEXPECTED $path" >> "$STUB_LOG"; echo '{"success":false}'; exit 0 ;;
esac
[ -f "$f" ] || { echo '{"success":false,"errors":[{"code":10007,"message":"not found"}]}'; exit 0; }
[ "$(cat "$f")" = NETERR ] && { echo "curl: (6) Could not resolve host" >&2; exit 6; }
cat "$f"`;

const ok = (result: unknown) =>
  JSON.stringify({ success: true, errors: [], result });
const deployment = (versions: { version_id: string; percentage: number }[]) =>
  ok({
    deployments: [
      // An older deployment first: the newest by created_on counts.
      {
        id: "old",
        created_on: "2026-10-01T00:00:00.000000Z",
        strategy: "percentage",
        versions: [{ version_id: vid(9), percentage: 100 }],
      },
      {
        id: "new",
        created_on: "2026-11-01T00:00:00.000000Z",
        strategy: "percentage",
        versions,
      },
    ],
  });
const version = (id: string, tag?: string) =>
  ok({
    id,
    number: 7,
    annotations: tag === undefined ? {} : { "workers/tag": tag },
  });

type Fx = Record<
  string,
  { deployments?: string; versions?: [string, string][] }
>;
const allTagged = (env = "s", tag = TAG): Fx =>
  Object.fromEntries(
    APPS.map((a, i) => [
      `oa-${env}-${a}`,
      {
        deployments: deployment([{ version_id: vid(i + 1), percentage: 100 }]),
        versions: [[vid(i + 1), version(vid(i + 1), tag)]],
      },
    ]),
  );

const run = (
  fx: Fx,
  args = ["staging", TAG],
  env: Record<string, string> = {},
) => {
  const sb = sandbox({ curl });
  for (const [w, f] of Object.entries(fx)) {
    mkdirSync(join(sb.dir, w), { recursive: true });
    if (f.deployments)
      writeFileSync(join(sb.dir, w, "deployments"), f.deployments);
    for (const [id, body] of f.versions ?? [])
      writeFileSync(join(sb.dir, w, `version-${id}`), body);
  }
  const r = sb.run(["bash", script("platform-tags.sh"), ...args], {
    env: {
      STATE: sb.dir,
      CLOUDFLARE_API_TOKEN: TOK,
      TOK_EXPECT: TOK,
      CLOUDFLARE_ACCOUNT_ID: ACCT,
      STUB_ACCT: ACCT,
      ...env,
    },
  });
  const log = sb.log();
  // The token is never in curl's argv, stdout or stderr.
  expect([r.out, r.err, ...log].join("\n")).not.toContain(TOK);
  expect(log.filter((l) => l.startsWith("UNEXPECTED"))).toEqual([]);
  return { ...r, log };
};

describe("platform-tags.sh", () => {
  it("all seven Workers on the tag: one ok line each, exit 0", () => {
    const r = run(allTagged());
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines).toHaveLength(7);
    for (const [i, a] of APPS.entries())
      expect(lines[i]).toBe(
        `ok oa-s-${a} runs ${TAG} (version ${vid(i + 1).slice(0, 8)})`,
      );
    // Two GETs per Worker, every one by curl -K - (the token on stdin).
    const calls = r.log.filter((l) => l.startsWith("curl "));
    expect(calls).toHaveLength(14);
    for (const c of calls) expect(c).toMatch(/^curl -sS -K - https:\/\//);
  });

  it("prod reads the oa-p- Workers", () => {
    const r = run(allTagged("p"), ["prod", TAG]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("ok oa-p-provisioning runs v0.90.3");
  });

  it("an untagged Worker fails, naming it and its version; the others still report", () => {
    const fx = allTagged();
    fx["oa-s-auth-broker"] = {
      deployments: deployment([{ version_id: vid(1), percentage: 100 }]),
      versions: [[vid(1), version(vid(1))]],
    };
    const r = run(fx);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      `oa-s-auth-broker runs untagged version ${vid(1).slice(0, 8)}`,
    );
    expect(r.out.trim().split("\n")).toHaveLength(6);
    expect(r.out).not.toContain("ok oa-s-auth-broker");
  });

  it("a Worker on another tag fails, naming what it runs", () => {
    const fx = allTagged();
    fx["oa-s-scheduler"] = {
      deployments: deployment([{ version_id: vid(5), percentage: 100 }]),
      versions: [[vid(5), version(vid(5), "v0.90.2")]],
    };
    const r = run(fx);
    expect(r.code).toBe(1);
    expect(r.err).toContain("oa-s-scheduler runs v0.90.2");
    expect(r.err).toContain("not v0.90.3");
  });

  it("a non-release tag is named, not echoed", () => {
    const fx = allTagged();
    fx["oa-s-dispatch"] = {
      deployments: deployment([{ version_id: vid(4), percentage: 100 }]),
      versions: [[vid(4), version(vid(4), "$(rm -rf) hi")]],
    };
    const r = run(fx);
    expect(r.code).toBe(1);
    expect(r.err).toContain("oa-s-dispatch runs version");
    expect(r.err).not.toContain("rm -rf");
  });

  it("a split deployment fails, even when both versions carry the tag", () => {
    const fx = allTagged();
    fx["oa-s-provisioner"] = {
      deployments: deployment([
        { version_id: vid(3), percentage: 50 },
        { version_id: vid(7), percentage: 50 },
      ]),
      versions: [
        [vid(3), version(vid(3), TAG)],
        [vid(7), version(vid(7), TAG)],
      ],
    };
    const r = run(fx);
    expect(r.code).toBe(1);
    expect(r.err).toContain("oa-s-provisioner runs a split deployment");
  });

  it("any API error fails closed, naming the Worker", () => {
    const cases: [string, Fx[string]][] = [
      // A missing Worker (10007), a refused call, a network error, an
      // unreadable version, no deployment at all.
      ["oa-s-inventory", {}],
      [
        "oa-s-inventory",
        {
          deployments: JSON.stringify({
            success: false,
            errors: [{ code: 10000, message: "Authentication error" }],
          }),
        },
      ],
      ["oa-s-inventory", { deployments: "NETERR" }],
      [
        "oa-s-inventory",
        {
          deployments: deployment([{ version_id: vid(6), percentage: 100 }]),
          versions: [],
        },
      ],
      ["oa-s-inventory", { deployments: ok({ deployments: [] }) }],
      ["oa-s-inventory", { deployments: "not json" }],
    ];
    for (const [w, f] of cases) {
      const fx = allTagged();
      fx[w] = f;
      const r = run(fx);
      expect(r.code, JSON.stringify(f)).toBe(1);
      expect(r.err).toContain(w);
      expect(r.out).not.toContain(`ok ${w}`);
    }
  });

  it("refuses bad arguments and a missing token or account before any call", () => {
    for (const args of [
      ["staging"],
      ["dev", TAG],
      ["staging", "0.90.3"],
      ["staging", "v0.90.3-rc.1"],
    ]) {
      const r = run(allTagged(), args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.log).toEqual([]);
    }
    const noTok = run(allTagged(), ["staging", TAG], {
      CLOUDFLARE_API_TOKEN: "",
    });
    expect(noTok.code).not.toBe(0);
    expect(noTok.log).toEqual([]);
    const noAcct = run(allTagged(), ["staging", TAG], {
      CLOUDFLARE_ACCOUNT_ID: "",
    });
    expect(noAcct.code).not.toBe(0);
    expect(noAcct.log).toEqual([]);
  });
});
