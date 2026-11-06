// #1567: `oa-bus link|unlink <dir> <dir>` resolves each folder's namespace,
// posts a proposal with the machine token and prints the confirm URL. It
// links nothing itself.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUS_ROUTES } from "@oa/bus-protocol";
import { describe, expect, it, vi } from "vitest";
import { parse } from "../src/index.ts";
import { main } from "../src/main.ts";
import { fakeCtx, HUB, TOKEN } from "./fake.ts";

const CONFIRM = `${HUB}/bus/links/confirm#${"A".repeat(43)}`;

function setup(reply?: (req: { url: string; init: RequestInit }) => Response) {
  const ctx = fakeCtx();
  ctx.userHome = realpathSync(ctx.userHome);
  ctx.home = join(ctx.userHome, ".oa-bus");
  mkdirSync(ctx.home, { recursive: true });
  writeFileSync(
    join(ctx.home, "machine.json"),
    JSON.stringify({ hub: HUB, label: "mac", machine_token: TOKEN }),
    { mode: 0o600 },
  );
  const app = join(ctx.userHome, "code/app");
  const docs = join(ctx.userHome, "code/docs");
  const cfg = (dir: string, ns: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, ".oa-bus.json"),
      JSON.stringify({ namespace: ns }),
      {
        mode: 0o600,
      },
    );
  };
  cfg(app, "team");
  mkdirSync(docs, { recursive: true });
  ctx.cwd = join(ctx.userHome, "code");
  const calls: { url: string; init: RequestInit }[] = [];
  ctx.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return (
      reply?.(call) ??
      Response.json({ confirmUrl: CONFIRM, expiresAt: "2030-01-01T00:00:00Z" })
    );
  }) as typeof fetch;
  const run = (...argv: string[]) => main(argv, () => ctx);
  return { ctx, run, calls, app, docs, cfg };
}

describe("parse", () => {
  it("link and unlink take two directories; link list takes none", () => {
    expect(parse(["link", "a", "b"])).toMatchObject({
      cmd: "link",
      sub: "add",
      dirs: ["a", "b"],
    });
    expect(parse(["unlink", "a", "b"])).toMatchObject({
      cmd: "link",
      sub: "rm",
      dirs: ["a", "b"],
    });
    expect(parse(["link", "list"])).toMatchObject({ cmd: "link", sub: "list" });
    expect(() => parse(["link", "a"])).toThrow(/usage/);
    expect(() => parse(["link", "a", "b", "c"])).toThrow(/unexpected/);
    expect(() => parse(["unlink", "a"])).toThrow(/usage/);
  });
});

describe("link", () => {
  it("resolves both namespaces, posts the proposal with the machine token and prints the confirm URL", async () => {
    const { ctx, run, calls } = setup();
    // app's .oa-bus.json says "team" but is not approved: the derived one applies.
    expect(await run("link", "app", "docs")).toBe(0);
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c?.url).toBe(`${HUB}${BUS_ROUTES.linkProposals}`);
    expect(c?.init.method).toBe("POST");
    expect(
      (c?.init.headers as Record<string, string> | undefined)?.authorization,
    ).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(String(c?.init.body)) as {
      action: string;
      a: string;
      b: string;
    };
    expect(body.action).toBe("link");
    expect(body.a).not.toBe(body.b);
    const out = ctx.all().join("\n");
    expect(out).toContain(CONFIRM);
    expect(out).toContain("Open this in your browser to confirm.");
    // The token is never printed.
    expect(ctx.raw()).not.toContain(TOKEN);
  });

  it("unlink posts the unlink action", async () => {
    const { run, calls } = setup();
    expect(await run("unlink", "app", "docs")).toBe(0);
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      action: "unlink",
    });
  });

  it("refuses two folders in the same namespace, posting nothing", async () => {
    const { ctx, run, calls, docs } = setup();
    expect(await run("link", "docs", docs)).toBe(1);
    expect(calls).toHaveLength(0);
    expect(ctx.err().join("\n")).toContain("same namespace");
  });

  it("refuses a folder that does not exist, and a machine not logged in", async () => {
    const { ctx, run, calls } = setup();
    expect(await run("link", "app", "nope")).toBe(1);
    expect(calls).toHaveLength(0);
    expect(ctx.err().join("\n")).toContain("not a directory");
    const bare = fakeCtx();
    bare.cwd = bare.userHome;
    mkdirSync(join(bare.userHome, "x"));
    mkdirSync(join(bare.userHome, "y"));
    expect(await main(["link", "x", "y"], () => bare)).toBe(1);
    expect(bare.err().join("\n")).toContain("login");
  });

  it("explains a refusal from the instance", async () => {
    for (const [status, body, text] of [
      [409, { details: { reason: "rate_limited" } }, "too many"],
      [409, { details: { reason: "proposal_limit" } }, "waiting"],
      [401, {}, "login"],
    ] as const) {
      const { ctx, run } = setup(() =>
        Response.json({ error: "x", ...body }, { status }),
      );
      expect(await run("link", "app", "docs")).toBe(1);
      expect(ctx.err().join("\n").toLowerCase()).toContain(text);
    }
  });

  it("never prints a confirm URL that is not the instance's own", async () => {
    const { ctx, run } = setup(() =>
      Response.json({
        confirmUrl: "https://evil.example/bus/links/confirm/x",
        expiresAt: "2030-01-01T00:00:00Z",
      }),
    );
    expect(await run("link", "app", "docs")).toBe(1);
    expect(ctx.raw()).not.toContain("evil.example");
  });

  it("shell-quotes the folders it names", async () => {
    const { ctx, run, cfg } = setup();
    const odd = join(ctx.userHome, "code/it's here");
    cfg(odd, "odd");
    expect(await run("link", "app", "it's here")).toBe(0);
    expect(ctx.raw()).toContain(`'${odd.replace(/'/g, "'\\''")}'`);
  });

  it("link list points at the bus page and makes no request", async () => {
    const { ctx, run, calls } = setup();
    expect(await run("link", "list")).toBe(0);
    expect(calls).toHaveLength(0);
    expect(ctx.all().join("\n")).toContain(`${HUB}${BUS_ROUTES.page}`);
  });
});
