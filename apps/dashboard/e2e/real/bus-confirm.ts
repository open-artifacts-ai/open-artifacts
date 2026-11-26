/// <reference types="node" />
// Helpers for the bus confirm pages' real-browser e2e (#1426): a machine
// approved through the device flow in the page, a daemon socket with one open
// agent, and the proposals an agent or `oa-bus link` would make.
import type { Page } from "@playwright/test";
import { APP, createToken, expect } from "./fixtures";
import { takeFrame } from "./frame-wait";
import { mcpWithToken } from "./mcp-client";
import { spendCodes } from "./spend-codes";

/** A fresh interactive-looking session (dev only, auth.ts ?fresh=1) that lands on `next`. */
export const freshSignInUrl = (email: string, next: string, role = "member") =>
  `${APP}/auth/dev-login?${new URLSearchParams({ email, role, fresh: "1", next })}`;

/** Device codes made and not yet spent: a refusal leaves one behind (an IP holds five). */
const outstanding = new Set<string>();

/**
 * Teardown for a test that approves machines: spends every code still
 * outstanding (a redeem answers whatever the code's state), each under a short
 * bound, errors ignored. Never blocks a failure: call it from afterEach.
 */
export async function spendDeviceCodes(): Promise<void> {
  const codes = [...outstanding];
  outstanding.clear();
  await spendCodes(APP, codes);
}

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
  outstanding.add(dev.device_code);
  await page.goto(`${APP}/bus/approve`);
  await page.locator("#code").fill(dev.user_code);
  await page.getByRole("button", { name: /continue|next|check/i }).click();
  const [approved] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith("/bus/approve") && r.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Approve", exact: true }).click(),
  ]);
  // The status is what counts, and it is known with the headers: neither a
  // success nor a failure waits on the body (a held body would stall it, and
  // WebKit drops a body once the page navigates). A failure names the status.
  // A failure throws at once, with nothing awaited first: the code it leaves
  // behind is spent by spendDeviceCodes in the test's teardown.
  if (approved.status() >= 300)
    throw new Error(
      `POST /bus/approve: ${approved.status()} ${approved.statusText()}`,
    );
  // Approval is committed once POST /bus/approve answers, and this is the
  // first token request for the code (so inside its rate limit): it returns
  // the token. No polling.
  const t = await fetch(`${APP}/bus/device/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code: dev.device_code }),
  });
  const j = (await t.json()) as { status?: string; machine_token?: string };
  expect(j.machine_token, JSON.stringify(j)).toBeTruthy();
  outstanding.delete(dev.device_code);
  return String(j.machine_token);
}

type Frame = Record<string, unknown>;

/** A daemon socket that says hello and opens one agent in `namespace`; returns its bus name. */
export async function openAgent(
  token: string,
  namespace: string,
): Promise<{ name: string; ref: string; close: () => void }> {
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
    takeFrame(frames, waiters, (f) => f.type === type, `a ${type} frame`);
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
  return { name: String(ok.bus_name), ref: "r1", close: () => ws.close() };
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
