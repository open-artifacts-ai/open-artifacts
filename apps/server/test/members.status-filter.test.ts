// GET /api/v1/members?status= (the dashboard's Departed card) and GET
// /members/:id/transfer on an active member.
import { env } from "cloudflare:workers";
import {
  type Member,
  MemberSchema,
  newId,
  R,
  type TransferSummary,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { errOf, fetchAndWait, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
const ON = { ...(env as object), FEATURES: "spaces" } as unknown as Env;

const call = (path: string, cookie: string) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${path}`, {
      headers: { "x-oa-request": "1", cookie },
    }),
    ON,
  );
const list = async (cookie: string, status?: string) => {
  const r = await call(
    status === undefined
      ? R.members
      : `${R.members}?status=${encodeURIComponent(status)}`,
    cookie,
  );
  expect(r.status).toBe(200);
  return z.array(MemberSchema).parse(await r.json());
};
const ids = (ms: Member[]) => ms.map((m) => m.id);
const run = (sql: string, ...binds: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...binds)
    .run();
const insertArtifact = (owner: string, deletedAt: number | null = null) =>
  run(
    "insert into artifacts (id, owner_id, space_id, title, format, visibility, created_at, updated_at, deleted_at) values (?, ?, ?, 't', 'html', 'private', 1, 1, ?)",
    newId(),
    owner,
    owner,
    deletedAt,
  );
const setStatus = (id: string, status: string) =>
  run("update users set status = ? where id = ?", status, id);

let owner: { cookie: string; userId: string };

beforeAll(async () => {
  owner = await login(`sf-owner-${tag}@x.com`, "owner");
});

// Runs first: until the later describes add people, the owner is the only user.
describe("a fresh install (only the owner, with a personal artifact)", () => {
  it("?status=suspended,removed is empty; the default lists the owner", async () => {
    const n = await env.DB.prepare("select count(*) n from users").first<{
      n: number;
    }>();
    expect(n?.n).toBe(1);
    await insertArtifact(owner.userId);
    expect(await list(owner.cookie, "suspended,removed")).toEqual([]);
    expect(await list(owner.cookie, "suspended")).toEqual([]);
    expect(await list(owner.cookie, "removed")).toEqual([]);
    expect(ids(await list(owner.cookie))).toEqual([owner.userId]);
  });
});

describe("GET /members?status=", () => {
  let admin: { cookie: string; userId: string };
  let member: { cookie: string; userId: string };
  let suspended: string;
  let removed: string;
  let legacy: string;

  beforeAll(async () => {
    admin = await login(`sf-admin-${tag}@x.com`, "admin");
    member = await login(`sf-member-${tag}@x.com`, "member");
    suspended = (await login(`sf-susp-${tag}@x.com`, "member")).userId;
    removed = (await login(`sf-rem-${tag}@x.com`, "admin")).userId;
    legacy = (await login(`sf-legacy-${tag}@x.com`, "member")).userId;
    // Distinct createdAt, so the expected order is (createdAt, id) by design.
    const order = [owner.userId, admin.userId, member.userId];
    for (const [i, u] of [...order, suspended, removed, legacy].entries())
      await run("update users set created_at = ? where id = ?", 1000 + i, u);
    for (const u of [admin.userId, member.userId, suspended, removed])
      await insertArtifact(u);
    await setStatus(suspended, "suspended");
    await setStatus(removed, "removed");
    // An unknown stored value reads as suspended (statusOf).
    await setStatus(legacy, "disabled");
  });

  const active = () => [owner.userId, admin.userId, member.userId];

  it("active members are never in suspended or removed", async () => {
    for (const q of ["suspended", "removed", "suspended,removed"]) {
      const got = ids(await list(admin.cookie, q));
      for (const id of active()) expect(got).not.toContain(id);
    }
  });

  it("each departed member is listed under its own status, with it", async () => {
    const s = await list(owner.cookie, "suspended");
    expect(ids(s)).toEqual([suspended, legacy]);
    expect(s.every((m) => m.status === "suspended")).toBe(true);
    const r = await list(owner.cookie, "removed");
    expect(ids(r)).toEqual([removed]);
    expect(r[0]?.status).toBe("removed");
  });

  it("the combined list has both, ordered by createdAt then id", async () => {
    const both = await list(admin.cookie, "suspended,removed");
    expect(ids(both)).toEqual([suspended, removed, legacy]);
    expect(ids(await list(admin.cookie, "removed,suspended"))).toEqual(
      ids(both),
    );
    expect(
      ids(await list(admin.cookie, " suspended , removed,removed")),
    ).toEqual(ids(both));
  });

  it("no query, or status=active, lists active members only", async () => {
    const d = await list(admin.cookie);
    expect(ids(d)).toEqual(active());
    // Every row carries its status (one shape, parity 1, A8).
    expect(d.every((m) => m.status === "active")).toBe(true);
    expect(ids(await list(admin.cookie, "active"))).toEqual(active());
  });

  it("status=active,suspended,removed lists everyone", async () => {
    expect(
      ids(await list(admin.cookie, "active,suspended,removed")).sort(),
    ).toEqual([...active(), suspended, removed, legacy].sort());
  });

  it.each(["", ",", "departed", "suspended,", "suspended,bogus", "ACTIVE"])(
    "status=%j → 400 bad_request",
    async (q) => {
      const r = await call(
        `${R.members}?status=${encodeURIComponent(q)}`,
        admin.cookie,
      );
      expect(r.status).toBe(400);
      expect((await errOf(r)).code).toBe("bad_request");
    },
  );

  it("an unknown query parameter → 400 bad_request", async () => {
    const r = await call(`${R.members}?state=removed`, admin.cookie);
    expect(r.status).toBe(400);
    expect((await errOf(r)).code).toBe("bad_request");
  });

  it("a member (not a manager) gets 404, whatever the status", async () => {
    for (const q of ["", "?status=suspended,removed", "?status=bogus"])
      expect((await call(`${R.members}${q}`, member.cookie)).status).toBe(404);
  });

  describe("GET /members/:id/transfer", () => {
    it.each(["owner", "admin", "member"] as const)(
      "an active %s → 409 member_active",
      async (who) => {
        const id = {
          owner: owner.userId,
          admin: admin.userId,
          member: member.userId,
        }[who];
        const r = await call(R.memberTransfer(id), owner.cookie);
        expect(r.status).toBe(409);
        expect(await errOf(r)).toMatchObject({
          code: "member_active",
          message:
            "Suspend or remove the member before transferring their artifacts",
        });
      },
    );

    it("a suspended member → its counts", async () => {
      await insertArtifact(suspended);
      await insertArtifact(suspended, Date.now());
      const r = await call(R.memberTransfer(suspended), admin.cookie);
      expect(r.status).toBe(200);
      expect((await r.json()) as TransferSummary).toEqual({
        live: 2,
        deleted: 1,
      });
    });

    it("a removed member → its counts", async () => {
      const r = await call(R.memberTransfer(removed), admin.cookie);
      expect(r.status).toBe(200);
      expect((await r.json()) as TransferSummary).toEqual({
        live: 1,
        deleted: 0,
      });
    });

    it("an unknown id → 404", async () => {
      expect((await call(R.memberTransfer(newId()), admin.cookie)).status).toBe(
        404,
      );
    });
  });
});
