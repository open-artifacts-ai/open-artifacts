// P2 item 3: GET R.spaceCandidates(id), the "Add people" search for space
// managers who aren't org admins (GET R.members stays admin-only).
import { env } from "cloudflare:workers";
import {
  newId,
  type Page,
  PageSchema,
  R,
  SPACE_CANDIDATES_MAX,
  type SpaceCandidate,
  SpaceCandidateSchema,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { errOf, fetchAndWait, login } from "./helpers.js";

const app = createApp();
// Every candidate this file makes has an email starting with PRE, so q=PRE
// sees only them in the shared test D1.
const PRE = `k${newId().slice(0, 6).toLowerCase()}`;
const ON = {
  ...(env as object),
  FEATURES: "spaces,sync_google",
} as unknown as Env;
const NONE = { ...(env as object), FEATURES: "" } as unknown as Env;

const get = (e: Env, path: string, cookie: string | null) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${path}`, {
      headers: { "x-oa-request": "1", ...(cookie ? { cookie } : {}) },
    }),
    e,
  );
const run = (sql: string, ...b: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...b)
    .run();
const Strict = PageSchema(SpaceCandidateSchema.strict()).strict();

type U = { cookie: string; userId: string };
const mk = (name: string, role: "owner" | "admin" | "member" | "guest") =>
  login(`${PRE}-${name}@x.com`, role);

let admin: U;
let mgr: U;
let ed: U;
let outsider: U;
let cappedMgr: U;
let flagged: U;
let guest: U;
let suspended: U;
let removed: U;
let space: string;
let other: string;

const row = (s: string, u: string, role: string, source = "manual") =>
  run(
    "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, ?, ?, 1)",
    s,
    u,
    role,
    source,
  );

beforeAll(async () => {
  admin = await mk("a-admin", "admin");
  mgr = await mk("b-mgr", "member");
  ed = await mk("c-ed", "member");
  outsider = await mk("d-out", "member");
  cappedMgr = await mk("e-capped", "member");
  flagged = await mk("f-flagged", "member");
  guest = await mk("g-guest", "guest");
  suspended = await mk("h-susp", "member");
  removed = await mk("i-rem", "member");
  await run(
    "update users set status = 'suspended' where id = ?",
    suspended.userId,
  );
  await run("update users set status = 'removed' where id = ?", removed.userId);
  await run(
    "update users set restricted_manual = 1 where id in (?, ?)",
    cappedMgr.userId,
    flagged.userId,
  );
  space = newId();
  other = newId();
  for (const [id, name] of [
    [space, `Cand ${PRE}`],
    [other, `Other ${PRE}`],
  ])
    await run(
      "insert into spaces (id, kind, name, public_links, created_at) values (?, 'shared', ?, 1, 1)",
      id,
      name,
    );
  await row(space, mgr.userId, "manager");
  await row(space, ed.userId, "editor");
  await row(space, ed.userId, "viewer", "sync");
  await row(space, cappedMgr.userId, "manager");
  await row(space, guest.userId, "viewer");
  await row(other, outsider.userId, "manager");
});

const search = async (as: U, qs = "", e: Env = ON) => {
  const r = await get(e, `${R.spaceCandidates(space)}${qs}`, as.cookie);
  expect(r.status).toBe(200);
  return Strict.parse(await r.json());
};
const emails = (p: Page<SpaceCandidate>) =>
  p.items.map((m) => m.email.split("@")[0]?.slice(PRE.length + 1));

describe("GET /spaces/:id/candidates", () => {
  it("a space manager sees active org members (never guests or departed), by email, with restriction and spaceRole", async () => {
    const p = await search(mgr, `?q=${PRE}`);
    expect(emails(p)).toEqual([
      "a-admin",
      "b-mgr",
      "c-ed",
      "d-out",
      "e-capped",
      "f-flagged",
    ]);
    expect(p.nextCursor).toBeNull();
    const by = (id: string) => p.items.find((m) => m.id === id);
    expect(by(admin.userId)).toMatchObject({
      role: "admin",
      restriction: null,
      spaceRole: null,
    });
    expect(by(mgr.userId)?.spaceRole).toBe("manager");
    // Manual and sync rows: the stronger one, as SpaceMember.role.
    expect(by(ed.userId)?.spaceRole).toBe("editor");
    expect(by(outsider.userId)?.spaceRole).toBeNull();
    expect(by(flagged.userId)).toMatchObject({
      role: "member",
      restriction: { manual: true, groups: [] },
      spaceRole: null,
    });
    // effectiveName: a name equal to the local part shows the email.
    expect(by(ed.userId)?.name).toBe(`${PRE}-c-ed@x.com`);
  });

  it("q matches an email or name-word prefix; pages walk by (email, id); the limit is bounded", async () => {
    expect(emails(await search(mgr, `?q=${PRE}-c`))).toEqual(["c-ed"]);
    expect(emails(await search(mgr, `?q=${PRE}-zz`))).toEqual([]);
    // LIKE wildcards are literal.
    expect(emails(await search(mgr, `?q=${PRE}_`))).toEqual([]);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = `?q=${PRE}&limit=4${cursor ? `&cursor=${cursor}` : ""}`;
      const p = await search(mgr, qs);
      expect(p.items.length).toBeLessThanOrEqual(4);
      seen.push(...(emails(p) as string[]));
      cursor = p.nextCursor;
    } while (cursor);
    expect(seen).toEqual([
      "a-admin",
      "b-mgr",
      "c-ed",
      "d-out",
      "e-capped",
      "f-flagged",
    ]);
    const over = await get(
      ON,
      `${R.spaceCandidates(space)}?limit=${SPACE_CANDIDATES_MAX + 1}`,
      mgr.cookie,
    );
    expect(over.status).toBe(400);
    const junk = await get(
      ON,
      `${R.spaceCandidates(space)}?cursor=nope!`,
      mgr.cookie,
    );
    expect(junk.status).toBe(400);
    expect(
      (await get(ON, `${R.spaceCandidates(space)}?x=1`, mgr.cookie)).status,
    ).toBe(400);
  });

  it("an org admin with no role in the space may search it", async () => {
    expect(emails(await search(admin, `?q=${PRE}-d`))).toEqual(["d-out"]);
  });

  it("everyone else gets 404: an editor, a guest, a manager of another space, a capped manager; anonymous 401", async () => {
    for (const u of [ed, guest, outsider, cappedMgr, flagged]) {
      const r = await get(ON, R.spaceCandidates(space), u.cookie);
      expect(r.status).toBe(404);
      expect((await errOf(r)).code).toBe("not_found");
    }
    expect((await get(ON, R.spaceCandidates(space), null)).status).toBe(401);
    // An unknown space reads the same as one they can't see.
    expect((await get(ON, R.spaceCandidates(newId()), mgr.cookie)).status).toBe(
      404,
    );
    // Without the spaces feature: 404 for an admin too.
    expect(
      (await get(NONE, R.spaceCandidates(space), admin.cookie)).status,
    ).toBe(404);
  });

  it("a personal space has no candidates (400 space_personal for its owner)", async () => {
    const r = await get(ON, R.spaceCandidates(mgr.userId), mgr.cookie);
    expect(r.status).toBe(400);
    expect((await errOf(r)).code).toBe("space_personal");
    // Someone else's personal space: 404.
    expect(
      (await get(ON, R.spaceCandidates(ed.userId), mgr.cookie)).status,
    ).toBe(404);
  });

  it("GET /members stays org-admin only: a space manager gets 404", async () => {
    expect((await get(ON, R.members, mgr.cookie)).status).toBe(404);
    expect((await get(ON, R.members, admin.cookie)).status).toBe(200);
  });

  it("the space's people list carries restriction (null when none)", async () => {
    const r = await get(ON, `${R.spaceMembers(space)}?q=${PRE}`, admin.cookie);
    const page = (await r.json()) as {
      items: { userId: string; restriction: unknown }[];
    };
    const by = (id: string) => page.items.find((m) => m.userId === id);
    expect(by(mgr.userId)).toHaveProperty("restriction", null);
    expect(by(cappedMgr.userId)?.restriction).toEqual({
      manual: true,
      groups: [],
    });
  });
});
