import { env } from "cloudflare:workers";
import { newId } from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPat } from "../src/auth/pat.js";
import * as serverModule from "../src/mcp/server.js";
import * as busModule from "../src/services/bus.js";
import { login } from "./helpers.js";
import { callWorker, MCP_URL, oauthToken } from "./mcp-helpers.js";

// The /mcp entry (PAT and OAuth): a throw in the bus link or the transport is
// logged and answered, never an uncaught Worker exception (1101); a link
// failure is not fatal.

/** Makes the bus link or the transport throw for one test (spies on the module exports the entry calls). */
const ctl = {
  link: (msg: string) =>
    vi.spyOn(busModule, "linkRequest").mockImplementation(() => {
      throw new Error(msg);
    }),
  transport: (msg: string) =>
    vi.spyOn(serverModule, "mcpHandler").mockImplementation(() => {
      throw new Error(msg);
    }),
};

const tag = newId().slice(0, 6).toLowerCase();
const TOKEN_TEXT = "SECRETPROOFVALUE0123456789abcdef";

const listTools = (auth: string) =>
  callWorker(
    new Request(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: auth,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );

const logs = () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return {
    events: () =>
      spy.mock.calls
        .map((c) => {
          try {
            return JSON.parse(String(c[0])) as Record<string, unknown>;
          } catch {
            return {};
          }
        })
        .filter((e) => typeof e.evt === "string"),
    text: () => JSON.stringify(spy.mock.calls),
  };
};

afterEach(() => vi.restoreAllMocks());

const entries: [string, () => Promise<string>][] = [
  [
    "PAT",
    async () => {
      const u = await login(
        `ee-pat-${tag}-${newId().slice(0, 4).toLowerCase()}@x.com`,
      );
      return `Bearer ${(await createPat(env, u.userId, "ee")).token}`;
    },
  ],
  [
    "OAuth",
    async () =>
      `Bearer ${(await oauthToken(`ee-oauth-${tag}-${newId().slice(0, 4).toLowerCase()}@x.com`)).accessToken}`,
  ],
];

for (const [name, auth] of entries)
  describe(`/mcp entry errors: ${name}`, () => {
    it("a normal request is unchanged", async () => {
      const a = await auth();
      const l = logs();
      const r = await listTools(a);
      expect(r.status).toBe(200);
      expect(l.events().filter((e) => e.evt === "mcp_entry_failed")).toEqual(
        [],
      );
    });

    it("a link step that throws is logged and the request is still answered", async () => {
      const a = await auth();
      const l = logs();
      ctl.link(`link boom ${TOKEN_TEXT}`);
      const r = await listTools(a);
      // Answered by the handler (it refuses the unforwarded body), never a 500 or an uncaught throw.
      expect(r.status).not.toBe(500);
      expect(l.events().some((e) => e.evt === "mcp_link_failed")).toBe(true);
      expect(l.text()).not.toContain(TOKEN_TEXT);
    });

    it("a transport that throws gives a 500 JSON body and a log, never the token", async () => {
      const a = await auth();
      const l = logs();
      ctl.transport(`transport boom ${a} ${TOKEN_TEXT}`);
      const r = await listTools(a);
      expect(r.status).toBe(500);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
        "internal",
      );
      const ev = l.events().find((e) => e.evt === "mcp_entry_failed");
      expect(ev).toMatchObject({ evt: "mcp_entry_failed", method: "POST" });
      expect(String(ev?.stack ?? "")).toContain("transport boom");
      expect(l.text()).not.toContain(a.slice(7));
      expect(l.text()).not.toContain(TOKEN_TEXT);
    });
  });
