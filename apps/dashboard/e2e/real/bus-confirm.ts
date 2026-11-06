/// <reference types="node" />
// Helpers for the bus confirm pages' real-browser e2e (#1426): a machine
// approved through the device flow in the page, a daemon socket with one open
// agent, and the proposals an agent or `oa-bus link` would make.
import type { Page } from "@playwright/test";
import { APP, createToken, expect } from "./fixtures";
import { mcpWithToken } from "./mcp-client";

/** A fresh interactive-looking session (dev only, auth.ts ?fresh=1) that lands on `next`. */
export const freshSignInUrl = (email: string, next: string) =>
  `${APP}/auth/dev-login?${new URLSearchParams({ email, role: "member", fresh: "1", next })}`;

/** Approves a new machine in the browser (the real device flow); returns its token. */
export async function approveMachine(page: Page): Promise<string> {
  const res = await fetch(`${APP}/bus/device`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ machine_label: "E2E laptop" }),
  });
  const dev = (await res.json()) as {
    device_code: string;
    user_code: string;
  };
  expect(res.status, JSON.stringify(dev)).toBe(201);
  await page.goto(`${APP}/bus/approve`);
  await page.locator("#code").fill(dev.user_code);
  await page.getByRole("button", { name: /continue|next|check/i }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  // The device-code poll is rate limited to one per interval.
  for (let i = 0; i < 12; i++) {
    const t = await fetch(`${APP}/bus/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: dev.device_code }),
    });
    const j = (await t.json()) as { status?: string; machine_token?: string };
    if (j.machine_token) return j.machine_token;
    await new Promise((r) => setTimeout(r, 5500));
  }
  throw new Error("the machine token never arrived");
}

type Frame = Record<string, unknown>;

/** A daemon socket that says hello and opens one agent in `namespace`; returns its bus name. */
export async function openAgent(
  token: string,
  namespace: string,
): Promise<{ name: string; close: () => void }> {
  const ws = new (
    WebSocket as unknown as new (
      url: string,
      init: { headers: Record<string, string> },
    ) => WebSocket
  )(`${APP.replace("http", "ws")}/bus/connect`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const frames: Frame[] = [];
  const waiters: ((f: Frame) => void)[] = [];
  ws.addEventListener("message", (ev) => {
    const text = String(ev.data);
    if (!text.startsWith("{")) return;
    const f = JSON.parse(text) as Frame;
    const w = waiters.shift();
    if (w) w(f);
    else frames.push(f);
  });
  const next = (type: string) =>
    new Promise<Frame>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no ${type} frame`)), 15_000);
      const take = (f: Frame) => {
        if (f.type === type) {
          clearTimeout(t);
          resolve(f);
        } else waiters.push(take);
      };
      const q = frames.findIndex((f) => f.type === type);
      if (q >= 0) {
        clearTimeout(t);
        resolve(frames.splice(q, 1)[0] as Frame);
      } else waiters.push(take);
    });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("socket error")));
  });
  ws.send(
    JSON.stringify({
      v: 1,
      id: "h",
      type: "hello",
      machine_label: "E2E laptop",
      client_version: "0.0.0",
      caps: ["roles", "rename"],
    }),
  );
  await next("hello_ok");
  ws.send(
    JSON.stringify({
      v: 1,
      id: "u1",
      type: "agent_up",
      agent_ref: "r1",
      kind: "opencode",
      proposed_name: "e2e-agent",
      namespace,
      global: false,
    }),
  );
  const ok = await next("agent_ok");
  return { name: String(ok.bus_name), close: () => ws.close() };
}

/** `bus_role_propose` over MCP as the signed-in member's PAT; returns the confirm URL. */
export async function proposeRole(
  page: Page,
  namespace: string,
  agent: string,
  name: string,
): Promise<string> {
  const a = await mcpWithToken(await createToken(page, "bus-agent"));
  try {
    const r = await a.call("bus_role_propose", {
      action: "set",
      namespace,
      name,
      agent,
    });
    expect(r.ok, r.text).toBe(true);
    return String(r.data?.confirmUrl);
  } finally {
    await a.close();
  }
}

/** What `oa-bus link` posts with the machine token; returns the confirm URL. */
export async function proposeLink(
  machineToken: string,
  a: string,
  b: string,
): Promise<string> {
  const res = await fetch(`${APP}/api/v1/bus/links/proposals`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${machineToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ action: "link", a, b }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return (JSON.parse(text) as { confirmUrl: string }).confirmUrl;
}
