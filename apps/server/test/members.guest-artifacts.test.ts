// Member.personalArtifacts: which guests have something to transfer, in the
// list's own query, on every install.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { publish } from "../src/services/artifacts.js";
import { listMembers } from "../src/services/members.js";
import { getUser } from "../src/services/users.js";
import { uniq } from "./auth-helpers.js";
import { login } from "./helpers.js";

/** A member who published, then became a guest: how a guest owns anything. */
const owner = async (role: "guest" | "member", artifacts = 1) => {
  const l = await login(uniq("own", "x.test"), "member");
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
  await env.DB.prepare("update users set role = ? where id = ?")
    .bind(role, l.userId)
    .run();
  return { userId: l.userId, id };
};

describe.each([
  ["Access-only", false],
  ["hosted or direct", true],
])("R.members on %s", (_name, hosted) => {
  it("flags only a guest with a live artifact of their own", async () => {
    const withOne = await owner("guest");
    const none = await owner("guest", 0);
    const member = await owner("member");
    const trashed = await owner("guest");
    await env.DB.prepare("update artifacts set deleted_at = ? where id = ?")
      .bind(Date.now(), trashed.id)
      .run();
    const rows = await listMembers(env, ["active"], hosted);
    const of = (id: string) => rows.find((r) => r.id === id);
    expect(of(withOne.userId)?.personalArtifacts).toBe(true);
    for (const u of [none, member, trashed])
      expect(of(u.userId)).not.toHaveProperty("personalArtifacts");
  });

  it("is one statement, however many rows", async () => {
    await owner("guest");
    await owner("guest");
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
    await listMembers({ ...env, DB } as typeof env, ["active"], hosted);
    expect(n).toBe(1);
  });
});
