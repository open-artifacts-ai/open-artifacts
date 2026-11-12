// Me.instance.directory.bound (#2149): a live binding exists; owners and
// admins only; absent when the mode is off.
import { env } from "cloudflare:workers";
import { type InstanceDirectory, R } from "@oa/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { K, UPSERT } from "../src/directory/store.js";
import type { Env } from "../src/env.js";
import { direct, mailer, uniq } from "./auth-helpers.js";
import { directEnv, resetDirectory } from "./directory-helpers.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();

const meDirectory = async (e: Env, cookie: string) =>
  (
    (await (
      await fetchAndWait(
        app,
        new Request(`http://app.localhost${R.me}`, {
          headers: { cookie, "x-oa-request": "1" },
        }),
        e,
      )
    ).json()) as { instance: { directory?: InstanceDirectory } }
  ).instance.directory;

const BINDING = JSON.stringify({
  provider: "google",
  customerId: "C01abc",
  domain: "a.com",
  connectedBy: "ada@a.com",
  connectedAt: "2026-10-25T15:30:00.000Z",
});
const bind = () => env.DB.prepare(UPSERT).bind(K.binding, BINDING).run();
const unbind = () =>
  env.DB.prepare("delete from directory_state where key = ?")
    .bind(K.binding)
    .run();

let e: Env;
beforeEach(async () => {
  await resetDirectory();
  e = directEnv(mailer().env);
});

describe("Me.instance.directory.bound", () => {
  it("true for an owner and an admin with a live binding", async () => {
    await bind();
    const owner = await login(uniq("bo"), "owner");
    const admin = await login(uniq("ba"), "admin");
    expect((await meDirectory(e, owner.cookie))?.bound).toBe(true);
    expect((await meDirectory(e, admin.cookie))?.bound).toBe(true);
  });

  it("false with no binding, and false again once it is removed", async () => {
    const owner = await login(uniq("bo"), "owner");
    expect((await meDirectory(e, owner.cookie))?.bound).toBe(false);
    await bind();
    expect((await meDirectory(e, owner.cookie))?.bound).toBe(true);
    await unbind();
    expect((await meDirectory(e, owner.cookie))?.bound).toBe(false);
  });

  it("absent for a member, even with a binding", async () => {
    await bind();
    const member = await login(uniq("bm"), "member");
    const d = await meDirectory(e, member.cookie);
    expect(d?.mode).toBe("google");
    expect(d).not.toHaveProperty("bound");
  });

  it("absent when the mode is off", async () => {
    await bind();
    const owner = await login(uniq("bo"), "owner");
    expect(await meDirectory(direct(mailer().env), owner.cookie)).toBe(
      undefined,
    );
  });
});
