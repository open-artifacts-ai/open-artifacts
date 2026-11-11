import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUS_CMD } from "@oa/bus-protocol";
import { describe, expect, it } from "vitest";
import { busCmd, useBusCmd } from "../src/bus-cmd.ts";
import { main } from "../src/main.ts";
import { installShim } from "../src/steps/path-shim.ts";
import { fakeCtx } from "./fake.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "oa-1998-"));

type World = ReturnType<typeof world>;

/** A temp user home and bus home, with a controlled PATH holding ~/.local/bin. */
function world() {
  const userHome = tmp();
  const busHome = join(userHome, ".oa-bus");
  mkdirSync(busHome, { recursive: true });
  const local = join(userHome, ".local", "bin");
  const env = { PATH: `${local}:/usr/bin` };
  const argv = ["/node", "/index.js"];
  return { userHome, busHome, platform: "linux x64", env, local, argv };
}
const install = (w: World) => installShim({ ...w, platform: "linux" });
const ctxFor = (w: World) => {
  const c = fakeCtx({ userHome: w.userHome, home: w.busHome, env: w.env });
  c.platform = "linux x64";
  return c;
};

describe("busCmd (#1998)", () => {
  it("is oa-bus when our shim for this home is on PATH", () => {
    const w = world();
    install(w);
    expect(busCmd(w)).toBe("oa-bus");
  });

  it("is npx when there is no oa-bus at all", () => {
    expect(busCmd(world())).toBe(BUS_CMD);
  });

  it("is npx when the oa-bus on PATH is foreign", () => {
    const w = world();
    mkdirSync(w.local, { recursive: true });
    writeFileSync(join(w.local, "oa-bus"), "#!/bin/sh\necho mine\n", {
      mode: 0o755,
    });
    expect(busCmd(w)).toBe(BUS_CMD);
  });

  it("is npx when the shim belongs to another bus home", () => {
    const w = world();
    install(w);
    expect(busCmd({ ...w, busHome: join(tmp(), "other") })).toBe(BUS_CMD);
  });

  it("is npx when our shim exists but its dir is not on PATH", () => {
    const w = world();
    install(w);
    expect(busCmd({ ...w, env: { PATH: "/usr/bin" } })).toBe(BUS_CMD);
  });

  it("is npx on Windows", () => {
    const w = world();
    install(w);
    expect(busCmd({ ...w, platform: "win32 x64" })).toBe(BUS_CMD);
  });

  it("is npx when the oa-bus is a symlink out of the bus home", () => {
    const w = world();
    mkdirSync(w.local, { recursive: true });
    symlinkSync("/usr/bin/env", join(w.local, "oa-bus"));
    expect(busCmd(w)).toBe(BUS_CMD);
  });
});

describe("printed commands (#1998)", () => {
  it("useBusCmd keeps npx without a shim and switches the copy with one", () => {
    const w = world();
    const none = ctxFor(w);
    useBusCmd(none);
    expect(none.busCmd).toBe(BUS_CMD);
    install(w);
    const ctx = ctxFor(w);
    useBusCmd(ctx);
    expect(ctx.busCmd).toBe("oa-bus");
    expect(ctx.copy.usage("x").join("\n")).toContain("Run oa-bus with install");
    expect(ctx.copy.usage("x").join("\n")).not.toContain("npx");
  });

  it("doctor's shim fix hints keep npx even when oa-bus is ours", () => {
    const w = world();
    install(w);
    const ctx = ctxFor(w);
    useBusCmd(ctx);
    expect(ctx.copy.shimDoctorMissing().join("\n")).toContain(BUS_CMD);
    expect(ctx.copy.shimDoctorOther("/x").join("\n")).toContain(BUS_CMD);
    expect(ctx.copy.shimForeign("/x").join("\n")).toContain(BUS_CMD);
  });

  it("main: --habits names oa-bus when ours is on PATH; a usage error keeps npx", async () => {
    const w = world();
    install(w);
    const bad = ctxFor(w);
    expect(await main(["leads", "nope"], () => bad)).toBe(2);
    expect(bad.all().join("\n")).toContain(`Usage: ${BUS_CMD} leads check`);
    const h = ctxFor(w);
    expect(await main(["install", "--habits"], () => h)).toBe(1);
    expect(h.all().join("\n")).toContain("Run oa-bus install first.");
  });

  it("main: uninstall prints npx even when our shim is there beforehand", async () => {
    const w = world();
    install(w);
    const u = ctxFor(w);
    await main(["uninstall"], () => u);
    expect(u.busCmd).toBe(BUS_CMD);
    expect(u.all().join("\n")).not.toContain("Run oa-bus");
  });

  it("main: without our shim the same commands print npx", async () => {
    const w = world();
    const h = ctxFor(w);
    expect(await main(["install", "--habits"], () => h)).toBe(1);
    expect(h.all().join("\n")).toContain(`Run ${BUS_CMD} install first.`);
  });
});
