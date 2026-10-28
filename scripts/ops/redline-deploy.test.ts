import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, sandbox } from "../ci/stubs.ts";

// pnpm stub: answers each oa:hosted step with its JSON line (FAIL_STEP makes
// one fail; ALREADY makes upgrade report "already at"). curl stub: /healthz
// with HZ_VERSION and the id from HZ_ID_<slug> (default: the right one).
const pnpm = `
step="$3"
if [ "$step" = "\${FAIL_STEP:-}" ]; then echo '{"step":"'"$step"'","status":"error","error":"X","message":"boom"}'; exit 1; fi
if [ "$step" = publish-release ] && [ -n "\${PUBLISHED:-}" ]; then echo '{"step":"publish-release","status":"error","error":"PublishRefused","message":"release 1.2.3 (release) is already published to oa-s-releases; a version is never overwritten"}'; exit 1; fi
if [ "$step" = upgrade ] && [ -n "\${ALREADY:-}" ]; then echo '{"step":"upgrade","status":"error","error":"ProvisionRefused","message":"install x is already at 1.2.3"}'; exit 1; fi
echo '{"step":"'"$step"'","status":"ok","data":{}}'`;
const curl = `
url="\${@: -1}"; slug="\${url#https://}"; slug="\${slug%%.*}"
case "$slug" in rl-a) id="\${HZ_ID_A:-ijzbmraouh5r}" ;; rl-b) id="\${HZ_ID_B:-i42fdk7ahvs2}" ;; esac
echo '{"ok":true,"version":"'"\${HZ_VERSION:-1.2.3}"'","installId":"'"$id"'"}'`;

const run = (args: string[], env: Record<string, string> = {}) => {
  const sb = sandbox({ pnpm, curl });
  const r = sb.run(
    ["bash", join(root, "scripts/ops/redline-deploy.sh"), ...args],
    { env: { CLOUDFLARE_ACCOUNT_ID: "acct", ...env } },
  );
  return { ...r, log: sb.log().filter((l) => l.startsWith("pnpm")) };
};

describe("redline-deploy.sh", () => {
  it("publishes the tag, upgrades rl-a, and checks its /healthz version and id", () => {
    const r = run(["v1.2.3"]);
    expect(r.code).toBe(0);
    expect(r.log).toEqual([
      "pnpm -s oa:hosted publish-release --env staging --tag v1.2.3",
      "pnpm -s oa:hosted upgrade --env staging --install ijzbmraouh5r --to 1.2.3",
    ]);
    expect(r.out).toContain(
      "redline-deploy: rl-a at 1.2.3 (install ijzbmraouh5r)",
    );
  });
  it("--with-rl-b upgrades both", () => {
    const r = run(["v1.2.3", "--with-rl-b"]);
    expect(r.code).toBe(0);
    expect(r.log).toHaveLength(3);
    expect(r.log[2]).toContain("--install i42fdk7ahvs2 --to 1.2.3");
    expect(r.out).toContain("rl-b at 1.2.3");
  });
  it("an install already at that version, or the release already published, is fine", () => {
    expect(run(["v1.2.3"], { ALREADY: "1" }).code).toBe(0);
    expect(run(["v1.2.3"], { PUBLISHED: "1", ALREADY: "1" }).code).toBe(0);
  });
  it("fails when publish or upgrade fails, or /healthz isn't that version on that install", () => {
    const pub = run(["v1.2.3"], { FAIL_STEP: "publish-release" });
    expect(pub.code).toBe(1);
    expect(pub.log).toHaveLength(1);
    expect(run(["v1.2.3"], { FAIL_STEP: "upgrade" }).code).toBe(1);
    const old = run(["v1.2.3"], { HZ_VERSION: "1.2.2" });
    expect(old.code).toBe(1);
    expect(old.err).toContain(
      'reports "1.2.2 ijzbmraouh5r", not "1.2.3 ijzbmraouh5r"',
    );
    // Another install answering on rl-a's host is not rl-a.
    expect(run(["v1.2.3"], { HZ_ID_A: "someone-else" }).code).toBe(1);
  });
  it("refuses a malformed tag, an unknown flag, or no account", () => {
    for (const a of [[], ["1.2.3"], ["v1.2"], ["v1.2.3", "--all"]])
      expect(run(a).code, a.join(" ")).toBe(2);
    expect(run(["v1.2.3"], { CLOUDFLARE_ACCOUNT_ID: "" }).code).not.toBe(0);
  });
});
