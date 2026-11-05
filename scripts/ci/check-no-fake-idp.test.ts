import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkNoFakeIdp } from "./check-no-fake-idp.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(root, "scripts/ci/check-no-fake-idp.ts");

const GOOGLE = `const T = "https://oauth2.googleapis.com/token"; const J = "https://www.googleapis.com/oauth2/v3/certs";`;

function bundle(body: string): string {
  const d = mkdtempSync(join(tmpdir(), "oa-cnfi-"));
  writeFileSync(join(d, "index.js"), `${GOOGLE}\n${body}\nexport default {};`);
  return d;
}

describe("check-no-fake-idp.ts", () => {
  it("a release-like bundle: exit 0, one line", () => {
    const r = spawnSync(
      process.execPath,
      ["--experimental-strip-types", script, bundle("// real code")],
      { encoding: "utf8", timeout: 60_000 },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^check-no-fake-idp: ok: /);
  });

  it.each([
    ["// ../../tests/redline/src/fake-idp/auth-core-shim.ts", /file name/],
    [
      'throw new Error("fake IdP shim: not a local fake-IdP build");',
      /file name|refusal message/,
    ],
    ["const o = __OA_FAKE_IDP__;", /define names/],
    [
      "if (!/^http:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(o)) x();",
      /loopback origin check/,
    ],
    ['const u = "http://127.0.0.1:51074/token";', /fake IdP URL/],
    ['const u = "http://127.0.0.1:51074/oauth2/v3/certs";', /fake IdP URL/],
  ])("refuses a bundle holding %s", (body, why) => {
    const [ok, msg] = checkNoFakeIdp(bundle(body));
    expect(ok).toBe(false);
    expect(msg).toMatch(why);
  });

  it("refuses a bundle without Google's real URLs, and no bundle at all", () => {
    const d = mkdtempSync(join(tmpdir(), "oa-cnfi-"));
    writeFileSync(join(d, "index.js"), "export default {};");
    expect(checkNoFakeIdp(d)).toEqual([
      false,
      "no https://oauth2.googleapis.com/token in the bundle (not a release build?)",
    ]);
    expect(checkNoFakeIdp(mkdtempSync(join(tmpdir(), "oa-cnfi-")))[0]).toBe(
      false,
    );
  });
});
