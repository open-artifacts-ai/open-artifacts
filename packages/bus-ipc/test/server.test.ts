import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { connectDaemon } from "../src/client.ts";
import { serveDaemon } from "../src/server.ts";
import { hello, ok, tmpSock, within } from "./helpers.ts";

describe("server hardening", () => {
  it("close() resolves while a client is still connected", async () => {
    const path = tmpSock();
    const s = await serveDaemon({
      path,
      onHello: ok,
      onFrame: () => undefined,
    });
    const raw = connect(path);
    await new Promise((r) => raw.once("connect", r));
    const res = await within(s.close().then(() => "closed"));
    raw.destroy();
    expect(res).toBe("closed");
  });

  it("a second serveDaemon on a live socket refuses instead of unlinking it", async () => {
    const path = tmpSock();
    const first = await serveDaemon({
      path,
      onHello: ok,
      onFrame: () => undefined,
    });
    const second = serveDaemon({ path, onHello: ok, onFrame: () => undefined });
    await expect(second).rejects.toThrow();
    // the first daemon must still be reachable
    const c = await connectDaemon({ path, hello: hello(), timeoutMs: 500 });
    c.close();
    void first;
  });

  it("an oversized send is refused too_large on its own id, not by killing the connection", async () => {
    const path = tmpSock();
    await serveDaemon({ path, onHello: ok, onFrame: () => undefined });
    const c = await connectDaemon({ path, hello: hello() });
    const r = await c
      .request({ type: "send", to: "p", body: "x".repeat(1024 * 1024 + 1) })
      .catch((e) => e);
    expect(r).toMatchObject({ id: "1" });
    expect(c.state).toBe("open");
  });
});

describe("server survives a throwing handler", () => {
  it("onHello throwing for one client answers that client with an error and keeps serving", async () => {
    const path = tmpSock();
    await serveDaemon({
      path,
      onHello: (h) => {
        if (h.agent_ref === "evil") throw new Error("pid gone");
        return ok();
      },
      onFrame: () => undefined,
    });
    await expect(
      connectDaemon({ path, hello: hello("evil"), timeoutMs: 500 }),
    ).rejects.toThrow(/pid gone|refused/);
    const good = await connectDaemon({
      path,
      hello: hello("good"),
      timeoutMs: 500,
    });
    expect(good.welcome.type).toBe("welcome");
    good.close();
  });
});

describe("server frame errors", () => {
  it("a handler throwing in onFrame answers internal on that id and keeps serving", async () => {
    const path = tmpSock();
    await serveDaemon({
      path,
      onHello: ok,
      onFrame: (f) => {
        if (f.type === "self") throw new Error("boom");
        return { type: "roster", agents: [] };
      },
    });
    const c = await connectDaemon({ path, hello: hello() });
    expect(await c.request({ type: "self", id: "x" })).toMatchObject({
      type: "error",
      code: "internal",
      id: "x",
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.state).toBe("closed");
    const d = await connectDaemon({
      path,
      hello: hello("other"),
      timeoutMs: 500,
    });
    expect(await d.request({ type: "list" })).toMatchObject({ type: "roster" });
    d.close();
  });

  it("oversized send gets too_large on its id; connection stays open", async () => {
    const path = tmpSock();
    await serveDaemon({
      path,
      onHello: ok,
      onFrame: () => ({ type: "receipt", msg_id: "m", state: "pending" }),
    });
    const c = await connectDaemon({ path, hello: hello() });
    const r = await c.request({
      type: "send",
      to: "p",
      body: "x".repeat(1024 * 1024 + 1),
      id: "big",
    });
    expect(r).toMatchObject({ type: "error", code: "too_large", id: "big" });
    expect(
      await c.request({ type: "send", to: "p", body: "ok" }),
    ).toMatchObject({ type: "receipt" });
    c.close();
  });

  it("other schema failures after hello answer bad_frame on the frame id and keep the connection (before hello they destroy)", async () => {
    const path = tmpSock();
    await serveDaemon({
      path,
      onHello: ok,
      onFrame: () => ({ type: "roster", agents: [] }),
    });
    const c = await connectDaemon({ path, hello: hello() });
    const r = await c.request({ type: "send", id: "bad" }); // missing to/body
    expect(r).toMatchObject({ type: "error", code: "bad_frame", id: "bad" });
    expect(c.state).toBe("open");
    c.close();
  });

  it("async reply path: onFrame returns undefined, later reply() resolves the pending request", async () => {
    const path = tmpSock();
    await serveDaemon({
      path,
      onHello: ok,
      onFrame: (f, _h, reply) => {
        setTimeout(
          () => reply({ v: 1, id: f.id, type: "roster", agents: [] }),
          20,
        );
        return undefined;
      },
    });
    const c = await connectDaemon({ path, hello: hello() });
    expect(await c.request({ type: "list" })).toMatchObject({ type: "roster" });
    c.close();
  });

  it("close() leaves another daemon's socket alone", async () => {
    const path = tmpSock();
    const a = await serveDaemon({
      path,
      onHello: ok,
      onFrame: () => undefined,
    });
    rmSync(path); // A's socket file is removed externally
    const b = await serveDaemon({
      path,
      onHello: ok,
      onFrame: () => undefined,
    });
    await a.close();
    expect(existsSync(path)).toBe(true);
    const c = await connectDaemon({ path, hello: hello(), timeoutMs: 500 });
    c.close();
    await b.close();
    expect(existsSync(path)).toBe(false);
  });

  it("close() removes its own socket", async () => {
    const path = tmpSock();
    const a = await serveDaemon({
      path,
      onHello: ok,
      onFrame: () => undefined,
    });
    await a.close();
    expect(existsSync(path)).toBe(false);
  });

  it("replaces a stale socket file left by a SIGKILLed daemon", async () => {
    const path = tmpSock();
    const child = spawn(
      process.execPath,
      [
        "-e",
        `require("net").createServer().listen(process.argv[1],()=>console.log("ready"))`,
        path,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((r) => child.stdout.once("data", () => r()));
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await exited;
    expect(lstatSync(path).isSocket()).toBe(true); // stale file really is there
    const s = await serveDaemon({
      path,
      onHello: ok,
      onFrame: () => undefined,
    });
    const c = await connectDaemon({ path, hello: hello(), timeoutMs: 500 });
    c.close();
    await s.close();
  });

  it("refuses a regular file at the path and does not delete it", async () => {
    const path = tmpSock();
    writeFileSync(path, "precious");
    await expect(
      serveDaemon({ path, onHello: ok, onFrame: () => undefined }),
    ).rejects.toThrow(/not a socket/);
    expect(readFileSync(path, "utf8")).toBe("precious");
  });
});

describe("bad frame messages", () => {
  it("names the first problem, not a JSON dump of every issue", async () => {
    const path = tmpSock();
    await serveDaemon({ path, onHello: ok, onFrame: () => undefined });
    const c = await connectDaemon({ path, hello: hello() });
    const r = await c.request({ type: "send", to: "peer", body: "a\ud800" });
    expect(r).toMatchObject({
      type: "error",
      code: "bad_frame",
      message: "text is not well-formed unicode",
    });
    c.close();
  });
});

describe("a one-request connection (C26c I1)", () => {
  /** Writes hello and `frames` at once; resolves with every line read once the daemon closes. */
  const exchange = async (path: string, frames: object[]) => {
    const raw = connect(path);
    await new Promise((r) => raw.once("connect", r));
    let got = "";
    raw.on("data", (d) => {
      got += String(d);
    });
    const closed = new Promise((r) => raw.once("close", r));
    raw.write(
      [hello(), ...frames.map((f) => ({ v: 1, ...f }))]
        .map((f) => `${JSON.stringify(f)}\n`)
        .join(""),
    );
    expect(await within(closed)).not.toBe("timeout");
    return got
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { id: string; type: string; code?: string });
  };

  it("answers the first request, then closes without serving a second", async () => {
    const path = tmpSock();
    await serveDaemon({
      path,
      onHello: ok,
      oneRequest: () => true,
      onFrame: () => ({ type: "roster", agents: [] }),
    });
    const lines = await exchange(path, [
      { id: "a", type: "list" },
      { id: "b", type: "list" },
    ]);
    expect(lines.map((l) => [l.id, l.type])).toEqual([
      ["h", "welcome"],
      ["a", "roster"],
    ]);
  });

  it("refuses a second request sent before the first is answered", async () => {
    const path = tmpSock();
    let calls = 0;
    await serveDaemon({
      path,
      onHello: ok,
      oneRequest: () => true,
      onFrame: () => {
        calls += 1;
        return undefined;
      },
    });
    const lines = await exchange(path, [
      { id: "a", type: "list" },
      { id: "b", type: "send", to: "p", body: "x" },
    ]);
    expect(lines.map((l) => [l.id, l.type, l.code])).toEqual([
      ["h", "welcome", undefined],
      ["b", "error", "unauthorized"],
    ]);
    expect(calls).toBe(1);
  });

  it("closes once a later answer is pushed", async () => {
    const path = tmpSock();
    await serveDaemon({
      path,
      onHello: ok,
      oneRequest: () => true,
      onFrame: (f, _h, reply) => {
        setTimeout(
          () => reply({ v: 1, id: f.id, type: "roster", agents: [] }),
          20,
        );
        return undefined;
      },
    });
    const lines = await exchange(path, [{ id: "a", type: "list" }]);
    expect(lines.map((l) => [l.id, l.type])).toEqual([
      ["h", "welcome"],
      ["a", "roster"],
    ]);
  });

  it("leaves other connections serving many requests", async () => {
    const path = tmpSock();
    await serveDaemon({
      path,
      onHello: ok,
      oneRequest: () => false,
      onFrame: () => ({ type: "roster", agents: [] }),
    });
    const c = await connectDaemon({ path, hello: hello() });
    await c.request({ type: "list" });
    await c.request({ type: "list" });
    expect(c.state).toBe("open");
    c.close();
  });
});

describe("an asynchronous hello (C26c N3)", () => {
  it("holds frames sent behind the hello until it is welcomed, in order", async () => {
    const path = tmpSock();
    const seen: string[] = [];
    await serveDaemon({
      path,
      onHello: async () => {
        await new Promise((r) => setTimeout(r, 30));
        seen.push("hello");
        return ok();
      },
      onFrame: (f) => {
        seen.push(f.id);
        return { type: "roster", agents: [] };
      },
    });
    const raw = connect(path);
    await new Promise((r) => raw.once("connect", r));
    let got = "";
    raw.on("data", (d) => {
      got += String(d);
    });
    raw.write(
      [hello(), { v: 1, id: "a", type: "list" }]
        .map((f) => `${JSON.stringify(f)}\n`)
        .join(""),
    );
    raw.write(`${JSON.stringify({ v: 1, id: "b", type: "list" })}\n`);
    await vi.waitFor(() => expect(got.trim().split("\n")).toHaveLength(3));
    raw.destroy();
    expect(seen).toEqual(["hello", "a", "b"]);
    expect(got.split("\n").map((l) => l && JSON.parse(l).type)).toEqual([
      "welcome",
      "roster",
      "roster",
      "",
    ]);
  });

  it("refuses an asynchronous error, never reading the frames behind it", async () => {
    const path = tmpSock();
    const seen: string[] = [];
    await serveDaemon({
      path,
      onHello: async () => ({ error: "no" }),
      onFrame: (f) => {
        seen.push(f.id);
        return undefined;
      },
    });
    await expect(connectDaemon({ path, hello: hello() })).rejects.toThrow(/no/);
    expect(seen).toEqual([]);
  });
});
