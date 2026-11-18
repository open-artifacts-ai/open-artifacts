// `oa-bus skill` and `oa-bus skill --check` (#2624): the skill alone, no login,
// daemon or harness wiring. Temp home, fake fetch, fake PATH; no network.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse } from "../src/index.ts";
import { main } from "../src/main.ts";
import { skillDir } from "../src/steps/skill.ts";
import { fakeCtx } from "./fake.ts";

const ORIGIN = "https://oa.example";
const world = (which: string[] = ["claude", "pi"]) =>
  fakeCtx({ which: (c: string) => which.includes(c) });
const file = (c: ReturnType<typeof world>) =>
  join(
    skillDir({ home: c.userHome }, "claude"),
    "open-artifacts-oa-test",
    "SKILL.md",
  );

describe("oa-bus skill", () => {
  it("parses", () => {
    expect(parse(["skill", "--check", "--instance", ORIGIN])).toMatchObject({
      cmd: "skill",
      check: true,
      hub: ORIGIN,
    });
    expect(() => parse(["skill", "--yes"])).toThrow(/does not apply/);
  });

  it("saves the skill with only an instance: no machine, no service, no exec", async () => {
    const c = world();
    expect(await main(["skill", "--instance", ORIGIN], () => c)).toBe(0);
    expect(existsSync(file(c))).toBe(true);
    expect(c.out().join("\n")).toMatch(/claude: skill saved at .*SKILL\.md/);
    expect(c.out().join("\n")).toMatch(/pi: skill saved at/);
    expect(existsSync(join(c.home, "machine.json"))).toBe(false);
    expect(c.exec).not.toHaveBeenCalled();
  });

  it("--check passes after, fails before with the fix, and writes nothing", async () => {
    const c = world();
    expect(
      await main(["skill", "--check", "--instance", ORIGIN], () => c),
    ).toBe(1);
    expect(c.err().join("\n")).toContain(
      `skill --instance ${ORIGIN} to save it`,
    );
    expect(existsSync(file(c))).toBe(false);
    await main(["skill", "--instance", ORIGIN], () => c);
    const d = world();
    Object.assign(d, { userHome: c.userHome, home: c.home });
    expect(
      await main(["skill", "--check", "--instance", ORIGIN], () => d),
    ).toBe(0);
    expect(d.out()).toHaveLength(2);
  });

  it("--check fails when the instance's skill can't be read, even with another instance's skill saved", async () => {
    const c = world(["claude"]);
    await main(["skill", "--instance", ORIGIN], () => c);
    const d = world(["claude"]);
    Object.assign(d, { userHome: c.userHome, home: c.home });
    d.fetch = vi.fn(async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(
      await main(["skill", "--check", "--instance", ORIGIN], () => d),
    ).toBe(1);
    expect(d.err().join("\n")).toContain(
      "Could not read this instance's skill",
    );
  });

  it("fails with the URL when the instance can't serve it", async () => {
    const c = world(["claude"]);
    c.fetch = vi.fn(async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await main(["skill", "--instance", ORIGIN], () => c)).toBe(1);
    expect(c.err().join("\n")).toContain(`${ORIGIN}/skill.md?harness=claude`);
  });

  it("says so when no harness is found, and when no instance is known", async () => {
    const none = world([]);
    expect(await main(["skill", "--instance", ORIGIN], () => none)).toBe(1);
    expect(none.err().join("\n")).toContain(`${ORIGIN}/skill.md`);
    const noHub = world();
    expect(await main(["skill"], () => noHub)).toBe(1);
    expect(noHub.err().join("\n")).toContain("--instance <url>");
  });

  it("--json prints one result line", async () => {
    const c = world(["claude"]);
    await main(["skill", "--json", "--instance", ORIGIN], () => c);
    const r = JSON.parse(c.out()[0] as string);
    expect(r).toMatchObject({ ok: true, origin: ORIGIN });
    expect(r.harnesses.claude).toContain("SKILL.md");
  });
});
