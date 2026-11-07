import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HELP, run } from "../src/index.ts";
import { renderConfig } from "../src/steps/resources.ts";
import { ROOT, STATE } from "./fakes.ts";
import { BASE, world } from "./world.ts";

const CONFIG = join(ROOT, "apps/server/wrangler.jsonc");
const TEMPLATE = readFileSync(
  join(import.meta.dirname, "../../../apps/server/wrangler.template.jsonc"),
  "utf8",
);
const PAID = [{ rate_plan: { id: "WORKERS_PAID" }, state: "Paid" }];
const FREE = [{ rate_plan: { id: "free" } }];
const CI = [...BASE.filter((a) => a !== "--yes"), "--ci", "--solo"];
type W = ReturnType<typeof world>;
const parse = (w: W) => w.lines.map((l) => JSON.parse(l));
const line = (w: W, step: string) => parse(w).find((j) => j.step === step);
const planOf = (w: W) => JSON.parse(w.files.get(CONFIG) ?? "").vars.PLAN;
const vars = {
  WORKER_NAME: "w",
  APP_HOST: "a.example.com",
  CONTENT_HOST: "c.example.com",
  OWNER_EMAIL: "o@example.com",
  D1_NAME: "d",
  D1_ID: "d1",
  R2_BUCKET: "r",
  KV_ID: "k",
  CF_ACCOUNT_ID: "acc",
  ACCESS_TEAM_DOMAIN: "t",
  ACCESS_CLIENT_ID: "c",
};

describe("renderConfig PLAN", () => {
  it("renders free by default and paid when asked, as strict JSON", () => {
    expect(JSON.parse(renderConfig(TEMPLATE, vars)).vars.PLAN).toBe("free");
    const paid = renderConfig(TEMPLATE, vars, true, false, "paid");
    expect(JSON.parse(paid).vars.PLAN).toBe("paid");
  });
});

describe("--plan and the rendered PLAN var", () => {
  it("--help documents --plan", () => {
    expect(HELP).toContain("--plan");
  });

  it("rejects a bad --plan value", async () => {
    const w = world();
    expect(await run([...BASE, "--plan", "gold"], w.deps, ROOT)).not.toBe(0);
    expect(w.lines.join("\n")).toContain("--plan");
  });

  it("detected paid renders paid; free renders free; reported next to plan", async () => {
    const p = world({ subscriptions: PAID });
    expect(await run([...BASE, "--solo"], p.deps, ROOT)).toBe(0);
    expect(planOf(p)).toBe("paid");
    expect(line(p, "prereqs").data).toMatchObject({
      plan: "paid",
      planVar: "paid",
    });
    expect(p.state()).toMatchObject({ planVar: "paid" });
    const f = world({ subscriptions: FREE });
    expect(await run([...BASE, "--solo"], f.deps, ROOT)).toBe(0);
    expect(planOf(f)).toBe("free");
    expect(line(f, "prereqs").data).toMatchObject({
      plan: "free",
      planVar: "free",
    });
  });

  it("unknown plan renders free; --yes-paid and --plan paid render paid", async () => {
    const u = world();
    expect(await run([...BASE, "--solo"], u.deps, ROOT)).toBe(0);
    expect(planOf(u)).toBe("free");
    const y = world();
    expect(await run([...BASE, "--solo", "--yes-paid"], y.deps, ROOT)).toBe(0);
    expect(planOf(y)).toBe("paid");
    const p = world();
    expect(await run([...BASE, "--solo", "--plan", "paid"], p.deps, ROOT)).toBe(
      0,
    );
    expect(planOf(p)).toBe("paid");
  });

  it("--plan overrides detection both ways", async () => {
    const w = world({ subscriptions: PAID });
    expect(await run([...BASE, "--solo", "--plan", "free"], w.deps, ROOT)).toBe(
      0,
    );
    expect(planOf(w)).toBe("free");
    const f = world({ subscriptions: FREE });
    expect(await run([...BASE, "--solo", "--plan", "paid"], f.deps, ROOT)).toBe(
      0,
    );
    expect(planOf(f)).toBe("paid");
  });

  it("--upgrade with an unknown plan keeps the saved value", async () => {
    const w = world({ subscriptions: PAID });
    expect(await run([...BASE, "--solo"], w.deps, ROOT)).toBe(0);
    w.setSubscriptions(undefined);
    w.lines.length = 0;
    expect(
      await run([...BASE, "--solo", "--upgrade", "--browser"], w.deps, ROOT),
    ).toBe(0);
    expect(planOf(w)).toBe("paid");
    const pre = line(w, "prereqs");
    expect(pre.data.notes.join("; ")).toContain("Workers Paid (saved plan)");
    expect(pre.message).not.toContain("--yes-paid");
  });
});

describe("#7: the paid note names its source", () => {
  it("--plan paid on a detected free plan never mentions --yes-paid", async () => {
    const w = world({ subscriptions: FREE });
    expect(await run([...BASE, "--solo", "--plan", "paid"], w.deps, ROOT)).toBe(
      0,
    );
    const pre = line(w, "prereqs");
    expect(pre.data.notes.join("; ")).toContain("Workers Paid (--plan paid)");
    expect(pre.message).not.toContain("--yes-paid");
    expect(pre.data.warnings).toEqual([]);
  });

  it("a saved plan never mentions --yes-paid and keeps warnings silent", async () => {
    const w = world({ subscriptions: FREE });
    expect(await run([...BASE, "--solo", "--yes-paid"], w.deps, ROOT)).toBe(0);
    w.setSubscriptions(undefined);
    w.lines.length = 0;
    expect(await run([...BASE, "--solo", "--upgrade"], w.deps, ROOT)).toBe(0);
    const pre = line(w, "prereqs");
    expect(pre.data.notes.join("; ")).toContain("Workers Paid (saved plan)");
    expect(pre.message).not.toContain("--yes-paid");
    expect(pre.data.warnings).toEqual([]);
  });

  it("--yes-paid wins the label when --plan paid is also passed", async () => {
    const w = world({ subscriptions: FREE });
    await run(
      [...BASE, "--solo", "--yes-paid", "--plan", "paid"],
      w.deps,
      ROOT,
    );
    expect(line(w, "prereqs").data.notes.join("; ")).toContain("--yes-paid");
  });
});

describe("#7: --yes-paid with the plan guard", () => {
  it("renders paid over a live paid PLAN with no guard; an explicit --plan free still wins", async () => {
    const w = world({ subscriptions: PAID });
    expect(await run([...BASE, "--solo"], w.deps, ROOT)).toBe(0);
    w.files.delete(STATE);
    w.setSubscriptions(undefined);
    w.lines.length = 0;
    const up = [...CI, "--upgrade", "--no-browser"];
    expect(await run([...up, "--yes-paid"], w.deps, ROOT)).toBe(0);
    expect(planOf(w)).toBe("paid");
    w.lines.length = 0;
    expect(
      await run([...up, "--yes-paid", "--plan", "free"], w.deps, ROOT),
    ).toBe(0);
    expect(planOf(w)).toBe("free");
  });
});

describe("downgrade guard", () => {
  it("refuses a free render over a live paid PLAN without --plan free", async () => {
    const w = world({ subscriptions: PAID });
    expect(await run([...BASE, "--solo"], w.deps, ROOT)).toBe(0);
    w.files.delete(STATE); // stateless: only the live Worker knows
    w.setSubscriptions(undefined);
    w.lines.length = 0;
    const up = [...CI, "--upgrade", "--no-browser"];
    expect(await run(up, w.deps, ROOT)).toBe(2);
    const l = line(w, "deploy");
    expect(l.status).toBe("action_required");
    expect(l.message).toContain("--plan free");
    expect(w.ops.filter((o) => o === "deploy")).toHaveLength(1);
    expect(await run([...up, "--plan", "free"], w.deps, ROOT)).toBe(0);
    expect(planOf(w)).toBe("free");
  });

  it("also guards from saved state when the live read is unavailable", async () => {
    const w = world({
      subscriptions: PAID,
      settingsFail: true,
      settingsFailAfter: 1,
    });
    expect(await run([...BASE, "--solo"], w.deps, ROOT)).toBe(0);
    w.setSubscriptions(FREE);
    w.lines.length = 0;
    const up = [...BASE, "--solo", "--upgrade", "--no-browser"];
    expect(await run(up, w.deps, ROOT)).toBe(2);
    expect(line(w, "deploy").message).toContain("--plan free");
  });
});

describe("selftest checks /healthz plan", () => {
  it("passes when healthz plan equals the rendered PLAN", async () => {
    const w = world({ subscriptions: PAID });
    expect(await run([...BASE, "--solo"], w.deps, ROOT)).toBe(0);
    expect(line(w, "selftest").status).toBe("ok");
  });

  it("fails with a clear message on a mismatch", async () => {
    const w = world({ subscriptions: PAID, healthPlan: "free" });
    expect(await run([...BASE, "--solo"], w.deps, ROOT)).toBe(1);
    const l = line(w, "healthcheck");
    expect(l.status).toBe("error");
    expect(l.message).toContain("PLAN");
    expect(l.message).toContain("paid");
    expect(l.message).toContain('"free"');
    expect(l.message).not.toContain("not 200");
  });
});

describe("fix round 1", () => {
  const paidInstall = async (extra: object = {}) => {
    const opts: Record<string, unknown> = { subscriptions: PAID, ...extra };
    const w = world(opts);
    expect(await run([...BASE, "--solo"], w.deps, ROOT)).toBe(0);
    return { w, opts };
  };

  it("M1: a refused run does not overwrite the saved planVar", async () => {
    const { w, opts } = await paidInstall();
    w.setSubscriptions(undefined);
    expect(await run([...BASE, "--solo"], w.deps, ROOT)).toBe(2);
    expect(w.state().planVar).toBe("paid");
    opts.settingsFail = true;
    opts.settingsFailAfter = 1;
    w.lines.length = 0;
    await run([...BASE, "--solo", "--upgrade"], w.deps, ROOT);
    expect(planOf(w)).toBe("paid");
  });

  it("M1: a failed live read with no saved planVar over a deployed Worker is action_required", async () => {
    const { w, opts } = await paidInstall();
    const st = JSON.parse(w.files.get(STATE) ?? "{}");
    st.planVar = undefined;
    w.files.set(STATE, JSON.stringify(st));
    w.setSubscriptions(undefined);
    opts.settingsFail = true;
    opts.settingsFailAfter = 1;
    w.lines.length = 0;
    expect(await run([...BASE, "--solo", "--upgrade"], w.deps, ROOT)).toBe(2);
    expect(line(w, "deploy").status).toBe("action_required");
    expect(line(w, "deploy").message).toContain("--plan");
  });

  it("M2: selftest waits out an old version still serving another plan", async () => {
    const w = world({
      subscriptions: PAID,
      healthPlanFirst: ["free", undefined],
    });
    expect(await run([...BASE, "--solo"], w.deps, ROOT)).toBe(0);
    expect(line(w, "selftest").status).toBe("ok");
  });

  it("m1: the guard message does not say could-not-confirm for a read free plan", async () => {
    const { w } = await paidInstall();
    w.setSubscriptions(FREE);
    w.lines.length = 0;
    expect(
      await run([...BASE, "--solo", "--upgrade", "--browser"], w.deps, ROOT),
    ).toBe(2);
    expect(line(w, "deploy").message).not.toContain("could not confirm");
  });

  it("m2: --check --strict flags a pending guard refusal", async () => {
    const { w } = await paidInstall();
    w.setSubscriptions(undefined);
    w.lines.length = 0;
    const c = [...BASE, "--solo", "--check", "--strict", "--json"];
    expect(await run(c, w.deps, ROOT)).toBe(2);
    expect(line(w, "deploy").message).toContain("--plan");
  });

  it("m3: the final --json state line carries planVar", async () => {
    const w = world({ subscriptions: PAID });
    expect(await run([...BASE, "--solo", "--json"], w.deps, ROOT)).toBe(0);
    expect(line(w, "state").data).toHaveProperty("planVar", "paid");
  });

  it("m5: precedence table", async () => {
    const free = world({ subscriptions: PAID });
    expect(
      await run(
        [...BASE, "--solo", "--plan", "free", "--yes-paid"],
        free.deps,
        ROOT,
      ),
    ).toBe(0);
    expect(planOf(free)).toBe("free");
    const yp = world({ subscriptions: FREE });
    expect(await run([...BASE, "--solo", "--yes-paid"], yp.deps, ROOT)).toBe(0);
    expect(planOf(yp)).toBe("paid");
    const noUp = world({ subscriptions: PAID });
    expect(await run([...BASE, "--solo"], noUp.deps, ROOT)).toBe(0);
    noUp.setSubscriptions(undefined);
    expect(await run([...BASE, "--solo"], noUp.deps, ROOT)).toBe(2);
    expect(planOf(noUp)).toBe("free");
  });
});
