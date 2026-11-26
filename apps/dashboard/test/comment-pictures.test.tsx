// #2508 slice A2: pictures in comments.
import { CommentListSchema, R, viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PICTURE_ROUTES, picturesOf } from "../src/api/commentPictures";
import {
  PICTURE_WORDS,
  PictureNotes,
  usePictureDrawer,
} from "../src/viewer/comments/pictures/drawer";
import { fitSide, isHeic } from "../src/viewer/comments/pictures/shrink";
import { calls, installHarness, mount, mountHosted, server } from "./harness";

// jsdom draws nothing: shrinking is the browser's, so it is stood in for here.
const shrunk = vi.hoisted(() => ({ size: 1000 }));
vi.mock("../src/viewer/comments/pictures/shrink", async (orig) => {
  const real =
    await orig<typeof import("../src/viewer/comments/pictures/shrink")>();
  return {
    ...real,
    shrink: async (f: File) => ({
      blob: new Blob([new Uint8Array(shrunk.size)], { type: f.type }),
      w: 1600,
      h: 1000,
      type: f.type,
    }),
    sha256: async () => "0".repeat(64),
  };
});
// jsdom's Blob can't ride MSW's XHR interceptor; the PUT goes by fetch here
// (the browser path, XHR with progress, is the e2e's).
vi.mock("../src/api/commentPictures", async (orig) => {
  const real = await orig<typeof import("../src/api/commentPictures")>();
  return {
    ...real,
    putBytes: async (
      url: string,
      blob: Blob,
      onProgress: (p: number) => void,
    ) => {
      const res = await fetch(url, {
        method: "PUT",
        body: new Uint8Array(await blob.arrayBuffer()),
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => null))?.error ?? {};
        throw new real.PictureUploadError(
          res.status,
          e.code,
          e.details?.reason,
        );
      }
      onProgress(1);
    },
  };
});
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
const png = (name = "shot.png", type = "image/png") =>
  new File([new Uint8Array(10)], name, { type });

/** The upload routes: a signed URL, and a PUT that can fail once. */
let putFails = 0;
const uploads = () => [
  http.post(`*${PICTURE_ROUTES.upload(OWNED)}`, async ({ request }) => {
    const b = (await request.json()) as { type: string; bytes: number };
    // Merged A1 contract: no w or h from the client.
    expect(Object.keys(b).sort()).toEqual(["bytes", "sha256", "type"]);
    return HttpResponse.json(
      {
        pictureId: `pic-${b.type}-${Math.random().toString(36).slice(2, 6)}`,
        url: "http://localhost/__upload/x",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
      { status: 201 },
    );
  }),
  http.put("http://localhost/__upload/x", () =>
    putFails-- > 0
      ? new HttpResponse(null, { status: 500 })
      : HttpResponse.json({
          id: "p",
          type: "image/png",
          w: 1600,
          h: 1000,
          bytes: 1000,
        }),
  ),
];

beforeEach(() => {
  putFails = 0;
  shrunk.size = 1000;
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
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

describe("shrink rules", () => {
  it("fits the longest side to 1,568px, keeping the shape", () => {
    expect(fitSide(4000, 3000)).toEqual({ w: 1568, h: 1176 });
    expect(fitSide(1200, 5120)).toEqual({ w: 368, h: 1568 });
    expect(fitSide(800, 600)).toEqual({ w: 800, h: 600 });
  });
  it("knows HEIC by type or name", () => {
    expect(isHeic(png("a.heic", ""))).toBe(true);
    expect(isHeic(png("a.HEIF", ""))).toBe(true);
    expect(isHeic(png("a.jpg", "image/heic"))).toBe(true);
    expect(isHeic(png("a.jpg", "image/jpeg"))).toBe(false);
  });
});

describe("the drawer", () => {
  it("uploads, and refuses HEIC and a fifth picture with Product's words", async () => {
    server.use(...uploads());
    const { result } = renderHook(() => usePictureDrawer(OWNED));
    await act(() => result.current.add([png(), png("IMG.HEIC", "image/heic")]));
    expect(result.current.notes).toEqual([PICTURE_WORDS.heic]);
    await waitFor(() => expect(result.current.refs).toHaveLength(1));
    expect(result.current.ready).toBe(true);
    await act(() => result.current.add([png(), png(), png(), png()]));
    expect(result.current.notes).toEqual([PICTURE_WORDS.tooMany]);
    await waitFor(() => expect(result.current.refs).toHaveLength(4));
  });

  it("a failed upload holds the comment; Try again sends it", async () => {
    server.use(...uploads());
    putFails = 1;
    const { result } = renderHook(() => usePictureDrawer(OWNED));
    await act(() => result.current.add([png()]));
    await waitFor(() => expect(result.current.failed).toBe(1));
    expect(result.current.ready).toBe(false);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.refs).toHaveLength(1));
    expect(result.current.failed).toBe(0);
  });

  it("over 10 MB after shrinking: named, with the limit, and not attached", async () => {
    server.use(...uploads());
    shrunk.size = 14 * 1024 * 1024;
    const { result } = renderHook(() => usePictureDrawer(OWNED));
    await act(() => result.current.add([png("board-photo.png")]));
    await waitFor(() =>
      expect(result.current.notes).toEqual([
        '"board-photo.png" is 14 MB. The limit is 10 MB a picture.',
      ]),
    );
    expect(result.current.items).toHaveLength(0);
  });

  it("the server's too_large (reason too_large) on the reservation: named, not attached", async () => {
    server.use(
      http.post(`*${PICTURE_ROUTES.upload(OWNED)}`, () =>
        HttpResponse.json(
          {
            error: {
              code: "too_large",
              message: "A picture can be up to 10 MB.",
              details: { reason: "too_large" },
            },
          },
          { status: 413 },
        ),
      ),
    );
    const { result } = renderHook(() => usePictureDrawer(OWNED));
    await act(() => result.current.add([png("big.png")]));
    await waitFor(() => expect(result.current.notes).toHaveLength(1));
    expect(result.current.notes[0]).toContain('"big.png"');
    expect(result.current.notes[0]).toContain("The limit is 10 MB a picture.");
    expect(result.current.items).toHaveLength(0);
  });

  it("the server's too_large with reason dimensions on the PUT: the same words, not attached", async () => {
    server.use(
      http.put("http://localhost/__upload/x", () =>
        HttpResponse.json(
          {
            error: {
              code: "too_large",
              message: "A picture can be up to 16384 pixels on a side.",
              details: { reason: "dimensions" },
            },
          },
          { status: 413 },
        ),
      ),
      ...uploads(),
    );
    const { result } = renderHook(() => usePictureDrawer(OWNED));
    await act(() => result.current.add([png("wide.png")]));
    await waitFor(() => expect(result.current.notes).toHaveLength(1));
    expect(result.current.notes[0]).toContain("The limit is 10 MB a picture.");
    expect(result.current.items).toHaveLength(0);
    expect(result.current.failed).toBe(0);
  });

  it("the server's unsupported_format (reason heic) shows the HEIC words", async () => {
    server.use(
      http.post(`*${PICTURE_ROUTES.upload(OWNED)}`, () =>
        HttpResponse.json(
          {
            error: {
              code: "unsupported_format",
              message: "HEIC",
              details: { reason: "heic" },
            },
          },
          { status: 400 },
        ),
      ),
    );
    const { result } = renderHook(() => usePictureDrawer(OWNED));
    await act(() => result.current.add([png("a.png")]));
    await waitFor(() =>
      expect(result.current.notes).toEqual([PICTURE_WORDS.heic]),
    );
    expect(result.current.items).toHaveLength(0);
  });

  it("removing a picture takes it out of the box and the refs", async () => {
    server.use(...uploads());
    const { result } = renderHook(() => usePictureDrawer(OWNED));
    await act(() => result.current.add([png("a.png"), png("b.png")]));
    await waitFor(() => expect(result.current.refs).toHaveLength(2));
    act(() => result.current.remove(result.current.items[0]?.key ?? ""));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.refs).toHaveLength(1);
  });

  it("a picture with a mention says it needs words", () => {
    const { result } = renderHook(() => usePictureDrawer(OWNED));
    const r = render(<PictureNotes d={result.current} needWords />);
    expect(r.container.textContent).toBe(PICTURE_WORDS.needWords);
  });

  it("another kind of file is refused out loud, never silently", async () => {
    const { result } = renderHook(() => usePictureDrawer(OWNED));
    await act(() => result.current.add([png("notes.pdf", "application/pdf")]));
    expect(result.current.items).toHaveLength(0);
    expect(result.current.notes).toEqual([
      "Only pictures can go in a comment: PNG, JPEG, GIF or WebP.",
    ]);
  });

  it("failed uploads: one, then two, in Product's words", async () => {
    server.use(...uploads());
    putFails = 2;
    const { result } = renderHook(() => usePictureDrawer(OWNED));
    await act(() => result.current.add([png("a.png")]));
    await waitFor(() => expect(result.current.failed).toBe(1));
    const one = render(<PictureNotes d={result.current} needWords={false} />);
    expect(one.container.textContent).toBe(
      "1 picture didn't upload. Try again, or remove it to send.",
    );
    one.unmount();
    await act(() => result.current.add([png("b.png")]));
    await waitFor(() => expect(result.current.failed).toBe(2));
    const two = render(<PictureNotes d={result.current} needWords={false} />);
    expect(two.container.textContent).toBe(
      "2 pictures didn't upload. Try again, or remove them to send.",
    );
    expect(two.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("in the viewer", () => {
  const col = async () => {
    fireEvent.click(await screen.findByRole("button", { name: /^Comments/ }));
    return screen.findByRole("complementary", { name: "Comments" });
  };
  const noteCard = (c: HTMLElement) =>
    within(c)
      .getByRole("textbox", { name: "Comment on the whole page" })
      .closest("div.flex.flex-col.gap-2.rounded-lg") as HTMLElement;

  it("a member attaches a picture and the new thread carries it", async () => {
    server.use(...uploads());
    const posts = calls("POST");
    mount(viewerPath(OWNED));
    const c = await col();
    const card = noteCard(c);
    const input = card.querySelector("[data-attach-input]") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [png()] } });
    await waitFor(() =>
      expect(
        card.querySelector('[data-attached-picture="done"]'),
      ).not.toBeNull(),
    );
    // The remove button names the file.
    expect(
      within(card).getByRole("button", { name: "Remove picture shot.png" }),
    ).toBeTruthy();
    // A picture alone is enough.
    const send = within(card).getByRole("button", { name: "Comment" });
    expect(send).toBeEnabled();
    fireEvent.click(send);
    await waitFor(() => {
      const p = posts.find((x) => x.path === R.comments(OWNED));
      expect(p?.body).toMatchObject({
        pictures: [{ pictureId: expect.stringMatching(/^pic-/) }],
      });
    });
  });

  it("no picture button for a guest", async () => {
    mountHosted(viewerPath(OWNED), true, (m) => ({
      ...m,
      user: { ...m.user, role: "guest" },
    }));
    await col();
    await new Promise((r) => setTimeout(r, 200));
    expect(document.querySelector("[data-attach-picture]")).toBeNull();
  });

  it("a posted comment shows its pictures, and opens full size", async () => {
    const list = {
      threads: [
        {
          id: "t1",
          anchor: { kind: "note" },
          version: 1,
          status: "open",
          resolvedBy: null,
          resolvedAt: null,
          createdAt: "2026-11-16T10:00:00Z",
          comments: [
            {
              id: "c1",
              body: "",
              author: { kind: "user", name: "Sam Rivera", me: false },
              createdAt: "2026-11-16T10:00:00Z",
              editedAt: null,
              typed: true,
              can: { edit: false, delete: false },
              pictures: [
                {
                  id: "p1",
                  type: "image/png",
                  w: 1600,
                  h: 1000,
                  bytes: 1,
                  alt: "Before",
                },
                { id: "p2", type: "image/png", w: 1600, h: 1000, bytes: 1 },
              ],
            },
          ],
        },
      ],
      open: 1,
      truncated: false,
    };
    // The shared schema keeps `pictures`.
    expect(
      picturesOf(CommentListSchema.parse(list).threads[0]?.comments[0] ?? {}),
    ).toHaveLength(2);
    server.use(
      http.get(`*${R.comments(OWNED)}`, () => HttpResponse.json(list)),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    const thumbs = await within(c).findAllByRole("button", {
      name: /^(Before|Picture 2 of 2)$/,
    });
    expect(thumbs).toHaveLength(2);
    const first = thumbs[0] as HTMLElement;
    expect(first.querySelector("img")?.getAttribute("src")).toBe(
      PICTURE_ROUTES.view(OWNED, "p1"),
    );
    fireEvent.click(thumbs[0] as HTMLElement);
    const lb = await screen.findByRole("dialog", { name: /1 of 2/ });
    expect(
      within(lb).getByRole("link", { name: "Open original" }),
    ).toHaveAttribute("href", PICTURE_ROUTES.view(OWNED, "p1"));
    fireEvent.keyDown(lb, { key: "ArrowRight" });
    await screen.findByRole("dialog", { name: /2 of 2/ });
  });
});
