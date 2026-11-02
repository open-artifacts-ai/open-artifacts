// A directory deletion leaves `removed+<id>@invalid` on the row. It isn't a
// valid address, and one such row must not fail a whole list (#1144).
import { env } from "cloudflare:workers";
import {
  ArtifactSummarySchema,
  type Member,
  MemberSchema,
  PageSchema,
  R,
  VersionInfoSchema,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";
import { deleteUser } from "../src/directory/apply.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { uniq } from "./auth-helpers.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();
const get = (path: string, cookie: string) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${path}`, {
      headers: { "x-oa-request": "1", cookie },
    }),
    env,
  );

describe("a member a directory deletion released", () => {
  let admin: { cookie: string };
  let userId: string;
  let artifactId: string;

  beforeAll(async () => {
    admin = await login(uniq("ra-admin", "a.com"), "admin");
    const u = await login(uniq("ra", "a.com"), "member");
    userId = u.userId;
    const { id } = await publish(
      env,
      (await getUser(env, userId)) as Member,
      {
        title: "Kept",
        format: "html",
        content: "<p>kept</p>",
        visibility: "team",
      } as never,
      null,
      undefined,
      "create",
    );
    artifactId = id;
    await deleteUser(env, userId, "directory_delete", () => {});
  });

  const placeholder = () => `removed+${userId}@invalid`;

  it("the members list still parses, with valid people in it", async () => {
    const r = await get(`${R.members}?status=removed`, admin.cookie);
    expect(r.status).toBe(200);
    const list = z.array(MemberSchema).parse(await r.json());
    // This list lowercases addresses; the stored row keeps the id's case.
    expect(list.find((m) => m.id === userId)?.email).toBe(
      placeholder().toLowerCase(),
    );
  });

  it("the library and versions still parse, with their surviving authorship", async () => {
    const r = await get(`${R.artifacts}?limit=100`, admin.cookie);
    expect(r.status).toBe(200);
    const { items } = PageSchema(ArtifactSummarySchema).parse(await r.json());
    expect(items.find((a) => a.id === artifactId)?.owner.email).toBe(
      placeholder(),
    );
    const v = await get(R.versions(artifactId), admin.cookie);
    expect(v.status).toBe(200);
    expect(
      z.array(VersionInfoSchema).parse(await v.json())[0]?.createdBy.email,
    ).toBe(placeholder());
  });
});
