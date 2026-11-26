import { env } from "cloudflare:workers";
import { type Member, newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { moveUserEmail } from "../src/services/email-move.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

// #2590: a moved address takes the larger of the two shares, can_comment included.

const E = env as unknown as Env;
const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
let owner: { cookie: string; member: Member };
beforeAll(async () => {
  const l = await login(`em-owner-${tag}@x.com`, "member");
  const member = (await getUser(E, l.userId)) as Member;
  owner = { cookie: l.cookie, member };
});

const page = async () =>
  (
    await publish(
      E,
      owner.member,
      { title: "d", format: "html", content: "<p>x</p>" } as never,
      null,
      undefined,
      "create",
    )
  ).id;
const put = (id: string, email: string, role: string) =>
  api(app, R.shares(id), owner.cookie, {
    method: "PUT",
    body: { email, role },
  });
const stored = (id: string, email: string) =>
  E.DB.prepare(
    "select role, can_comment as c from shares where artifact_id = ? and email = ?",
  )
    .bind(id, email)
    .first<{ role: string; c: number }>();

describe("moving an address keeps the larger share", () => {
  it("a commenter share raises a viewer share already at the new address", async () => {
    const id = await page();
    const from = `em-from-${tag}@x.com`;
    const to = `em-to-${tag}@x.com`;
    const u = await login(from, "member");
    // A member's share at the old address: commenter reads as viewer-level.
    await put(id, from, "commenter");
    await put(id, to, "viewer");
    expect(await stored(id, to)).toEqual({ role: "viewer", c: 0 });
    expect(await moveUserEmail(E, u.userId, from, to)).not.toBeNull();
    expect(await stored(id, to)).toEqual({ role: "viewer", c: 1 });
    expect(await stored(id, from)).toBeNull();
  });

  it.each(["source", "destination"])(
    "preserves a migrated member grant at the %s address",
    async (side) => {
      const id = await page();
      const from = `legacy-${side}-${tag}@x.com`;
      const to = `moved-${side}-${tag}@x.com`;
      const user = await login(from, "member");
      const legacy = side === "source" ? from : to;
      await put(id, from, "viewer");
      await put(id, to, "viewer");
      await E.DB.prepare(
        "INSERT INTO legacy_viewer_comments (artifact_id,email,can_comment) VALUES (?,?,1)",
      )
        .bind(id, legacy)
        .run();
      expect(await moveUserEmail(E, user.userId, from, to)).not.toBeNull();
      expect(await stored(id, to)).toEqual({ role: "viewer", c: 1 });
      expect(await stored(id, from)).toBeNull();
    },
  );

  it("an editor share still wins, and keeps the comment bit", async () => {
    const id = await page();
    const from = `em-from2-${tag}@x.com`;
    const to = `em-to2-${tag}@x.com`;
    const u = await login(from, "member");
    await put(id, from, "editor");
    await put(id, to, "commenter");
    expect(await moveUserEmail(E, u.userId, from, to)).not.toBeNull();
    expect(await stored(id, to)).toEqual({ role: "editor", c: 1 });
  });

  it("a commenter share never lowers an existing editor share", async () => {
    const id = await page();
    const from = `em-from3-${tag}@x.com`;
    const to = `em-to3-${tag}@x.com`;
    const u = await login(from, "member");
    await put(id, from, "commenter");
    // An unknown address is clamped when shared through the API: an older editor row.
    await E.DB.prepare(
      "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, 'editor', ?, ?)",
    )
      .bind(id, to, owner.member.id, Date.now())
      .run();
    expect(await moveUserEmail(E, u.userId, from, to)).not.toBeNull();
    expect((await stored(id, to))?.role).toBe("editor");
  });
});
