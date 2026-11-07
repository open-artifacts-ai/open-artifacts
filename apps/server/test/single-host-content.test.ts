import { env } from "cloudflare:workers";
import { newId } from "@oa/shared";
import { expect, it } from "vitest";
import {
  contentViewer,
  publicPrefix,
  signContent,
} from "../src/content/signing.js";
import { publish } from "../src/services/artifacts.js";
import { SYSTEM_ACTOR, setUserStatus } from "../src/services/members.js";
import { getUser, getUserWithEpoch } from "../src/services/users.js";
import { fakeAssets } from "./assets-stub.js";
import { login } from "./helpers.js";
import { callWorker, E } from "./mcp-helpers.js";

it("single-host dispatch preserves signed URL version, expiry and user revocation checks", async () => {
  const l = await login(`single-${newId().toLowerCase()}@example.com`);
  const user = await getUser(env, l.userId);
  if (!user) throw new Error("no user");
  const row = await getUserWithEpoch(env, user.id);
  if (!row) throw new Error("no epoch");
  const { id } = await publish(
    env,
    user,
    {
      title: "private",
      format: "html",
      content: "<p>private bytes</p>",
      visibility: "private",
    },
    null,
    undefined,
    "create",
  );
  const over = E({
    CONTENT_HOST: "app.localhost",
    CONTENT_ROUTING: "path",
    ASSETS: fakeAssets().fetcher,
  });
  const get = (path: string) =>
    callWorker(new Request(`http://app.localhost${path}`), over);
  const viewer = contentViewer(env, user.id, row.sessionEpoch);
  const { prefix } = await signContent(
    env,
    id,
    1,
    Date.now(),
    600,
    "frame",
    viewer,
  );
  expect((await get(prefix + "__view")).status).toBe(200);
  expect((await get(publicPrefix(id, 1) + "__view")).status).toBe(404);
  expect((await get(prefix.replace("/v1/", "/v2/") + "__view")).status).toBe(
    404,
  );
  const expired = await signContent(
    env,
    id,
    1,
    Date.now() - 700_000,
    600,
    "frame",
    viewer,
  );
  expect((await get(expired.prefix + "__view")).status).toBe(404);
  await setUserStatus(env, user.id, "suspended", "admin_suspend", SYSTEM_ACTOR);
  expect((await get(prefix + "__view")).status).toBe(404);
});
