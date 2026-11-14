// #2287: the shell answers onboarding.get only for the Welcome artifact and
// only for its owner. Anything else is forbidden, with no request made.
import { type ArtifactSummary, R } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridge } from "../src/viewer/bridge";
import { asFrame, FakeFrame, stamped } from "./fake-frame";

const WELCOME = "WmCnEfGhJk4mNpQr";
const art = (id: string, viewer = false) =>
  ({
    id,
    title: "T",
    format: "html",
    // No capabilities: the call has its own gate.
    capabilities: { db: false, viewer, storage: false },
  }) as unknown as ArtifactSummary;
const PROGRESS = {
  dismissed: false,
  completed: false,
  welcomeId: WELCOME,
  welcomeOpened: true,
  agentConnected: true,
  firstArtifact: { id: "Cd5fGhJkLm6nPqRs", title: "Landing page" },
  commented: false,
};

let win = new EventTarget();
const live: { dispose(): void }[] = [];
const post = vi.fn();
const contentWindow = { postMessage: post };
let frame = new FakeFrame(contentWindow);
let fetchMock: ReturnType<typeof vi.fn>;

const send = (data: unknown) => {
  const ev = new Event("message");
  Object.assign(ev, {
    data: stamped(frame, data),
    source: contentWindow,
    origin: "null",
  });
  win.dispatchEvent(ev);
};
const flush = () => new Promise((r) => setTimeout(r, 0));
const ask = async (artifact: ArtifactSummary, gate: { owner: boolean }) => {
  live.push(
    createBridge({
      iframe: asFrame(frame),
      url: "https://content.test/a/v1/index.html",
      artifact,
      version: 1,
      viewer: { email: "a@b.c", name: "A" },
      onboarding: () => gate,
      theme: "light",
      onPdfText: vi.fn(),
      onThumb: vi.fn(),
    }),
  );
  send({ oa: 1, type: "call", id: "c1", method: "onboarding.get", params: {} });
  await flush();
  return post.mock.calls[0]?.[0];
};

beforeEach(() => {
  frame = new FakeFrame(contentWindow);
  win = new EventTarget();
  post.mockReset();
  fetchMock = vi.fn(
    async () => new Response(JSON.stringify(PROGRESS), { status: 200 }),
  );
  vi.stubGlobal("window", win);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", { protocol: "https:", host: "app.test" });
});
afterEach(() => {
  for (const b of live.splice(0)) b.dispose();
  vi.unstubAllGlobals();
});

describe("onboarding.get", () => {
  it("answers the owner on the Welcome artifact at the first call, with one fetch", async () => {
    // A direct load: nothing else has been loaded, only who is viewing.
    const r = await ask(art(WELCOME), { owner: true });
    expect(r).toMatchObject({
      ok: true,
      value: {
        agentConnected: true,
        firstArtifact: { id: "Cd5fGhJkLm6nPqRs", title: "Landing page" },
        commented: false,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain(R.onboarding);
  });

  it("answers without the viewer capability", async () => {
    const r = await ask(art(WELCOME, false), { owner: true });
    expect(r.ok).toBe(true);
  });

  it("refuses any other artifact, whatever the Welcome's id", async () => {
    const r = await ask(art("OtherArtifact0001"), { owner: true });
    expect(r).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("refuses someone who is not the owner, with no request", async () => {
    const r = await ask(art(WELCOME), { owner: false });
    expect(r).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when no Welcome was seeded", async () => {
    for (const welcomeId of [undefined, null]) {
      post.mockReset();
      frame = new FakeFrame(contentWindow);
      fetchMock.mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ dismissed: false, completed: false, welcomeId }),
            { status: 200 },
          ),
      );
      const r = await ask(art(WELCOME), { owner: true });
      expect(r).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
  });

  it("gives an unset flag as not done", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            dismissed: false,
            completed: false,
            welcomeId: WELCOME,
          }),
          { status: 200 },
        ),
    );
    const r = await ask(art(WELCOME), { owner: true });
    expect(r.value).toEqual({
      agentConnected: false,
      firstArtifact: null,
      commented: false,
      agentNamed: false,
      agentName: null,
      mentionReplied: false,
      mentionStalled: false,
      askAnswered: false,
    });
  });
});
