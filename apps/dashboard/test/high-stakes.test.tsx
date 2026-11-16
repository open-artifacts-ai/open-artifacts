// #2661 part A: the ask card with the high-stakes mark (PROVISIONAL
// api/highStakes.ts).
import { R, viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cardMarks, MarkedListSchema } from "../src/api/highStakes";
import { calls, installHarness, mount, server } from "./harness";

vi.mock("../src/viewer/bridge", async () => {
  const { loadArtifactFrame } = await import("../src/viewer/frame");
  return {
    createBridge: (o: { iframe: HTMLIFrameElement; url: string }) => {
      loadArtifactFrame(o.iframe, o.url);
      return {
        dispose: () => {},
        requestThumbnail: () => {},
        setTheme: () => {},
        setArtifact: () => {},
        scrollTo: () => {},
        setCommentsMode: () => {},
        setComments: () => {},
        focusComment: () => {},
        commentOnSelection: () => {},
        clearSelection: () => {},
      };
    },
  };
});

installHarness();

const OWNED = (
  fixtures.artifacts.find((a) => a.title === "Landing page") as { id: string }
).id;
const REASON = "Picking Send emails all 240 customers. It can't be undone.";
const me = { kind: "user", id: fixtures.me.user.id, name: "Ada", me: true };

const list = (
  options: object[],
  extra: object = {},
  author: object = {
    kind: "agent",
    id: fixtures.me.user.id,
    name: "OA Bus",
    for: "Ada",
    linked: true,
    me: false,
  },
) => ({
  threads: [
    {
      id: "t1",
      anchor: { kind: "note" },
      version: 1,
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
      createdAt: "2026-11-16T15:00:00Z",
      comments: [
        {
          id: "c1",
          body: "Pick what happens next.",
          author,
          createdAt: "2026-11-16T15:00:00Z",
          editedAt: null,
          typed: false,
          can: { edit: false, delete: false },
          ask: {
            question: "Send the proposal?",
            options,
            to: [me],
            decider: me,
            role: "decide",
            picks: [],
            closed: false,
            ...extra,
          },
        },
      ],
    },
  ],
  open: 1,
  truncated: false,
});
const marked = (needs = true) => ({
  id: "send",
  label: "Send it",
  highStakes: { reason: REASON },
  ...(needs ? { passkey: true } : {}),
});
const plainOpts = [
  { id: "changes", label: "Changes first" },
  { id: "no", label: "No" },
];

beforeEach(() => {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches: q === "(min-width: 960px)",
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
});

const card = async (body: object) => {
  server.use(
    http.get(`*${R.comments(OWNED)}`, () => HttpResponse.json(body)),
    http.post(`*${R.commentAnswerChallenge(OWNED, "t1", "c1")}`, () =>
      HttpResponse.json(
        { error: { code: "no_passkey", message: "No passkey" } },
        { status: 409 },
      ),
    ),
    http.post(`*${R.commentAnswer(OWNED, "t1", "c1")}`, () =>
      HttpResponse.json(
        (body as ReturnType<typeof list>).threads[0]?.comments[0],
      ),
    ),
  );
  mount(viewerPath(OWNED));
  fireEvent.click(await screen.findByRole("button", { name: /^Comments/ }));
  const c = await screen.findByRole("complementary", { name: "Comments" });
  return (await within(c).findByText("Send the proposal?")).closest(
    "[data-ask]",
  ) as HTMLElement;
};
const opt = (el: HTMLElement, id: string) =>
  el.querySelector(`[data-option="${id}"]`) as HTMLButtonElement;

describe("cardMarks", () => {
  it("collects reasons and says what caused a prompt", () => {
    expect(cardMarks({ options: [marked(), ...plainOpts] })).toEqual({
      reasons: [REASON],
      marked: [{ label: "Send it", reason: REASON }],
      markedNeeds: true,
      every: false,
    });
    expect(
      cardMarks({
        options: [
          { id: "a", label: "A", passkey: true },
          { id: "b", label: "B", passkey: true },
        ],
      }),
    ).toEqual({ reasons: [], marked: [], markedNeeds: false, every: true });
    expect(cardMarks({ options: [marked(false)] }).markedNeeds).toBe(false);
  });
  it("the adapter keeps the mark and the stamps", () => {
    const o = MarkedListSchema.parse(
      list([marked(), ...plainOpts], { passkeyMissing: true }),
    ).threads[0]?.comments[0]?.ask;
    expect(o?.options[0]).toMatchObject({
      highStakes: { reason: REASON },
      passkey: true,
    });
    expect(o?.passkeyMissing).toBe(true);
  });
});

describe("the card", () => {
  it("shows the mark and the asker's words; only the marked option needs the passkey", async () => {
    const el = await card(list([marked(), ...plainOpts]));
    const hs = el.querySelector("[data-high-stakes]") as HTMLElement;
    expect(hs.textContent).toContain("High stakes · needs your passkey");
    expect(hs.textContent).toContain(`OA Bus says: "${REASON}"`);
    expect(opt(el, "send").textContent).toContain("High stakes");
    expect(opt(el, "send").querySelector("[data-passkey-hint]")).not.toBeNull();
    expect(opt(el, "changes").querySelector("[data-passkey-hint]")).toBeNull();
  });

  it("an unmarked option is one tap; the marked one asks for the passkey", async () => {
    const posts = calls("POST");
    const el = await card(list([marked(), ...plainOpts]));
    fireEvent.click(opt(el, "changes"));
    await waitFor(() =>
      expect(
        posts.find((p) => p.path === R.commentAnswer(OWNED, "t1", "c1"))?.body,
      ).toEqual({ optionId: "changes" }),
    );
    expect(
      posts.some((p) => p.path === R.commentAnswerChallenge(OWNED, "t1", "c1")),
    ).toBe(false);
  });

  it("the marked option goes through the challenge", async () => {
    const posts = calls("POST");
    const el = await card(list([marked(), ...plainOpts]));
    fireEvent.click(opt(el, "send"));
    await waitFor(() =>
      expect(
        posts.some(
          (p) => p.path === R.commentAnswerChallenge(OWNED, "t1", "c1"),
        ),
      ).toBe(true),
    );
    // No passkey: one button to Settings, Security.
    expect(
      await within(el).findByRole("link", {
        name: "Add a passkey to approve this",
      }),
    ).toHaveAttribute("href", "/settings/security");
  });

  it("no passkey yet: one button, marked options wait, the rest stay one tap", async () => {
    const el = await card(
      list([marked(), ...plainOpts], { passkeyMissing: true }),
    );
    expect(
      within(el).getByRole("link", { name: "Add a passkey to approve this" }),
    ).toHaveAttribute("href", "/settings/security");
    expect(opt(el, "send")).toBeDisabled();
    expect(opt(el, "no")).toBeEnabled();
  });

  it("every answer says so", async () => {
    const el = await card(
      list([
        { id: "a", label: "Send it", passkey: true },
        { id: "b", label: "No", passkey: true },
      ]),
    );
    expect(el.textContent).toContain(
      "You've chosen to confirm every answer with your passkey.",
    );
    expect(el.querySelector("[data-high-stakes]")).toBeNull();
  });

  it("the switch off: the mark and reason, no passkey", async () => {
    const el = await card(list([marked(false), ...plainOpts]));
    const hs = el.querySelector("[data-high-stakes]") as HTMLElement;
    expect(hs.textContent).not.toContain("needs your passkey");
    expect(hs.textContent).toContain(`OA Bus says: "${REASON}"`);
    expect(el.querySelector("[data-passkey-hint]")).toBeNull();
  });

  it("two marked options: the asker once, then one line each (Design)", async () => {
    const el = await card(
      list([
        marked(),
        {
          id: "tomorrow",
          label: "Send tomorrow",
          highStakes: { reason: "It emails all 240 customers at 9:00." },
          passkey: true,
        },
        ...plainOpts,
      ]),
    );
    const hs = el.querySelector("[data-high-stakes]") as HTMLElement;
    expect(hs.textContent).toContain("OA Bus says:");
    expect(hs.textContent).not.toContain(`OA Bus says: "`);
    expect(
      [...hs.querySelectorAll("[data-high-stakes-reason]")].map(
        (x) => x.textContent,
      ),
    ).toEqual([
      `Send it: "${REASON}"`,
      'Send tomorrow: "It emails all 240 customers at 9:00."',
    ]);
  });

  it("a person's own ask: their name on the reason", async () => {
    const el = await card(
      list(
        [marked(), ...plainOpts],
        {},
        {
          kind: "user",
          id: "sam",
          name: "Sam Rivera",
          me: false,
        },
      ),
    );
    expect(el.textContent).toContain(`Sam Rivera says: "${REASON}"`);
  });
});
