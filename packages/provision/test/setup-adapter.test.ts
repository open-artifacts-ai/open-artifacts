// P1 Task 8: the self-hosted Provisioner over @oa/setup's run and
// rollbackCommand. The setup functions are stand-ins that print the JSON
// lines setup prints; nothing here deploys.
import { describe, expect, it } from "vitest";
import {
  type SetupDeps,
  type SetupFns,
  SetupProvisioner,
} from "../src/setup-adapter.js";
import { NotInM1 } from "../src/types.js";

type Line = { step: string; status: string; message: string; data?: unknown };

function fakeSetup(o: {
  run?: Line[];
  runCode?: number;
  rollback?: Line[];
  rollbackCode?: number;
}) {
  const calls: { fn: string; argv: string[]; root: string }[] = [];
  const fns: SetupFns = {
    run: async (argv, deps, root) => {
      calls.push({ fn: "run", argv, root });
      for (const l of o.run ?? []) deps.out(JSON.stringify(l));
      return o.runCode ?? 0;
    },
    rollbackCommand: async (argv, deps, root) => {
      calls.push({ fn: "rollback", argv, root });
      for (const l of o.rollback ?? []) deps.out(JSON.stringify(l));
      return o.rollbackCode ?? 0;
    },
  };
  return { fns, calls };
}

const printed: string[] = [];
const deps = {
  out: (l: string) => printed.push(l),
  env: {},
} as unknown as SetupDeps;

const CREATED: Line[] = [
  { step: "prereqs", status: "ok", message: "ok" },
  {
    step: "deploy",
    status: "ok",
    message: "deployed 0.55.2",
    data: { deployedVersion: "0.55.2", repoVersion: "0.55.2" },
  },
  {
    step: "owner-token",
    status: "ok",
    message: "ok",
    data: {
      tokenId: "t1",
      tokenFile: "/h/.open-artifacts/a.example-pat-token",
    },
  },
  {
    step: "state",
    status: "ok",
    message: "saved",
    data: {
      name: "acme",
      appHost: "a.example",
      contentHost: "c.example",
      ownerEmail: "o@example.com",
    },
  },
];

describe("SetupProvisioner", () => {
  it("setup adapter maps a successful run to Install and a failed upgrade to ok:false", async () => {
    const ok = fakeSetup({ run: CREATED });
    const p = new SetupProvisioner({ deps, root: "/repo", setup: ok.fns });
    const inst = await p.create({
      slug: "acme",
      ownerEmail: "o@example.com",
      plan: "paid",
      vars: { FEATURES: "spaces" },
    });
    expect(inst).toEqual({
      id: "acme",
      slug: "acme",
      appHost: "a.example",
      contentHost: "c.example",
      version: "0.55.2",
      patFile: "/h/.open-artifacts/a.example-pat-token",
    });
    expect(ok.calls[0]).toEqual({
      fn: "run",
      root: "/repo",
      argv: [
        "--json",
        "--yes",
        "--solo",
        "--name",
        "acme",
        "--owner-email",
        "o@example.com",
        "--var",
        "FEATURES=spaces",
      ],
    });

    const bad = fakeSetup({
      runCode: 1,
      run: [
        { step: "prereqs", status: "ok", message: "ok" },
        { step: "deploy", status: "error", message: "wrangler deploy failed" },
      ],
    });
    const q = new SetupProvisioner({ deps, root: "/repo", setup: bad.fns });
    const r = await q.upgrade("acme", { version: "0.56.0", bundleKey: "" });
    expect(bad.calls[0]?.argv).toEqual([
      "--upgrade",
      "--json",
      "--name",
      "acme",
    ]);
    expect(r).toEqual({
      id: "acme",
      from: "",
      to: "0.56.0",
      ok: false,
      rolledBack: false,
      reason: "deploy: wrangler deploy failed",
    });
  });

  it("a successful upgrade reports from and to", async () => {
    const s = fakeSetup({
      run: [
        {
          step: "deploy",
          status: "ok",
          message: "deployed 0.56.0",
          data: {
            deployedVersion: "0.56.0",
            repoVersion: "0.56.0",
            liveVersion: "0.55.2",
          },
        },
      ],
    });
    const p = new SetupProvisioner({ deps, root: "/r", setup: s.fns });
    expect(
      await p.upgrade("acme", { version: "0.56.0", bundleKey: "" }),
    ).toEqual({
      id: "acme",
      from: "0.55.2",
      to: "0.56.0",
      ok: true,
      rolledBack: false,
    });
  });

  it("an upgrade that deploys another version than asked is ok:false", async () => {
    const s = fakeSetup({
      run: [
        {
          step: "deploy",
          status: "ok",
          message: "deployed 0.55.9",
          data: { deployedVersion: "0.55.9", liveVersion: "0.55.2" },
        },
      ],
    });
    const p = new SetupProvisioner({ deps, root: "/r", setup: s.fns });
    const r = await p.upgrade("acme", { version: "0.56.0", bundleKey: "" });
    expect(r).toMatchObject({ ok: false, to: "0.55.9" });
    expect(r.reason).toMatch(/0\.56\.0/);
  });

  it("rollback maps rollbackCommand's from/to; a refusal is ok:false", async () => {
    const s = fakeSetup({
      rollback: [
        {
          step: "rollback",
          status: "ok",
          message: "rolled acme back",
          data: { from: "ver-2", to: "ver-1" },
        },
      ],
    });
    const p = new SetupProvisioner({ deps, root: "/r", setup: s.fns });
    expect(await p.rollback("acme")).toEqual({
      id: "acme",
      from: "ver-2",
      to: "ver-1",
      ok: true,
      rolledBack: true,
    });
    expect(s.calls[0]?.argv).toEqual(["--json", "--name", "acme"]);

    const n = fakeSetup({
      rollbackCode: 2,
      rollback: [
        {
          step: "rollback",
          status: "action_required",
          message: "no previous version is recorded",
        },
      ],
    });
    const q = new SetupProvisioner({ deps, root: "/r", setup: n.fns });
    expect(await q.rollback("acme")).toEqual({
      id: "acme",
      from: "",
      to: "",
      ok: false,
      rolledBack: false,
      reason: "rollback: no previous version is recorded",
    });
  });

  it("a failed create throws with setup's error line; test hooks are refused", async () => {
    const s = fakeSetup({
      runCode: 2,
      run: [
        { step: "prereqs", status: "action_required", message: "log in first" },
      ],
    });
    const p = new SetupProvisioner({ deps, root: "/r", setup: s.fns });
    await expect(
      p.create({ slug: "acme", ownerEmail: "o@example.com", plan: "paid" }),
    ).rejects.toThrow(/prereqs: log in first/);
    await expect(
      p.create({
        slug: "acme",
        ownerEmail: "o@example.com",
        plan: "paid",
        testHooks: true,
      }),
    ).rejects.toThrow(/test hooks/);
    expect(s.calls).toHaveLength(1);
  });

  it("delete, export and import are NotInM1, and call nothing", async () => {
    const s = fakeSetup({});
    const p = new SetupProvisioner({ deps, root: "/r", setup: s.fns });
    await expect(p.delete("acme", "acme")).rejects.toBeInstanceOf(NotInM1);
    await expect(p.export("acme", "/tmp/x")).rejects.toBeInstanceOf(NotInM1);
    await expect(
      p.import("/tmp/x", { slug: "a", ownerEmail: "o@e.com", plan: "paid" }),
    ).rejects.toBeInstanceOf(NotInM1);
    expect(s.calls).toEqual([]);
  });

  it("setup's lines still reach the caller's out", async () => {
    printed.length = 0;
    const s = fakeSetup({ run: CREATED });
    const p = new SetupProvisioner({ deps, root: "/r", setup: s.fns });
    await p.create({ slug: "acme", ownerEmail: "o@example.com", plan: "paid" });
    expect(printed).toHaveLength(CREATED.length);
  });
});
