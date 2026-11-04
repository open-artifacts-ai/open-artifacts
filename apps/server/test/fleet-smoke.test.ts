// #1343: the scheduler's canary smoke (apps/scheduler/src/provapi/smoke.ts)
// against this real server Worker, so its calls and the shapes it reads can't
// drift from the routes they test. smoke-a, a plain member with a PAT, and
// the share target, an existing member of the same domain (on prod, the
// owner's own canary account).
import { env } from "cloudflare:workers";
import { newId } from "@oa/shared";
import { describe, expect, it } from "vitest";
import {
  SMOKE_BUS_SKIPPED,
  SMOKE_TITLE_PREFIX,
  smoke,
} from "../../scheduler/src/provapi/smoke.js";
import { createPat } from "../src/auth/pat.js";
import { login } from "./helpers.js";
import { callWorker, E } from "./mcp-helpers.js";

const INSTALL = "icanary00001";
const HOST = "app.localhost";

describe("the canary smoke against the real server (#1343)", () => {
  it("passes, sweeps only smoke-a's leftovers, and leaves nothing behind", async () => {
    const tag = newId().slice(0, 6).toLowerCase();
    const a = await login(`smoke-a-${tag}@smoke.test`, "member");
    const b = await login(`owner-${tag}@smoke.test`, "owner");
    const { token } = await createPat(env, a.userId, "fleet-smoke");
    const { token: tb } = await createPat(env, b.userId, "b");
    const e = E({ INSTALL_ID: INSTALL });
    const call = (path: string, tok: string, init: RequestInit = {}) =>
      callWorker(
        new Request(`https://${HOST}${path}`, {
          ...init,
          headers: {
            authorization: `Bearer ${tok}`,
            "content-type": "application/json",
            ...(init.headers as Record<string, string>),
          },
        }),
        e,
      );
    const pub = async (tok: string, title: string) =>
      (
        (await (
          await call("/api/v1/artifacts", tok, {
            method: "POST",
            body: JSON.stringify({
              title,
              format: "markdown",
              content: "x",
              visibility: "private",
            }),
          })
        ).json()) as { id: string }
      ).id;
    const oldMine = await pub(token, `${SMOKE_TITLE_PREFIX}old`);
    const keepMine = await pub(token, "keep me");
    // The target's own smoke-titled artifact, shared with smoke-a: never swept.
    const bOwn = await pub(tb, `${SMOKE_TITLE_PREFIX}b-owned`);
    await call(`/api/v1/artifacts/${bOwn}/shares`, tb, {
      method: "PUT",
      body: JSON.stringify({
        email: `smoke-a-${tag}@smoke.test`,
        role: "editor",
      }),
    });

    // The release under test is whatever this server reports.
    const hz = (await (
      await callWorker(new Request(`https://${HOST}/healthz`), e)
    ).json()) as { version: string; testHooks?: boolean };
    const log: string[] = [];
    const r = await smoke({
      fetch: async (url, init) => {
        const res = await callWorker(new Request(url, init), e);
        log.push(
          `${init.method ?? "GET"} ${new URL(url).pathname} ${res.status}`,
        );
        // The test bundle has hooks on; a canary never does. Only that field
        // is dropped, so every other check still reads the real answer.
        if (new URL(url).pathname === "/healthz" && hz.testHooks) {
          const { testHooks: _, ...rest } = (await res.json()) as Record<
            string,
            unknown
          >;
          return Response.json(rest, { status: res.status });
        }
        return res;
      },
      installId: INSTALL,
      appHost: HOST,
      token,
      shareTo: `owner-${tag}@smoke.test`,
      brokerOrigin: undefined,
      version: hz.version,
      callMs: 10_000,
      budgetMs: 60_000,
    });
    expect(r, log.join(" | ")).toEqual({
      ok: true,
      notes: [SMOKE_BUS_SKIPPED],
    });
    // Every call it made, in order, on real routes.
    expect(log.map((l) => l.split(" ").slice(0, 2).join(" "))).toEqual(
      expect.arrayContaining(["GET /healthz", "GET /api/v1/me", "POST /mcp"]),
    );
    const alive = async (id: string) =>
      (
        await env.DB.prepare(
          "select deleted_at as d from artifacts where id = ?",
        )
          .bind(id)
          .first<{ d: number | null }>()
      )?.d == null;
    expect(await alive(oldMine)).toBe(false);
    expect(await alive(keepMine)).toBe(true);
    expect(await alive(bOwn)).toBe(true);
    // Its own artifact is gone, and no share of it is left.
    const left = await env.DB.prepare(
      "select a.id as id from artifacts a join users u on u.id = a.owner_id where u.id = ? and a.deleted_at is null",
    )
      .bind(a.userId)
      .all<{ id: string }>();
    expect(left.results.map((x) => x.id)).toEqual([keepMine]);
  });
});
