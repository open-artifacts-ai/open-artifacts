// agy S5: `oa-bus install` (behind OA_BUS_EXPERIMENTAL_AGY=1) points
// Antigravity's Open Artifacts entry at the local proxy, which adds each
// conversation's link proof; added instances get the `--name` form; doctor
// reports each entry; uninstall puts the user's entry back byte for byte.
// A fake agy on PATH (deps.which) and a scratch HOME only: no real agy runs.
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonSocketPath } from "@oa/bus-adapter-claude-code";
import { jsoncValue } from "@oa/bus-adapter-mcp-json";
import { saveInstance } from "@oa/bus-daemon";
import { describe, expect, it } from "vitest";
import { parse } from "../src/index.ts";
import {
  type AdapterDeps,
  agyEntryIo,
  agyTargets,
  installAdapters,
  uninstallAdapters,
} from "../src/steps/adapters.ts";
import { withAgyConfigLock } from "../src/steps/agy-config-lock.ts";
import {
  AGY_TOKEN_ENV,
  agyPagesState,
  installAgyEntries,
  restoreAgyEntries,
} from "../src/steps/agy-proof.ts";
import { TOKEN } from "./fake.ts";

const HUB = "https://artifacts.example.com";
const MIT = "https://mit-ai.example.com";
const PAT = `oa_pat_${"b".repeat(40)}`;
const BIN = ["/opt/node/bin/node", "/h/.oa-bus/bin/oa-bus.js"];
const ON = { OA_BUS_EXPERIMENTAL_AGY: "1" };

function setup(opts: { env?: Record<string, string>; busHome?: string } = {}) {
  const h = mkdtempSync(join(tmpdir(), "ob-agy5-"));
  const deps: AdapterDeps = {
    home: h,
    env: opts.env ?? ON,
    busBin: BIN,
    hub: HUB,
    ...(opts.busHome ? { busHome: opts.busHome } : {}),
    assets: { pi: "PI_ASSET", opencodePlugin: "PLUGIN_JS" },
    which: (cmd) => cmd === "agy" || cmd === "node",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  return {
    h,
    deps,
    file: join(h, ".gemini/config/mcp_config.json"),
    moved: join(opts.busHome ?? join(h, ".oa-bus"), "agy-pages-entries.json"),
  };
}

function ownershipProcess(...args: string[]) {
  return spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("../node_modules/jiti/lib/jiti-cli.mjs", import.meta.url),
      ),
      fileURLToPath(new URL("./fixtures/agy-ownership.ts", import.meta.url)),
      ...args,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}

const put = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const read = (path: string) => readFileSync(path, "utf8");
const entry = (text: string, name = "open-artifacts") =>
  jsoncValue(text.replace(/^﻿/, ""), ["mcpServers", name]) as Record<
    string,
    unknown
  >;

// What `agy mcp add --header "Authorization: Bearer …" open-artifacts <url>`
// writes (agy 1.5.17), plus a comment and another server of the user's.
const THEIRS = (
  url = `${HUB}/mcp`,
  headers = `"Authorization": "Bearer ${PAT}"`,
) => `{
  // mine
  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "server-fs", "/work"] },
    "open-artifacts": {
      "disabled": false,
      "headers": {
        ${headers}
      },
      "serverUrl": "${url}"
    }
  }
}
`;

const PROXY_ARGS = [
  BIN[1],
  "mcp-proxy",
  "--instance",
  HUB,
  "--for",
  "antigravity",
  "--token-env",
  AGY_TOKEN_ENV,
];

describe("Antigravity pages entry (agy S5)", () => {
  it("never binds a slug-only PAT to either colliding install target", async () => {
    const { deps, h, file } = setup();
    const other = "https://artifacts-example.com";
    saveInstance(
      {
        name: "other",
        hub: other,
        machine_id: "",
        label: "m",
        machine_token: TOKEN,
      },
      join(h, ".oa-bus"),
    );
    put(join(h, ".open-artifacts/artifacts-example-com-pat-token"), PAT);
    const r = await installAdapters(deps);
    expect(entry(read(file))).toEqual({ serverUrl: `${HUB}/mcp` });
    expect(entry(read(file), "open-artifacts-other")).toEqual({
      serverUrl: `${other}/mcp`,
    });
    expect(r.notes.join("\n")).not.toContain(PAT);
    const before = read(file);
    put(
      join(h, ".open-artifacts/pats", encodeURIComponent(other)),
      "dummy-other-credential",
    );
    await installAdapters(deps);
    expect(read(file)).toBe(before);
    await uninstallAdapters(deps);
    expect(entry(read(file))).toBeUndefined();
  });
  it("keeps a user comment inside a generated native entry", async () => {
    const { deps, file } = setup();
    await installAdapters(deps);
    put(
      file,
      read(file).replace('"serverUrl"', '/* keep my note */ "serverUrl"'),
    );
    await installAdapters(deps);
    await uninstallAdapters(deps);
    expect(read(file)).toContain("/* keep my note */");
    expect(entry(read(file))).toEqual({ serverUrl: `${HUB}/mcp` });
  });

  it.each([true, false])(
    "removes the shared native entry only on last uninstall (creator first: %s)",
    async (creatorFirst) => {
      const { deps, file, h } = setup();
      const other = { ...deps, busHome: join(h, "second-bus") };
      await installAdapters(deps);
      await installAdapters(other);
      await uninstallAdapters(creatorFirst ? deps : other);
      expect(entry(read(file))).toEqual({ serverUrl: `${HUB}/mcp` });
      await uninstallAdapters(creatorFirst ? other : deps);
      // Last uninstall may remove the empty config file.
      expect(existsSync(file) ? entry(read(file)) : undefined).toBeUndefined();
    },
  );

  it("recovers when the creator stops immediately after publishing the native entry", async () => {
    const { deps, file, h } = setup();
    const io = agyEntryIo(deps);
    put(file, '{"mcpServers":{}}');
    expect(() =>
      installAgyEntries(
        {
          ...io,
          write(text) {
            io.write(text);
            throw Error("interrupted");
          },
        },
        [{ origin: HUB }],
      ),
    ).toThrow("interrupted");
    const second = { ...deps, busHome: join(h, "second-bus") };
    await installAdapters(second);
    await installAdapters(deps);
    await uninstallAdapters(deps);
    expect(entry(read(file))).toEqual({ serverUrl: `${HUB}/mcp` });
    await uninstallAdapters(second);
    expect(entry(read(file))).toBeUndefined();
  });

  it("recovers a ticket left by a process that exits inside the config lock", async () => {
    const { deps, h, file } = setup();
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./fixtures/agy-lock-exit.ts", import.meta.url)),
        h,
      ],
      { stdio: "inherit" },
    );
    expect((await once(child, "exit"))[0]).toBe(42);
    await installAdapters(deps);
    expect(entry(read(file))).toEqual({ serverUrl: `${HUB}/mcp` });
    expect(
      readdirSync(h).some((f) => f.startsWith(".oa-bus-agy-ticket.")),
    ).toBe(false);
  });

  it("serializes two uninstall processes that are both ready to remove the same native entry", async () => {
    const { deps, h, file } = setup();
    const second = join(h, "second-bus");
    await installAdapters(deps);
    await installAdapters({ ...deps, busHome: second });
    const children: ReturnType<typeof spawn>[] = [];
    const done: Promise<void>[] = [];
    try {
      await withAgyConfigLock(h, async () => {
        const watcher = watch(h);
        try {
          const queued = new Promise<void>((resolve, reject) => {
            watcher.once("error", reject);
            watcher.on("change", () => {
              if (
                readdirSync(h).filter((f) =>
                  f.startsWith(".oa-bus-agy-ticket."),
                ).length === 3
              )
                resolve();
            });
          });
          for (const bus of [join(h, ".oa-bus"), second]) {
            const child = ownershipProcess(h, bus);
            children.push(child);
            done.push(
              once(child, "exit").then(([code]) => {
                expect(code).toBe(0);
              }),
            );
          }
          // An early exit means an uninstall bypassed the held lock.
          await Promise.race([
            queued,
            ...done.map((p) =>
              p.then(() => {
                throw Error("uninstall escaped the config lock");
              }),
            ),
          ]);
        } finally {
          watcher.close();
        }
      });
      await Promise.all(done);
      expect(existsSync(file) ? entry(read(file)) : undefined).toBeUndefined();
      expect(existsSync(file + ".oa-bus-claims")).toBe(false);
    } finally {
      for (const child of children) child.kill();
      await Promise.allSettled(done);
    }
  }, 20_000);

  it("installs and removes the main pages proxy on a fresh machine", async () => {
    const { deps, file, h } = setup();
    put(join(h, ".open-artifacts/pats", encodeURIComponent(HUB)), PAT);
    await installAdapters(deps);
    const config = read(file);
    expect(entry(config)).toEqual({
      command: BIN[0],
      args: [
        ...PROXY_ARGS.slice(0, -2),
        "--token-file",
        join(h, ".open-artifacts/pats", encodeURIComponent(HUB)),
      ],
    });
    await installAdapters(deps);
    expect(read(file)).toBe(config);
    await uninstallAdapters(deps);
    expect(entry(read(file))).toBeUndefined();
  });
  it("keeps an occupied name and preserves changes to the generated proxy", async () => {
    const { deps, file, h } = setup();
    const other = { command: "mine", args: [] };
    put(file, JSON.stringify({ mcpServers: { "open-artifacts": other } }));
    put(join(h, ".open-artifacts/pats", encodeURIComponent(HUB)), PAT);
    await installAdapters(deps);
    const config = JSON.parse(read(file));
    expect(config.mcpServers["open-artifacts"]).toEqual(other);
    const generated = config.mcpServers["open-artifacts-2"];
    expect(generated.args).toContain(HUB);
    generated.disabled = true;
    put(file, JSON.stringify(config));
    await installAdapters({ ...deps, busBin: ["/new/node", "/new/cli"] });
    await uninstallAdapters(deps);
    expect(entry(read(file), "open-artifacts-2")).toEqual(generated);
    expect(entry(read(file))).toEqual(other);
  });

  it("is left alone without OA_BUS_EXPERIMENTAL_AGY=1", async () => {
    const { deps, file } = setup({ env: {} });
    put(file, THEIRS());
    await installAdapters(deps);
    expect(read(file)).toBe(THEIRS());
  });

  it("swaps the instance's entry for the proxy, the token in env only, and uninstall puts the file back byte for byte", async () => {
    const { deps, file, moved } = setup();
    put(file, THEIRS());
    const r = await installAdapters(deps);
    expect(r.installed).toContain("antigravity");
    const text = read(file);
    const e = entry(text);
    expect(e).toEqual({
      disabled: false,
      command: BIN[0],
      args: PROXY_ARGS,
      env: { [AGY_TOKEN_ENV]: PAT },
    });
    // The rest of the file is the user's, comment included.
    expect(text).toContain("// mine");
    expect(entry(text, "fs")).toEqual({
      command: "npx",
      args: ["-y", "server-fs", "/work"],
    });
    // The token is never an argument, nor copied to the bus home.
    expect(JSON.stringify(e.args)).not.toContain(PAT);
    expect(read(moved)).not.toContain(PAT);
    expect(statSync(moved).mode & 0o777).toBe(0o600);
    // A second install changes nothing.
    await installAdapters(deps);
    expect(read(file)).toBe(text);
    await uninstallAdapters(deps);
    // oa_bus is gone and the user's entry is back exactly.
    expect(read(file)).toBe(THEIRS());
  });

  it("preserves existing native OAuth entries even with a PAT available", async () => {
    const { deps, file, h } = setup();
    const original = THEIRS(`${HUB}/mcp`, "");
    put(file, original);
    put(join(h, ".open-artifacts/pats", encodeURIComponent(HUB)), PAT);
    await installAdapters(deps);
    expect(entry(read(file))).toEqual(entry(original));
    await uninstallAdapters(deps);
    expect(read(file)).toBe(original);
  });

  it("leaves an entry with other headers, another address, or turned off", async () => {
    for (const text of [
      THEIRS(`${HUB}/mcp`, `"Authorization": "Bearer ${PAT}", "X-Other": "1"`),
      THEIRS("https://elsewhere.example.com/mcp"),
      THEIRS().replace('"disabled": false', '"disabled": true'),
    ]) {
      const { deps, file } = setup();
      put(file, text);
      await installAdapters(deps);
      expect(entry(read(file))).toEqual(entry(text));
    }
  });

  it("gives an added instance's entry the --name form", async () => {
    const bus = mkdtempSync(join(tmpdir(), "ob-agy5-bus-"));
    saveInstance(
      {
        name: "mit-ai",
        hub: MIT,
        machine_id: "",
        label: "m",
        machine_token: TOKEN,
      },
      bus,
    );
    const { deps, file } = setup({ busHome: bus });
    put(
      file,
      THEIRS().replace(
        '"fs":',
        `"oa-mit": { "serverUrl": "${MIT}/mcp", "headers": { "Authorization": "Bearer ${PAT}" } },\n    "fs":`,
      ),
    );
    expect(agyTargets(deps)).toEqual([
      { origin: HUB },
      { origin: MIT, name: "mit-ai" },
    ]);
    await installAdapters(deps);
    const e = entry(read(file), "oa-mit");
    expect(e.args).toEqual([
      BIN[1],
      "mcp-proxy",
      "--instance",
      MIT,
      "--for",
      "antigravity",
      "--name",
      "mit-ai",
      "--token-env",
      AGY_TOKEN_ENV,
    ]);
    expect(e.env).toEqual({ [AGY_TOKEN_ENV]: PAT, OA_BUS_HOME: bus });
  });

  it("leaves another running bus's proxy entry, and main's even when its bus has stopped (#3075)", async () => {
    const other = mkdtempSync(join(tmpdir(), "ob-agy5-other-"));
    const theirs = (home: string) =>
      `{\n  "mcpServers": {\n    "open-artifacts": ${JSON.stringify({
        command: BIN[0],
        args: PROXY_ARGS,
        env: { [AGY_TOKEN_ENV]: PAT, OA_BUS_HOME: home },
      })}\n  }\n}\n`;
    // A running bus holds its daemon socket.
    put(daemonSocketPath(other), "");
    const a = setup();
    put(a.file, theirs(other));
    const r = await installAdapters(a.deps);
    expect(entry(read(a.file)).env).toMatchObject({ OA_BUS_HOME: other });
    expect(r.notes.join("\n")).toContain(`belongs to the bus at ${other}`);
    // Main's entry stays with its bus even with no socket: that bus keeps
    // the user's original for its own uninstall.
    const gone = join(other, "gone");
    const b = setup();
    put(b.file, theirs(gone));
    const rb = await installAdapters(b.deps);
    expect(entry(read(b.file))).toEqual(entry(theirs(gone)));
    expect(rb.notes.join("\n")).toContain(`belongs to the bus at ${gone}`);
  });

  it("takes an added instance's entry whose bus has stopped, carrying the user's original, and the old bus's uninstall keeps it (#3075)", async () => {
    const bus = mkdtempSync(join(tmpdir(), "ob-agy5-bus-"));
    saveInstance(
      {
        name: "mit-ai",
        hub: MIT,
        machine_id: "",
        label: "m",
        machine_token: TOKEN,
      },
      bus,
    );
    // The stopped bus has no socket, but kept the user's own entry text.
    const old = mkdtempSync(join(tmpdir(), "ob-agy5-old-"));
    const mine = `{ "serverUrl": "${MIT}/mcp", "headers": { "Authorization": "Bearer {{oa-bus:pages-token}}" } }`;
    const keptOld = `${JSON.stringify({ entries: [{ name: "oa-mit", origin: MIT, instance: "mit-ai", original: mine }] }, null, 2)}\n`;
    put(join(old, "agy-pages-entries.json"), keptOld);
    const args = [
      BIN[1],
      "mcp-proxy",
      "--instance",
      MIT,
      "--for",
      "antigravity",
      "--name",
      "mit-ai",
      "--token-env",
      AGY_TOKEN_ENV,
    ];
    const { deps, file } = setup({ busHome: bus });
    put(
      file,
      `{\n  "mcpServers": {\n    "oa-mit": ${JSON.stringify({
        command: BIN[0],
        args,
        env: { [AGY_TOKEN_ENV]: PAT, OA_BUS_HOME: old },
      })}\n  }\n}\n`,
    );
    const r = await installAdapters(deps);
    expect(entry(read(file), "oa-mit").env).toEqual({
      [AGY_TOKEN_ENV]: PAT,
      OA_BUS_HOME: bus,
    });
    expect(r.notes.join("\n")).toContain("took over the oa-mit entry");
    // The old bus's uninstall leaves the entry and keeps its kept file.
    const o = setup({ busHome: old });
    expect(restoreAgyEntries({ ...agyEntryIo(o.deps), file }).restored).toEqual(
      [],
    );
    expect(read(join(old, "agy-pages-entries.json"))).toBe(keptOld);
    // This bus's uninstall puts the user's own text back, token in place.
    await uninstallAdapters(deps);
    expect(entry(read(file), "oa-mit")).toEqual({
      serverUrl: `${MIT}/mcp`,
      headers: { Authorization: `Bearer ${PAT}` },
    });
    expect(read(file)).toContain(mine.replace("{{oa-bus:pages-token}}", PAT));
  });

  it("doctor's state: pending, linked, then missing program", async () => {
    const { deps, file } = setup();
    put(file, THEIRS());
    const state = (which = deps.which) =>
      agyPagesState(agyEntryIo(deps), agyTargets(deps), which);
    expect(state()).toEqual([
      { state: "pending", name: "open-artifacts", origin: HUB },
    ]);
    await installAdapters(deps);
    expect(state()).toEqual([
      { state: "missing", name: "open-artifacts", program: BIN[0] },
    ]);
    const bin = join(deps.home, "oa-bus.js");
    put(bin, "");
    const d2 = { ...deps, busBin: ["node", bin] };
    await installAdapters(d2);
    expect(agyPagesState(agyEntryIo(d2), agyTargets(d2), d2.which)).toEqual([
      { state: "linked", name: "open-artifacts", origin: HUB },
    ]);
  });

  it("parses mcp-proxy --for antigravity with --name and --token-env", () => {
    expect(
      parse([
        "mcp-proxy",
        "--instance",
        MIT,
        "--for",
        "antigravity",
        "--name",
        "mit-ai",
        "--token-env",
        AGY_TOKEN_ENV,
      ]),
    ).toMatchObject({
      cmd: "mcp-proxy",
      hub: MIT,
      for: "antigravity",
      name: "mit-ai",
      tokenEnv: AGY_TOKEN_ENV,
    });
    expect(() =>
      parse(["mcp-proxy", "--instance", MIT, "--name", "mit-ai"]),
    ).toThrow(/--name needs --for antigravity/);
  });
});
