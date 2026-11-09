// #1822: the two /mcp entry points (a PAT in index.ts, an OAuth grant in
// oauth.ts) each hand linkRequest the credential OWNER's id and pass the
// handler the cleaned request. Driven through the Worker with a real PAT and a
// real OAuth grant. The hub asked is recorded; the request the MCP handler
// receives is recorded by wrapping mcpHandler (the real handler still runs).
import {
  BUS_CAPS,
  type ClientFrame,
  LINK_PROOF_HEADER,
} from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPat } from "../../src/auth/pat.js";
import * as mcpServer from "../../src/mcp/server.js";
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
