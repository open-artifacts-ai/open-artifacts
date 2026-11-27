import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { credentialsFor, listInstances } from "@oa/bus-daemon";
import { describe, expect, it, vi } from "vitest";
import { add, parseAddress, showAddress } from "../src/commands/add.ts";
import { parse } from "../src/index.ts";
import { CODE, fakeCtx, TOKEN } from "./fake.ts";

const OTHER = `oa_machine_${"b".repeat(28)}7f3a`;
const approvalServer = (
  host: string,
  over: {
    redirect?: string;
    redirectPoll?: string;
    token?: string;
    onPoll?: () => void;
  } = {},
) =>
  vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (over.redirect)
      return new Response(null, {
        status: 302,
        headers: { location: over.redirect },
      });
    if (u.endsWith("/bus/device"))
      return Response.json({
        device_code: "d".repeat(43),
        user_code: CODE,
        verification_uri: `${host}/bus/approve`,
        expires_in: 600,
        interval: 5,
      });
    if (over.redirectPoll)
      return new Response(null, {
        status: 302,
        headers: { location: over.redirectPoll },
      });
    over.onPoll?.();
    return Response.json({
      status: "approved",
      machine_token: over.token ?? TOKEN,
    });
  }) as unknown as typeof fetch;

const term = (fetch: typeof globalThis.fetch) =>
  fakeCtx({ fetch, stdinIsTTY: true }, true);

const writeMain = (home: string, hub = "https://main.example.com") => {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "machine.json"),
    JSON.stringify({ hub, label: "m", machine_token: OTHER }),
    { mode: 0o600 },
  );
};

describe("oa-bus add (#2793 S1)", () => {
  it("parses add <address> --name", () => {
    expect(
      parse(["add", "https://a.example.com", "--name", "work"]),
    ).toMatchObject({
      cmd: "add",
      address: "https://a.example.com",
      name: "work",
    });
    expect(() => parse(["add"])).toThrow(/usage/);
  });

  it("refuses without a TTY on stdin or stdout", async () => {
    const fetch = approvalServer("https://a.example.com");
    for (const [stdinIsTTY, tty] of [
      [false, true],
      [true, false],
    ] as const) {
      const ctx = fakeCtx({ fetch, stdinIsTTY }, tty);
      expect(
        await add({ address: "https://a.example.com", noOpen: true }, ctx),
      ).toBe(1);
      expect(ctx.err().join("\n")).toMatch(/real terminal/);
      expect(existsSync(join(ctx.home, "instances"))).toBe(false);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a redirect to another host and saves nothing", async () => {
    const fetch = approvalServer("https://a.example.com", {
      redirect: "https://evil.example.net/bus/device",
    });
    const ctx = term(fetch);
    expect(
      await add(
        { address: "https://a.example.com", name: "work", noOpen: true },
        ctx,
      ),
    ).toBe(1);
    expect(ctx.err().join("\n")).toMatch(/redirected/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1],
    ).toMatchObject({ redirect: "manual" });
    expect(existsSync(join(ctx.home, "instances"))).toBe(false);
    expect(existsSync(join(ctx.home, "machine.json"))).toBe(false);
  });

  it("refuses a redirect on the token poll and saves nothing", async () => {
    const ctx = term(
      approvalServer("https://a.example.com", {
        redirectPoll: "https://evil.example.net/bus/device/token",
      }),
    );
    expect(
      await add(
        { address: "https://a.example.com", name: "work", noOpen: true },
        ctx,
      ),
    ).toBe(1);
    expect(ctx.err().join("\n")).toMatch(/redirected/);
    expect(existsSync(join(ctx.home, "instances"))).toBe(false);
  });

  it("says so when the key is approved but cannot be saved", async () => {
    let ctx: ReturnType<typeof term>;
    const fetch = approvalServer("https://a.example.com", {
      onPoll: () => {
        mkdirSync(join(ctx.home, "instances"), { recursive: true });
        writeFileSync(join(ctx.home, "instances", "work.json"), "{}");
      },
    });
    ctx = term(fetch);
    expect(
      await add(
        { address: "https://a.example.com", name: "work", noOpen: true },
        ctx,
      ),
    ).toBe(1);
    expect(ctx.err().join("\n")).toMatch(
      /approved this machine but the key was not saved/,
    );
  });

  it("refuses an address whose host is too long to show in full", async () => {
    const long = `https://artifacts.leourbina.com.${"a".repeat(90)}.evil.example`;
    expect(parseAddress(long)).toEqual({
      refused: "the address is too long to show in full",
    });
    const fetch = approvalServer("https://a.example.com");
    const ctx = term(fetch);
    expect(await add({ address: long, name: "work", noOpen: true }, ctx)).toBe(
      1,
    );
    expect(ctx.err().join("\n")).toMatch(/too long to show in full/);
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(join(ctx.home, "instances"))).toBe(false);
  });

  it("saves the key 0600 in its own file with its own address, never machine.json", async () => {
    const ctx = term(approvalServer("https://a.example.com"));
    writeMain(ctx.home);
    const before = readFileSync(join(ctx.home, "machine.json"), "utf8");
    expect(
      await add(
        { address: "https://a.example.com/", name: "work", noOpen: true },
        ctx,
      ),
    ).toBe(0);
    const file = join(ctx.home, "instances", "work.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      name: "work",
      hub: "https://a.example.com",
      machine_token: TOKEN,
    });
    expect(readFileSync(join(ctx.home, "machine.json"), "utf8")).toBe(before);
    expect(readdirSync(join(ctx.home, "instances"))).toEqual(["work.json"]);
    expect(listInstances(ctx.home).map((i) => i.name)).toEqual([
      "main",
      "work",
    ]);
  });

  it("warns that unmapped folders leave main after the next restart, and suggests use main", async () => {
    const ctx = term(approvalServer("https://a.example.com"));
    writeMain(ctx.home);
    await add(
      { address: "https://a.example.com/", name: "work", noOpen: true },
      ctx,
    );
    const out = ctx.all().join("\n");
    expect(out).toContain(
      "every folder that is not mapped stops going to your main instance",
    );
    expect(out).toContain("automatic update");
    expect(out).toContain(
      `${ctx.busCmd} use main in a parent folder such as ~`,
    );
  });

  it("credentialsFor never returns another file's address or key", async () => {
    const ctx = term(approvalServer("https://a.example.com"));
    writeMain(ctx.home);
    await add(
      { address: "https://a.example.com", name: "work", noOpen: true },
      ctx,
    );
    const work = credentialsFor("work", ctx.home);
    const main = credentialsFor("main", ctx.home);
    expect(work.hub).toBe("https://a.example.com");
    expect(work.machine_token).toBe(TOKEN);
    expect(main.hub).toBe("https://main.example.com");
    expect(main.machine_token).toBe(OTHER);
    // An environment override of the main address never reaches an added instance.
    process.env.OA_BUS_INSTANCE = "https://evil.example.net";
    try {
      expect(credentialsFor("work", ctx.home).hub).toBe(
        "https://a.example.com",
      );
    } finally {
      delete process.env.OA_BUS_INSTANCE;
    }
    // A file whose name field names another instance is refused.
    writeFileSync(
      join(ctx.home, "instances", "other.json"),
      readFileSync(join(ctx.home, "instances", "work.json")),
      { mode: 0o600 },
    );
    expect(() => credentialsFor("other", ctx.home)).toThrow(
      /no instance named/,
    );
    expect(() => credentialsFor("nope", ctx.home)).toThrow(/no instance named/);
  });

  it("refuses an instance file open to other users", async () => {
    const ctx = term(approvalServer("https://a.example.com"));
    await add(
      { address: "https://a.example.com", name: "work", noOpen: true },
      ctx,
    );
    const { chmodSync } = await import("node:fs");
    chmodSync(join(ctx.home, "instances", "work.json"), 0o644);
    expect(() => credentialsFor("work", ctx.home)).toThrow(
      /readable by other users/,
    );
  });

  it("listInstances on a home with only machine.json returns just main", () => {
    const ctx = fakeCtx();
    writeMain(ctx.home);
    expect(listInstances(ctx.home)).toEqual([
      { name: "main", hub: "https://main.example.com", main: true },
    ]);
  });

  it("refuses a duplicate address, main's address, a duplicate name and bad names", async () => {
    const ctx = term(approvalServer("https://a.example.com"));
    writeMain(ctx.home);
    await add(
      { address: "https://a.example.com", name: "work", noOpen: true },
      ctx,
    );
    const cases: [string, string, RegExp][] = [
      ["https://a.example.com/", "second", /already the instance work/],
      ["https://main.example.com", "second", /main instance/],
      ["https://b.example.com", "work", /already exists/],
      ["https://b.example.com", "main", /reserved/],
      ["https://b.example.com", "Work", /lowercase/],
      ["https://b.example.com", "x".repeat(33), /1 to 32/],
    ];
    for (const [address, name, why] of cases) {
      const c = term(approvalServer(address));
      c.home = ctx.home;
      expect(await add({ address, name, noOpen: true }, c)).toBe(1);
      expect(c.err().join("\n")).toMatch(why);
    }
    expect(readdirSync(join(ctx.home, "instances"))).toEqual(["work.json"]);
  });

  it("shows a non-ASCII host in xn-- form before the browser opens", async () => {
    const ctx = term(approvalServer("https://xn--pple-43d.example"));
    const order: string[] = [];
    ctx.openBrowser = vi.fn(async () => {
      order.push(`open:${ctx.raw().includes("xn--pple-43d.example")}`);
      return true;
    });
    expect(
      await add(
        { address: "https://аpple.example", name: "look", noOpen: false },
        ctx,
      ),
    ).toBe(0);
    expect(ctx.raw()).toContain("https://xn--pple-43d.example");
    expect(ctx.raw()).not.toContain("а");
    expect(order).toEqual(["open:true"]);
  });

  it("strips control and colour codes and never cuts", () => {
    expect(
      showAddress("https://a.example.com/\u001b[31mred\u001b]52;c;eA==\u0007​"),
    ).toBe("https://a.example.com/red");
    expect(
      showAddress(`https://a.example.com/${"x".repeat(500)}`),
    ).toHaveLength(22 + 500);
  });

  it("allows only https, or http on loopback", () => {
    expect(parseAddress("http://a.example.com")).toHaveProperty("refused");
    expect(parseAddress("ftp://a.example.com")).toHaveProperty("refused");
    expect(parseAddress("https://u:p@a.example.com")).toHaveProperty("refused");
    expect(parseAddress("http://127.0.0.1:8787")).toEqual({
      hub: "http://127.0.0.1:8787",
      host: "127.0.0.1:8787",
    });
  });
});

// agy S5: with OA_BUS_EXPERIMENTAL_AGY=1, add gives Antigravity's entry at the
// new instance's address the --name form; without it the file stays as it is.
// A scratch HOME and a hand-written agy config only: no real agy runs.
describe("oa-bus add: Antigravity's entry (agy S5)", () => {
  const PAT = `oa_pat_${"c".repeat(40)}`;
  const agyConfig = `{
  "mcpServers": {
    "oa-work": {
      "headers": { "Authorization": "Bearer ${PAT}" },
      "serverUrl": "https://a.example.com/mcp"
    }
  }
}
`;
  const run = async (env: Record<string, string>, config = agyConfig) => {
    const ctx = fakeCtx(
      { fetch: approvalServer("https://a.example.com"), stdinIsTTY: true, env },
      true,
    );
    writeMain(ctx.home);
    const file = join(ctx.userHome, ".gemini", "config", "mcp_config.json");
    mkdirSync(join(file, ".."), { recursive: true });
    if (config) writeFileSync(file, config);
    expect(
      await add(
        { address: "https://a.example.com/", name: "work", noOpen: true },
        ctx,
      ),
    ).toBe(0);
    return readFileSync(file, "utf8");
  };

  it("creates a named pages proxy when add finds no agy config", async () => {
    const config = JSON.parse(await run({ OA_BUS_EXPERIMENTAL_AGY: "1" }, ""));
    const args = config.mcpServers["open-artifacts-work"].args;
    expect(args.slice(args.indexOf("mcp-proxy"))).toEqual([
      "mcp-proxy",
      "--instance",
      "https://a.example.com",
      "--for",
      "antigravity",
      "--name",
      "work",
      "--token-file",
      expect.stringMatching(/a-example-com-pat-token$/),
    ]);
  });
  it("gives the new instance's entry the proxy with --name <instance>", async () => {
    const e = JSON.parse(await run({ OA_BUS_EXPERIMENTAL_AGY: "1" }))
      .mcpServers["oa-work"];
    const args = e.args as string[];
    const i = args.indexOf("mcp-proxy");
    expect(args.slice(i)).toEqual([
      "mcp-proxy",
      "--instance",
      "https://a.example.com",
      "--for",
      "antigravity",
      "--name",
      "work",
      "--token-env",
      "OA_PAGES_TOKEN",
    ]);
    expect(e.env.OA_PAGES_TOKEN).toBe(PAT);
    expect(JSON.stringify(args)).not.toContain(PAT);
  });

  it("leaves the entry alone without OA_BUS_EXPERIMENTAL_AGY=1", async () => {
    expect(await run({})).toBe(agyConfig);
  });
});
