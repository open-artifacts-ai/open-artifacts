import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authorizeCode,
  authorizeRefused,
  authorizeUrl,
  codeForm,
  kvCaseTimeout,
  lastRedeemAt,
  mcpResource,
  oauthStoreMode,
  pkce,
  redeem,
  refreshForm,
  registerClient,
  slot,
  slotValue,
  tokenIssued,
  tokenRefused,
  tokenRequest,
  untilKvSettled,
} from "../src/creds.ts";
import { deleteThrowaways } from "../src/fixtures.ts";
import {
  type Cred,
  HttpError,
  hook,
  parseJson,
  readBody,
  sessionCred,
  withCred,
} from "../src/http.ts";
import { note } from "../src/notes.ts";
import {
  allMarkers,
  crossCheck,
  expectRefused,
  prepareSide,
  type Side,
} from "../src/refused.ts";
import { label, proof } from "../src/report.ts";
import { loadTargets, type Target, type Targets } from "../src/targets.ts";

// P5 Task 4: A's real credentials don't work at B. Every case goes through
// crossCheck (B's credential succeeds at B, A's at A, then A's is refused at
// B). The credential is the admin test user's (hooks never act on the owner).
// Every case is listed in live/manifest.json.
//
// Not here, on purpose:
// - A cookie signed with a guessed key: "A's session cookie at B" already
//   proves it. A's signing key is a wrong key from B's side, so B refusing
//   A's real cookie is B refusing a session signed with a key other than its
//   own.
// - The capture header (X-OA-Capture): no route issues one (only the
//   Worker's own thumbnail capture mints it), so there is no A value to carry
//   to B. Its validation is covered by the server's own tests.

let T: Targets;
let A: Side;
let B: Side;
const side = (t: Target) => (t === T.a ? A : B);

beforeAll(async () => {
  T = await loadTargets();
  A = await prepareSide(T.a);
  B = await prepareSide(T.b);
});

afterAll(async () => {
  // Per id, one retry, never a throw mid-loop: a failed delete is noted.
  let bad = 0;
  for (const s of [A, B])
    if (s) bad += await deleteThrowaways(s.t, s.pat, [s.markerId]);
  if (bad) note(`cleanup: ${bad} marker artifact(s) not deleted`);
});

const pair = (credA: Cred, credB: Cred) => ({
  a: T.a,
  b: T.b,
  credA,
  credB,
});

const me = (cred: Cred, t: Target) =>
  new Request(`${t.app}/api/v1/me`, withCred(cred));

const mcpList = (cred: Cred, t: Target) =>
  new Request(
    `${t.app}/mcp`,
    withCred(cred, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );

async function getJson(t: Target, path: string, cred: Cred): Promise<unknown> {
  const res = await fetch(`${t.app}${path}`, withCred(cred));
  const text = await readBody(res);
  if (res.status !== 200) throw new HttpError(`${t.name} ${path}`, res, text);
  return parseJson(res, text, `${t.name} ${path}`);
}

/** The signed path of the marker's file (/c/<token>/<id>/v<n>/README.md) on `t`. */
async function signedPath(t: Target, pat: Cred, id: string): Promise<string> {
  const j = (await getJson(
    t,
    `/api/v1/artifacts/${encodeURIComponent(id)}/content-url`,
    pat,
  )) as { url?: unknown };
  if (typeof j.url !== "string") throw new Error(`${t.name}: no content url`);
  const p = new URL(j.url).pathname;
  if (!p.startsWith("/c/"))
    throw new Error(`${t.name}: the marker's content url is not signed`);
  // The raw file: __view renders through the runtime, absent locally (503).
  return p.replace(/__view$/, "README.md");
}

/** Every `email` field in a JSON value, sorted. */
function emails(v: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object")
      for (const [k, y] of Object.entries(x)) {
        if (k === "email" && typeof y === "string") out.push(y);
        else walk(y);
      }
  };
  walk(v);
  return out.sort();
}

const itemIds = (v: unknown): string[] =>
  ((v as { items?: { id?: unknown }[] }).items ?? [])
    .map((i) => String(i.id))
    .sort();

const okStatus = (s: number) => (r: Response) => r.status === s;

describe("credentials", () => {
  // ------------------------------------------------------------- admin PAT

  it("A's admin PAT at B: /api/v1/me", async () => {
    await crossCheck(me, pair(A.pat, B.pat));
  });

  it("A's admin PAT at B: /api/v1/artifacts", async () => {
    await crossCheck(
      (c, t) => new Request(`${t.app}/api/v1/artifacts`, withCred(c)),
      pair(A.pat, B.pat),
    );
  });

  it("A's admin PAT at B: /mcp tools/list", async () => {
    await crossCheck(mcpList, pair(A.pat, B.pat));
  });

  // ---------------------------------------------------------- session cookie

  it("A's session cookie at B: replayed on B's app host", async () => {
    await crossCheck(me, pair(A.cookie, B.cookie));
  });

  it("A's session cookie at B: replayed under the alternate cookie name", async () => {
    // A's value under both names (__Host-oa_session and oa_session) at B.
    const bare = (c: Cred) => (c.kind === "cookie" ? c.value : "");
    const req = (c: Cred, t: Target) =>
      new Request(`${t.app}/api/v1/me`, {
        redirect: "manual",
        headers: {
          cookie:
            c === A.cookie && t === T.b
              ? `__Host-oa_session=${bare(c)}; oa_session=${bare(c)}`
              : `${t.cookieName}=${bare(c)}`,
        },
      });
    await crossCheck(req, pair(A.cookie, B.cookie));
  });

  it("B's content host ignores cookies, A's included", async () => {
    // An invariant, not a crossCheck: the content host reads no cookie, so no
    // B cookie can succeed there to give a same-request baseline. A's cookie
    // is live (it works at A); on B's content host, B's private marker gets
    // the same refusal with A's cookie, B's cookie or none.
    const live = await fetch(`${T.a.app}/api/v1/me`, withCred(A.cookie));
    await live.body?.cancel();
    expect(live.status).toBe(200);
    const url = `${T.b.content}/p/${encodeURIComponent(B.markerId)}/v1/README.md`;
    const seen: string[] = [];
    for (const c of [A.cookie, B.cookie, { kind: "none" } as Cred]) {
      const res = await fetch(url, withCred(c));
      const body = await readBody(res.clone());
      seen.push(
        `${res.status}:${createHash("sha256").update(body).digest("hex")}`,
      );
      await expectRefused(res, T.b);
    }
    expect(new Set(seen).size).toBe(1);
    for (const c of [A.cookie, B.cookie])
      await expectRefused(
        await fetch(`${T.b.content}/api/v1/me`, withCred(c)),
        T.b,
      );
  });

  // ------------------------------------------------------------------ OAuth

  it("A's MCP OAuth access token at B: /mcp tools/list", async (ctx) => {
    // Local installs serve http, while the provider's /mcp resource is
    // https://<APP_HOST>/mcp: an OAuth bearer at /mcp isn't served over
    // local http (B's own token gets 401), so only staging can prove this.
    if (T.mode === "local")
      return proof(
        ctx,
        "staging-only",
        "OAuth bearer at /mcp needs the https resource; local installs serve http",
      );
    const grant = async (t: Target): Promise<Cred> => {
      const r = (await hook(t, "/__test/oauth-client")) as {
        accessToken?: unknown;
      };
      if (typeof r.accessToken !== "string")
        throw new Error(`${t.name} oauth-client hook: no token`);
      return { kind: "oauth", token: r.accessToken };
    };
    await crossCheck(mcpList, pair(await grant(T.a), await grant(T.b)));
  });

  describe("OAuth endpoints", () => {
    // A new authorization for the same user and client revokes that pair's
    // earlier grants, so every live code or token below has its own client.
    const res = (t: Target) => mcpResource(t);

    /** A fresh, unredeemed code on `t` for `clientId`. */
    async function code(t: Target, clientId: string) {
      const p = pkce();
      const c = await authorizeCode(t, side(t).cookie, clientId, p, res(t));
      return { code: c, verifier: p.verifier };
    }

    /** A fresh refresh token on `t` for `clientId`. */
    async function refresh(t: Target, clientId: string): Promise<string> {
      const c = await code(t, clientId);
      return (await redeem(t, clientId, c.code, c.verifier, res(t)))
        .refreshToken;
    }

    /** One client on B, two on A (A at A, A at B). */
    async function clients() {
      return {
        b: await registerClient(T.b),
        aAtA: await registerClient(T.a),
        aAtB: await registerClient(T.a),
      };
    }

    it("A's OAuth client_id in B's /authorize: no auto-grant", async () => {
      const p = pkce();
      const c = await clients();
      const credA = slot(() => c.aAtA);
      const credB = slot(() => c.b);
      const req = (cr: Cred, t: Target) =>
        new Request(
          authorizeUrl(t, slotValue<string>(cr, t), p.challenge, res(t)),
          withCred(side(t).cookie),
        );
      await crossCheck(req, {
        ...pair(credA, credB),
        ok: okStatus(200),
        refused: authorizeRefused,
      });
    });

    for (const via of ["A's client_id", "B's client_id"] as const) {
      const errors =
        via === "A's client_id"
          ? ["invalid_grant", "invalid_client"]
          : ["invalid_grant"];

      it(`A's OAuth refresh token at B's /token (${via}): no token`, async () => {
        const c = await clients();
        const atB = via === "A's client_id" ? c.aAtB : c.b;
        const rtB = await refresh(T.b, c.b);
        const rtAatA = await refresh(T.a, c.aAtA);
        const rtAatB = await refresh(T.a, c.aAtB);
        const credB = slot(() => refreshForm(c.b, rtB, res(T.b)));
        const credA = slot((t) =>
          t === T.a
            ? refreshForm(c.aAtA, rtAatA, res(T.a))
            : refreshForm(atB, rtAatB, res(T.b)),
        );
        // Each refresh reads a grant just written by its redeem: wait out
        // KV's read cache first, or a stale read refuses a valid token (#769).
        await untilKvSettled(lastRedeemAt());
        await crossCheck((cr, t) => tokenRequest(t, slotValue(cr, t)), {
          ...pair(credA, credB),
          ok: okStatus(200),
          refused: tokenRefused(errors),
        });
        // The token B refused is live at A.
        await untilKvSettled(lastRedeemAt());
        const r = await fetch(
          tokenRequest(T.a, refreshForm(c.aAtB, rtAatB, res(T.a))),
        );
        await r.body?.cancel();
        expect(r.status).toBe(200);
      });

      it(`An unredeemed A authorization code at B's /token (${via}): no token`, async () => {
        const c = await clients();
        const atB = via === "A's client_id" ? c.aAtB : c.b;
        const cB = await code(T.b, c.b);
        const cAatA = await code(T.a, c.aAtA);
        const cAatB = await code(T.a, c.aAtB);
        const credB = slot(() => codeForm(c.b, cB.code, cB.verifier, res(T.b)));
        const credA = slot((t) =>
          t === T.a
            ? codeForm(c.aAtA, cAatA.code, cAatA.verifier, res(T.a))
            : codeForm(atB, cAatB.code, cAatB.verifier, res(T.b)),
        );
        await crossCheck((cr, t) => tokenRequest(t, slotValue(cr, t)), {
          ...pair(credA, credB),
          ok: okStatus(200),
          refused: tokenRefused(errors),
        });
        // The code B refused was live and unredeemed: A still redeems it.
        await redeem(T.a, c.aAtB, cAatB.code, cAatB.verifier, res(T.a));
      });
    }

    // The OAuth store move: with OAUTH_STORE dual or d1 the grant is read
    // from the install's D1, so neither case waits. An install still on KV
    // waits out the edge cache (#769) and the case says so (label).
    const KV_WAIT_LABEL =
      "KV OAuth store: waited out the edge cache (no wait needs dual or d1)";

    it(
      "An OAuth refresh straight after the redeem: a new token, on A and on B (#769)",
      async (ctx) => {
        for (const t of [T.a, T.b]) {
          const kv = (await oauthStoreMode(t)) === "kv";
          if (kv) label(ctx, KV_WAIT_LABEL);
          const clientId = await registerClient(t);
          const rt = await refresh(t, clientId);
          if (kv) await untilKvSettled(lastRedeemAt());
          const r = await fetch(
            tokenRequest(t, refreshForm(clientId, rt, res(t))),
          );
          const ok = await tokenIssued(r);
          await r.body?.cancel();
          expect(ok, `${t.name}: refresh right after the redeem`).toBe(true);
        }
        // KV: one settle wait per install.
      },
      kvCaseTimeout(2),
    );

    it(
      "A revoked OAuth refresh token is refused at once, on A and on B",
      async (ctx) => {
        for (const t of [T.a, T.b]) {
          const kv = (await oauthStoreMode(t)) === "kv";
          if (kv) label(ctx, KV_WAIT_LABEL);
          const clientId = await registerClient(t);
          const rt = await refresh(t, clientId);
          if (kv) await untilKvSettled(lastRedeemAt());
          // RFC 7009 at the token endpoint: the refresh token's grant goes.
          const rv = await fetch(
            new Request(`${t.app}/oauth/token`, {
              method: "POST",
              redirect: "manual",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                token: rt,
                token_type_hint: "refresh_token",
                client_id: clientId,
              }),
            }),
          );
          await rv.body?.cancel();
          expect(rv.status, `${t.name}: revoke`).toBe(200);
          if (kv) await untilKvSettled(Date.now());
          await tokenRefused(["invalid_grant"])(
            await fetch(tokenRequest(t, refreshForm(clientId, rt, res(t)))),
            t,
          );
        }
        // KV: two settle waits per install (after the redeem, after the revoke).
      },
      kvCaseTimeout(4),
    );
  });

  // ------------------------------------------------------------ signed URLs

  it("A's signed content URL at B's content host", async () => {
    const pA = await signedPath(T.a, A.pat, A.markerId);
    const pB = await signedPath(T.b, B.pat, B.markerId);
    const req = (c: Cred, t: Target) =>
      new Request(`${t.content}${slotValue<string>(c, t)}`, {
        redirect: "manual",
      });
    await crossCheck(
      req,
      pair(
        slot(() => pA),
        slot(() => pB),
      ),
    );
  });

  it("A's content signature with B's artifact id at B's content host", async () => {
    const pA = await signedPath(T.a, A.pat, A.markerId);
    const pB = await signedPath(T.b, B.pat, B.markerId);
    // /c/<A's token>/<B's id>/v<n>/README.md
    const segs = pB.split("/");
    segs[2] = pA.split("/")[2] ?? "";
    const swapped = segs.join("/");
    const req = (c: Cred, t: Target) =>
      new Request(`${t.content}${slotValue<string>(c, t)}`, {
        redirect: "manual",
      });
    await crossCheck(
      req,
      pair(
        slot((t) => (t === T.a ? pA : swapped)),
        slot(() => pB),
      ),
    );
  });

  it("A's signed upload URL at B", async () => {
    const body = "redline";
    const mint = async (t: Target): Promise<string> => {
      const r = await fetch(
        `${t.app}/api/v1/uploads`,
        withCred(side(t).pat, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            path: "redline.txt",
            size: body.length,
            contentType: "text/plain",
          }),
        }),
      );
      const text = await readBody(r);
      if (r.status !== 201) throw new HttpError(`${t.name} upload`, r, text);
      const u = new URL(
        (parseJson(r, text, `${t.name} upload`) as { url: string }).url,
      );
      return `${u.pathname}${u.search}`;
    };
    const uB = await mint(T.b);
    const uAatA = await mint(T.a);
    const uAatB = await mint(T.a);
    const req = (c: Cred, t: Target) =>
      new Request(`${t.app}${slotValue<string>(c, t)}`, {
        method: "PUT",
        redirect: "manual",
        headers: { "content-type": "text/plain" },
        body,
      });
    await crossCheck(
      req,
      pair(
        slot((t) => (t === T.a ? uAatA : uAatB)),
        slot(() => uB),
      ),
    );
    // The URL B refused was live: A still accepts it.
    const r = await fetch(`${T.a.app}${uAatB}`, {
      method: "PUT",
      redirect: "manual",
      headers: { "content-type": "text/plain" },
      body,
    });
    await r.body?.cancel();
    expect(r.status).toBe(204);
  });

  // -------------------------------------------------------------------- ids

  it("B's private artifact id fetched with A's credentials at A: 404", async () => {
    // The id is the credential here: B's id is refused at A (the roles of
    // crossCheck's a and b swap), with A's PAT and A's cookie.
    for (const k of ["pat", "cookie"] as const) {
      const req = (c: Cred, t: Target) =>
        new Request(
          `${t.app}/api/v1/artifacts/${encodeURIComponent(slotValue<string>(c, t))}`,
          withCred(side(t)[k]),
        );
      await crossCheck(req, {
        a: T.b,
        b: T.a,
        credA: slot(() => B.markerId),
        credB: slot(() => A.markerId),
      });
    }
  });

  // ------------------------------------------------------------------ links

  describe("links", () => {
    const opener = new Map<Target, Cred>();
    const openerEmail = (t: Target) => `redline-member@${t.testDomain}`;

    beforeAll(async () => {
      for (const t of [T.a, T.b])
        opener.set(t, await sessionCred(t, openerEmail(t), "member"));
    });

    const memberList = async () =>
      (
        (await getJson(T.b, "/api/v1/members", B.pat)) as {
          email: string;
          role: string;
        }[]
      )
        .map((m) => `${m.email}:${m.role}`)
        .sort();

    it("A's invite link opened at B by a B member: no membership on B", async () => {
      // The invitee row an invite inserts, made through the hook (no email
      // is sent). The invite link is A's /sign-in.
      const invitee = `redline-invitee-${randomBytes(6).toString("hex")}@${T.a.testDomain}`;
      const inviteeA = await sessionCred(T.a, invitee, "member");
      const before = await memberList();
      const meB = await getJson(T.b, "/api/v1/me", opener.get(T.b) as Cred);
      // A's invitee is refused at B.
      await crossCheck(me, pair(inviteeA, opener.get(T.b) as Cred));
      // The link's path, opened at B by the B member.
      const r = await fetch(
        `${T.b.app}/sign-in`,
        withCred(opener.get(T.b) as Cred),
      );
      const text = await readBody(r);
      for (const m of allMarkers()) expect(text.includes(m)).toBe(false);
      expect(
        r.headers
          .getSetCookie()
          .some((l) => /^(__Host-)?oa_session=[^;]+/.test(l)),
      ).toBe(false);
      const after = await memberList();
      expect(after).toEqual(before);
      expect(after.some((m) => m.startsWith(`${invitee}:`))).toBe(false);
      expect(await getJson(T.b, "/api/v1/me", opener.get(T.b) as Cred)).toEqual(
        meB,
      );
    });

    it("A's share email link opened at B by a B member: no share on B", async () => {
      // Each side shares its marker with its own member (members get no
      // email). The share link is <app>/a/<id>.
      for (const t of [T.a, T.b]) {
        const r = await fetch(
          `${t.app}/api/v1/artifacts/${encodeURIComponent(side(t).markerId)}/shares`,
          withCred(side(t).pat, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: openerEmail(t), role: "viewer" }),
          }),
        );
        const text = await readBody(r);
        if (r.status !== 200) throw new HttpError(`${t.name} share`, r, text);
      }
      const sharesB = () =>
        getJson(
          T.b,
          `/api/v1/artifacts/${encodeURIComponent(B.markerId)}/shares`,
          B.pat,
        ).then(emails);
      const listB = () =>
        getJson(T.b, "/api/v1/artifacts", opener.get(T.b) as Cred).then(
          itemIds,
        );
      const [shares0, list0, members0] = [
        await sharesB(),
        await listB(),
        await memberList(),
      ];
      // The link's artifact, read by each host's own member.
      const req = (c: Cred, t: Target) =>
        new Request(
          `${t.app}/api/v1/artifacts/${encodeURIComponent(slotValue<string>(c, t))}`,
          withCred(opener.get(t) as Cred),
        );
      await crossCheck(
        req,
        pair(
          slot(() => A.markerId),
          slot(() => B.markerId),
        ),
      );
      // The viewer page itself at B: whatever it serves, none of A's data.
      const v = await fetch(
        `${T.b.app}/a/${encodeURIComponent(A.markerId)}`,
        withCred(opener.get(T.b) as Cred),
      );
      const vt = await readBody(v);
      for (const m of allMarkers()) expect(vt.includes(m)).toBe(false);
      expect(await sharesB()).toEqual(shares0);
      expect(await listB()).toEqual(list0);
      expect(await memberList()).toEqual(members0);
    });
  });
});
