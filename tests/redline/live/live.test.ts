import { afterAll, beforeAll, describe, it } from "vitest";
import {
  apiReq,
  call,
  createThrowaway,
  dataPath,
  deleteThrowaways,
  serverOrigin,
  whoami,
} from "../src/fixtures.ts";
import {
  type Cred,
  describeRes,
  parseJson,
  readBody,
  send,
  sendProbe,
  withCred,
} from "../src/http.ts";
import {
  crossCheck,
  defaultOk,
  expectRefused,
  prepareSide,
  type Side,
} from "../src/refused.ts";
import { loadTargets, type Target, type Targets } from "../src/targets.ts";
import { wsHandshake } from "../src/ws.ts";

// P5 Task 5: live sockets and anonymous writes. Every socket refusal goes
// through crossCheck (B's own credential succeeds at B, A's at A, then A's is
// refused at B). #1235: the data API cases (A's PAT at B on each data and
// storage route) are retired; src/retired.ts names what guards them.

const COL = "c";

interface Live {
  s: Side;
  user: { id: string; email: string };
  /** Private, db + storage: the sockets' artifact. */
  data: string;
  /** Public, db, allowAnonymousWrites. */
  anon: string;
}

let T: Targets;
let A: Live;
let B: Live;
/** Every artifact a side created (marker first), recorded as it is made. */
const made = new Map<Side, string[]>();

const side = (t: Target): Live => (t === T.a ? A : B);

async function setup(t: Target): Promise<Live> {
  const s = await prepareSide(t);
  const ids: string[] = [s.markerId];
  made.set(s, ids);
  const user = await whoami(t, s.pat);
  const mk = async (o: Parameters<typeof createThrowaway>[2]) => {
    const w = await createThrowaway(t, s.pat, o);
    ids.push(w.id);
    return w;
  };
  const data = await mk({ capabilities: { db: true, storage: true } });
  const anon = await mk({
    visibility: "public",
    capabilities: { db: true },
    allowAnonymousWrites: true,
  });
  return { s, user, data: data.id, anon: anon.id };
}

beforeAll(async () => {
  T = await loadTargets();
  A = await setup(T.a);
  B = await setup(T.b);
});

afterAll(async () => {
  let bad = 0;
  let partial = 0;
  for (const [s, ids] of made) {
    // A side whose setup failed part way: still clean up, but fail the run.
    if (s !== A?.s && s !== B?.s) partial++;
    bad += await deleteThrowaways(s.t, s.pat, ids);
  }
  if (bad || partial)
    throw new Error(
      `${bad} throwaway artifacts were not deleted; ${partial} side(s) failed setup`,
    );
});

const subscribeUrl = (t: Target) =>
  `${t.app}${dataPath(side(t).data, "data-subscribe")}?collection=${COL}`;
const eventsUrl = (t: Target) => `${t.app}${dataPath(side(t).data, "events")}`;

describe("WebSocket at B with A's credential: no 101", () => {
  const SOCKETS = [
    ["data-subscribe", subscribeUrl],
    ["events", eventsUrl],
  ] as const;
  for (const [what, url] of SOCKETS) {
    for (const kind of ["PAT", "session"] as const) {
      it(`${what} with A's ${kind}`, async () => {
        const credOf = (l: Live) => (kind === "PAT" ? l.s.pat : l.s.cookie);
        await crossCheck((cred, t) => new Request(url(t), withCred(cred)), {
          a: T.a,
          b: T.b,
          credA: credOf(A),
          credB: credOf(B),
          ok: (r) => r.status === 101,
          send: wsHandshake,
        });
      });
    }
  }
});

describe("WebSocket at B with B's own session and A's Origin: refused", () => {
  const SOCKETS = [
    ["data-subscribe", subscribeUrl],
    ["events", eventsUrl],
  ] as const;
  for (const [what, url] of SOCKETS) {
    for (const which of ["app", "content"] as const) {
      it(`${what} with Origin = A's ${which} origin`, async () => {
        // No response: one more try, then infra (sendProbe), never a verdict.
        const hs = (l: Live, origin: string) =>
          sendProbe(
            new Request(
              url(l.s.t),
              withCred(l.s.cookie, { headers: { origin } }),
            ),
            wsHandshake,
          );
        // Success legs: each side's own session from its own app origin.
        for (const l of [B, A]) {
          const r = await hs(l, serverOrigin(l.s.t, T.mode, "app"));
          if (r.status !== 101)
            throw new Error(
              `${l.s.t.name}'s own session from its own origin: ${describeRes(r, await readBody(r))}`,
            );
        }
        await expectRefused(await hs(B, serverOrigin(T.a, T.mode, which)), T.b);
      });
    }
  }
});

/** The stored doc's updatedBy (read with the artifact owner's PAT). */
async function updatedBy(
  l: Live,
  doc: string,
): Promise<{ by: string; text: string }> {
  const { res, text } = await call(
    apiReq(l.s.t, l.s.pat, "GET", dataPath(l.anon, "data", COL, doc)),
    `${l.s.t.name} read ${doc}`,
  );
  const by = (
    parseJson(res, text, `${l.s.t.name} read ${doc}`) as {
      updatedBy?: unknown;
    }
  ).updatedBy;
  if (typeof by !== "string")
    throw new Error(`${l.s.t.name} ${doc}: no updatedBy`);
  return { by, text };
}

const anonPut = (l: Live, cred: Cred, doc: string) =>
  apiReq(l.s.t, cred, "PUT", dataPath(l.anon, "data", COL, doc), {
    note: "redline-anon",
  });

describe("anonymous writes on a B public artifact", () => {
  it("the fixture accepts an anonymous write", async () => {
    for (const l of [B, A]) {
      const res = await send(anonPut(l, { kind: "none" }, "anon"));
      const text = await readBody(res);
      if (!defaultOk(res))
        throw new Error(
          `${l.s.t.name} anonymous write: ${describeRes(res, text)}`,
        );
      const { by } = await updatedBy(l, "anon");
      if (!by.startsWith("anon"))
        throw new Error(
          `${l.s.t.name} anonymous write: updatedBy is not anonymous`,
        );
    }
  });

  it("A's PAT sent along does not change the actor to A's user", async () => {
    // Controls: each PAT is attributed at its own install, so the check below
    // can see an identity when there is one.
    for (const l of [B, A]) {
      await call(anonPut(l, l.s.pat, "own"), `${l.s.t.name} own write`);
      const { by } = await updatedBy(l, "own");
      if (by !== `u:${l.user.id}`)
        throw new Error(`${l.s.t.name} own write: not attributed to its user`);
    }
    const res = await send(anonPut(B, A.s.pat, "from-a"));
    const text = await readBody(res);
    if (!defaultOk(res))
      throw new Error(
        `A's PAT anonymous write at B: ${describeRes(res, text)}`,
      );
    const stored = await updatedBy(B, "from-a");
    if (!stored.by.startsWith("anon"))
      throw new Error("A's PAT at B: updatedBy is not anonymous");
    for (const s of [text, stored.text])
      if (s.includes(A.user.id) || s.includes(A.user.email))
        throw new Error("A's PAT at B: the stored doc carries A's identity");
  });
});

// Failure model gap 13 (PUBLIC-1): /p/ serves a public artifact to anyone, so
// no tenant credential is involved, and the surface probes drop it. What
// only a live run shows: the deployed content host stops serving it the
// moment it goes private, with no edge cache in between. One try, no poll:
// waiting for a refusal would hide exactly that window.
describe("a public link on B", () => {
  it("serves while public, and is refused as soon as the artifact is private", async () => {
    const w = await createThrowaway(T.b, B.s.pat, { visibility: "public" });
    made.get(B.s)?.push(w.id);
    const url = `${T.b.content}/p/${encodeURIComponent(w.id)}/v1/index.html`;
    const open = await fetch(url, { redirect: "manual" });
    const body = await readBody(open);
    if (open.status !== 200 || !body.includes(w.marker))
      throw new Error(
        `B's public link didn't serve the artifact (${describeRes(open, body)})`,
      );
    const flip = await send(
      apiReq(T.b, B.s.pat, "PATCH", `/api/v1/artifacts/${w.id}`, {
        visibility: "private",
      }),
    );
    const flipped = await readBody(flip);
    if (flip.status !== 200)
      throw new Error(`B's flip to private: ${describeRes(flip, flipped)}`);
    await expectRefused(await fetch(url, { redirect: "manual" }), T.b);
  });
});
