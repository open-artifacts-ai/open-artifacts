// #792 D: restoring from a shared space's trash needs that space live and the
// spaces feature on (managers by space role; personal trash is unaffected).
import { env } from "cloudflare:workers";
import { type Member, newId } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { publish, softDelete, undelete } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { login } from "./helpers.js";

const SPACES = { ...(env as object), FEATURES: "spaces" } as Env;
const OFF = { ...(env as object), FEATURES: "" } as Env;
const tag = newId().slice(0, 6).toLowerCase();

let manager: Member;
let spaceId: string;

const run = (sql: string, ...binds: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...binds)
    .run();

/** A deleted artifact in the shared space, published and deleted by its manager. */
async function trashed(): Promise<string> {
  const { id } = await publish(
    SPACES,
    manager,
    { title: "t", format: "html", content: "<p>x</p>", spaceId } as never,
    null,
  );
  await softDelete(SPACES, manager, id);
  return id;
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { code?: string }) => e.code ?? String(e),
  );

beforeAll(async () => {
  const m = await login(`tr-mgr-${tag}@x.com`);
  manager = (await getUser(SPACES, m.userId)) as Member;
  spaceId = newId();
  await run(
    "insert into spaces (id, kind, name, created_at) values (?, 'shared', ?, 1)",
    spaceId,
    `Trash ${tag}`,
  );
  await run(
    "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'manager', 'manual', 1)",
    spaceId,
    m.userId,
  );
});

describe("restore from a shared space's trash (#792 D)", () => {
  it("a manager restores while the space is live and spaces are on", async () => {
    const id = await trashed();
    const a = await undelete(SPACES, manager, id);
    expect(a.deletedAt).toBeNull();
  });

  it("refused (404) while spaces are off; restorable once they're back", async () => {
    const id = await trashed();
    expect(await code(undelete(OFF, manager, id))).toBe("not_found");
    expect(
      (
        await env.DB.prepare("select deleted_at d from artifacts where id = ?")
          .bind(id)
          .first<{ d: number | null }>()
      )?.d,
    ).not.toBeNull();
    expect((await undelete(SPACES, manager, id)).deletedAt).toBeNull();
  });

  it("refused (404) when the space is deleted", async () => {
    const id = await trashed();
    await run(
      "update spaces set deleted_at = ? where id = ?",
      Date.now(),
      spaceId,
    );
    try {
      expect(await code(undelete(SPACES, manager, id))).toBe("not_found");
    } finally {
      await run("update spaces set deleted_at = null where id = ?", spaceId);
    }
  });

  it("personal trash restores with spaces off", async () => {
    const { id } = await publish(
      OFF,
      manager,
      { title: "p", format: "html", content: "<p>x</p>" } as never,
      null,
    );
    await softDelete(OFF, manager, id);
    expect((await undelete(OFF, manager, id)).deletedAt).toBeNull();
  });
});
