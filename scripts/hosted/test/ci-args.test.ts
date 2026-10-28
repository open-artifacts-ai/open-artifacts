// OPS-B: hosted-ops.yml's input validator. Every op's schema, and injection
// attempts in every input.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ARG_KEYS,
  ArgsRefused,
  CI_TOKEN_OPS,
  type Inputs,
  OPS,
  plan,
  run,
} from "../src/ci-args.ts";
import { COMMANDS } from "../src/cli.ts";

const ID = "iabcdefghijk";
const base: Inputs = {
  env: "staging",
  op: "status",
  install: ID,
  tag: "",
  args: "",
  confirm: "",
};
const ok = (o: Partial<Inputs>, floor?: string) =>
  plan({ ...base, ...o }, floor);
const refused = (o: Partial<Inputs>, re?: RegExp, floor?: string) => {
  let e: unknown;
  try {
    plan({ ...base, ...o }, floor);
  } catch (x) {
    e = x;
  }
  expect(e, JSON.stringify(o)).toBeInstanceOf(ArgsRefused);
  if (re) expect((e as Error).message, JSON.stringify(o)).toMatch(re);
};
const CREATE = (args: Record<string, unknown> = {}): Partial<Inputs> => ({
  op: "create",
  install: "",
  tag: "v0.74.1",
  args: JSON.stringify({ slug: "finqore", owner: "ops@finqore.test", ...args }),
});

const INJECT = [
  "$(touch /tmp/pwned)",
  "`id`",
  "a;rm -rf /",
  "a && curl evil",
  "a\nb",
  "a\rb",
  "a\u0000b",
  "--env=prod",
  "-x",
  "${{ secrets.PROVISION_TOKEN }}",
  "' OR 1=1 --",
  "a|b",
  "é",
];

describe("the op allowlist and env", () => {
  it("accepts exactly the ten ops, all of them CLI commands", () => {
    expect([...OPS]).toEqual([
      "create",
      "upgrade",
      "rollback",
      "update-vars",
      "status",
      "delete",
      "release-lease",
      "turnstile-init",
      "publish-release",
      "publish-floor",
    ]);
    for (const op of OPS)
      expect((COMMANDS as readonly string[]).includes(op)).toBe(true);
    for (const op of [
      "owner-token",
      "redline-creds",
      "ci-token-sweep",
      "Create",
      "create ",
      "",
      ...INJECT,
    ])
      refused({ op }, /op must be one of/);
  });

  it("env is staging or prod only", () => {
    for (const env of ["", "Prod", "production", "prod ", "dev", ...INJECT])
      refused({ env }, /env must be staging or prod/);
    expect(ok({ env: "prod" }).argv).toEqual([
      "status",
      "--env",
      "prod",
      "--install",
      ID,
    ]);
  });
});

describe("install, tag and confirm", () => {
  it("install: an install id where needed, nothing where not", () => {
    for (const op of [
      "upgrade",
      "rollback",
      "update-vars",
      "status",
      "delete",
      "release-lease",
    ])
      refused({ op, install: "" }, /needs an install/);
    for (const install of [
      "iabc",
      "IABCDEFGHIJK",
      "iabcdefghijkl",
      ` ${ID}`,
      `${ID}\n`,
      ...INJECT,
    ])
      refused({ install }, /not an install id/);
    for (const op of ["turnstile-init", "publish-release", "publish-floor"])
      refused({ op, install: ID, tag: "v1.0.0" }, /takes no install/);
    // create may resume an install.
    expect(ok({ ...CREATE(), install: ID }).argv).toContain(ID);
  });

  it("tag: a stable vX.Y.Z where needed; refused elsewhere", () => {
    for (const tag of [
      "0.74.1",
      "v0.74",
      "v0.74.1-rc.1",
      "v0.74.1 ",
      "main",
      "refs/tags/v0.74.1",
      ...INJECT,
    ]) {
      refused({ ...CREATE(), tag }, /stable release tag/);
      refused({ op: "upgrade", tag }, /stable release tag/);
      refused({ op: "publish-release", install: "", tag }, /stable release tag/);
    }
    refused({ op: "upgrade", tag: "" }, /upgrade needs a tag/);
    refused({ op: "publish-release", install: "", tag: "" }, /needs a tag/);
    for (const op of ["rollback", "status", "update-vars", "delete"])
      refused({ op, tag: "v1.2.3", confirm: op === "delete" ? ID : "" }, /takes no tag/);
  });

  it("confirm: exactly the install for delete and release-lease, empty elsewhere", () => {
    for (const op of ["delete", "release-lease"]) {
      for (const confirm of ["", "iaaaaaaaaaaa", `${ID} `, ID.toUpperCase()])
        refused({ op, confirm }, /confirm to be exactly the install id/);
      expect(ok({ op, confirm: ID }).argv).toEqual([
        op,
        "--env",
        "staging",
        "--install",
        ID,
        "--confirm",
        ID,
      ]);
    }
    refused({ op: "status", confirm: ID }, /takes no confirm/);
  });
});

describe("args: JSON against each op's schema", () => {
  it("args is a JSON object with only the op's keys", () => {
    for (const args of ["[]", "null", "1", '"x"', "{", "{'a':1}", "x".repeat(20_000)])
      refused({ args });
    for (const op of OPS)
      if (ARG_KEYS[op].length === 0)
        refused(
          {
            op,
            install: ["turnstile-init", "publish-release"].includes(op) ? "" : ID,
            tag: ["upgrade", "publish-release"].includes(op) ? "v1.0.0" : "",
            args: '{"x":1}',
          },
          /takes no args/,
        );
    refused({ ...CREATE(), args: '{"slug":"a","owner":"a@b.co","__proto__":{"x":1}}' }, /not one of/);
    refused({ ...CREATE({ install: ID }) }, /not one of/);
    refused({ ...CREATE({ env: "prod" }) }, /not one of/);
  });

  it("create: --slug, --owner, --to from the tag (or args.to), --var, staging --test-hooks; always --ci-owner-token", () => {
    expect(ok(CREATE({ var: ["AUTH_PROVIDERS=email"] }))).toEqual({
      argv: [
        "create",
        "--env",
        "staging",
        "--slug",
        "finqore",
        "--owner",
        "ops@finqore.test",
        "--to",
        "0.74.1",
        "--var",
        "AUTH_PROVIDERS=email",
        "--ci-owner-token",
      ],
      sweep: null,
    });
    expect(ok({ ...CREATE({ to: "0.74.1" }), tag: "" }).argv).toContain(
      "0.74.1",
    );
    refused(CREATE({ to: "0.74.2" }), /different versions/);
    refused({ ...CREATE(), tag: "" }, /needs a tag/);
    expect(ok(CREATE({ testHooks: true })).argv).toContain("--test-hooks");
    expect(ok(CREATE({ testHooks: false })).argv).not.toContain("--test-hooks");
    refused({ ...CREATE({ testHooks: true }), env: "prod" }, /staging only/);
    refused(CREATE({ testHooks: "true" }), /boolean/);
    for (const slug of ["www", "xn--a", "-ab","Fin", "x".repeat(40), "", 1, ...INJECT])
      refused(CREATE({ slug }));
    for (const owner of ["nope", "", 7, "a b@c.co", ...INJECT]) refused(CREATE({ owner }));
    refused({ ...CREATE(), args: '{"slug":"finqore"}' }, /args.owner/);
  });

  it("var entries: K=V with only the var names the CLI accepts", () => {
    for (const v of [
      ["NOT_A_VAR=1"],
      ["lower=1"],
      ["=1"],
      ["AUTH_PROVIDERS"],
      ["AUTH_PROVIDERS=email", "AUTH_PROVIDERS=email"],
      ["AUTH_PROVIDERS=email\nX=1"],
      ["AUTH_PROVIDERS=$(id)"],
      ["AUTH_PROVIDERS=email;rm -rf /"],
      [],
      "AUTH_PROVIDERS=email",
      [1],
      Array.from({ length: 65 }, (_, i) => `FEATURES=${i}`),
    ]) {
      refused(CREATE({ var: v }));
      refused({ op: "update-vars", args: JSON.stringify({ var: v }) });
    }
    expect(
      ok({
        op: "update-vars",
        args: JSON.stringify({ var: ["FEATURES=beta", "AUTH_PROVIDERS=email"] }),
      }),
    ).toEqual({
      argv: [
        "update-vars",
        "--env",
        "staging",
        "--install",
        ID,
        "--var",
        "FEATURES=beta",
        "--var",
        "AUTH_PROVIDERS=email",
        "--ci-owner-token",
      ],
      sweep: ID,
    });
    refused({ op: "update-vars" }, /non-empty list/);
  });

  it("upgrade and rollback: --ci-owner-token and the sweep's install", () => {
    expect(ok({ op: "upgrade", tag: "v0.75.0" })).toEqual({
      argv: [
        "upgrade",
        "--env",
        "staging",
        "--install",
        ID,
        "--to",
        "0.75.0",
        "--ci-owner-token",
      ],
      sweep: ID,
    });
    expect(ok({ op: "rollback" })).toEqual({
      argv: ["rollback", "--env", "staging", "--install", ID, "--ci-owner-token"],
      sweep: ID,
    });
  });

  it("delete, release-lease, status, turnstile-init, publish-release: their flags only, no CI token", () => {
    expect(
      ok({
        op: "delete",
        confirm: ID,
        args: JSON.stringify({ skipDirectoryRevoke: "the customer revoked it" }),
      }).argv,
    ).toEqual([
      "delete",
      "--env",
      "staging",
      "--install",
      ID,
      "--confirm",
      ID,
      "--skip-directory-revoke",
      "the customer revoked it",
    ]);
    for (const r of ["", "-x", "a\nb", 1])
      refused({
        op: "delete",
        confirm: ID,
        args: JSON.stringify({ skipDirectoryRevoke: r }),
      });
    expect(
      ok({ op: "release-lease", confirm: ID, args: '{"force":true}' }).argv,
    ).toContain("--force");
    refused({ op: "release-lease", confirm: ID, args: '{"force":"yes"}' });
    expect(ok({ op: "turnstile-init", install: "" })).toEqual({
      argv: ["turnstile-init", "--env", "staging"],
      sweep: null,
    });
    expect(
      ok({ op: "publish-release", install: "", tag: "v0.74.1" }),
    ).toEqual({
      argv: ["publish-release", "--env", "staging", "--tag", "v0.74.1"],
      sweep: null,
    });
    for (const op of OPS)
      expect(CI_TOKEN_OPS.includes(op)).toBe(
        ["create", "upgrade", "rollback", "update-vars"].includes(op),
      );
  });

  it("publish-floor: the signed floor object, re-serialized to OPS_FLOOR_FILE", () => {
    const floor = {
      record: JSON.stringify({ env: "staging", seq: 2, minVersion: "0.20.0", revoked: [] }),
      signature: "abcDEF123_-",
    };
    const p = ok(
      { op: "publish-floor", install: "", args: JSON.stringify({ floor }) },
      "/tmp/floor.sig.json",
    );
    expect(p.argv).toEqual([
      "publish-floor",
      "--env",
      "staging",
      "--floor",
      "/tmp/floor.sig.json",
    ]);
    expect(JSON.parse(p.floor as string)).toEqual(floor);
    const pf = (f: unknown, file = "/tmp/f.json") =>
      refused(
        { op: "publish-floor", install: "", args: JSON.stringify({ floor: f }) },
        undefined,
        file,
      );
    pf({ ...floor, extra: "x" });
    pf({ record: floor.record });
    pf({ ...floor, signature: "a\nb" });
    pf({ ...floor, signature: "$(id)" });
    pf({ ...floor, record: "not json" });
    pf({ ...floor, record: JSON.stringify({ env: "prod", seq: 2 }) });
    pf("floor");
    pf(floor, "relative.json");
    refused({ op: "publish-floor", install: "", args: JSON.stringify({ floor }) });
  });

  it("no injection string survives in any argv slot: every value is refused or kept as one inert argv entry", () => {
    for (const s of INJECT) {
      for (const o of [
        CREATE({ slug: s }),
        CREATE({ owner: s }),
        CREATE({ to: s }),
        CREATE({ var: [`FEATURES=${s}`] }),
        { op: "delete", confirm: ID, args: JSON.stringify({ skipDirectoryRevoke: s }) },
      ] as Partial<Inputs>[]) {
        let p: ReturnType<typeof plan> | undefined;
        try {
          p = plan({ ...base, ...o });
        } catch (e) {
          expect(e).toBeInstanceOf(ArgsRefused);
          continue;
        }
        // Kept: printable ASCII, never a flag, one argv entry.
        for (const a of p.argv) {
          expect(a).toMatch(/^[\x20-\x7e]+$/);
          if (a === s) expect(a.startsWith("-")).toBe(false);
        }
      }
    }
  });
});

describe("the script: env in, one JSON argv out", () => {
  const script = fileURLToPath(new URL("../src/ci-args.ts", import.meta.url));
  const go = (env: Record<string, string>) =>
    spawnSync(process.execPath, [script], {
      env: { PATH: process.env.PATH ?? "", ...env },
      encoding: "utf8",
    });

  it("prints the argv JSON and writes the sweep install to GITHUB_OUTPUT", () => {
    const dir = mkdtempSync(join(tmpdir(), "oa-ci-args-"));
    const out = join(dir, "out");
    const r = go({
      OPS_ENV: "staging",
      OPS_OP: "upgrade",
      OPS_INSTALL: ID,
      OPS_TAG: "v0.75.0",
      OPS_ARGS: "",
      OPS_CONFIRM: "",
      GITHUB_OUTPUT: out,
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([
      "upgrade",
      "--env",
      "staging",
      "--install",
      ID,
      "--to",
      "0.75.0",
      "--ci-owner-token",
    ]);
    expect(readFileSync(out, "utf8")).toBe(`install=${ID}\n`);
  });

  it("a refusal exits 1, prints no argv and names the field, not the value", () => {
    const r = go({ OPS_ENV: "staging", OPS_OP: "$(touch /tmp/x)" });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^hosted-ops: refused: op must be one of/);
    expect(r.stderr).not.toContain("touch");
  });

  it("publish-floor writes the floor 0600 and refuses to overwrite a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "oa-ci-args-"));
    const file = join(dir, "floor.sig.json");
    const floor = {
      record: JSON.stringify({ env: "prod", seq: 3, minVersion: "0.70.0", revoked: [] }),
      signature: "sig",
    };
    const env = {
      OPS_ENV: "prod",
      OPS_OP: "publish-floor",
      OPS_ARGS: JSON.stringify({ floor }),
      OPS_FLOOR_FILE: file,
    };
    const r = go(env);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([
      "publish-floor",
      "--env",
      "prod",
      "--floor",
      file,
    ]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(floor);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(go(env).status).not.toBe(0);
  });

  it("run() reports through io only", () => {
    const outs: string[] = [];
    const errs: string[] = [];
    const io = {
      out: (s: string) => outs.push(s),
      err: (s: string) => errs.push(s),
      writeFile: () => {},
      appendFile: () => {},
    };
    expect(run({ OPS_ENV: "prod", OPS_OP: "status", OPS_INSTALL: ID }, io)).toBe(0);
    expect(outs).toEqual([JSON.stringify(["status", "--env", "prod", "--install", ID])]);
    expect(run({ OPS_ENV: "prod", OPS_OP: "status" }, io)).toBe(1);
    expect(errs).toEqual(["hosted-ops: refused: status needs an install"]);
  });
});
