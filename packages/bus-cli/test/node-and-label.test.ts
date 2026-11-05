import { describe, expect, it, vi } from "vitest";
import { install } from "../src/commands/install.ts";
import { noService } from "../src/context.ts";
import { defaultMachineLabel } from "../src/machine-label.ts";
import { systemService } from "../src/steps/service.ts";
import { fakeCtx } from "./fake.ts";

describe("defaultMachineLabel (#1448 item 2)", () => {
  const exec = (map: Record<string, string>) =>
    vi.fn(async (_cmd: string, args: string[]) => {
      const v = map[args.join(" ")];
      return v === undefined
        ? { code: 1, stdout: "", stderr: "" }
        : { code: 0, stdout: `${v}\n`, stderr: "" };
    });

  it("macOS: the friendly ComputerName, not the Tailscale FQDN", async () => {
    const label = await defaultMachineLabel({
      platform: "darwin",
      hostname: () => "leonardos-macbook-pro.tailb6503e.ts.net",
      exec: exec({ "--get ComputerName": "Leonardo's MacBook Pro" }),
    });
    expect(label).toBe("Leonardo's MacBook Pro");
  });

  it("macOS: LocalHostName when there is no ComputerName", async () => {
    const label = await defaultMachineLabel({
      platform: "darwin",
      hostname: () => "x.ts.net",
      exec: exec({ "--get LocalHostName": "Leonardos-MacBook-Pro" }),
    });
    expect(label).toBe("Leonardos-MacBook-Pro");
  });

  it("macOS: scutil missing falls back to the trimmed hostname", async () => {
    const label = await defaultMachineLabel({
      platform: "darwin",
      hostname: () => "leonardos-macbook-pro.tailb6503e.ts.net",
      exec: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(label).toBe("leonardos-macbook-pro");
  });

  it("Linux: the hostname with a search-domain suffix trimmed; .local kept off", async () => {
    const exec = vi.fn();
    expect(
      await defaultMachineLabel({
        platform: "linux",
        hostname: () => "dev-box.corp.example.com",
        exec,
      }),
    ).toBe("dev-box");
    expect(
      await defaultMachineLabel({
        platform: "linux",
        hostname: () => "dev-box",
        exec,
      }),
    ).toBe("dev-box");
    expect(exec).not.toHaveBeenCalled();
  });

  it("an empty answer is no answer", async () => {
    expect(
      await defaultMachineLabel({
        platform: "darwin",
        hostname: () => "h.ts.net",
        exec: exec({ "--get ComputerName": "  " }),
      }),
    ).toBe("h");
  });
});

describe("node check at install (#1448 item 4)", () => {
  it("systemService.checkNode runs the pinned node with an ICU probe", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const ctx = fakeCtx();
    const svc = systemService({
      platform: "linux",
      userHome: ctx.userHome,
      home: () => ctx.home,
      env: {},
      exec,
      sleep: ctx.sleep,
      execPath: "/opt/node/bin/node",
      uid: 1,
      user: "u",
      source: () => ({ kind: "bundle", file: "/x/dist/index.js" }),
      daemonPid: async () => undefined,
      processArgs: () => undefined,
      kill: () => {},
      spawnDaemon: () => 1,
    });
    expect(await svc.checkNode?.()).toBeUndefined();
    const [cmd, args] = exec.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe("/opt/node/bin/node");
    expect(args.join(" ")).toContain("Intl.DateTimeFormat");
  });

  it("a node that fails the probe is reported with its path and reason", async () => {
    const exec = vi.fn(async () => ({
      code: 134,
      stdout: "",
      stderr: "dyld: Library not loaded: libicui18n.74.dylib",
    }));
    const ctx = fakeCtx();
    const svc = systemService({
      platform: "darwin",
      userHome: ctx.userHome,
      home: () => ctx.home,
      env: {},
      exec,
      sleep: ctx.sleep,
      execPath: "/opt/homebrew/bin/node",
      uid: 1,
      user: "u",
      source: () => ({ kind: "bundle", file: "/x/dist/index.js" }),
      daemonPid: async () => undefined,
      processArgs: () => undefined,
      kill: () => {},
      spawnDaemon: () => 1,
    });
    const bad = await svc.checkNode?.();
    expect(bad).toEqual({
      node: "/opt/homebrew/bin/node",
      reason: expect.stringContaining("libicui18n"),
    });
  });

  it("install refuses before approving anything, naming the binary", async () => {
    const ensure = vi.fn(async () => ({}));
    const ctx = fakeCtx({
      service: {
        ...noService,
        ensure,
        checkNode: async () => ({
          node: "/opt/homebrew/bin/node",
          reason: "Library not loaded: libicui18n",
        }),
      },
    });
    expect(await install({}, ctx)).toBe(1);
    expect(ctx.err().join("\n")).toContain("/opt/homebrew/bin/node");
    expect(ctx.err().join("\n")).toContain("libicui18n");
    expect(ctx.fetch).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
  });
});
