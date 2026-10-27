import { describe, expect, it } from "vitest";
import { HELP, run } from "../src/index.ts";
import { ROOT, STATE } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

type W = ReturnType<typeof world>;
const parse = (w: W) => w.lines.map((l) => JSON.parse(l));
const last = (w: W) => parse(w).at(-1);
const ROLLBACK = ["--name", "open-artifacts", "--json", "--rollback"];

/** Install, then upgrade once: state holds ver-2 with ver-1 as the previous. */
async function twice(o: Parameters<typeof world>[0] = {}) {
  const w = world(o);
  // world() keeps a reference to `o`: tests flip its flags between runs.
  expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
  expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
  w.lines.length = 0;
  w.ops.length = 0;
  return w;
}

describe("deploy records the Worker version it replaces", () => {
  it("first install: workerVersion set, previous unset", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    const st = w.state();
    expect(st.workerVersion).toBe("ver-1");
    expect(st.previousWorkerVersion).toBeUndefined();
  });

  it("an upgrade records the replaced version as previous", async () => {
    const w = await twice();
    const st = w.state();
    expect(st.workerVersion).toBe("ver-2");
    expect(st.previousWorkerVersion).toBe("ver-1");
  });

  it("a live Worker's version is recorded as previous", async () => {
    const w = world({ workerVersion: "live-0", worker: { APP_HOST: "x" } });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.state().previousWorkerVersion).toBe("live-0");
  });

  it("a failed upgrade leaves both ids unchanged", async () => {
    const o: Parameters<typeof world>[0] = {};
    const w = await twice(o);
    const before = w.state();
    o.deployFails = "boom";
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(1);
    expect(w.state().workerVersion).toBe(before.workerVersion);
    expect(w.state().previousWorkerVersion).toBe(before.previousWorkerVersion);
  });

  it.each([
    ["unreadable", { deploymentsFail: true }],
    ["split", { splitDeployment: true }],
  ])(
    "an %s pre-read clears previous, never leaves it stale",
    async (_n, flip) => {
      const o: Parameters<typeof world>[0] = {};
      const w = await twice(o);
      expect(w.state().previousWorkerVersion).toBe("ver-1");
      Object.assign(o, flip);
      expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
      const st = w.state();
      expect(st.previousWorkerVersion).toBeUndefined();
      expect(st.workerVersion).toBe("ver-3");
      expect(w.lines.join("\n")).toContain("previousWorkerVersion");
    },
  );

  it("an unparseable deploy output leaves workerVersion unset", async () => {
    const o: Parameters<typeof world>[0] = {};
    const w = await twice(o);
    const exec = w.deps.exec;
    w.deps.exec = async (c, a, op) => {
      const r = await exec(c, a, op);
      return a.at(-1) === "deploy" ? { ...r, stdout: "ok" } : r;
    };
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(w.state().workerVersion).toBeUndefined();
    expect(w.state().previousWorkerVersion).toBe("ver-2");
  });

  it("a failed deploy records neither", async () => {
    const w = world({ workerVersion: "live-0", deployFails: "boom" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    const st = w.state();
    expect(st.workerVersion).toBeUndefined();
    expect(st.previousWorkerVersion).toBeUndefined();
  });

  it("an unreadable version only warns; the deploy still succeeds", async () => {
    const w = world({ deploymentsFail: true });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.state().previousWorkerVersion).toBeUndefined();
    expect(w.lines.join("\n")).toContain(
      "could not read the live Worker version",
    );
  });

  it("--check and --json report both ids", async () => {
    const w = await twice();
    expect(await run([...HOSTS, "--check"], w.deps, ROOT)).toBe(0);
    expect(last(w).data).toMatchObject({
      workerVersion: "ver-2",
      previousWorkerVersion: "ver-1",
    });
  });
});

describe("--rollback", () => {
  it("documents itself, D1 included", () => {
    expect(HELP).toContain("--rollback");
    expect(HELP).toMatch(/never touches D1/i);
  });

  it("rolls back, runs nothing else, and swaps the state", async () => {
    const w = await twice();
    expect(await run(ROLLBACK, w.deps, ROOT)).toBe(0);
    expect(parse(w)).toEqual([
      {
        step: "rollback",
        status: "ok",
        message: expect.any(String),
        data: { from: "ver-2", to: "ver-1" },
      },
    ]);
    expect(w.ops).toEqual(["rollback ver-1"]);
    expect(w.argv.at(-1)).toContain(
      "rollback ver-1 --name open-artifacts --message oa:setup --rollback -y",
    );
    expect(w.state()).toMatchObject({
      workerVersion: "ver-1",
      previousWorkerVersion: "ver-2",
    });
    // A second rollback undoes the first.
    w.lines.length = 0;
    expect(await run(ROLLBACK, w.deps, ROOT)).toBe(0);
    expect(last(w).data).toEqual({ from: "ver-1", to: "ver-2" });
    expect(w.state()).toMatchObject({
      workerVersion: "ver-2",
      previousWorkerVersion: "ver-1",
    });
  });

  it("with no previous version: exit 2, action_required, dashboard hint", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    w.lines.length = 0;
    w.ops.length = 0;
    expect(await run(ROLLBACK, w.deps, ROOT)).toBe(2);
    const l = last(w);
    expect(l).toMatchObject({ step: "rollback", status: "action_required" });
    expect(l.message).toMatch(/no previous version/i);
    expect(l.message).toContain("Workers → open-artifacts → Deployments");
    expect(w.ops).toEqual([]);
  });

  it("a live version that is not the recorded one: exit 2, nothing run", async () => {
    const w = await twice();
    const st = { ...w.state(), workerVersion: "ver-other" };
    w.files.set(STATE, JSON.stringify(st));
    expect(await run(ROLLBACK, w.deps, ROOT)).toBe(2);
    expect(last(w)).toMatchObject({ status: "action_required" });
    expect(last(w).message).toContain("ver-2");
    expect(last(w).message).toContain("Workers → open-artifacts → Deployments");
    expect(w.ops).toEqual([]);
  });

  it("legacy state without workerVersion: exit 2", async () => {
    const w = await twice();
    const { workerVersion: _, ...st } = w.state();
    w.files.set(STATE, JSON.stringify(st));
    expect(await run(ROLLBACK, w.deps, ROOT)).toBe(2);
    expect(w.ops).toEqual([]);
  });

  it("an unreadable live version: exit 2", async () => {
    const o: Parameters<typeof world>[0] = {};
    const w = await twice(o);
    o.deploymentsFail = true;
    expect(await run(ROLLBACK, w.deps, ROOT)).toBe(2);
    expect(w.ops).toEqual([]);
  });

  it("an unreadable live version says why; a 403 names the token permission", async () => {
    const o: Parameters<typeof world>[0] = {};
    const w = await twice(o);
    o.deploymentsFail = true;
    expect(await run(ROLLBACK, w.deps, ROOT)).toBe(2);
    expect(last(w).message).toContain("internal error");
    expect(last(w).message).not.toContain("Workers Scripts Read");
    o.deploymentsFail = false;
    o.deploymentsForbidden = true;
    w.lines.length = 0;
    expect(await run(ROLLBACK, w.deps, ROOT)).toBe(2);
    expect(last(w).message).toContain("Authentication error");
    expect(last(w).message).toContain("Workers Scripts Read");
  });

  it("a --name or --account-id that differs from state is a usage error", async () => {
    const w = await twice();
    for (const extra of [
      ["--name", "other"],
      ["--account-id", "acc9"],
    ]) {
      w.lines.length = 0;
      const argv = [
        ...ROLLBACK.filter(
          (a, i) => !(a === "--name" || ROLLBACK[i - 1] === "--name"),
        ),
        ...extra,
      ];
      expect(await run(argv, w.deps, ROOT)).toBe(1);
      expect(last(w)).toMatchObject({ step: "args", status: "error" });
    }
    expect(w.ops).toEqual([]);
  });

  it("passes --name to wrangler rollback", async () => {
    const w = await twice();
    expect(await run(ROLLBACK, w.deps, ROOT)).toBe(0);
    expect(w.argv.at(-1)).toContain(
      "rollback ver-1 --name open-artifacts --message oa:setup --rollback -y",
    );
  });

  it("a wrangler failure: exit 1, error, no token in the output", async () => {
    const token = "cf-secret-token-123";
    const w = await twice({
      env: { CLOUDFLARE_API_TOKEN: token },
      rollbackFails: `bad request, Authorization: Bearer ${token} oa_pat_abc123`,
    });
    const before = w.state();
    expect(await run(ROLLBACK, w.deps, ROOT)).toBe(1);
    expect(last(w)).toMatchObject({ step: "rollback", status: "error" });
    expect(last(w).message).toContain("bad request");
    const out = w.lines.join("\n");
    expect(out).not.toContain(token);
    expect(out).not.toContain("oa_pat_abc123");
    expect(w.state()).toEqual(before);
  });

  it.each(["--upgrade", "--check", "--ci"])(
    "combined with %s is a usage error",
    async (flag) => {
      const w = await twice();
      expect(await run([...ROLLBACK, flag], w.deps, ROOT)).toBe(1);
      expect(last(w)).toMatchObject({ step: "args", status: "error" });
      expect(last(w).message).toContain("--rollback");
      expect(w.ops).toEqual([]);
    },
  );
});

describe("item 44: --rollback reads the deploy token files", () => {
  const HOME = "/home/t";
  /** Records the deploy token each wrangler child gets (env only, never argv). */
  const spy = (w: W) => {
    const seen: (string | undefined)[] = [];
    const exec = w.deps.exec;
    w.deps.exec = async (cmd, args, opts) => {
      if (args.includes("rollback")) seen.push(opts?.env?.CLOUDFLARE_API_TOKEN);
      return exec(cmd, args, opts);
    };
    return seen;
  };

  it("uses the saved ~/.open-artifacts/<name>-cloudflare-token", async () => {
    const w = await twice({ env: { HOME } });
    w.files.set(
      `${HOME}/.open-artifacts/open-artifacts-cloudflare-token`,
      "saved-tok\n",
    );
    const seen = spy(w);
    expect(await run(ROLLBACK, w.deps, ROOT)).toBe(0);
    expect(seen).toEqual(["saved-tok"]);
    expect(w.auths.some((a) => a.endsWith("Bearer saved-tok"))).toBe(true);
  });

  it("accepts --token-file, and a missing one is an error that runs nothing", async () => {
    const w = await twice({ env: { HOME }, files: { "/t/cf": "flag-tok\n" } });
    const seen = spy(w);
    expect(
      await run([...ROLLBACK, "--token-file", "/t/cf"], w.deps, ROOT),
    ).toBe(0);
    expect(seen).toEqual(["flag-tok"]);
    w.lines.length = 0;
    w.ops.length = 0;
    expect(
      await run([...ROLLBACK, "--token-file", "/t/none"], w.deps, ROOT),
    ).toBe(1);
    expect(last(w)).toMatchObject({ step: "args", status: "error" });
    expect(w.ops).toEqual([]);
  });
});
