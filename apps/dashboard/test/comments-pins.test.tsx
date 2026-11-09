import { ANON_ID_HEADER, R, viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fullPath } from "../src/viewer/paths";
import {
  calls,
  events,
  installHarness,
  lastClient,
  mount,
  server,
  wait,
} from "./harness";

type Opts = {
  iframe: HTMLIFrameElement;
  url: string;
  onHello: () => void;
  onInteracted: () => void;
  onCommentSelect: (a: unknown) => void;
  onCommentPositions: (p: unknown[]) => void;
  onCommentOpen: (id: string) => void;
  onCommentEscape: () => void;
  onCommentPin: (p: { x: number; y: number; page?: number }) => void;
};
const opts: Opts[] = [];
const setMode = vi.fn();
const setComments = vi.fn();
const focus = vi.fn();
// Like the real bridge, the mock loads the frame (Shell ignores earlier loads).
vi.mock("../src/viewer/bridge", async () => {
  const { loadArtifactFrame } = await import("../src/viewer/frame");
  return {
    createBridge: (o: Opts) => {
      loadArtifactFrame(o.iframe, o.url);
      opts.push(o);
      return {
        dispose: () => {},
        requestThumbnail: () => {},
        setTheme: () => {},
        setArtifact: () => {},
        scrollTo: () => {},
        setCommentsMode: setMode,
        setComments,
        focusComment: focus,
      };
    },
  };
});

installHarness();

const OWNED = (
  fixtures.artifacts.find((a) => a.title === "Landing page") as { id: string }
).id;
const PUBLIC = (
  fixtures.artifacts.find((a) => a.title === "Q4 report") as { id: string }
).id;

const viewport = (width: number, coarse = false) => {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches:
          q === "(pointer: coarse)"
            ? coarse
            : q === "(min-width: 960px)"
              ? width >= 960
              : q === "(max-width: 600px)"
                ? width <= 600
                : false,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
};
const hello = () =>
  act(async () => {
    await waitFor(() => expect(opts.length).toBeGreaterThan(0));
    opts.at(-1)?.onHello();
  });
/** The column opens by itself only when there is something to show: open it. */
const col = async () => {
  const b = await screen.findByRole("button", { name: /^Comments/ });
  if (!screen.queryByRole("complementary", { name: "Comments" }))
    fireEvent.click(b);
  return screen.findByRole("complementary", { name: "Comments" });
};

type Pin = { x: number; y: number; page?: number };
const onPin = (p: Pin) => act(async () => opts.at(-1)?.onCommentPin(p));

const CAN = {
  edit: true,
  share: true,
  setVisibility: true,
  delete: true,
  transfer: false,
  move: false,
  dataWrite: true,
};

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

const pinThread = (id: string, n: number, hash: string | null) => ({
  id,
  anchor: { kind: "pin", version: 2, x: 0.25, y: 0.5, contentHash: hash },
  version: 2,
  status: "open",
  resolvedBy: null,
  resolvedAt: null,
  createdAt: `2026-11-05T10:0${n}:00Z`,
  comments: [
    {
      id: `c${id}`,
      body: `note ${id}`,
      author: { kind: "guest", name: "Guest", me: false },
      createdAt: `2026-11-05T10:0${n}:00Z`,
      editedAt: null,
      can: { edit: false, delete: false },
    },
  ],
});

/** OWNED as an image (or pdf) artifact whose shown version has this hash. */
function asFormat(
  format: "image" | "pdf" | "html",
  hash: string | null,
  o: { comment?: boolean; threads?: unknown[] } = {},
) {
  const art = fixtures.artifacts.find((a) => a.id === OWNED);
  const ver = fixtures.versions[OWNED]?.[0];
  server.use(
    http.get(`*${R.artifact(OWNED)}`, () =>
      HttpResponse.json({
        ...art,
        format,
        ...(o.comment === false ? { can: { ...CAN, comment: false } } : {}),
      }),
    ),
    http.get(`*${R.versions(OWNED)}`, () =>
      HttpResponse.json([{ ...ver, format, contentHash: hash }]),
    ),
    http.get(`*${R.comments(OWNED)}`, () =>
      HttpResponse.json({
        threads: o.threads ?? [],
        open: (o.threads ?? []).length,
        truncated: false,
      }),
    ),
  );
}

beforeEach(() => {
  opts.length = 0;
  setMode.mockClear();
  setComments.mockClear();
  focus.mockClear();
  viewport(1280);
});
afterEach(() => vi.restoreAllMocks());

const tool = (name: string) => screen.findByRole("button", { name });

describe("a pin whose page changed reaches the frame (#1657)", () => {
  it("the shell sends changed:true for a pin stamped with another version's hash", async () => {
    asFormat("image", H2, { threads: [pinThread("p1", 1, H1)] });
    mount(viewerPath(OWNED));
    await col();
    await hello();
    await waitFor(() => {
      const sent = setComments.mock.calls.at(-1)?.[0] as
        | { id: string; changed?: boolean }[]
        | undefined;
      expect(sent?.find((t) => t.id === "p1")?.changed).toBe(true);
    });
  });

  it("and sends no flag when the pin's hash is the shown version's", async () => {
    asFormat("image", H1, { threads: [pinThread("p1", 1, H1)] });
    mount(viewerPath(OWNED));
    await col();
    await hello();
    await waitFor(() => {
      const sent = setComments.mock.calls.at(-1)?.[0] as
        | { id: string; changed?: boolean }[]
        | undefined;
      expect(sent?.find((t) => t.id === "p1")).not.toHaveProperty("changed");
    });
  });
});

describe("comments: pins on images and pdfs (#1490)", () => {
  it("an image opens in Pin mode, says what to do, and Select reaches text selection", async () => {
    asFormat("image", H1);
    mount(viewerPath(OWNED));
    await col();
    await hello();
    // #1657, spec 6: an image starts in Pin; a pdf starts in Select.
    expect(await tool("Pin")).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByText("Click to place a pin")).toBeInTheDocument();
    // #1698: the default is not a mode the reader chose, so Esc is not offered
    // for it and does not take it away.
    expect(screen.queryByText(/Esc to cancel/)).toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await wait(30);
    expect(await tool("Pin")).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(setMode).toHaveBeenLastCalledWith("pin"));
    fireEvent.click(await tool("Select"));
    await waitFor(() => expect(setMode).toHaveBeenLastCalledWith("select"));
    expect(screen.queryByText("Click to place a pin")).toBeNull();
    // And back: Pin is one click away, and now the choice is the reader's.
    fireEvent.click(await tool("Pin"));
    expect(await screen.findByText("Click to place a pin")).toBeInTheDocument();
    expect(screen.getByText(/Esc to cancel/)).toBeInTheDocument();
    // Esc leaves that pin mode.
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(setMode).toHaveBeenLastCalledWith("select"));
    expect(screen.queryByText("Click to place a pin")).toBeNull();
  });

  it("a pdf opens in Select mode (#1657)", async () => {
    asFormat("pdf", H1);
    mount(viewerPath(OWNED));
    await col();
    await hello();
    expect(await tool("Select")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Click to place a pin")).toBeNull();
  });

  it("keeps a cue on the page when pin mode is on and the comments column is closed", async () => {
    asFormat("image", H1);
    mount(viewerPath(OWNED));
    await col();
    fireEvent.click(await tool("Pin"));
    // The list shows its own cue: one hint, no bar.
    expect(await screen.findAllByText("Click to place a pin")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /^Comments/ }));
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Comments" }),
      ).toBeNull(),
    );
    const bar = (await screen.findByText("Click to place a pin")).closest(
      "[role=status]",
    ) as HTMLElement;
    expect(within(bar).getByText("Click to place a pin")).toBeInTheDocument();
    fireEvent.click(within(bar).getByRole("button", { name: "Select" }));
    await waitFor(() =>
      expect(screen.queryByText("Click to place a pin")).toBeNull(),
    );
  });

  it("says Tap on a touch screen", async () => {
    asFormat("image", H1);
    viewport(1280, true);
    mount(viewerPath(OWNED));
    await col();
    fireEvent.click(await tool("Pin"));
    expect(await screen.findByText("Tap to place a pin")).toBeInTheDocument();
    expect(screen.queryByText(/Esc to cancel/)).toBeNull();
  });

  it("the frame's Esc (comment.escape) leaves pin mode", async () => {
    asFormat("pdf", H1);
    mount(viewerPath(OWNED));
    await col();
    fireEvent.click(await tool("Pin"));
    await waitFor(() => expect(setMode).toHaveBeenLastCalledWith("pin"));
    await act(async () => opts.at(-1)?.onCommentEscape());
    await waitFor(() => expect(setMode).toHaveBeenLastCalledWith("select"));
  });

  it("a forged comment.escape outside pin mode does nothing", async () => {
    asFormat("pdf", H1);
    mount(viewerPath(OWNED));
    await col();
    setMode.mockClear();
    await act(async () => opts.at(-1)?.onCommentEscape());
    expect(screen.getByRole("button", { name: "Select" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("in full screen, the first Esc leaves pin mode and the second leaves full screen", async () => {
    asFormat("pdf", H1);
    viewport(1280);
    const router = mount(fullPath(OWNED));
    fireEvent.click(await screen.findByRole("button", { name: /^Comments/ }));
    const sheet = await screen.findByRole("dialog", { name: "Comments" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Pin" }));
    await waitFor(() => expect(setMode).toHaveBeenLastCalledWith("pin"));
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(setMode).toHaveBeenLastCalledWith("select"));
    await wait(30);
    expect(router.state.location.pathname).toBe(fullPath(OWNED));
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(viewerPath(OWNED)),
    );
  });

  it("an image's default pin mode falls back to Select once a pin is placed (#1698)", async () => {
    asFormat("image", H1);
    mount(viewerPath(OWNED));
    await col();
    expect(await tool("Pin")).toHaveAttribute("aria-pressed", "true");
    // The reader never chose Pin, so the draft takes the mode back: the next
    // gesture is not another pin.
    await onPin({ x: 0.25, y: 0.75 });
    await screen.findByRole("textbox", { name: "Add a comment" });
    expect(await tool("Select")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Click to place a pin")).toBeNull();
  });

  it("Esc in a text field, an IME or a modal does not leave a chosen pin mode (#1698)", async () => {
    asFormat("image", H1);
    mount(viewerPath(OWNED));
    const c = await col();
    fireEvent.click(await tool("Select"));
    fireEvent.click(await tool("Pin"));
    await waitFor(() => expect(setMode).toHaveBeenLastCalledWith("pin"));
    setMode.mockClear();
    // A composer's box owns Esc (it cancels the draft): pin mode stays.
    const box = within(c).getByRole("textbox", {
      name: "Comment on the whole page",
    });
    fireEvent.keyDown(box, { key: "Escape" });
    // An IME composition owns it too.
    fireEvent.keyDown(document.body, { key: "Escape", isComposing: true });
    // So does a modal above the viewer, whether it says aria-modal or is a
    // Radix dialog in its open state.
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    const inside = document.createElement("button");
    modal.append(inside);
    document.body.append(modal);
    inside.focus();
    fireEvent.keyDown(inside, { key: "Escape" });
    const radix = document.createElement("div");
    radix.setAttribute("role", "dialog");
    radix.setAttribute("data-state", "open");
    const inRadix = document.createElement("button");
    radix.append(inRadix);
    document.body.append(radix);
    fireEvent.keyDown(inRadix, { key: "Escape" });
    // ...but not the comments sheet, which is a plain role=dialog: its Esc
    // still leaves the pin mode the reader chose.
    expect(setMode).not.toHaveBeenCalledWith("select");
    radix.remove();
    expect(await tool("Pin")).toHaveAttribute("aria-pressed", "true");
    modal.remove();
    // Outside all three, Esc still leaves the mode the reader chose.
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(setMode).toHaveBeenLastCalledWith("select"));
  });

  it("a comment.pin on an image outside pin mode is ignored (page code can forge it)", async () => {
    asFormat("image", H1);
    mount(viewerPath(OWNED));
    await col();
    fireEvent.click(await tool("Select"));
    await waitFor(() => expect(setMode).toHaveBeenLastCalledWith("select"));
    await onPin({ x: 0.5, y: 0.5 });
    await wait(30);
    expect(screen.queryByRole("textbox", { name: "Add a comment" })).toBeNull();
  });

  it("in full screen on an image, the first Esc closes full screen, not the default pin mode (#1698)", async () => {
    asFormat("image", H1);
    viewport(1280);
    const router = mount(fullPath(OWNED));
    fireEvent.click(await screen.findByRole("button", { name: /^Comments/ }));
    const sheet = await screen.findByRole("dialog", { name: "Comments" });
    // The image's own default: pin mode the reader never chose.
    expect(within(sheet).getByRole("button", { name: "Pin" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    setMode.mockClear();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(viewerPath(OWNED)),
    );
    expect(setMode).not.toHaveBeenCalledWith("select");
  });

  it("in full screen on an image, a chosen pin mode takes the first Esc (#1698)", async () => {
    asFormat("image", H1);
    viewport(1280);
    const router = mount(fullPath(OWNED));
    fireEvent.click(await screen.findByRole("button", { name: /^Comments/ }));
    const sheet = await screen.findByRole("dialog", { name: "Comments" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Select" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Pin" }));
    await waitFor(() => expect(setMode).toHaveBeenLastCalledWith("pin"));
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(setMode).toHaveBeenLastCalledWith("select"));
    await wait(30);
    expect(router.state.location.pathname).toBe(fullPath(OWNED));
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(viewerPath(OWNED)),
    );
  });

  it("offers pins on a pdf but not on html", async () => {
    asFormat("pdf", H1);
    mount(viewerPath(OWNED));
    await col();
    expect(await tool("Pin")).toBeInTheDocument();
  });

  it("offers no Pin tool on html", async () => {
    asFormat("html", H1);
    mount(viewerPath(OWNED));
    await col();
    await screen.findByText(/No comments yet/);
    expect(screen.queryByRole("button", { name: "Pin" })).toBeNull();
  });

  it("a comment.pin outside pin mode is ignored (page code can forge it)", async () => {
    asFormat("pdf", H1);
    mount(viewerPath(OWNED));
    await col();
    await onPin({ x: 0.5, y: 0.5 });
    await wait(30);
    expect(screen.queryByRole("textbox", { name: "Add a comment" })).toBeNull();
  });

  it("a comment.pin from a viewer who can't comment is ignored, and they get no tools", async () => {
    asFormat("image", H1, { comment: false });
    mount(viewerPath(OWNED));
    await col();
    await screen.findByText(/No comments yet/);
    expect(screen.queryByRole("button", { name: "Pin" })).toBeNull();
    await onPin({ x: 0.5, y: 0.5 });
    await wait(30);
    expect(screen.queryByRole("textbox", { name: "Add a comment" })).toBeNull();
  });

  it("a placed pin becomes a draft; nothing posts until submit, and the client sends no contentHash", async () => {
    asFormat("image", H1);
    const posts = calls("POST");
    mount(viewerPath(OWNED));
    await col();
    fireEvent.click(await tool("Pin"));
    await onPin({ x: 0.25, y: 0.75 });
    const box = await screen.findByRole("textbox", { name: "Add a comment" });
    expect(screen.getByText("New pin")).toBeInTheDocument();
    // #1698: the reader chose Pin, so that choice holds for the view: the
    // next pin is one click away.
    expect(screen.getByText("Click to place a pin")).toBeInTheDocument();
    await wait(30);
    expect(posts).toHaveLength(0);
    fireEvent.change(box, { target: { value: "Here" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.body).toMatchObject({
      anchor: { kind: "pin", version: 2, x: 0.25, y: 0.75 },
      body: "Here",
    });
    const sent = posts[0]?.body as { anchor: Record<string, unknown> };
    expect(sent.anchor).not.toHaveProperty("contentHash");
  });

  it("shows a ghost pin at the click while composing, cleared on cancel and on post", async () => {
    asFormat("image", H1);
    mount(viewerPath(OWNED));
    await col();
    const ghost = () =>
      setComments.mock.calls.at(-1)?.[1] as
        | { x: number; y: number }
        | undefined;
    fireEvent.click(await tool("Pin"));
    await onPin({ x: 0.25, y: 0.75 });
    const box = await screen.findByRole("textbox", { name: "Add a comment" });
    await waitFor(() => expect(ghost()).toEqual({ x: 0.25, y: 0.75 }));
    // Cancel removes it.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(ghost()).toBeUndefined());
    // Place again and post: the real pin replaces it.
    fireEvent.click(await tool("Pin"));
    await onPin({ x: 0.5, y: 0.5 });
    const box2 = await screen.findByRole("textbox", { name: "Add a comment" });
    await waitFor(() => expect(ghost()).toEqual({ x: 0.5, y: 0.5 }));
    fireEvent.change(box2, { target: { value: "Here" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(ghost()).toBeUndefined());
    expect(box).toBeDefined();
  });

  it("numbers pin cards and focuses the pin on click", async () => {
    asFormat("image", H1, {
      threads: [pinThread("a", 1, H1), pinThread("b", 2, H1)],
    });
    mount(viewerPath(OWNED));
    const c = await col();
    await within(c).findByText("Pin 2");
    expect(within(c).getByText("Pin 1")).toBeInTheDocument();
    fireEvent.click(
      within(c).getByRole("button", { name: "Show pin 2 in page" }),
    );
    await waitFor(() => expect(focus).toHaveBeenCalledWith("b"));
  });

  it("says the image or page changed only when both hashes are known and differ", async () => {
    asFormat("image", H2, { threads: [pinThread("a", 1, H1)] });
    mount(viewerPath(OWNED));
    expect(
      await screen.findByText("The image changed since this was placed."),
    ).toBeInTheDocument();
  });

  it("says This file changed on a pdf (the hash covers the whole file)", async () => {
    asFormat("pdf", H2, { threads: [pinThread("a", 1, H1)] });
    mount(viewerPath(OWNED));
    expect(
      await screen.findByText("This file changed since this was placed."),
    ).toBeInTheDocument();
  });

  it("says nothing when the hashes match, or the shown version's is unknown", async () => {
    asFormat("image", H1, { threads: [pinThread("a", 1, H1)] });
    mount(viewerPath(OWNED));
    await screen.findByText("Pin 1");
    expect(screen.queryByText(/changed since this was placed/)).toBeNull();
  });

  it("says nothing when the pin's own hash is null, even if the version's is known", async () => {
    asFormat("image", H2, { threads: [pinThread("a", 1, null)] });
    mount(viewerPath(OWNED));
    await screen.findByText("Pin 1");
    expect(screen.queryByText(/changed since this was placed/)).toBeNull();
  });

  it("says nothing when the shown version has no hash", async () => {
    asFormat("image", null, { threads: [pinThread("a", 1, H1)] });
    mount(viewerPath(OWNED));
    await screen.findByText("Pin 1");
    expect(screen.queryByText(/changed since this was placed/)).toBeNull();
  });
});
