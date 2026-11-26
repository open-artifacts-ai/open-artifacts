/// <reference types="node" />
// Helpers for the bus confirm pages' real-browser e2e (#1426): a machine
// approved through the device flow in the page, a daemon socket with one open
// agent, and the proposals an agent or `oa-bus link` would make.
import type { Page } from "@playwright/test";
import { withDeadline } from "../staging/with-deadline";
import { APP, createToken, expect } from "./fixtures";
import { mcpWithToken } from "./mcp-client";

/** A fresh interactive-looking session (dev only, auth.ts ?fresh=1) that lands on `next`. */
export const freshSignInUrl = (email: string, next: string, role = "member") =>
  `${APP}/auth/dev-login?${new URLSearchParams({ email, role, fresh: "1", next })}`;

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
  const [approved] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith("/bus/approve") && r.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Approve", exact: true }).click(),
  ]);
  // The status is what counts, and it is known with the headers: a success
  // never waits on the body. Only a failure reads it, to say why (WebKit drops
  // a body once the page has navigated away; then the status stands alone).
  if (approved.status() >= 300) {
    const body = await approved.text().catch(() => "(body unavailable)");
    throw new Error(`POST /bus/approve: ${approved.status()} ${body}`);
  }
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
    withDeadline(
      new Promise<Frame>((resolve) => {
        const take = (f: Frame) => {
          if (f.type === type) resolve(f);
          else waiters.push(take);
        };
        const q = frames.findIndex((f) => f.type === type);
        if (q >= 0) resolve(frames.splice(q, 1)[0] as Frame);
        else waiters.push(take);
      }),
      15_000,
      `a ${type} frame`,
    );
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
