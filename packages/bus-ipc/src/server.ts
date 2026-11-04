import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  AdapterFrame,
  type DaemonFrame,
  type Hello,
  MAX_BODY_BYTES,
  type StatusReply,
  StatusRequest,
} from "./frames.ts";
import { FrameTooLarge, LineDecoder } from "./lines.ts";

/** A daemon frame without the envelope the server fills in; distributes over the union. */
export type Unframed<T = DaemonFrame> = T extends unknown
  ? Omit<T, "v" | "id">
  : never;

export type HelloResult = {
  bus_name: string;
  namespace: string;
  global: boolean;
};
export type ServeOptions = {
  path: string;
  /**
   * May answer later: frames after the hello wait for it, in order. `closed`
   * says whether the connection has gone since, so a late answer admits nothing.
   */
  onHello: (
    hello: Hello,
    closed: () => boolean,
  ) =>
    | HelloResult
    | { error: string }
    | Promise<HelloResult | { error: string }>;
  /** Pushes a later answer on this connection, for requests the hub answers asynchronously. */
  onFrame: (
    frame: AdapterFrame,
    hello: Hello,
    /** False when the connection is gone and nothing was written. */
    reply: (f: DaemonFrame) => boolean,
  ) => Unframed | undefined;
  /** After the welcome is written: `push` writes later frames on this connection. */
  onOpen?: (hello: Hello, push: (f: DaemonFrame) => void) => void;
  onClose?: (hello?: Hello) => void;
  /**
   * True for a connection that proves itself per request (Codex: per call
   * id): it serves one request, closes once that is answered, and any other
   * request on it is refused.
   */
  oneRequest?: (hello: Hello) => boolean;
  /** Answers a `status` request; without it, status needs a hello like anything else. */
  onStatus?: (
    req: StatusRequest,
  ) =>
    | Omit<StatusReply, "v" | "id" | "type">
    | Promise<Omit<StatusReply, "v" | "id" | "type">>;
};

export type ServedDaemon = { close: () => Promise<void>; mode: number };

/** Unlinks a socket file left by a dead daemon; throws EADDRINUSE if something still answers. */
async function clearStale(path: string): Promise<void> {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (!st.isSocket()) {
    throw Object.assign(new Error(`${path} exists and is not a socket`), {
      code: "ENOTSOCK",
    });
  }
  const live = await new Promise<boolean>((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
  if (live) {
    throw Object.assign(new Error(`daemon already listening on ${path}`), {
      code: "EADDRINUSE",
    });
  }
  rmSync(path, { force: true });
}

export async function serveDaemon(opts: ServeOptions): Promise<ServedDaemon> {
  const parent = dirname(opts.path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  await clearStale(opts.path);
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock: Socket) => {
    sockets.add(sock);
    sock.once("close", () => sockets.delete(sock));
    handle(sock, opts);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.path, () => resolve());
  });
  chmodSync(opts.path, 0o600);
  const st = statSync(opts.path);
  const mode = st.mode & 0o777;
  return {
    mode,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        // libuv unlinks the path inside server.close() whatever is there. If
        // it is no longer our socket, park a hard link and put it back after.
        let parked: string | undefined;
        try {
          const now = statSync(opts.path);
          if (now.ino !== st.ino || now.dev !== st.dev) {
            parked = `${opts.path}.keep-${process.pid}`;
            linkSync(opts.path, parked);
          }
        } catch {}
        server.close(() => {
          if (parked) {
            try {
              renameSync(parked, opts.path);
            } catch {}
          }
          resolve();
        });
      }),
  };
}

function handle(sock: Socket, opts: ServeOptions) {
  const decoder = new LineDecoder();
  let hello: Hello | undefined;
  /** An un-helloed status was asked: the connection closes once it is answered. */
  let answered = false;
  /** Set for a one-request connection once its request was read. */
  let served = false;
  const send = (frame: Unframed & { id?: string }) => {
    if (sock.destroyed) return;
    const out = { ...frame, v: 1 as const, id: frame.id ?? "0" } as DaemonFrame;
    sock.write(`${JSON.stringify(out)}\n`);
  };
  const push = (f: DaemonFrame): boolean => {
    if (sock.destroyed || !sock.writable) return false;
    sock.write(`${JSON.stringify(f)}\n`);
    return true;
  };
  const fail = (id: string, message: string) => {
    send({ type: "error", id, code: "internal", message });
    sock.destroy();
  };

  /** Frames read while an asynchronous hello is pending, handled once it settles. */
  let backlog: unknown[] | undefined;
  sock.on("data", (chunk) => {
    if (answered) return;
    let frames: unknown[];
    try {
      frames = decoder.push(chunk);
    } catch (e) {
      const code = e instanceof FrameTooLarge ? "frame_too_large" : "bad_frame";
      send({ type: "error", id: "0", code, message: String(e) });
      sock.destroy();
      return;
    }
    if (backlog) backlog.push(...frames);
    else handleFrames(frames);
  });
  const handleFrames = (frames: unknown[]) => {
    for (let i = 0; i < frames.length; i += 1) {
      const raw = frames[i];
      const status = opts.onStatus && StatusRequest.safeParse(raw);
      if (status?.success && opts.onStatus) {
        const { id } = status.data;
        const helloed = Boolean(hello);
        // Without a hello a connection is one status question: nothing else is read.
        if (!helloed) {
          answered = true;
          sock.pause();
        }
        Promise.resolve()
          .then(() => opts.onStatus?.(status.data))
          .then(
            (r) => {
              if (r) send({ type: "status", id, ...r });
              if (!helloed) sock.end();
            },
            (e: unknown) =>
              fail(id, e instanceof Error ? e.message : String(e)),
          );
        if (!helloed) return;
        continue;
      }
      const parsed = AdapterFrame.safeParse(raw);
      if (!parsed.success) {
        const r = raw as { id?: unknown; type?: unknown; body?: unknown };
        const id = typeof r?.id === "string" && r.id ? r.id.slice(0, 64) : "0";
        if (hello && id !== "0") {
          // Framing is intact, so after hello a bad request costs only itself.
          const tooLarge =
            r.type === "send" &&
            typeof r.body === "string" &&
            Buffer.byteLength(r.body, "utf8") > MAX_BODY_BYTES;
          send({
            type: "error",
            id,
            code: tooLarge ? "too_large" : "bad_frame",
            message: tooLarge
              ? "body too large"
              : (parsed.error.issues[0]?.message ?? "bad frame"),
          });
          continue;
        }
        send({
          type: "error",
          id,
          code: "bad_frame",
          message: parsed.error.issues[0]?.message ?? "bad frame",
        });
        sock.destroy();
        return;
      }
      const frame = parsed.data;
      if (!hello) {
        if (frame.type !== "hello") {
          send({
            type: "error",
            id: frame.id,
            code: "unauthorized",
            message: "hello first",
          });
          sock.destroy();
          return;
        }
        let result: ReturnType<ServeOptions["onHello"]>;
        try {
          result = opts.onHello(frame, () => sock.destroyed);
        } catch (e) {
          fail(frame.id, e instanceof Error ? e.message : String(e));
          return;
        }
        if (result instanceof Promise) {
          backlog = frames.slice(i + 1);
          result.then(
            (r) => {
              const rest = backlog ?? [];
              backlog = undefined;
              if (sock.destroyed) return;
              if (welcomed(frame, r)) handleFrames(rest);
            },
            (e: unknown) =>
              fail(frame.id, e instanceof Error ? e.message : String(e)),
          );
          return;
        }
        if (!welcomed(frame, result)) return;
        continue;
      }
      if (frame.type === "hello") {
        send({
          type: "error",
          id: frame.id,
          code: "bad_frame",
          message: "already helloed",
        });
        sock.destroy();
        return;
      }
      const one = opts.oneRequest?.(hello) ?? false;
      if (one && served) {
        send({
          type: "error",
          id: frame.id,
          code: "unauthorized",
          message: "this connection already served its one request",
        });
        sock.destroy();
        return;
      }
      served = true;
      // The answer (its id) ends a one-request connection.
      const reply = one
        ? (f: DaemonFrame): boolean => {
            const ok = push(f);
            if (f.id === frame.id) sock.end();
            return ok;
          }
        : push;
      try {
        const replyNow = opts.onFrame(frame, hello, reply);
        if (replyNow) {
          send({ ...replyNow, id: frame.id });
          if (one) sock.end();
        }
      } catch (e) {
        fail(frame.id, e instanceof Error ? e.message : String(e));
        return;
      }
    }
  };
  /** Answers a settled hello: true once welcomed, false (and closed) when refused. */
  const welcomed = (
    frame: Hello,
    result: HelloResult | { error: string },
  ): boolean => {
    if ("error" in result) {
      send({
        type: "error",
        id: frame.id,
        code: "unauthorized",
        message: result.error,
      });
      sock.destroy();
      return false;
    }
    hello = frame;
    send({
      type: "welcome",
      id: frame.id,
      agent_ref: frame.agent_ref,
      ...result,
    });
    try {
      opts.onOpen?.(frame, push);
    } catch (e) {
      fail(frame.id, e instanceof Error ? e.message : String(e));
      return false;
    }
    return true;
  };
  sock.on("close", () => opts.onClose?.(hello));
  sock.on("error", () => {});
}
