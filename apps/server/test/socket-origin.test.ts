// Red-line port (OA Platform L, the red-line split): live.test.ts "Live
// connections refuse an install's own login when the request claims to come
// from the other install's site". The Origin check on the live-data and
// events sockets is exact: a neighbouring hosted install's app or content
// address, or a look-alike, is refused, and only the install's own app
// address connects. Hosted addresses (cloud packages/provision/src/names.ts
// hosts(): <slug>.open-artifacts.app, <slug>.open-artifacts.page), with the
// hosted ENVIRONMENT so the app origin is https.
import { env } from "cloudflare:workers";
import { type Member, newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { appOrigin } from "../src/http/errors.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();

/** Install B: acme, on the hosted domains. */
const HOSTED = {
  ...(env as unknown as Env),
  ENVIRONMENT: "production",
  APP_HOST: "acme.open-artifacts.app",
  CONTENT_HOST: "acme.open-artifacts.page",
} as Env;

/** Addresses next to B's that must never pass B's Origin check. */
const NEIGHBOURS = [
  // Another install's app and content addresses (install A).
  "https://acme2.open-artifacts.app",
  "https://acme2.open-artifacts.page",
  // B's own content address: artifact scripts run there.
  "https://acme.open-artifacts.page",
  // Suffix and prefix look-alikes a loose match would let through.
  "https://evilacme.open-artifacts.app",
  "https://x.acme.open-artifacts.app",
  "https://acme.open-artifacts.app.evil.example",
  "https://open-artifacts.app",
  // B's app address with another scheme or port.
  "http://acme.open-artifacts.app",
  "https://acme.open-artifacts.app:8443",
];

let owner: Member;
let cookie = "";
let ipSeq = 0;

beforeAll(async () => {
  const l = await login(`sock-origin-${tag}@x.com`);
  owner = (await getUser(env, l.userId)) as Member;
  const epoch =
    (
      await env.DB.prepare("select session_epoch e from users where id = ?")
        .bind(l.userId)
        .first<{ e: number }>()
    )?.e ?? 0;
  cookie = `${sessionCookieName(HOSTED)}=${await signSession(HOSTED, l.userId, Date.now(), { provider: "access", epoch })}`;
});

const pub = async () =>
  (
    await publish(
      env,
      owner,
      {
        title: "live",
        format: "html",
        content: "<p>hi</p>",
        visibility: "team",
        capabilities: { db: true, viewer: true, storage: true },
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;

/** Opens `path` on B as the owner's login, from `origin`. */
function open(path: string, origin: string) {
  return fetchAndWait(
    app,
    new Request(`https://${HOSTED.APP_HOST}${path}`, {
      headers: {
        cookie,
        origin,
        upgrade: "websocket",
        "cf-connecting-ip": `198.51.100.${(++ipSeq % 250) + 1}`,
      },
    }),
    HOSTED,
  );
}

describe("socket Origin check with hosted neighbouring addresses", () => {
  it("B's own app address is exactly the allowed origin", () => {
    expect(appOrigin(HOSTED)).toBe("https://acme.open-artifacts.app");
  });

  for (const [name, path] of [
    ["live data", (id: string) => R.dataSubscribe(id, "c")],
    ["events", (id: string) => R.events(id)],
  ] as const) {
    it(`${name}: every neighbouring origin is refused; B's own app origin connects`, async () => {
      const id = await pub();
      for (const origin of NEIGHBOURS) {
        const r = await open(path(id), origin);
        expect(r.status, origin).toBe(403);
        expect(r.webSocket, origin).toBeNull();
      }
      const ok = await open(path(id), appOrigin(HOSTED));
      expect(ok.status).toBe(101);
      const ws = ok.webSocket;
      if (!ws) throw new Error("no websocket");
      ws.accept();
      ws.close();
    });
  }
});
