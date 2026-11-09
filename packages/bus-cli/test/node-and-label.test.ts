import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { doctor } from "../src/commands/doctor.ts";
import { install } from "../src/commands/install.ts";
import { login } from "../src/commands/login.ts";
import { noService } from "../src/context.ts";
import { defaultMachineLabel } from "../src/machine-label.ts";
import { launcherText, systemService } from "../src/steps/service.ts";
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

describe("pinned node check in doctor (#1448 item 4)", () => {
  const mk = (
    exec: ReturnType<typeof vi.fn>,
    execPath = "/opt/homebrew/bin/node",
  ) => {
    const ctx = fakeCtx();
    const svc = systemService({
      platform: "linux",
      userHome: ctx.userHome,
      home: () => ctx.home,
      env: {},
      exec: exec as never,
      sleep: ctx.sleep,
      execPath,
      uid: 1,
      user: "u",
      lingerDir: ctx.userHome,
      source: () => ({ kind: "bundle", file: join(ctx.userHome, "i.js") }),
      daemonPid: async () => undefined,
      processArgs: () => undefined,
      kill: () => {},
      spawnDaemon: () => 1,
    });
    return { ctx, svc };
  };
  const record = (home: string, node: string) => {
    mkdirSync(home, { recursive: true });
    const unit = join(dirname(home), ".config/systemd/user/oa-bus.service");
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, "[Service]\n");
    writeFileSync(
      join(home, "install.json"),
      JSON.stringify({ service: { kind: "systemd", node, unit } }),
    );
  };

  it("nothing installed: nothing to check, nothing run", async () => {
    const exec = vi.fn();
    const { svc } = mk(exec);
    expect(await svc.checkNode?.()).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });

  it("probes the RECORDED node, not the one running now", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const { ctx, svc } = mk(exec, "/running/now/node");
    record(ctx.home, "/pinned/node");
    expect(await svc.checkNode?.()).toBeUndefined();
    const [cmd, args] = exec.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe("/pinned/node");
    expect(args.join(" ")).toContain("Intl.DateTimeFormat");
  });

  it("a pinned node that now fails is reported with binary and first stderr line", async () => {
    const exec = vi.fn(async () => ({
      code: 134,
      stdout: "",
      stderr: "dyld: Library not loaded: libicui18n.74.dylib\nmore",
    }));
    const { ctx, svc } = mk(exec);
    record(ctx.home, "/opt/homebrew/bin/node");
    expect(await svc.checkNode?.()).toEqual({
      node: "/opt/homebrew/bin/node",
      reason: expect.stringContaining("libicui18n"),
    });
  });

  it("the launcher with no node anywhere: doctor's probe reports its one line (#1729)", async () => {
    const { execFileSync } = await import("node:child_process");
    const exec = async (cmd: string, args: string[]) => {
      try {
        const stdout = execFileSync(cmd, args, {
          env: { PATH: "" },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { code: 0, stdout, stderr: "" };
      } catch (e) {
        const x = e as { status: number; stderr: string };
        return { code: x.status, stdout: "", stderr: x.stderr };
      }
    };
    const { ctx, svc } = mk(exec as never);
    const bin = join(ctx.home, "bin");
    mkdirSync(bin, { recursive: true });
    const launcher = join(bin, "node");
    writeFileSync(launcher, launcherText("/gone/node", []), { mode: 0o700 });
    record(ctx.home, launcher);
    expect(await svc.checkNode?.()).toEqual({
      node: launcher,
      reason:
        "oa-bus: Node.js 22 or newer not found. Install it, then run: npx @open-artifacts/bus install",
    });
  });

  it("doctor probes with the service's PATH: a node only doctor's shell reaches is reported (#1729)", async () => {
    const { execFileSync } = await import("node:child_process");
    const d = mkdtempSync(join(tmpdir(), "ob-doc-"));
    const good = join(d, "good");
    mkdirSync(good);
    writeFileSync(
      join(good, "node"),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v22.1.0; fi\nexit 0\n',
      { mode: 0o755 },
    );
    const doctorPath = `${good}:/usr/bin:/bin`;
    const exec = async (cmd: string, args: string[]) => {
      try {
        const stdout = execFileSync(cmd, args, {
          env: { PATH: doctorPath },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { code: 0, stdout, stderr: "" };
      } catch (e) {
        const x = e as { status: number; stderr: string };
        return { code: x.status, stdout: "", stderr: x.stderr };
      }
    };
    const { ctx, svc } = mk(exec as never);
    const bin = join(ctx.home, "bin");
    mkdirSync(bin, { recursive: true });
    const launcher = join(bin, "node");
    writeFileSync(launcher, launcherText("/gone/node", []), { mode: 0o700 });
    record(ctx.home, launcher);
    // Before: no service env recorded, doctor's PATH finds the node.
    expect(await svc.checkNode?.()).toBeUndefined();
    // The service's PATH holds no node: it would fail after a reboot.
    const f = join(ctx.home, "install.json");
    const j = JSON.parse(readFileSync(f, "utf8"));
    j.service.env = { PATH: join(d, "empty") };
    writeFileSync(f, JSON.stringify(j));
    expect(await svc.checkNode?.()).toEqual({
      node: launcher,
      reason: expect.stringContaining("22 or newer not found"),
    });
  });

  it("doctor fails naming the binary, reason and the fix", async () => {
    const ctx = fakeCtx({
      service: {
        ...noService,
        kind: "systemd",
        checkNode: async () => ({
          node: "/opt/homebrew/bin/node",
          reason: "Library not loaded: libicui18n",
        }),
      },
    });
    ctx.fetch = vi.fn(async () => new Response("ok")) as never;
    expect(await doctor(ctx)).toBe(1);
    const out = ctx.all().join("\n");
    expect(out).toContain("/opt/homebrew/bin/node");
    expect(out).toContain("libicui18n");
    expect(out).toContain("working Node first on your PATH");
  });

  it("install no longer probes the node running it", async () => {
    const checkNode = vi.fn(async () => undefined);
    const ctx = fakeCtx({ service: { ...noService, checkNode } });
    await install({ check: true }, ctx);
    await install({}, ctx).catch(() => {});
    expect(checkNode).not.toHaveBeenCalled();
  });
});

describe("login default label (#1448 item 2)", () => {
  it("uses the friendly machine label, not os.hostname()", async () => {
    const sent: string[] = [];
    const fetch = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith("/bus/device")) {
          sent.push(JSON.parse(String(init?.body)).machine_label);
          throw new Error("stop here");
        }
        throw new Error("unexpected");
      },
    );
    const exec = async (_c: string, a: string[]) => ({
      code: 0,
      stdout: a[1] === "ComputerName" ? "Leonardo's MacBook Pro\n" : "",
      stderr: "",
    });
    await expect(
      login({
        hub: "https://bus.test",
        home: mkdtempSync(join(tmpdir(), "ob-lbl-")),
        fetch: fetch as never,
        openBrowser: async () => true,
        sleep: async () => {},
        now: () => 0,
        exec,
        platform: "darwin",
      }),
    ).rejects.toThrow();
    expect(sent).toEqual(["Leonardo's MacBook Pro"]);
  });
});
