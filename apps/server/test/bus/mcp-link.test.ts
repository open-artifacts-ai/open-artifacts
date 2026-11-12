// #1822: the /mcp auth step's proof lookup (services/bus.ts linkRequest). The
// lookup asks only the hub of the member who owns the request's credential,
// so another member's proof never resolves; every miss, malformed value, slow
// or failing hub leaves the request unlinked with the same response; the
// proof header never reaches the handler. Hubs are real, wrapped to record
// which one is asked.
import {
  BUS_CAPS,
  type ClientFrame,
  LINK_PROOF_HEADER,
} from "@oa/bus-protocol";
import { describe, expect, it, vi } from "vitest";
import { createPat } from "../../src/auth/pat.js";
import {
  type BusHubRpc,
  linkRequest,
  PROOF_LOOKUP_MS,
} from "../../src/services/bus.js";
import { sha256Hex } from "../../src/util/crypto.js";
import { E, MCP_URL } from "../mcp-helpers.js";
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

let seq = 0;
const proofOf = () =>
  `${"p".repeat(11)}${crypto.randomUUID().replaceAll("-", "")}`;

/** A member with a connected machine, one registered agent, and its proof bound. */
async function bound(proof: string) {
  const m = await member();
  const mach = await machine("Laptop", m.userId);
  const d = await daemon(mach.token);
  d.send({ ...hello(`h${++seq}`), caps: [BUS_CAPS.link] } as ClientFrame);
  await waitFor(d, "hello_ok");
  d.send(up(`u${++seq}`, `ref${seq}`, `Lead${seq}`, ns("mcp-link")));
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

/** BUS_HUB that records every hub name asked, optionally replacing the stub's reply. */
function spyHubs(over?: Partial<BusHubRpc>) {
  const real = e.BUS_HUB as unknown as DurableObjectNamespace;
  const asked: string[] = [];
  const BUS_HUB = {
    idFromName: (n: string) => {
      asked.push(n);
      return real.idFromName(n);
    },
    get: (id: DurableObjectId) => {
      const stub = real.get(id) as unknown as BusHubRpc;
      return over ? { ...over } : stub;
    },
  };
  return { asked, ev: E({ BUS_HUB }) as never };
}

const mcpReq = (pat: string, headers: Record<string, string> = {}) =>
  new Request(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${pat}`,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

describe("linkRequest (#1822)", () => {
  it("resolves a proof in the credential owner's own hub, and strips the header", async () => {
    const proof = proofOf();
    const a = await bound(proof);
    const { asked, ev } = spyHubs();
    const r = await linkRequest(
      ev,
      a.userId,
      mcpReq("x", { [LINK_PROOF_HEADER]: proof }),
    );
    expect(r.identity?.name).toMatch(/^Lead/);
    expect(r.req.headers.has(LINK_PROOF_HEADER)).toBe(false);
    // The lookup follows a D1 read and is not cancelled by the bound, so the ask
    // can land after linkRequest returned: wait for it.
    await vi.waitFor(() => expect(asked).toEqual([`bus:${a.userId}`]), {
      timeout: 5000,
    });
  });

  it("a proof of person A sent with person B's credential is unlinked, and only B's hub is asked", async () => {
    const proof = proofOf();
    const a = await bound(proof);
    const b = await bound(proofOf());
    const { asked, ev } = spyHubs();
    const r = await linkRequest(
      ev,
      b.userId,
      mcpReq("x", { [LINK_PROOF_HEADER]: proof }),
    );
    expect(r.identity).toBeUndefined();
    expect(r.req.headers.has(LINK_PROOF_HEADER)).toBe(false);
    // The lookup follows a D1 read and is not cancelled by the bound, so the ask
    // can land after linkRequest returned: wait for it.
    await vi.waitFor(() => expect(asked).toEqual([`bus:${b.userId}`]), {
      timeout: 5000,
    });
    expect(asked).not.toContain(`bus:${a.userId}`);
  });

  it("malformed and unknown proofs give the same result as no link", async () => {
    const a = await bound(proofOf());
    const { asked, ev } = spyHubs();
    for (const v of ["", "short", `${proofOf()}!`, proofOf()]) {
      const r = await linkRequest(
        ev,
        a.userId,
        mcpReq("x", { [LINK_PROOF_HEADER]: v }),
      );
      expect(Object.keys(r)).toEqual(["req"]);
      expect(r.req.headers.has(LINK_PROOF_HEADER)).toBe(false);
    }
    // Only the well-formed unknown one reached the hub.
    // The lookup follows a D1 read and is not cancelled by the bound, so the ask
    // can land after linkRequest returned: wait for it.
    await vi.waitFor(() => expect(asked).toEqual([`bus:${a.userId}`]), {
      timeout: 5000,
    });
  });

  it("a hub that fails or is slow leaves the request unlinked", async () => {
    const proof = proofOf();
    const a = await bound(proof);
    const req = () => mcpReq("x", { [LINK_PROOF_HEADER]: proof });
    const failing = spyHubs({
      agentByProof: () => Promise.reject(new Error("boom")),
    });
    const f = await linkRequest(failing.ev, a.userId, req());
    expect(Object.keys(f)).toEqual(["req"]);
    const slow = spyHubs({ agentByProof: () => new Promise(() => {}) });
    const t0 = Date.now();
    const s = await linkRequest(slow.ev, a.userId, req());
    expect(Object.keys(s)).toEqual(["req"]);
    expect(Date.now() - t0).toBeLessThan(PROOF_LOOKUP_MS + 1500);
  });

  it("a slow machine read (D1) is bound by the same limit and leaves the request unlinked", async () => {
    const proof = proofOf();
    const a = await bound(proof);
    const { asked, ev } = spyHubs();
    const hang = new Promise(() => {});
    const DB = { prepare: () => ({ bind: () => ({ first: () => hang }) }) };
    const t0 = Date.now();
    const r = await linkRequest(
      { ...(ev as object), DB } as never,
      a.userId,
      mcpReq("x", { [LINK_PROOF_HEADER]: proof }),
    );
    expect(Object.keys(r)).toEqual(["req"]);
    expect(r.req.headers.has(LINK_PROOF_HEADER)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(PROOF_LOOKUP_MS + 1500);
    expect(asked).toEqual([]);
  });

  it("#2110: an unresolved lookup logs its reason and elapsed ms, never the proof", async () => {
    const proof = proofOf();
    const a = await bound(proof);
    const hash = await sha256Hex(proof);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const req = () => mcpReq("x", { [LINK_PROOF_HEADER]: proof });
      await linkRequest(
        spyHubs({ agentByProof: () => new Promise(() => {}) }).ev,
        a.userId,
        req(),
      );
      await linkRequest(
        spyHubs({ agentByProof: async () => null }).ev,
        a.userId,
        req(),
      );
      const lines = log.mock.calls.map((c) => String(c[0]));
      const none = lines.filter((l) => l.includes("bus_link_lookup_none"));
      expect(none.map((l) => JSON.parse(l).reason)).toEqual([
        "timeout",
        "miss",
      ]);
      for (const l of none) {
        expect(typeof JSON.parse(l).ms).toBe("number");
        expect(l).not.toContain(proof);
        expect(l).not.toContain(hash);
      }
    } finally {
      log.mockRestore();
    }
  });

  it("#2110: a lookup that never answers waits PROOF_LOOKUP_MS (1.5 s) and logs reason timeout", async () => {
    expect(PROOF_LOOKUP_MS).toBe(1500);
    const proof = proofOf();
    const a = await bound(proof);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const t0 = Date.now();
      const r = await linkRequest(
        spyHubs({ agentByProof: () => new Promise(() => {}) }).ev,
        a.userId,
        mcpReq("x", { [LINK_PROOF_HEADER]: proof }),
      );
      expect(Object.keys(r)).toEqual(["req"]);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(PROOF_LOOKUP_MS - 5);
      const none = log.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("bus_link_lookup_none"))
        .map((l) => JSON.parse(l));
      expect(none).toHaveLength(1);
      expect(none[0].reason).toBe("timeout");
      expect(none[0].ms).toBeGreaterThanOrEqual(PROOF_LOOKUP_MS - 5);
    } finally {
      log.mockRestore();
    }
  });

  it("#2110: a slow success links and logs bus_link_lookup_ok {ms}; a fast one under 150 ms logs nothing", async () => {
    const proof = proofOf();
    const a = await bound(proof);
    const hash = await sha256Hex(proof);
    const who = {
      identityId: "f".repeat(32),
      namespace: "n",
      name: "Lead",
      kind: "claude-code",
    } as never;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const ok = () =>
      log.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("bus_link_lookup_ok"));
    try {
      const slow = await linkRequest(
        spyHubs({
          agentByProof: () =>
            new Promise((res) => setTimeout(() => res(who), 400)),
        }).ev,
        a.userId,
        mcpReq("x", { [LINK_PROOF_HEADER]: proof }),
      );
      expect(slow.identity).toEqual(who);
      expect(ok()).toHaveLength(1);
      const line = ok()[0] as string;
      expect(Object.keys(JSON.parse(line)).sort()).toEqual(
        expect.arrayContaining(["ms"]),
      );
      expect(JSON.parse(line).ms).toBeGreaterThanOrEqual(400);
      expect(line).not.toContain(proof);
      expect(line).not.toContain(hash);
      // Fast answers: any ok line they add is at least 150 ms (a loaded
      // runner can be that slow), never a line for every request.
      for (let i = 0; i < 3; i++)
        await linkRequest(
          spyHubs({ agentByProof: async () => who }).ev,
          a.userId,
          mcpReq("x", { [LINK_PROOF_HEADER]: proof }),
        );
      for (const l of ok())
        expect(JSON.parse(l).ms).toBeGreaterThanOrEqual(150);
    } finally {
      log.mockRestore();
    }
  });

  it("with the bus off the header is stripped and no hub is asked", async () => {
    const proof = proofOf();
    const a = await bound(proof);
    const r = await linkRequest(
      E({ BUS_HUB: undefined }),
      a.userId,
      mcpReq("x", { [LINK_PROOF_HEADER]: proof }),
    );
    expect(Object.keys(r)).toEqual(["req"]);
    expect(r.req.headers.has(LINK_PROOF_HEADER)).toBe(false);
  });

  it("without the header the request is returned as it came", async () => {
    const a = await bound(proofOf());
    const { asked, ev } = spyHubs();
    const req = mcpReq("x");
    const r = await linkRequest(ev, a.userId, req);
    expect(r.req).toBe(req);
    expect(asked).toEqual([]);
  });
});

describe("/mcp with a proof header (#1822)", () => {
  it("answers the same with a good proof, a foreign proof, junk, or none", async () => {
    const proof = proofOf();
    const a = await bound(proof);
    const b = await bound(proofOf());
    const patA = (await createPat(e, a.userId, "agent-a")).token;
    const patB = (await createPat(e, b.userId, "agent-b")).token;
    const call = async (pat: string, h: Record<string, string>) => {
      const r = await workerFetch(mcpReq(pat, h));
      return { status: r.status, body: await r.text() };
    };
    const none = await call(patB, {});
    expect(none.status).toBe(200);
    expect(await call(patA, { [LINK_PROOF_HEADER]: proof })).toEqual(none);
    expect(await call(patB, { [LINK_PROOF_HEADER]: proof })).toEqual(none);
    expect(await call(patB, { [LINK_PROOF_HEADER]: "junk" })).toEqual(none);
    expect(await call(patB, { [LINK_PROOF_HEADER]: proofOf() })).toEqual(none);
    // Bus off: a header changes nothing there either.
    const off = async (h: Record<string, string>) => {
      const r = await workerFetch(mcpReq(patB, h), E({ BUS_HUB: undefined }));
      return { status: r.status, body: await r.text() };
    };
    const offNone = await off({});
    expect(offNone.status).toBe(200);
    expect(await off({ [LINK_PROOF_HEADER]: proof })).toEqual(offNone);
  });
});
