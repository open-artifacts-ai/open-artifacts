// Member.transferable: which suspended or removed members have artifacts to
// transfer (personal space, trash included), in the list's own query, so the
// dashboard asks R.memberTransfer only for them (v0.187.0 T19).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { publish } from "../src/services/artifacts.js";
import { listMembers } from "../src/services/members.js";
import { transferSummary } from "../src/services/spaces.js";
import { getUser } from "../src/services/users.js";
import { uniq } from "./auth-helpers.js";
import { login } from "./helpers.js";

/** A member who published `artifacts`, then got `status`. */
const person = async (
  status: "active" | "suspended" | "removed",
  artifacts = 1,
) => {
  const l = await login(uniq("gone", "x.test"), "member");
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  let id = "";
  for (let i = 0; i < artifacts; i++)
    ({ id } = await publish(
      env,
      m,
      { title: "T", format: "markdown", content: "x" } as never,
      null,
      undefined,
      "create",
    ));
  await env.DB.prepare("update users set status = ? where id = ?")
    .bind(status, l.userId)
    .run();
  return { userId: l.userId, id };
};

describe("R.members transferable", () => {
  it("flags a departed member with live or only trashed artifacts, not one with none or an active member", async () => {
    const live = await person("suspended");
    const removedLive = await person("removed");
    const trashedOnly = await person("removed");
    await env.DB.prepare("update artifacts set deleted_at = ? where id = ?")
      .bind(Date.now(), trashedOnly.id)
      .run();
    const none = await person("suspended", 0);
    const active = await person("active");
    const rows = await listMembers(env, ["active", "suspended", "removed"]);
    const of = (id: string) => rows.find((r) => r.id === id);
    for (const u of [live, removedLive, trashedOnly])
      expect(of(u.userId)?.transferable).toBe(true);
    for (const u of [none, active])
      expect(of(u.userId)).not.toHaveProperty("transferable");
  });

  it("matches what the transfer summary counts", async () => {
    const a = await login(uniq("adm", "x.test"), "admin");
    const actor = await getUser(env, a.userId);
    if (!actor) throw new Error("no admin");
    const people = [
      await person("suspended"),
      await person("removed", 0),
      await person("removed"),
    ];
    const trashed = people[2];
    if (trashed)
      await env.DB.prepare("update artifacts set deleted_at = ? where id = ?")
        .bind(Date.now(), trashed.id)
        .run();
    const rows = await listMembers(env, ["suspended", "removed"]);
    for (const p of people) {
      const s = await transferSummary(env, actor, p.userId);
      expect(rows.find((r) => r.id === p.userId)?.transferable === true).toBe(
        s.live + s.deleted > 0,
      );
    }
  });

  it("stays one statement, however many departed rows", async () => {
    await person("suspended");
    await person("removed");
    let n = 0;
    const DB = new Proxy(env.DB, {
      get(t, k) {
        const v = Reflect.get(t, k);
        if (typeof v !== "function") return v;
        return (...a: unknown[]) => {
          if (k === "prepare") n++;
          return v.apply(t, a);
        };
      },
    });
    await listMembers({ ...env, DB } as typeof env, ["suspended", "removed"]);
    expect(n).toBe(1);
  });
});
