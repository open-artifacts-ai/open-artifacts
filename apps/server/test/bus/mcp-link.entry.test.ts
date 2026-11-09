// #1822: the two /mcp entry points (a PAT in index.ts, an OAuth grant in
// oauth.ts) each hand linkRequest the credential OWNER's id and pass the
// handler the cleaned request. Driven through the Worker with a real PAT and a
// real OAuth grant. The hub asked is recorded; the request the MCP handler
// receives is recorded by wrapping mcpHandler (the real handler still runs).
import {
  BUS_CAPS,
  type ClientFrame,
  LINK_PROOF_ARG,
  LINK_PROOF_HEADER,
} from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPat } from "../../src/auth/pat.js";
import * as mcpServer from "../../src/mcp/server.js";
import { type BusHubRpc, LINK_LOOKUP_MS } from "../../src/services/bus.js";
import { sha256Hex } from "../../src/util/crypto.js";
import { callWorker, E, MCP_URL, oauthToken } from "../mcp-helpers.js";
import {
  daemon,
  e,
  hello,
  machine,
  member,
  ns,
  up,
  waitFor,
  workerFetch,
} from "./helpers.js";

const seen: (string | null)[] = [];

/** Records the proof header of every request the real MCP handler receives. */
function watchHandler() {
  seen.length = 0;
  const orig = mcpServer.mcpHandler;
  return vi.spyOn(mcpServer, "mcpHandler").mockImplementation((...a) => {
    const real = orig(...a) as unknown as {
      (req: Request, ...r: unknown[]): unknown;
      fetch?: (req: Request, ...r: unknown[]) => unknown;
    };
    return new Proxy(real, {
      apply: (t, self, args: unknown[]) => {
        seen.push((args[0] as Request).headers.get(LINK_PROOF_HEADER));
        return Reflect.apply(t, self, args);
      },
      get: (t, k, r) =>
        k === "fetch" && typeof t.fetch === "function"
          ? (req: Request, ...rest: unknown[]) => {
              seen.push(req.headers.get(LINK_PROOF_HEADER));
              return t.fetch?.(req, ...rest);
            }
          : Reflect.get(t, k, r),
    }) as never;
  });
}

let seq = 0;
const proofOf = () =>
  `${"p".repeat(11)}${crypto.randomUUID().replaceAll("-", "")}`;

/** A member with a connected machine and one agent whose proof is bound. */
async function bound(proof: string) {
  const m = await member();
  const mach = await machine("Laptop", m.userId);
  const d = await daemon(mach.token);
  d.send({ ...hello(`h${++seq}`), caps: [BUS_CAPS.link] } as ClientFrame);
  await waitFor(d, "hello_ok");
  d.send(up(`u${++seq}`, `ref${seq}`, `Lead${seq}`, ns("entry")));
  await waitFor(d, "agent_ok");
  d.send({
    v: 1,
    id: `b${++seq}`,
    type: "link_bind",
    agent_ref: `ref${seq - 1}`,
    hash: await sha256Hex(proof),
  } as never);
  await waitFor(d, "link_bound");
  return m;
}

function spyHubs() {
  const real = e.BUS_HUB as unknown as DurableObjectNamespace;
  const asked: string[] = [];
  const BUS_HUB = {
    idFromName: (n: string) => {
      asked.push(n);
      return real.idFromName(n);
    },
    get: (id: DurableObjectId) => real.get(id),
  };
  return { asked, ev: E({ BUS_HUB }) };
}

const mcpReq = (token: string, proof: string) =>
  new Request(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      [LINK_PROOF_HEADER]: proof,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

afterEach(() => vi.restoreAllMocks());

describe("/mcp entry points ask the credential owner's hub (#1822)", () => {
  it("a PAT: the owner's hub is asked (not the token id), and the handler sees no proof header", async () => {
    const proof = proofOf();
    const a = await bound(proof);
    const pat = await createPat(e, a.userId, "agent-a");
    const { asked, ev } = spyHubs();
    watchHandler();
    const r = await callWorker(mcpReq(pat.token, proof), ev);
    expect(r.status).toBe(200);
    expect(asked).toEqual([`bus:${a.userId}`]);
    expect(seen).toEqual([null]);
  });

  it("an OAuth grant: the owner's hub is asked, and the handler sees no proof header", async () => {
    const proof = proofOf();
    const a = await bound(proof);
    const row = await e.DB.prepare("select email from users where id = ?")
      .bind(a.userId)
      .first<{ email: string }>();
    const { accessToken } = await oauthToken(row?.email ?? "", "Agent", {
      cookie: a.cookie,
      userId: a.userId,
    });
    const { asked, ev } = spyHubs();
    watchHandler();
    const r = await callWorker(mcpReq(accessToken, proof), ev);
    expect(r.status).toBe(200);
    expect(asked).toEqual([`bus:${a.userId}`]);
    expect(seen).toEqual([null]);
  });
});

// #1856: the same lookup by the reserved tool argument, for harnesses that
// cannot set a per-session header. Only tools/call is read; the key is always
// removed before the handler (and so before schema validation, audit rows and
// error text) sees the body.
const bodies: Request[] = [];

/** Records a clone of every request the real MCP handler receives. */
function watchBodies() {
  vi.restoreAllMocks();
  bodies.length = 0;
  const orig = mcpServer.mcpHandler;
  return vi.spyOn(mcpServer, "mcpHandler").mockImplementation((...a) => {
    const real = orig(...a) as unknown as {
      (req: Request, ...r: unknown[]): unknown;
      fetch?: (req: Request, ...r: unknown[]) => unknown;
    };
    return new Proxy(real, {
      apply: (t, self, args: unknown[]) => {
        bodies.push((args[0] as Request).clone());
        return Reflect.apply(t, self, args);
      },
      get: (t, k, r) =>
        k === "fetch" && typeof t.fetch === "function"
          ? (req: Request, ...rest: unknown[]) => {
              bodies.push(req.clone());
              return t.fetch?.(req, ...rest);
            }
          : Reflect.get(t, k, r),
    }) as never;
  });
}

const call = (name: string, args: Record<string, unknown>, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

const post = (
  token: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Request(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** The agent a hub lookup resolved: a spy on agentByProof's result. */
function spyResolve() {
  const real = e.BUS_HUB as unknown as DurableObjectNamespace;
  const asked: string[] = [];
  const resolved: unknown[] = [];
  const BUS_HUB = {
    idFromName: (n: string) => {
      asked.push(n);
      return real.idFromName(n);
    },
    get: (id: DurableObjectId) => {
      const stub = real.get(id) as unknown as BusHubRpc;
      return {
        ...stub,
        agentByProof: async (h: string) => {
          const r = await stub.agentByProof(h);
          resolved.push(r);
          return r;
        },
      };
    },
  };
  return { asked, resolved, ev: E({ BUS_HUB }) };
}

describe("/mcp proof by tool argument (#1856)", () => {
  it("a PAT: the owner's hub resolves it and the handler never sees the key", async () => {
    const proof = proofOf();
    const a = await bound(proof);
    const pat = await createPat(e, a.userId, "agent-a");
    const { asked, resolved, ev } = spyResolve();
    watchBodies();
    const r = await callWorker(
      post(pat.token, call("list_artifacts", { [LINK_PROOF_ARG]: proof })),
      ev,
    );
    expect(r.status).toBe(200);
    expect(asked).toEqual([`bus:${a.userId}`]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ name: expect.stringMatching(/^Lead/) });
    expect(bodies).toHaveLength(1);
    const text = await bodies[0]?.text();
    expect(text).not.toContain(LINK_PROOF_ARG);
    expect(text).not.toContain(proof);
    expect(JSON.parse(text ?? "").params.arguments).toEqual({});
  });

  it("an OAuth grant: same, and a foreign person's credential asks only its own hub", async () => {
    const proof = proofOf();
    const a = await bound(proof);
    const b = await bound(proofOf());
    const row = await e.DB.prepare("select email from users where id = ?")
      .bind(b.userId)
      .first<{ email: string }>();
    const { accessToken } = await oauthToken(row?.email ?? "", "Agent", {
      cookie: b.cookie,
      userId: b.userId,
    });
    const { asked, resolved, ev } = spyResolve();
    watchBodies();
    const r = await callWorker(
      post(accessToken, call("list_artifacts", { [LINK_PROOF_ARG]: proof })),
      ev,
    );
    expect(r.status).toBe(200);
    expect(asked).toEqual([`bus:${b.userId}`]);
    expect(asked).not.toContain(`bus:${a.userId}`);
    expect(resolved).toEqual([null]);
    expect(await bodies[0]?.text()).not.toContain(proof);
  });

  it("other tool arguments stay as sent; only the key goes", async () => {
    const proof = proofOf();
    const a = await bound(proof);
    const pat = await createPat(e, a.userId, "agent-a");
    const { ev } = spyResolve();
    watchBodies();
    await callWorker(
      post(
        pat.token,
        call("list_artifacts", { limit: 3, [LINK_PROOF_ARG]: proof }),
      ),
      ev,
    );
    expect(
      JSON.parse((await bodies[0]?.text()) ?? "").params.arguments,
    ).toEqual({
      limit: 3,
    });
  });

  it("a non tools/call method keeps the key and the exact bytes; no lookup", async () => {
    const proof = proofOf();
    const a = await bound(proof);
    const pat = await createPat(e, a.userId, "agent-a");
    const { asked, ev } = spyResolve();
    watchBodies();
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { [LINK_PROOF_ARG]: proof },
    });
    await callWorker(post(pat.token, raw), ev);
    expect(asked).toEqual([]);
    expect(await bodies[0]?.text()).toBe(raw);
  });

  it("the header wins when both are present, and the key is still removed", async () => {
    const good = proofOf();
    const other = proofOf();
    const a = await bound(good);
    const pat = await createPat(e, a.userId, "agent-a");
    const { resolved, ev } = spyResolve();
    watchBodies();
    // Good header, junk argument: linked through the header.
    await callWorker(
      post(pat.token, call("list_artifacts", { [LINK_PROOF_ARG]: other }), {
        [LINK_PROOF_HEADER]: good,
      }),
      ev,
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).not.toBeNull();
    // Bad header, good argument: the header wins, so unlinked (no fallback).
    resolved.length = 0;
    await callWorker(
      post(pat.token, call("list_artifacts", { [LINK_PROOF_ARG]: good }), {
        [LINK_PROOF_HEADER]: other,
      }),
      ev,
    );
    expect(resolved).toEqual([null]);
    for (const b of bodies)
      expect(await b.text()).not.toContain(LINK_PROOF_ARG);
  });

  it("a batch: one shared proof links; differing, missing or bad proofs are unlinked; the key is gone from every call", async () => {
    const proof = proofOf();
    const a = await bound(proof);
    const pat = await createPat(e, a.userId, "agent-a");
    const run = async (items: unknown[]) => {
      const { resolved, ev } = spyResolve();
      watchBodies();
      await callWorker(post(pat.token, items), ev);
      const text = (await bodies[0]?.text()) ?? "";
      expect(text).not.toContain(LINK_PROOF_ARG);
      return resolved;
    };
    const same = await run([
      call("list_artifacts", { [LINK_PROOF_ARG]: proof }, 1),
      call("list_artifacts", { [LINK_PROOF_ARG]: proof }, 2),
    ]);
    expect(same).toHaveLength(1);
    expect(same[0]).not.toBeNull();
    for (const items of [
      [
        call("list_artifacts", { [LINK_PROOF_ARG]: proof }, 1),
        call("list_artifacts", { [LINK_PROOF_ARG]: proofOf() }, 2),
      ],
      [
        call("list_artifacts", { [LINK_PROOF_ARG]: proof }, 1),
        call("list_artifacts", {}, 2),
      ],
      [
        call("list_artifacts", { [LINK_PROOF_ARG]: proof }, 1),
        call("list_artifacts", { [LINK_PROOF_ARG]: 7 }, 2),
      ],
    ])
      expect(await run(items)).toEqual([]);
  });

  it("a bad shape or non-string value is unlinked, with no hub asked, and the key is gone", async () => {
    const a = await bound(proofOf());
    const pat = await createPat(e, a.userId, "agent-a");
    for (const v of ["", "short", `${proofOf()}!`, 7, null, { x: 1 }]) {
      const { asked, ev } = spyResolve();
      watchBodies();
      const r = await callWorker(
        post(pat.token, call("list_artifacts", { [LINK_PROOF_ARG]: v })),
        ev,
      );
      expect(r.status).toBe(200);
      expect(asked).toEqual([]);
      expect(await bodies[0]?.text()).not.toContain(LINK_PROOF_ARG);
    }
  });

  it("an escaped key (\\u005f) is removed too", async () => {
    const proof = proofOf();
    const a = await bound(proof);
    const pat = await createPat(e, a.userId, "agent-a");
    const { resolved, ev } = spyResolve();
    watchBodies();
    const raw = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_artifacts","arguments":{"\\u005foa_agent_proof":"${proof}"}}}`;
    await callWorker(post(pat.token, raw), ev);
    expect(resolved).toHaveLength(1);
    const text = (await bodies[0]?.text()) ?? "";
    expect(text).not.toContain(proof);
  });

  it("answers the same with a good, foreign, junk or no argument (no oracle), and the proof is not in the response, validation errors or audit rows", async () => {
    const proof = proofOf();
    const a = await bound(proof);
    const b = await bound(proofOf());
    const patA = (await createPat(e, a.userId, "agent-a")).token;
    const patB = (await createPat(e, b.userId, "agent-b")).token;
    const go = async (pat: string, args: Record<string, unknown>) => {
      const r = await workerFetch(
        post(pat, call("publish_artifact", { title: 5, ...args })),
      );
      return { status: r.status, body: await r.text() };
    };
    const none = await go(patB, {});
    expect(none.status).toBe(200);
    expect(await go(patA, { [LINK_PROOF_ARG]: proof })).toEqual(none);
    expect(await go(patB, { [LINK_PROOF_ARG]: proof })).toEqual(none);
    expect(await go(patB, { [LINK_PROOF_ARG]: "junk" })).toEqual(none);
    expect(none.body).not.toContain(proof);
    // A valid publish carrying it writes audit rows without it.
    const ok = await workerFetch(
      post(
        patA,
        call("publish_artifact", {
          title: "t",
          format: "markdown",
          content: "# x",
          [LINK_PROOF_ARG]: proof,
        }),
      ),
    );
    expect(await ok.text()).not.toContain(proof);
    const rows = await e.DB.prepare("select * from audit_events").all();
    expect(JSON.stringify(rows.results)).not.toContain(proof);
    expect(JSON.stringify(rows.results)).not.toContain(LINK_PROOF_ARG);
  });

  it("a hub that fails or hangs leaves it unlinked, with the key gone and the call answered", async () => {
    const proof = proofOf();
    const a = await bound(proof);
    const pat = await createPat(e, a.userId, "agent-a");
    for (const agentByProof of [
      () => Promise.reject(new Error("boom")),
      () => new Promise<never>(() => {}),
    ]) {
      const { ev } = spyHubs({ agentByProof } as never);
      watchBodies();
      const t0 = Date.now();
      const r = await callWorker(
        post(pat.token, call("list_artifacts", { [LINK_PROOF_ARG]: proof })),
        ev as never,
      );
      expect(r.status).toBe(200);
      expect(Date.now() - t0).toBeLessThan(LINK_LOOKUP_MS + 3000);
      expect(await bodies[0]?.text()).not.toContain(proof);
    }
  });

  it("a malformed or oversize body behaves as before: no throw from the link step, and the same answer", async () => {
    const a = await bound(proofOf());
    const pat = await createPat(e, a.userId, "agent-a");
    const junk = await workerFetch(
      post(pat.token, `{"method":"tools/call",${LINK_PROOF_ARG}`),
    );
    expect(junk.status).toBe(400);
    const big = JSON.stringify(
      call("list_artifacts", {
        [LINK_PROOF_ARG]: "x",
        pad: "y".repeat(5_000_000),
      }),
    );
    const r = await workerFetch(post(pat.token, big));
    expect(r.status).toBe(413);
  });
});
