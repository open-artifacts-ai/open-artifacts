// Mock-only (#2508 slice A2): the PROVISIONAL picture routes
// (api/commentPictures.ts) over the shared mocks. Loaded only with VITE_MOCK.
// - POST comment-pictures answers a signed URL on this origin; PUT stores
//   the bytes; GET serves them (or a drawn stand-in for fixture pictures).
// - A new thread or reply keeps its `pictures`, and the list shows them.
// - ?mock=pictures: the first thread's first comment has two pictures and
//   its reply one; &picfail=1: the first upload fails once; e2e may hold
//   uploads with window.__oaPicHold = true and window.__oaPicRelease().
import { getResponse, type HttpHandler, HttpResponse, http } from "msw";

type Pic = {
  id: string;
  type: string;
  w: number;
  h: number;
  bytes: number;
  alt?: string;
};

const STAND_IN = (hue: number, label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 82%)"/><stop offset="1" stop-color="hsl(${hue + 30} 55% 92%)"/></linearGradient></defs><rect width="1280" height="800" fill="url(#g)"/><rect x="90" y="90" width="620" height="70" rx="10" fill="#fff" opacity=".8"/><rect x="90" y="200" width="1100" height="500" rx="16" fill="#fff" opacity=".55"/><text x="110" y="140" font-family="system-ui" font-size="40" font-weight="700" fill="#15181c">${label}</text></svg>`;

export function pictureHandlers(
  main: HttpHandler[],
  params: URLSearchParams,
): HttpHandler[] {
  const bytes = new Map<string, Blob>();
  const meta = new Map<string, Pic>();
  const onComment = new Map<string, Pic[]>();
  const blank = new Set<string>();
  let n = 0;
  let failOnce = params.get("picfail") === "1";
  const fixture = params.get("mock") === "pictures";
  const fixturePics: Pic[] = [
    {
      id: "fx_before",
      type: "image/svg+xml",
      w: 1280,
      h: 800,
      bytes: 1,
      alt: "Before: the comments view at 760px.",
    },
    {
      id: "fx_after",
      type: "image/svg+xml",
      w: 1280,
      h: 800,
      bytes: 1,
      alt: "After: one row of buttons.",
    },
  ];
  const fixtureReply: Pic[] = [
    { id: "fx_error", type: "image/svg+xml", w: 1280, h: 800, bytes: 1 },
  ];
  const ZW = "​";
  const hold = () =>
    new Promise<void>((ok) => {
      const w = window as unknown as {
        __oaPicHold?: boolean;
        __oaPicRelease?: () => void;
      };
      if (!w.__oaPicHold) return ok();
      const prev = w.__oaPicRelease;
      w.__oaPicRelease = () => {
        prev?.();
        ok();
      };
    });

  /** The shared handler answers with the body we pass; pictures ride on top. */
  const withPictures = async (request: Request) => {
    const raw = (await request.clone().json()) as {
      body?: string;
      pictures?: { pictureId: string; alt?: string }[];
    };
    const pics = (raw.pictures ?? []).flatMap((r) => {
      const m = meta.get(r.pictureId);
      return m ? [{ ...m, ...(r.alt ? { alt: r.alt } : {}) }] : [];
    });
    const empty = pics.length > 0 && !raw.body?.trim();
    const { pictures: _p, ...rest } = raw;
    const forward = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(empty ? { ...rest, body: ZW } : rest),
    });
    const res = await getResponse(main, forward);
    if (!res?.ok || pics.length === 0) return res;
    const out = (await res.json()) as {
      id: string;
      body: string;
      comments?: { id: string; body: string }[];
    };
    const c = out.comments ? out.comments[0] : out;
    if (!c) return HttpResponse.json(out, { status: res.status });
    onComment.set(c.id, pics);
    if (empty) {
      blank.add(c.id);
      c.body = "";
    }
    (c as { pictures?: Pic[] }).pictures = pics;
    return HttpResponse.json(out, { status: res.status });
  };

  return [
    http.post(
      "*/api/v1/artifacts/:id/comment-pictures",
      async ({ request }) => {
        const b = (await request.json()) as {
          type: string;
          bytes: number;
          w: number;
          h: number;
        };
        if (/hei[cf]/i.test(b.type))
          return HttpResponse.json(
            { error: { code: "unsupported_format", message: "HEIC" } },
            { status: 400 },
          );
        const id = `pic_${++n}`;
        meta.set(id, { id, type: b.type, w: b.w, h: b.h, bytes: b.bytes });
        return HttpResponse.json({
          pictureId: id,
          url: `${location.origin}/__mock-upload/${id}`,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
      },
    ),
    http.put("*/__mock-upload/:pid", async ({ request, params: p }) => {
      await hold();
      if (failOnce) {
        failOnce = false;
        return new HttpResponse(null, { status: 500 });
      }
      bytes.set(String(p.pid), await request.blob());
      return new HttpResponse(null, { status: 200 });
    }),
    http.get(
      "*/api/v1/artifacts/:id/comment-pictures/:pid",
      ({ params: p }) => {
        const pid = String(p.pid);
        const b = bytes.get(pid);
        if (b)
          return new HttpResponse(b, { headers: { "Content-Type": b.type } });
        if (pid.startsWith("fx_"))
          return new HttpResponse(
            STAND_IN(
              pid === "fx_after" ? 140 : pid === "fx_error" ? 10 : 220,
              pid === "fx_after"
                ? "After"
                : pid === "fx_error"
                  ? "Error"
                  : "Before",
            ),
            { headers: { "Content-Type": "image/svg+xml" } },
          );
        return new HttpResponse(null, { status: 404 });
      },
    ),
    http.post("*/api/v1/artifacts/:id/comments", ({ request }) =>
      withPictures(request),
    ),
    http.post(
      "*/api/v1/artifacts/:id/comments/:thread/replies",
      ({ request }) => withPictures(request),
    ),
    http.get("*/api/v1/artifacts/:id/comments", async ({ request }) => {
      const res = await getResponse(main, request);
      if (!res?.ok) return res;
      const list = (await res.json()) as {
        threads: {
          comments: { id: string; body: string; pictures?: Pic[] }[];
        }[];
      };
      for (const [ti, t] of list.threads.entries())
        for (const [ci, c] of t.comments.entries()) {
          const own = onComment.get(c.id);
          if (own) c.pictures = own;
          if (blank.has(c.id)) c.body = "";
          if (fixture && ti === 0 && ci === 0) c.pictures = fixturePics;
          if (fixture && ti === 0 && ci === 1) c.pictures = fixtureReply;
        }
      return HttpResponse.json(list);
    }),
  ];
}
