// Parity 2 red line, in-server: on an Access-only install, an Access guest
// holding an editor share can't publish or write data. Each write first
// succeeds for a member holding the same editor share on a twin artifact, so
// a server that refuses everything can't pass; the guest's attempts then
// leave D1 and the artifact's data unchanged.
import { env } from "cloudflare:workers";
import { R } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { uniq } from "./auth-helpers.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();
/** Access-only: no google, no email provider. */
const ACCESS_ONLY = { ...env, AUTH_PROVIDERS: "access" } as Env;

const send = (cookie: string, method: string, path: string, body?: unknown) =>
  fetchAndWait(
    app as never,
    new Request(`http://app.localhost${path}`, {
      method,
      headers: {
        cookie,
        "x-oa-request": "1",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    ACCESS_ONLY as never,
  );

/** A db-capable artifact shared with `email` as editor. */
async function editorShare(ownerId: string, email: string): Promise<string> {
  const o = await getUser(env, ownerId);
  const { id } = await publish(
    env,
    o as never,
    {
      title: "t",
      format: "html",
      content: "<p>x</p>",
      capabilities: { db: true, storage: true, viewer: false },
    } as never,
    null,
    undefined,
    "create",
  );
  await env.DB.prepare(
    "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, 'editor', ?, ?)",
  )
    .bind(id, email, ownerId, Date.now())
    .run();
  return id;
}

const WRITES = (id: string) =>
  [
    [
      "publish a version",
      "POST",
      R.versions(id),
      { format: "html", content: "<p>y</p>" },
    ],
    ["edit metadata", "PATCH", R.artifact(id), { title: "x" }],
    ["restore a version", "POST", R.restoreVersion(id, 1), undefined],
    ["write a data doc", "PUT", R.dataDoc(id, "c", "d"), { v: 1 }],
    ["merge a data doc", "PATCH", R.dataDoc(id, "c", "d"), { v: 2 }],
    ["delete a data doc", "DELETE", R.dataDoc(id, "c", "d"), undefined],
  ] as const;

describe("red line: an Access guest with an editor share is view-only (parity 2)", () => {
  it("the member control writes; the guest can't publish or write data, and nothing changes", async () => {
    const owner = await login(uniq("own"));
    const memberEmail = uniq("m").toLowerCase();
    const guestEmail = uniq("g", "outside.example").toLowerCase();
    const member = await login(memberEmail);
    const guest = await login(guestEmail, "guest");
    const twin = await editorShare(owner.userId, memberEmail);
    const target = await editorShare(owner.userId, guestEmail);

    for (const [what, method, path, body] of WRITES(twin)) {
      const r = await send(member.cookie, method, path, body);
      expect(r.status, `member: ${what}`).toBeLessThan(300);
    }

    // The guest can read the artifact it holds an editor share on.
    expect((await send(guest.cookie, "GET", R.artifact(target))).status).toBe(
      200,
    );
    for (const [what, method, path, body] of WRITES(target)) {
      const r = await send(guest.cookie, method, path, body);
      expect(r.status, `guest: ${what}`).toBe(404);
    }
    const create = await send(guest.cookie, "POST", R.artifacts, {
      title: "n",
      format: "markdown",
      content: "x",
    });
    expect(create.status).toBe(403);

    const a = await env.DB.prepare(
      "select title, current_version v from artifacts where id = ?",
    )
      .bind(target)
      .first<{ title: string; v: number }>();
    expect(a).toEqual({ title: "t", v: 1 });
    const versions = await env.DB.prepare(
      "select count(*) n from versions where artifact_id = ?",
    )
      .bind(target)
      .first<{ n: number }>();
    expect(versions?.n).toBe(1);
    const mine = await env.DB.prepare(
      "select count(*) n from artifacts where owner_id = ?",
    )
      .bind(guest.userId)
      .first<{ n: number }>();
    expect(mine?.n).toBe(0);
    // The data doc was never written (the owner reads an empty collection).
    const page = await send(owner.cookie, "GET", R.dataCollection(target, "c"));
    expect(page.status).toBe(200);
    expect(((await page.json()) as { items: unknown[] }).items).toEqual([]);
    // The share row still says editor: nothing was rewritten.
    const share = await env.DB.prepare(
      "select role from shares where artifact_id = ? and email = ?",
    )
      .bind(target, guestEmail)
      .first<{ role: string }>();
    expect(share?.role).toBe("editor");
  });
});
