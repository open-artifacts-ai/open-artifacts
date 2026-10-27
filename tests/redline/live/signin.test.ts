import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  ID_TOKEN_CASES,
  idTokenOutcome,
  NEEDS_CAPTURE,
} from "../src/capture.ts";
import { setupFetch } from "../src/fetch-timeout.ts";
import {
  type Cred,
  describeRes,
  HttpError,
  hook,
  readBody,
  send,
  withCred,
} from "../src/http.ts";
import {
  crossCheck,
  expectRefused,
  prepareSide,
  type Side,
} from "../src/refused.ts";
import { proof } from "../src/report.ts";
import {
  brokerCallbackReq,
  brokerState,
  type CookiePair,
  callbackReq,
  codeAccepted,
  codeRequestReq,
  expectStateRefused,
  expectTurnstileRequired,
  type GoogleStart,
  labelTurnstileTestKey,
  latestOtp,
  relayedTo,
  requestCode,
  startGoogle,
  stateAccepted,
  tamperInstall,
  verifyReq,
} from "../src/signin.ts";
import { loadTargets, type Target, type Targets } from "../src/targets.ts";

// P5 R6 (plan Task 6): sign-in is bound to its install. Only real values are
// replayed (state, cookies and codes the installs issued, and Google codes
// from real tenant users); nothing is minted or signed here.
//
// Proof levels:
// - OIDC state replay, one-time codes and guests: live on both modes.
// - ID-token cases: a validly signed Google token with a chosen hd/aud can't
//   be produced against a live install without real tenant users, so they
//   run on P2's fake-Google fixture (apps/server/test/xt-google.local.test.ts)
//   and report unproven-live here, unless REDLINE_SIGNIN_CAPTURES holds the
//   verdicts of a capture run (docs/ops/redline-signin.md; rehearsed with no
//   human against a fake IdP in test/rehearsal.test.ts).
// - Broker: staging only (there is no broker locally).

let T: Targets;
let A: Side;
let B: Side;

beforeAll(async () => {
  T = await loadTargets();
  A = await prepareSide(T.a);
  B = await prepareSide(T.b);
});

const cleanup: { t: Target; pat: Cred; id: string }[] = [];
afterAll(async () => {
  for (const s of [A, B])
    if (s) cleanup.push({ t: s.t, pat: s.pat, id: s.markerId });
  for (const c of cleanup)
    await fetch(
      `${c.t.app}/api/v1/artifacts/${encodeURIComponent(c.id)}`,
      withCred(c.pat, { method: "DELETE" }),
    ).then((r) => r.body?.cancel());
});

const rand = () => randomBytes(5).toString("hex");
const sideOf = (host: Target): "a" | "b" => (host === T.a ? "a" : "b");

async function mustStart(t: Target): Promise<GoogleStart> {
  const s = await startGoogle(t);
  if (!s) throw new Error(`${t.name}: Google sign-in is off`);
  return s;
}

describe("sign-in: OIDC state and nonce", () => {
  it("A's OIDC state and state cookie (with its nonce) replayed at B: no session", async () => {
    // B's own state is accepted at B; A's at A; A's (state and the signed
    // cookie holding its nonce) is refused at B's state check. A refused
    // first, then still accepted at A: the value was valid.
    const sa = await mustStart(T.a);
    const sb = await mustStart(T.b);
    await crossCheck<GoogleStart>(
      (s, host) =>
        callbackReq(host, { state: s.state, error: "access_denied" }, s.cookie),
      {
        a: T.a,
        b: T.b,
        credA: sa,
        credB: sb,
        ok: stateAccepted,
        refused: expectStateRefused,
        refuseFirst: true,
      },
    );
  });

  it("A's OIDC state with B's own state cookie at B: no session", async () => {
    const sa = await mustStart(T.a);
    const sb = await mustStart(T.b);
    const spliced = await mustStart(T.b);
    // B's validly signed cookie, under the name A's state selects.
    const atB: CookiePair = {
      name: sa.cookie.name,
      value: spliced.cookie.value,
    };
    type C = { state: string; cookie: Record<"a" | "b", CookiePair> };
    await crossCheck<C>(
      (c, host) =>
        callbackReq(
          host,
          { state: c.state, error: "access_denied" },
          c.cookie[sideOf(host)],
        ),
      {
        a: T.a,
        b: T.b,
        credA: { state: sa.state, cookie: { a: sa.cookie, b: atB } },
        credB: { state: sb.state, cookie: { a: sb.cookie, b: sb.cookie } },
        ok: stateAccepted,
        refused: expectStateRefused,
        refuseFirst: true,
      },
    );
  });
});

describe("sign-in: ID tokens", () => {
  // Each capture was redeemed right after its own prompt by
  // scripts/signin-capture.ts (src/capture.ts: the crossCheck legs, run with
  // okLeg/refusedLeg), and its verdicts written to REDLINE_SIGNIN_CAPTURES.
  // A capture-file problem (missing, too old, other installs) is
  // unproven-live with its reason, never a bare fail; a failed leg fails the
  // case with each leg's redacted reason.
  for (const which of ["hd", "aud"] as const)
    it(ID_TOKEN_CASES[which], (ctx) => {
      const out = idTokenOutcome(process.env.REDLINE_SIGNIN_CAPTURES, T, which);
      // The gate's combine() (src/combine.ts) replaces exactly this reason.
      if (out.kind === "none")
        return proof(ctx, "unproven-live", NEEDS_CAPTURE);
      if (out.kind === "unproven")
        return proof(ctx, "unproven-live", `unproven: ${out.reason}`);
      if (out.kind === "fail") throw out.error;
    });
});

describe("sign-in: broker", () => {
  it("a tampered install id at the broker callback is refused", async (ctx) => {
    if (T.mode !== "staging")
      return proof(ctx, "staging-only", "no auth broker in local mode");
    const sa = await brokerState(T.a);
    const sb = await brokerState(T.b);
    if (!sa || !sb)
      return proof(
        ctx,
        "unproven-live",
        "a target doesn't sign in through the broker",
      );
    if (sa.broker !== sb.broker)
      throw new Error("the two targets use different brokers");
    // Real broker states (each relays to its own install); x's with y's
    // install id swapped in, signature kept, is refused. Both directions.
    for (const [x, y] of [
      [T.a, T.b],
      [T.b, T.a],
    ] as const) {
      const fx = await brokerState(x);
      const fy = await brokerState(y);
      if (!fx || !fy) throw new Error("broker state vanished");
      const byHost = (atX: string, atY: string) => ({
        [x.name]: atX,
        [y.name]: atY,
      });
      await crossCheck<Record<string, string>>(
        (c, host) => brokerCallbackReq(sa.broker, c[host.name] as string),
        {
          a: x,
          b: y,
          credA: byHost(fx.bstate, tamperInstall(fx.bstate, y.installId)),
          credB: byHost(fy.bstate, fy.bstate),
          ok: relayedTo,
        },
      );
    }
  });
});

// --- one-time codes ---------------------------------------------------------

/** A guest of `t` (the session hook), so codes are sent to it there. */
async function guestOn(t: Target, local: string): Promise<string> {
  const email = `${local}-${rand()}@${t.testDomain}`;
  await hook(t, "/__test/session", { email, role: "guest" });
  return email;
}

/** Requests a code at `t` for `email`; returns its pending cookie and the code (hook). */
async function codeFor(t: Target, email: string) {
  const r = await requestCode(t, email);
  if (r.status !== 202 || !r.pending)
    throw new Error(`${t.name} code request: status ${r.status}`);
  const code = await latestOtp(t, email);
  if (!code) throw new Error(`${t.name}: no code was sent to its own guest`);
  return { pending: r.pending, code };
}

type CodeCred = {
  code: string;
  pending: Partial<Record<"a" | "b", CookiePair>>;
};
const verifyAt = (c: CodeCred, host: Target) =>
  verifyReq(host, c.code, c.pending[sideOf(host)] as CookiePair);

describe("sign-in: Turnstile", () => {
  it("a code request with no Turnstile token is refused at each install (400 turnstile_required)", async (ctx) => {
    // The server's own check still runs on the red-line installs, whatever
    // token the other code cases send (rl-a and rl-b run the test secret).
    if (T.mode !== "staging")
      return proof(ctx, "staging-only", "local installs run without Turnstile");
    for (const t of [T.a, T.b])
      await expectTurnstileRequired(
        t,
        await send(
          codeRequestReq(t, `rl-noturnstile-${rand()}@${t.testDomain}`),
        ),
      );
  });
});

describe("sign-in: one-time codes", () => {
  // On the dummy token these prove the code flow, not real bot protection.
  beforeEach((ctx) => labelTurnstileTestKey(ctx, [T.a, T.b]));

  it("a code issued by A, entered at B with B's pending cookie: refused", async () => {
    const ea = await guestOn(T.a, "rl-otp");
    // A's guest is also B's guest (B shares with it), so B sends it a code of
    // its own: a code store shared by address would let A's code through.
    await share(B, ea);
    const eb = await guestOn(T.b, "rl-otp");
    const ca = await codeFor(T.a, ea);
    const cb = await codeFor(T.b, eb);
    // B's own pending cookie for A's address.
    const atB = await requestCode(T.b, ea);
    if (!atB.pending) throw new Error("B gave no pending cookie");
    await crossCheck<CodeCred>(verifyAt, {
      a: T.a,
      b: T.b,
      credA: { code: ca.code, pending: { a: ca.pending, b: atB.pending } },
      credB: { code: cb.code, pending: { b: cb.pending } },
      ok: codeAccepted,
      refuseFirst: true,
    });
  });

  it("a code issued by A, entered at B with A's pending cookie: refused", async () => {
    const ea = await guestOn(T.a, "rl-otp");
    const eb = await guestOn(T.b, "rl-otp");
    const ca = await codeFor(T.a, ea);
    const cb = await codeFor(T.b, eb);
    await crossCheck<CodeCred>(verifyAt, {
      a: T.a,
      b: T.b,
      credA: { code: ca.code, pending: { a: ca.pending, b: ca.pending } },
      credB: { code: cb.code, pending: { b: cb.pending } },
      ok: codeAccepted,
      refuseFirst: true,
    });
  });

  it("a code requested at B for an address not invited to B: no code sent, generic response", async () => {
    // Control: an invited address (B's guest) gets a code, and the hook shows it.
    const invited = await guestOn(T.b, "rl-invited");
    const ri = await requestCode(T.b, invited);
    if (ri.status !== 202 || !ri.pending)
      throw new Error(`invited request: status ${ri.status}`);
    if (!(await latestOtp(T.b, invited)))
      throw new Error("the invited address got no code (control failed)");
    // The same domain, never invited: same answer, and no code.
    const stranger = `rl-uninvited-${rand()}@${T.b.testDomain}`;
    const rs = await requestCode(T.b, stranger);
    if (rs.status !== ri.status || rs.shape !== ri.shape || !rs.pending)
      throw new Error(
        `not generic: status ${rs.status} vs ${ri.status}, same body shape ${rs.shape === ri.shape}, pending cookie ${!!rs.pending}`,
      );
    if ((await latestOtp(T.b, stranger, 4000)) !== null)
      throw new Error("B sent a code to an address it never invited");
  });
});

// --- guests -----------------------------------------------------------------

const mcpCall = (body: unknown) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...(body as object) }),
});
const publishCall = (title: string) =>
  mcpCall({
    method: "tools/call",
    params: {
      name: "publish_artifact",
      arguments: { title, format: "markdown", content: `# ${title}\n` },
    },
  });

async function share(s: Side, email: string, id = s.markerId) {
  const res = await fetch(
    `${s.t.app}/api/v1/artifacts/${encodeURIComponent(id)}/shares`,
    withCred(s.pat, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, role: "viewer" }),
    }),
  );
  const text = await readBody(res);
  if (res.status < 200 || res.status > 299)
    throw new HttpError(`${s.t.name} share`, res, text);
}

/** A private html artifact on `s` that declares the db capability (data API). */
async function publishDb(s: Side): Promise<string> {
  // A setup publish: SETUP_PUBLISH_MS, a timeout is infra (never retried).
  const { res, text } = await setupFetch(
    s.t.name,
    new Request(
      `${s.t.app}/api/v1/artifacts`,
      withCred(s.pat, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: `rl-db-${rand()}`,
          format: "html",
          content: "<p>red-line data artifact</p>",
          capabilities: { db: true },
        }),
      }),
    ),
  );
  if (res.status < 200 || res.status > 299)
    throw new HttpError(`${s.t.name} publish db artifact`, res, text);
  const id = (JSON.parse(text) as { id?: unknown }).id;
  if (typeof id !== "string") throw new Error("db artifact: no id");
  cleanup.push({ t: s.t, pat: s.pat, id });
  return id;
}

describe("sign-in: guests", () => {
  let guest: string;
  let gB: Cred;
  let mB: Cred;
  let dbArt: string;

  /** A cookie session at B for `email` (the session hook). */
  async function sessionAtB(email: string, role: "member" | "guest") {
    const out = (await hook(T.b, "/__test/session", { email, role })) as {
      cookie?: unknown;
    };
    if (typeof out.cookie !== "string") throw new Error(`no ${role} cookie`);
    return { kind: "cookie", name: T.b.cookieName, value: out.cookie } as Cred;
  }

  beforeAll(async () => {
    // One address: a guest of A (A shares with it) who is invited to B.
    guest = `rl-guest-${rand()}@${T.b.testDomain}`;
    await share(A, guest);
    dbArt = await publishDb(B);
    await share(B, guest, dbArt);
    gB = await sessionAtB(guest, "guest");
    // The control: a B member with the same access to the artifact.
    const member = `rl-member-${rand()}@${T.b.testDomain}`;
    await share(B, member, dbArt);
    mB = await sessionAtB(member, "member");
  });

  it("a guest of A invited to B reads on B but can't publish via MCP or the data API there", async () => {
    const b = T.b;
    const art = `${b.app}/api/v1/artifacts/${encodeURIComponent(dbArt)}`;
    const csrf = { "x-oa-request": "1", "content-type": "application/json" };

    // Precondition: B caps guests read-only (guestsReadOnly), members not.
    const auth = async (cred: Cred) => {
      const r = await send(new Request(`${b.app}/api/v1/me`, withCred(cred)));
      const t = await readBody(r);
      if (r.status !== 200) throw new Error(`/me at B: ${describeRes(r, t)}`);
      return (JSON.parse(t) as { auth?: { readOnly?: unknown; cap?: unknown } })
        .auth;
    };
    const ga = await auth(gB);
    if (ga?.readOnly !== true || ga.cap !== "guest")
      throw new Error("precondition: B doesn't cap the guest read-only");
    if ((await auth(mB))?.readOnly !== false)
      throw new Error("precondition: B caps its member too");

    // Reads what B shared with it.
    const read = await send(new Request(art, withCred(gB)));
    const rb = await readBody(read);
    if (read.status !== 200)
      throw new Error(`guest read at B: ${describeRes(read, rb)}`);

    // Each write: the member's identical request succeeds, the guest's is refused.
    const writes: [string, (cred: Cred) => Request][] = [
      [
        "mint a PAT (the guest's way to MCP)",
        (cred) =>
          new Request(
            `${b.app}/api/v1/tokens`,
            withCred(cred, {
              method: "POST",
              headers: csrf,
              body: JSON.stringify({ label: "rl-guest" }),
            }),
          ),
      ],
      [
        "publish (POST /api/v1/artifacts)",
        (cred) =>
          new Request(
            `${b.app}/api/v1/artifacts`,
            withCred(cred, {
              method: "POST",
              headers: csrf,
              body: JSON.stringify({
                title: `rl-guest-${rand()}`,
                format: "markdown",
                content: "x",
              }),
            }),
          ),
      ],
      [
        "data PUT",
        (cred) =>
          new Request(
            `${art}/data/redline/${rand()}`,
            withCred(cred, {
              method: "PUT",
              headers: csrf,
              body: JSON.stringify({ v: 1 }),
            }),
          ),
      ],
    ];
    for (const [what, req] of writes) {
      const ok = await send(req(mB));
      const okText = await readBody(ok);
      if (ok.status < 200 || ok.status > 299)
        throw new Error(`B member ${what}: ${describeRes(ok, okText)}`);
      const made = (JSON.parse(okText || "{}") as { id?: unknown }).id;
      if (typeof made === "string" && what.startsWith("publish"))
        cleanup.push({ t: b, pat: B.pat, id: made });
      if (typeof made === "string" && what.startsWith("mint"))
        await fetch(
          `${b.app}/api/v1/tokens/${encodeURIComponent(made)}`,
          withCred(mB, { method: "DELETE", headers: csrf }),
        ).then((r) => r.body?.cancel());
      await expectRefused(await send(req(gB)), b);
    }

    // MCP: B's admin publishes through /mcp with its PAT.
    const pub = await send(
      new Request(
        `${b.app}/mcp`,
        withCred(B.pat, publishCall(`rl-mcp-${rand()}`)),
      ),
    );
    const pubText = await readBody(pub);
    if (pub.status !== 200 || pubText.includes('"isError":true'))
      throw new Error(`admin MCP publish at B: ${describeRes(pub, pubText)}`);
    const id = /"id"\s*:\s*\\?"([A-Za-z0-9_-]{8,})\\?"/.exec(pubText)?.[1];
    if (id) cleanup.push({ t: b, pat: B.pat, id });
    // Invariant, not a crossCheck: /mcp takes no session cookie from anyone
    // (bearer only), so the guest's cookie there is refused.
    await expectRefused(
      await send(
        new Request(`${b.app}/mcp`, withCred(gB, publishCall("rl-guest"))),
      ),
      b,
    );
  });

  it("the guest's B session is refused at A", async () => {
    const me = (cred: Cred, t: Target) =>
      new Request(`${t.app}/api/v1/me`, withCred(cred));
    // Roles swapped: the guest's own install is B.
    await crossCheck(me, { a: T.b, b: T.a, credA: gB, credB: A.cookie });
  });
});
