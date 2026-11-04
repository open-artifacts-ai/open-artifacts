import { describe, expect, it, vi } from "vitest";
import { connectDaemon } from "../src/client.ts";
import { fakeDaemon, hello, tmpSock, welcomeLine, within } from "./helpers.ts";

const deliverLine = (msg_id: string) =>
  `${JSON.stringify({ v: 1, id: "0", type: "deliver", msg_id, from_name: "peer", namespace: "n", body: "hi" })}\n`;

describe("client", () => {
  it("a deliver in the same chunk as the welcome is not dropped", async () => {
    const path = tmpSock();
    await fakeDaemon(path, (sock, l) => {
      if (l.type === "hello") sock.write(welcomeLine() + deliverLine("m1"));
    });
    const c = await connectDaemon({ path, hello: hello() });
    const got = new Promise((r) => c.onDeliver((f) => r(f.msg_id)));
    expect(await within(got, 300)).toBe("m1");
    c.close();
  });

  it("a throwing onDeliver callback does not tear down the daemon connection", async () => {
    const path = tmpSock();
    await fakeDaemon(path, (sock, l) => {
      if (l.type === "hello") sock.write(welcomeLine());
      if (l.type === "self") {
        sock.write(deliverLine("m2"));
        setTimeout(
          () =>
            sock.write(
              `${JSON.stringify({ v: 1, id: l.id, type: "agent", agent: null })}\n`,
            ),
          50,
        );
      }
    });
    const onError = vi.fn();
    const c = await connectDaemon({ path, hello: hello(), onError });
    c.onDeliver(() => {
      throw new Error("adapter bug");
    });
    const r = await c.request({ type: "self" }).catch((e) => e);
    expect(r).toMatchObject({ type: "agent" });
    expect(c.state).toBe("open");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("delivers buffered before onDeliver registers are flushed in order", async () => {
    const path = tmpSock();
    await fakeDaemon(path, (sock, l) => {
      if (l.type === "hello")
        sock.write(welcomeLine() + deliverLine("a") + deliverLine("b"));
    });
    const c = await connectDaemon({ path, hello: hello() });
    await new Promise((r) => setTimeout(r, 30));
    const seen: string[] = [];
    c.onDeliver((f) => seen.push(f.msg_id));
    expect(seen).toEqual(["a", "b"]);
    c.close();
  });

  it("a throwing onDeliver is reported to onError", async () => {
    const path = tmpSock();
    await fakeDaemon(path, (sock, l) => {
      if (l.type === "hello") sock.write(welcomeLine() + deliverLine("a"));
    });
    const errors: unknown[] = [];
    const c = await connectDaemon({
      path,
      hello: hello(),
      onError: (e) => errors.push(e),
    });
    c.onDeliver(() => {
      throw new Error("adapter bug");
    });
    expect(errors).toHaveLength(1);
    expect(c.state).toBe("open");
    c.close();
  });

  it("ack is fire-and-forget and leaves later requests in order", async () => {
    const path = tmpSock();
    const lines: { type: string; id: string }[] = [];
    await fakeDaemon(path, (sock, l) => {
      lines.push(l);
      if (l.type === "hello") sock.write(welcomeLine());
      if (l.type === "self")
        sock.write(
          `${JSON.stringify({ v: 1, id: l.id, type: "agent", agent: null })}\n`,
        );
    });
    const c = await connectDaemon({ path, hello: hello() });
    expect(c.ack("m1")).toBeUndefined();
    expect(await within(c.request({ type: "self" }), 300)).toMatchObject({
      type: "agent",
    });
    expect(lines[1]).toMatchObject({ v: 1, type: "ack", msg_id: "m1" });
    c.close();
  });

  it("a request the daemon never answers rejects after the timeout", async () => {
    const path = tmpSock();
    await fakeDaemon(path, (sock, l) => {
      if (l.type === "hello") sock.write(welcomeLine());
      if (l.type === "self" && l.id === "late")
        sock.write(
          `${JSON.stringify({ v: 1, id: l.id, type: "agent", agent: null })}\n`,
        );
    });
    const c = await connectDaemon({
      path,
      hello: hello(),
      requestTimeoutMs: 100,
    });
    await expect(within(c.request({ type: "list" }), 1000)).rejects.toThrow(
      /timed out/,
    );
    // The connection still serves later requests.
    expect(
      await within(c.request({ type: "self", id: "late" }), 300),
    ).toMatchObject({ type: "agent" });
    c.close();
  });

  it("requests time out after 20 s by default: above the daemon's 10 s hub wait plus 5 s for delivered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const path = tmpSock();
      await fakeDaemon(path, (sock, l) => {
        if (l.type === "hello") sock.write(welcomeLine());
      });
      const c = await connectDaemon({ path, hello: hello() });
      const r = c.request({ type: "list" });
      r.catch(() => {});
      await vi.advanceTimersByTimeAsync(19_900);
      let settled = false;
      r.then(
        () => (settled = true),
        () => (settled = true),
      );
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      await expect(r).rejects.toThrow(/timed out/);
      c.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
