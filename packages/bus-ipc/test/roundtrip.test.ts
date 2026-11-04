import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectDaemon } from "../src/client.ts";
import { Hello } from "../src/frames.ts";
import { serveDaemon } from "../src/server.ts";

const dir = mkdtempSync(join(tmpdir(), "ob-ipc-"));
const served: { close: () => Promise<void> | void }[] = [];
afterEach(async () => {
  await Promise.all(served.splice(0).map((s) => s.close()));
});

const hello = (ref = "s1") =>
  Hello.parse({
    v: 1,
    id: "h",
    type: "hello",
    kind: "claude-code",
    agent_ref: ref,
    pid: process.pid,
    cwd: process.cwd(),
    attest: {},
  });
const okHello = () => ({
  bus_name: "claude-1",
  namespace: "dir:repo",
  global: false,
});

describe("local socket round trip", () => {
  it("is 0600, greets a hello, and answers a request by id", async () => {
    const path = join(dir, "daemon.sock");
    const server = await serveDaemon({
      path,
      onHello: okHello,
      onFrame: (frame) =>
        frame.type === "list" ? { type: "roster", agents: [] } : undefined,
    });
    served.push(server);
    expect(server.mode).toBe(0o600);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const client = await connectDaemon({ path, hello: hello() });
    served.push({ close: () => client.close() });
    expect(client.welcome.bus_name).toBe("claude-1");
    expect(await client.request({ type: "list" })).toMatchObject({
      type: "roster",
    });
  });

  it("chmods a pre-existing parent dir to 0700", async () => {
    const parent = join(dir, "pre");
    mkdirSync(parent, { mode: 0o755 });
    const server = await serveDaemon({
      path: join(parent, "d.sock"),
      onHello: okHello,
      onFrame: () => undefined,
    });
    served.push(server);
    expect(statSync(parent).mode & 0o777).toBe(0o700);
  });

  it("closes the connection when the first frame is not hello", async () => {
    const path = join(dir, "bad.sock");
    served.push(
      await serveDaemon({ path, onHello: okHello, onFrame: () => undefined }),
    );

    const sock = connect(path);
    await new Promise<void>((r, j) => {
      sock.once("connect", r);
      sock.once("error", j);
    });
    const closed = new Promise<void>((r) => sock.once("close", () => r()));
    const lines: string[] = [];
    createInterface({ input: sock }).on("line", (l) => lines.push(l));
    sock.write(`${JSON.stringify({ v: 1, id: "1", type: "list" })}\n`);

    await vi.waitFor(() => expect(lines.length).toBeGreaterThan(0));
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      type: "error",
      code: "unauthorized",
    });
    await closed;
  });

  it("answers invalid JSON with bad_frame", async () => {
    const path = join(dir, "json.sock");
    served.push(
      await serveDaemon({ path, onHello: okHello, onFrame: () => undefined }),
    );
    const sock = connect(path);
    await new Promise<void>((r, j) => {
      sock.once("connect", r);
      sock.once("error", j);
    });
    const lines: string[] = [];
    createInterface({ input: sock }).on("line", (l) => lines.push(l));
    sock.write("{not json\n");
    await vi.waitFor(() => expect(lines.length).toBeGreaterThan(0));
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      type: "error",
      code: "bad_frame",
    });
  });

  it("attributes a request to the helloed agent even if the frame names another", async () => {
    const path = join(dir, "attr.sock");
    const seen: { ref: string; frame: unknown }[] = [];
    served.push(
      await serveDaemon({
        path,
        onHello: (h) => ({
          bus_name: h.agent_ref,
          namespace: "n",
          global: false,
        }),
        onFrame: (frame, h) => {
          seen.push({ ref: h.agent_ref, frame });
          return { type: "receipt", msg_id: "m", state: "pending" };
        },
      }),
    );
    const client = await connectDaemon({ path, hello: hello() });
    served.push({ close: () => client.close() });

    // deliberate extra field: the daemon must ignore it
    const forged = {
      type: "send" as const,
      to: "peer",
      body: "hi",
      from: "someone-else",
    };
    await client.request(forged);
    expect(seen[0]?.ref).toBe("s1");
    expect(seen[0]?.frame).not.toHaveProperty("from");
  });

  it("rejects pending requests when the socket closes", async () => {
    const path = join(dir, "pend.sock");
    const server = await serveDaemon({
      path,
      onHello: okHello,
      onFrame: () => undefined,
    });
    served.push(server);
    const client = await connectDaemon({ path, hello: hello() });
    const p = client.request({ type: "list" });
    const assertion = expect(p).rejects.toThrow();
    client.close();
    await assertion;
    await expect(client.request({ type: "list" })).rejects.toThrow();
  });

  it("clears the hello timeout once answered", async () => {
    const path = join(dir, "timer.sock");
    served.push(
      await serveDaemon({ path, onHello: okHello, onFrame: () => undefined }),
    );
    const spy = vi.spyOn(globalThis, "clearTimeout");
    const client = await connectDaemon({
      path,
      hello: hello(),
      timeoutMs: 60_000,
    });
    served.push({ close: () => client.close() });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
