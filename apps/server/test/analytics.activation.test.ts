// #2479: activation events to PostHog. Hosted only, key required, once each,
// fixed payload, best effort.
import { env } from "cloudflare:workers";
import { newId, WELCOME_TITLE } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import {
  activation,
  firstKey,
  noteInstanceFirst,
  resetAnalyticsMemo,
  sendActivation,
} from "../src/services/analytics.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { connectedMachine } from "./comment-hub.js";
import { login } from "./helpers.js";

const tag = newId().slice(0, 6).toLowerCase();
const on = (over: Partial<Env> = {}) =>
  ({
    ...env,
    HOSTED: "1",
    POSTHOG_KEY: "phc_test",
    INSTALL_ID: "inst123",
    ...over,
  }) as Env;

const fetchSpy = vi.fn();
const clear = () =>
  env.DB.prepare("delete from settings where key like 'analytics:%'").run();
const bodies = () =>
  fetchSpy.mock.calls.map((c) => JSON.parse(c[1].body as string));

beforeEach(async () => {
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
  resetAnalyticsMemo();
  await clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("activation events", () => {
  it("sends nothing when not hosted", async () => {
    await activation(on({ HOSTED: undefined }), "agent_named");
    await noteInstanceFirst(on({ HOSTED: undefined }), "agent_connected");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        "select 1 from settings where key like 'analytics:%'",
      ).first(),
    ).toBeNull();
  });

  it("sends nothing without a key", async () => {
    await activation(on({ POSTHOG_KEY: undefined }), "agent_named");
    await activation(on({ POSTHOG_KEY: "  " }), "agent_named");
    await noteInstanceFirst(on({ POSTHOG_KEY: undefined }), "agent_connected");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts one event with only the allowed fields", async () => {
    await sendActivation(on(), "agent_named", Date.UTC(2026, 10, 14));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://us.i.posthog.com/capture/");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      api_key: "phc_test",
      event: "agent_named",
      distinct_id: "inst123",
      properties: {
        instance_id: "inst123",
        plan: null,
        time: "2026-11-14T00:00:00.000Z",
      },
    });
  });

  it("honours POSTHOG_HOST", async () => {
    await sendActivation(
      on({ POSTHOG_HOST: "https://eu.i.posthog.com/" }),
      "agent_named",
    );
    expect(fetchSpy.mock.calls[0][0]).toBe("https://eu.i.posthog.com/capture/");
  });

  it("an instance first fires once, not on repeats", async () => {
    await noteInstanceFirst(on(), "agent_connected");
    await noteInstanceFirst(on(), "agent_connected");
    resetAnalyticsMemo();
    await noteInstanceFirst(on(), "agent_connected");
    expect(bodies().map((b) => b.event)).toEqual(["agent_connected"]);
    expect(
      await env.DB.prepare("select 1 as x from settings where key = ?1")
        .bind(firstKey("agent_connected"))
        .first(),
    ).not.toBeNull();
  });

  it("the first page published fires once, never for the Welcome", async () => {
    const owner = await login(`an-owner-${tag}@x.com`, "owner");
    await connectedMachine(env.DB, owner.userId);
    const u = await getUser(on(), owner.userId);
    if (!u) throw new Error("no user");
    const e = on();
    const pub = (title: string) =>
      publish(
        e,
        u,
        { title, format: "html", content: "<p>x</p>", visibility: "private" },
        null,
      );
    await pub(WELCOME_TITLE);
    expect(fetchSpy).not.toHaveBeenCalled();
    await pub("Secret plan");
    await pub("Another");
    expect(bodies().map((b) => b.event)).toEqual(["first_page_published"]);
    expect(JSON.stringify(bodies())).not.toContain("Secret plan");
  });

  it("a throwing or failing send never throws", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("boom https://x.test/?k=secret"));
    await expect(activation(on(), "agent_named")).resolves.toBeUndefined();
    fetchSpy.mockResolvedValueOnce(new Response("no", { status: 500 }));
    await expect(sendActivation(on(), "agent_named")).resolves.toBeUndefined();
    fetchSpy.mockRejectedValueOnce(new Error("boom"));
    await expect(
      noteInstanceFirst(on(), "first_page_published"),
    ).resolves.toBeUndefined();
  });

  it("with a ctx the send runs after the response", async () => {
    const held: Promise<unknown>[] = [];
    await activation(on(), "agent_named", {
      waitUntil: (p) => void held.push(p),
    });
    expect(held).toHaveLength(1);
    await Promise.all(held);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
