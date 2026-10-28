import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  apiReq,
  call,
  createThrowaway,
  dataPath,
  deleteThrowaways,
  serverOrigin,
  snapshotBeforeAttack,
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

// P5 Task 5: live data and sockets. Every refusal goes through crossCheck (B's
// own credential succeeds at B, A's at A, then A's is refused at B). Writes:
// each side's success leg writes its OWN throwaway; A's attempt at B targets
// B's victim doc/key, and B's state is re-read before and after it.

const COL = "c";

interface Live {
  s: Side;
  user: { id: string; email: string };
  /** Private, db + storage: data API and sockets. */
  data: string;
  /** Private, db: PUT data (reset). */
  reset: string;
  /** Public, db, allowAnonymousWrites. */
  anon: string;
  /** Markers in the data and reset throwaways' seeded state. */
  dataMarker: string;
  resetMarker: string;
}

let T: Targets;
let A: Live;
let B: Live;
/** Every artifact a side created (marker first), recorded as it is made. */
const made = new Map<Side, string[]>();

const side = (t: Target): Live => (t === T.a ? A : B);
const hashOf = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 16);

async function putDoc(l: Live, art: string, doc: string, data: unknown) {
  await call(
    apiReq(l.s.t, l.s.pat, "PUT", dataPath(art, "data", COL, doc), data),
    `${l.s.t.name} seed ${doc}`,
  );
}

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
  const reset = await mk({ capabilities: { db: true } });
  const anon = await mk({
    visibility: "public",
    capabilities: { db: true },
    allowAnonymousWrites: true,
  });
  const l: Live = {
    s,
    user,
    data: data.id,
    reset: reset.id,
    anon: anon.id,
    dataMarker: data.marker,
    resetMarker: reset.marker,
  };
  for (const doc of ["victim", "own-put", "own-patch", "own-del"])
    await putDoc(l, l.data, doc, { marker: data.marker, doc });
  await putDoc(l, l.reset, "victim", { marker: reset.marker });
  for (const key of ["victim", "own-del"])
    await call(
      apiReq(t, s.pat, "PUT", dataPath(l.data, "storage", key), {
        value: { marker: data.marker, key },
      }),
      `${t.name} seed storage ${key}`,
    );
  return l;
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

/** Status and body of a GET with B's PAT: the state A's attempt must not change. */
const stateOf = (path: string) => async () => {
  const res = await send(apiReq(T.b, B.s.pat, "GET", path));
  return `${res.status}\n${await readBody(res)}`;
};

function expectSame(before: string, after: string, what: string): void {
  if (before !== after)
    throw new Error(
      `B's ${what} changed after A's attempt (sha256:${hashOf(before)} -> sha256:${hashOf(after)})`,
    );
}

/** crossCheck a write, then prove B's state at `path` is what A's attempt met. */
async function writeCase(
  req: (cred: Cred, t: Target) => Request,
  statePath: string,
  what: string,
  marker: string,
): Promise<void> {
  const snap = snapshotBeforeAttack(stateOf(statePath));
  await crossCheck(req, {
    a: T.a,
    b: T.b,
    credA: A.s.pat,
    credB: B.s.pat,
    send: snap.send,
  });
  const before = snap.before();
  // The state A's attempt met must be B's real seeded state, so a 404 = 404
  // match can't pass.
  if (!before.startsWith("200\n") || !before.includes(marker))
    throw new Error(`B's ${what} was not readable before A's attempt`);
  expectSame(before, await stateOf(statePath)(), what);
}

/** The doc a leg writes: B's victim for A's attempt at B, else the side's own. */
const docFor = (cred: Cred, t: Target, own: string) =>
  t === T.b && cred === A.s.pat ? "victim" : own;

describe("data API at B with A's PAT", () => {
  const pat = () => ({ a: T.a, b: T.b, credA: A.s.pat, credB: B.s.pat });

  it("GET data/:col/:doc", async () => {
    await crossCheck(
      (cred, t) =>
        apiReq(t, cred, "GET", dataPath(side(t).data, "data", COL, "victim")),
      pat(),
    );
  });

  it("GET data/:col (list)", async () => {
    await crossCheck(
      (cred, t) => apiReq(t, cred, "GET", dataPath(side(t).data, "data", COL)),
      pat(),
    );
  });

  it("POST data/:col/query", async () => {
    await crossCheck(
      (cred, t) =>
        apiReq(t, cred, "POST", dataPath(side(t).data, "data", COL, "query"), {
          limit: 10,
        }),
      pat(),
    );
  });

  it("PUT data/:col/:doc: refused, and B's doc is unchanged", async () => {
    await writeCase(
      (cred, t) =>
        apiReq(
          t,
          cred,
          "PUT",
          dataPath(side(t).data, "data", COL, docFor(cred, t, "own-put")),
          { from: "redline-put" },
        ),
      dataPath(B.data, "data", COL, "victim"),
      "victim doc",
      B.dataMarker,
    );
  });

  it("PATCH data/:col/:doc: refused, and B's doc is unchanged", async () => {
    await writeCase(
      (cred, t) =>
        apiReq(
          t,
          cred,
          "PATCH",
          dataPath(side(t).data, "data", COL, docFor(cred, t, "own-patch")),
          { patched: "redline-patch" },
        ),
      dataPath(B.data, "data", COL, "victim"),
      "victim doc",
      B.dataMarker,
    );
  });

  it("DELETE data/:col/:doc: refused, and B's doc is unchanged", async () => {
    await writeCase(
      (cred, t) =>
        apiReq(
          t,
          cred,
          "DELETE",
          dataPath(side(t).data, "data", COL, docFor(cred, t, "own-del")),
        ),
      dataPath(B.data, "data", COL, "victim"),
      "victim doc",
      B.dataMarker,
    );
  });

  it("PUT data (reset): refused, and B's data is unchanged", async () => {
    await writeCase(
      (cred, t) =>
        apiReq(t, cred, "PUT", dataPath(side(t).reset, "data"), {
          collections: {
            [COL]: {
              ...(cred === A.s.pat && t === T.b
                ? { "from-a": { by: "a" } }
                : { own: { by: t.name, marker: side(t).resetMarker } }),
            },
          },
        }),
      dataPath(B.reset, "data", COL),
      "reset artifact's data",
      B.resetMarker,
    );
  });

  it("GET storage (list)", async () => {
    await crossCheck(
      (cred, t) => apiReq(t, cred, "GET", dataPath(side(t).data, "storage")),
      pat(),
    );
  });

  it("GET storage/:key", async () => {
    await crossCheck(
      (cred, t) =>
        apiReq(t, cred, "GET", dataPath(side(t).data, "storage", "victim")),
      pat(),
    );
  });

  it("PUT storage/:key: refused, and B's key is unchanged", async () => {
    await writeCase(
      (cred, t) =>
        apiReq(
          t,
          cred,
          "PUT",
          dataPath(side(t).data, "storage", docFor(cred, t, "own-put")),
          { value: { from: "redline-put" } },
        ),
      dataPath(B.data, "storage", "victim"),
      "victim storage key",
      B.dataMarker,
    );
  });

  it("DELETE storage/:key: refused, and B's key is unchanged", async () => {
    await writeCase(
      (cred, t) =>
        apiReq(
          t,
          cred,
          "DELETE",
          dataPath(side(t).data, "storage", docFor(cred, t, "own-del")),
        ),
      dataPath(B.data, "storage", "victim"),
      "victim storage key",
      B.dataMarker,
    );
  });
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
