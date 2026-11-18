import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  foldersFile,
  readFolders,
  saveInstance,
  writeFolders,
} from "@oa/bus-daemon";
import { describe, expect, it, vi } from "vitest";
import { use } from "../src/commands/use.ts";
import { parse } from "../src/index.ts";
import { fakeCtx, TOKEN } from "./fake.ts";

const OTHER = `oa_machine_${"b".repeat(28)}7f3a`;

/** A terminal ctx on scratch homes, a fetch spy, two instances, and a repo folder. */
function setup(
  opts: { answers?: string[]; suggest?: unknown; tty?: boolean } = {},
) {
  const fetch = vi.fn(async () => {
    throw new Error("no network");
  }) as unknown as typeof globalThis.fetch;
  const answers = [...(opts.answers ?? [])];
  const readLine = vi.fn(async (_q: string) => answers.shift() ?? "");
  const tty = opts.tty ?? true;
  const ctx = fakeCtx({ fetch, stdinIsTTY: tty, readLine }, tty);
  mkdirSync(ctx.home, { recursive: true });
  writeFileSync(
    join(ctx.home, "machine.json"),
    JSON.stringify({
      hub: "https://main.example.com",
      label: "m",
      machine_token: OTHER,
    }),
    { mode: 0o600 },
  );
  saveInstance(
    {
      name: "work",
      hub: "https://work.example.com",
      machine_id: "",
      label: "l",
      machine_token: TOKEN,
    },
    ctx.home,
  );
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ob-use-")));
  const writeSuggest = (body: unknown) =>
    writeFileSync(join(dir, ".oa-bus.json"), JSON.stringify(body), {
      mode: 0o600,
    });
  if (opts.suggest !== undefined) writeSuggest({ instance: opts.suggest });
  (ctx as { cwd: string }).cwd = dir;
  return { ctx, dir, fetch, readLine, writeSuggest };
}

describe("oa-bus use (#2793 S2)", () => {
  it("parses use, use <name> and use --none", () => {
    expect(parse(["use"])).toMatchObject({ cmd: "use", none: false });
    expect(parse(["use", "work"])).toMatchObject({ cmd: "use", name: "work" });
    expect(parse(["use", "--none"])).toMatchObject({ cmd: "use", none: true });
    expect(() => parse(["use", "work", "--none"])).toThrow(/usage/);
    expect(() => parse(["use", "--yes"])).toThrow(/does not apply/);
  });

  it("is refused without a terminal", async () => {
    const { ctx, dir } = setup({ tty: false });
    expect(await use({ name: "work", none: false }, ctx)).toBe(1);
    expect(ctx.err().join("\n")).toMatch(/real terminal/);
    expect(existsSync(foldersFile(ctx.home))).toBe(false);
    expect(dir).toBeTruthy();
  });

  it("Enter alone maps nothing", async () => {
    const { ctx } = setup({ answers: [""] });
    expect(await use({ none: false }, ctx)).toBe(0);
    expect(existsSync(foldersFile(ctx.home))).toBe(false);
    expect(ctx.out().join("\n")).toMatch(/Nothing changed/);
  });

  it("a number maps the folder by local name; a bad answer maps nothing", async () => {
    const { ctx, dir } = setup({ answers: ["2"] });
    expect(await use({ none: false }, ctx)).toBe(0);
    expect(readFolders(ctx.home).map).toEqual({ [dir]: "work" });
    const bad = setup({ answers: ["9"] });
    expect(await use({ none: false }, bad.ctx)).toBe(1);
    expect(existsSync(foldersFile(bad.ctx.home))).toBe(false);
  });

  it("lists every instance by name with its full address", async () => {
    const { ctx } = setup({ answers: [""] });
    await use({ none: false }, ctx);
    const out = ctx.out().join("\n");
    expect(out).toContain("1. main  https://main.example.com");
    expect(out).toContain("2. work  https://work.example.com");
    expect(out).not.toMatch(/suggested by this repo/);
  });

  it("only an added instance is accepted by name", async () => {
    const { ctx } = setup();
    expect(await use({ name: "nope", none: false }, ctx)).toBe(1);
    expect(existsSync(foldersFile(ctx.home))).toBe(false);
    expect(await use({ name: "work", none: false }, ctx)).toBe(0);
  });

  it("a single-instance home says so and writes nothing", async () => {
    const { ctx } = setup();
    const solo = fakeCtx({ stdinIsTTY: true }, true);
    mkdirSync(solo.home, { recursive: true });
    writeFileSync(
      join(solo.home, "machine.json"),
      JSON.stringify({ hub: "https://main.example.com", machine_token: OTHER }),
      { mode: 0o600 },
    );
    expect(await use({ name: "main", none: false }, solo)).toBe(0);
    expect(existsSync(foldersFile(solo.home))).toBe(false);
    expect(ctx).toBeTruthy();
  });

  it("marks the suggested instance only on an exact canonical address", async () => {
    const hit = setup({ suggest: "https://WORK.example.com", answers: [""] });
    await use({ none: false }, hit.ctx);
    expect(hit.ctx.out().join("\n")).toMatch(
      /2\. work {2}https:\/\/work\.example\.com {2}\(suggested by this repo\)/,
    );
    // A suggestion never matches by local name.
    const byName = setup({ suggest: "https://work", answers: [""] });
    await use({ none: false }, byName.ctx);
    expect(byName.ctx.out().join("\n")).not.toMatch(/suggested by this repo/);
  });

  it("a suggestion for an instance not added: one line, no add, no browser, no request", async () => {
    const s = setup({ suggest: "https://new.example.com", answers: [""] });
    await use({ none: false }, s.ctx);
    expect(s.ctx.out().join("\n")).toContain(
      `This repo suggests https://new.example.com, which this computer hasn't added. Run ${s.ctx.busCmd} add yourself if you trust it.`,
    );
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.ctx.openBrowser).not.toHaveBeenCalled();
    expect(s.ctx.exec).not.toHaveBeenCalled();
    expect(existsSync(join(s.ctx.home, "instances", "new.json"))).toBe(false);
    expect(existsSync(foldersFile(s.ctx.home))).toBe(false);
  });

  it("a lookalike address is shown in full in xn-- form and offered nothing", async () => {
    const s = setup({ suggest: "https://wпrk.example.com", answers: [""] });
    await use({ none: false }, s.ctx);
    const out = s.ctx.out().join("\n");
    expect(out).toMatch(
      /This repo suggests https:\/\/xn--[a-z0-9-]+\.example\.com, which/,
    );
    expect(out).not.toMatch(/suggested by this repo/);
    expect([...out].every((c) => c.charCodeAt(0) < 128)).toBe(true);
    expect(s.fetch).not.toHaveBeenCalled();
  });

  it("changing the file after a yes leaves the map unchanged and notes once", async () => {
    const s = setup({ suggest: "https://work.example.com", answers: ["2"] });
    await use({ none: false }, s.ctx);
    const mapped = readFolders(s.ctx.home).map;
    expect(mapped).toEqual({ [s.dir]: "work" });
    s.writeSuggest({ instance: "https://evil.example.com" });
    const again = [await use({ name: undefined, none: false } as never, s.ctx)];
    expect(again).toEqual([0]);
    expect(readFolders(s.ctx.home).map).toEqual(mapped);
    const notes = () =>
      s.ctx.out().filter((l) => /now suggests/.test(l)).length;
    expect(notes()).toBe(1);
    await use({ none: false }, s.ctx);
    expect(notes()).toBe(1);
  });

  it("a nested file under a mapped folder is ignored", async () => {
    const s = setup({ answers: [""] });
    writeFolders({ map: { [s.dir]: "work" }, no: {}, seen: {} }, s.ctx.home);
    const nested = join(s.dir, "sub");
    mkdirSync(nested);
    writeFileSync(
      join(nested, ".oa-bus.json"),
      '{"instance":"https://new.example.com"}',
      { mode: 0o600 },
    );
    (s.ctx as { cwd: string }).cwd = nested;
    await use({ none: false }, s.ctx);
    expect(s.ctx.out().join("\n")).not.toMatch(/suggests/);
    expect(readFolders(s.ctx.home).map).toEqual({ [s.dir]: "work" });
  });

  it("use --none remembers a no, and the hint is not offered again", async () => {
    const s = setup({ suggest: "https://work.example.com", answers: ["", ""] });
    expect(await use({ none: true }, s.ctx)).toBe(0);
    expect(readFolders(s.ctx.home).no).toEqual({
      [s.dir]: "https://work.example.com",
    });
    expect(readFolders(s.ctx.home).map).toEqual({});
    await use({ none: false }, s.ctx);
    expect(s.ctx.out().join("\n")).not.toMatch(/suggested by this repo/);
  });

  it("refuses to cut an address over 120 characters", async () => {
    const long = `https://${"a".repeat(60)}.${"b".repeat(60)}.example.com`;
    const s = setup({ answers: ["1"] });
    saveInstance(
      {
        name: "big",
        hub: long,
        machine_id: "",
        label: "l",
        machine_token: TOKEN,
      },
      s.ctx.home,
    );
    expect(await use({ none: false }, s.ctx)).toBe(1);
    expect(s.readLine).not.toHaveBeenCalled();
    expect(existsSync(foldersFile(s.ctx.home))).toBe(false);
  });
});
