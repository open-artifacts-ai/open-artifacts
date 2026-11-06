// #1525: a `.oa-bus.json` namespace that differs from the derived one takes
// effect only when the user approved that directory for exactly that namespace.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTER_CAPS, daemonStatus, LineDecoder } from "@oa/bus-ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ConfigIssues,
  inspectApprovals,
  scanConfigFiles,
} from "../src/config-issues.ts";
import { resolveNamespace } from "../src/namespace.ts";
import {
  namespacesFile,
  readApprovals,
  writeApprovals,
} from "../src/namespaces.ts";
import { approvals } from "./approvals.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "ob-1525-")));
const noGit = { gitRemote: () => null, gitRoot: () => null };

/** A directory whose `.oa-bus.json` sets `namespace`. */
function repo(namespace = "team", name = "r") {
  const dir = join(tmp(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".oa-bus.json"), JSON.stringify({ namespace }), {
    mode: 0o600,
  });
  return dir;
}

describe("an unapproved namespace", () => {
  it("is ignored, falls back to the derived one, is logged once and listed as pending", () => {
    const dir = repo();
    const issues = new ConfigIssues();
    const log = vi.fn();
    const deps = { ...noGit, log, issues, namespacesFile: approvals() };
    const ns = resolveNamespace(dir, deps);
    expect(ns).toMatchObject({ namespace: "r", source: "cwd" });
    resolveNamespace(dir, deps);
    expect(log.mock.calls.filter(([m]) => /not approved/.test(m))).toHaveLength(
      1,
    );
    expect(issues.list(undefined, { pending: true })).toEqual([
      {
        file: join(dir, ".oa-bus.json"),
        state: "pending",
        reason: 'sets namespace "team", which you have not approved',
        fix: `oa-bus namespace approve '${dir}'`,
      },
    ]);
    // Not listed for a client that cannot decode it.
    expect(issues.list()).toEqual([]);
  });

  it("shell-quotes the directory in the fix", () => {
    const dir = repo("team", "it's here");
    const issues = new ConfigIssues();
    resolveNamespace(dir, { ...noGit, issues, namespacesFile: approvals() });
    expect(issues.list(undefined, { pending: true })[0]?.fix).toBe(
      `oa-bus namespace approve '${dir.replace(/'/g, "'\\''")}'`,
    );
  });

  it("drops off the list once approved", () => {
    const dir = repo();
    const issues = new ConfigIssues();
    const file = approvals();
    resolveNamespace(dir, { ...noGit, issues, namespacesFile: file });
    expect(issues.list(undefined, { pending: true })).toHaveLength(1);
    writeApprovals([{ dir, namespace: "team" }], join(file, ".."));
    expect(issues.list(undefined, { pending: true })).toEqual([]);
  });
});

describe("an approved namespace", () => {
  it("takes effect", () => {
    const dir = repo();
    const issues = new ConfigIssues();
    expect(
      resolveNamespace(dir, {
        ...noGit,
        issues,
        namespacesFile: approvals([dir, "team"]),
      }),
    ).toEqual({ namespace: "team", global: false, source: "config" });
    expect(issues.list(undefined, { pending: true })).toEqual([]);
  });

  it("is matched by directory identity: a symlinked cwd reaches the approved repo", () => {
    const dir = repo();
    const link = join(tmp(), "link");
    symlinkSync(dir, link);
    expect(
      resolveNamespace(link, {
        ...noGit,
        namespacesFile: approvals([dir, "team"]),
      }).namespace,
    ).toBe("team");
  });

  it("an entry that is a symlink now never matches", () => {
    const dir = repo();
    const link = join(tmp(), "link");
    symlinkSync(dir, link);
    expect(
      resolveNamespace(dir, {
        ...noGit,
        namespacesFile: approvals([link, "team"]),
      }).namespace,
    ).toBe("r");
  });
});

describe("an approval that does not apply", () => {
  it("for a different namespace", () => {
    const dir = repo();
    expect(
      resolveNamespace(dir, {
        ...noGit,
        namespacesFile: approvals([dir, "other"]),
      }).namespace,
    ).toBe("r");
  });

  it("for a different directory, a parent or a child", () => {
    const dir = repo();
    const sibling = repo();
    const parent = join(dir, "..");
    const child = join(dir, "sub");
    mkdirSync(child);
    for (const approved of [sibling, parent, child])
      expect(
        resolveNamespace(dir, {
          ...noGit,
          namespacesFile: approvals([approved, "team"]),
        }).namespace,
      ).toBe("r");
  });
});

describe("a namespace equal to the derived one", () => {
  it("needs no approval and lists nothing", () => {
    const dir = repo("github.com/acme/app");
    const issues = new ConfigIssues();
    const ns = resolveNamespace(dir, {
      gitRemote: () => "git@github.com:acme/app.git",
      gitRoot: () => null,
      issues,
      namespacesFile: approvals(),
    });
    expect(ns).toEqual({
      namespace: "github.com/acme/app",
      global: false,
      source: "git",
    });
    expect(issues.list(undefined, { pending: true })).toEqual([]);
  });
});

describe("namespaces.json is read strictly", () => {
  it("a group-writable file is refused: nothing is approved, and it is listed", () => {
    const dir = repo();
    const file = approvals([dir, "team"]);
    chmodSync(file, 0o660);
    const log = vi.fn();
    expect(
      resolveNamespace(dir, { ...noGit, log, namespacesFile: file }).namespace,
    ).toBe("r");
    expect(readApprovals(file).error).toBe("is writable by others");
    expect(inspectApprovals(file)).toMatchObject({
      file,
      state: "refused",
      reason: "is writable by others",
      fix: `run chmod go-w '${file}'`,
    });
    expect(
      log.mock.calls.some(([m]) => /namespaces\.json|is writable/.test(m)),
    ).toBe(true);
  });

  it("malformed content approves nothing", () => {
    const file = approvals();
    writeFileSync(
      file,
      JSON.stringify({ approved: [{ dir: "relative", namespace: "x" }] }),
    );
    expect(readApprovals(file).error).toBe("is not valid JSON");
  });

  it("the default file is <OA_BUS_HOME>/namespaces.json", () => {
    expect(namespacesFile("/h")).toBe("/h/namespaces.json");
  });
});

describe("doctor's scan", () => {
  it("lists a pending namespace with the approve fix", () => {
    const dir = repo();
    const files = scanConfigFiles(dir, {
      ...noGit,
      namespacesFile: approvals(),
    });
    expect(files).toEqual([
      expect.objectContaining({
        state: "pending",
        fix: `oa-bus namespace approve '${dir}'`,
      }),
    ]);
  });
});

describe("status and self carry pending only to clients that can decode it", () => {
  const OldConfigFile = z.object({
    file: z.string(),
    state: z.enum(["refused", "noted"]),
    reason: z.string(),
    fix: z.string(),
  });

  const setup = async () => {
    const dir = repo();
    const saved = process.env.OA_BUS_HOME;
    const home = tmp();
    process.env.OA_BUS_HOME = home;
    const restore = () => {
      if (saved === undefined) delete process.env.OA_BUS_HOME;
      else process.env.OA_BUS_HOME = saved;
    };
    const h = await daemonHarness({ resolveNamespace: undefined });
    return { dir, h, restore, home };
  };

  it("self: an adapter that listed the cap sees it, one that did not sees nothing an old decoder rejects", async () => {
    const { dir, h, restore } = await setup();
    try {
      const noCap = await h.adapter("A", { cwd: dir });
      const withCap = await h.adapter("B", {
        cwd: dir,
        caps: [ADAPTER_CAPS.pending],
      });
      const a = await noCap.request({ type: "self", row: true });
      const b = await withCap.request({ type: "self", row: true });
      const files = (r: typeof a) =>
        r.type === "agent" ? (r.agent?.config_files ?? []) : [];
      expect(files(a)).toEqual([]);
      expect(files(b)).toEqual([
        expect.objectContaining({
          state: "pending",
          fix: `oa-bus namespace approve '${dir}'`,
        }),
      ]);
      // The old strict decoder takes every entry the daemon sent without the cap.
      for (const f of files(a))
        expect(OldConfigFile.safeParse(f).success).toBe(true);
      expect(OldConfigFile.safeParse(files(b)[0]).success).toBe(false);
    } finally {
      restore();
    }
  });

  it("status: a client with the cap sees it; an old one does not", async () => {
    const { dir, h, restore } = await setup();
    try {
      await h.adapter("A", { cwd: dir });
      const withCap = await daemonStatus({
        path: h.socketPath,
        timeoutMs: 3000,
      });
      expect(withCap.config_files).toEqual([
        expect.objectContaining({ state: "pending" }),
      ]);
      const raw = await new Promise<{ config_files?: unknown[] }>(
        (resolve, reject) => {
          const sock = connect(h.socketPath);
          const decoder = new LineDecoder();
          sock.once("error", reject);
          sock.once("connect", () =>
            sock.write(
              `${JSON.stringify({ v: 1, id: "st", type: "status", client_version: "0.125.0" })}\n`,
            ),
          );
          sock.on("data", (chunk) => {
            const [f] = decoder.push(chunk);
            if (f) {
              sock.end();
              resolve(f as { config_files?: unknown[] });
            }
          });
        },
      );
      for (const f of raw.config_files ?? [])
        expect(OldConfigFile.safeParse(f).success).toBe(true);
      expect(raw.config_files ?? []).toEqual([]);
    } finally {
      restore();
    }
  });

  it("after approval a new session joins the namespace", async () => {
    const { dir, h, restore, home } = await setup();
    try {
      writeApprovals([{ dir, namespace: "team" }], home);
      const a = await h.adapter("A", { cwd: dir });
      const r = await a.request({ type: "self" });
      expect(r.type === "agent" && r.agent?.namespace).toBe("team");
    } finally {
      restore();
    }
  });
});
