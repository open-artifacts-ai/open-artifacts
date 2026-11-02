import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.gen.js";
import { APP, callWorker, E } from "./mcp-helpers.js";

// Hosted provisioning checks /healthz after a deploy: `installId` proves the
// host answered from the install it meant to, not just a Worker at the right
// version. Self-host is unchanged: the key is absent when INSTALL_ID is unset.
const get = (over: Record<string, unknown> = {}) =>
  callWorker(new Request(`${APP}/healthz`), E(over));

describe("/healthz installId", () => {
  it("omits installId when INSTALL_ID is unset", async () => {
    const r = await get({ INSTALL_ID: undefined });
    expect(r.status).toBe(200);
    expect(Object.keys((await r.json()) as object)).toEqual([
      "ok",
      "plan",
      "version",
      "oauthStore",
    ]);
  });

  it("omits installId when INSTALL_ID is empty", async () => {
    const r = await get({ INSTALL_ID: "" });
    expect(await r.json()).toEqual({
      ok: true,
      plan: "free",
      version: VERSION,
      oauthStore: { mode: "kv", backfilled: false, kvWritesOffSince: null },
    });
  });

  it("reports the trimmed installId as the last key", async () => {
    const r = await get({ INSTALL_ID: "  inst-a\n" });
    expect(await r.text()).toBe(
      `{"ok":true,"plan":"free","version":"${VERSION}","oauthStore":{"mode":"kv","backfilled":false,"kvWritesOffSince":null},"installId":"inst-a"}`,
    );
  });

  it("omits installId when INSTALL_ID is only whitespace", async () => {
    const r = await get({ INSTALL_ID: "   " });
    expect(Object.keys((await r.json()) as object)).toEqual([
      "ok",
      "plan",
      "version",
      "oauthStore",
    ]);
  });
});
