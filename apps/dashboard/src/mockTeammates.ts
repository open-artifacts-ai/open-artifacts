// PROVISIONAL (#2577 s2): mock-only teammates, `memberId` on shares and
// `listensAsked` on onboarding, over the shared mocks. Delete with
// src/api/teammates.ts once the shared mocks serve them.
import { getResponse, type HttpHandler, HttpResponse, http } from "msw";
import { LISTENS_ASKED, ME_TEAMMATES } from "./api/teammates";

type M = { id: string; name: string | null; email: string; role: string };

const initials = (n: string) =>
  n
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();

/** `next` is every handler after these. `asked`: the question was already answered. */
export function teammatesHandlers(
  next: HttpHandler[],
  opts: { asked?: boolean } = {},
): HttpHandler[] {
  let asked = opts.asked ?? false;
  const members = async (request: Request): Promise<M[]> => {
    const res = await getResponse(
      next,
      new Request(new URL("/api/v1/members", request.url), {
        headers: request.headers,
      }),
    );
    return res?.ok ? ((await res.json()) as M[]) : [];
  };
  return [
    http.get(`*${ME_TEAMMATES}`, async ({ request }) => {
      const list = (await members(request)).filter(
        (m) => m.role === "member" || m.role === "admin",
      );
      return HttpResponse.json({
        members: list.map((m) => {
          const name = m.name ?? m.email.split("@")[0] ?? "";
          return { id: m.id, name, initials: initials(name) };
        }),
      });
    }),
    http.post(`*${LISTENS_ASKED}`, () => {
      asked = true;
      return new HttpResponse(null, { status: 204 });
    }),
    http.get("*/api/v1/onboarding", async ({ request }) => {
      const res = await getResponse(next, request);
      if (!res?.ok) return res;
      const o = (await res.json()) as Record<string, unknown>;
      return HttpResponse.json({
        ...o,
        agentConnected: true,
        listensAsked: asked,
      });
    }),
    http.put("*/api/v1/artifacts/:id/shares", async ({ request }) => {
      const res = await getResponse(next, request.clone());
      if (!res?.ok) return res;
      const body = (await res.json()) as { email: string };
      const m = (await members(request)).find(
        (x) => x.email.toLowerCase() === body.email.toLowerCase(),
      );
      return HttpResponse.json({ ...body, memberId: m?.id ?? null });
    }),
  ];
}
