// Mock-only. PROVISIONAL (#2590, until OA Comments' contract lets the shared
// mocks take "commenter"): a commenter share is stored by `base` as a viewer
// and remembered here, so the Share panel can save it and read it back.
// Used by the mock app (main.tsx) and the unit-test harness; put these
// handlers ahead of `base`.
import { getResponse, type HttpHandler, HttpResponse, http } from "msw";

export function commenterShareHandlers(
  base: () => readonly HttpHandler[],
): HttpHandler[] {
  const commenters = new Map<string, Set<string>>();
  const url = "*/api/v1/artifacts/:id/shares";
  const of = (id: unknown) => {
    const set = commenters.get(String(id)) ?? new Set<string>();
    commenters.set(String(id), set);
    return set;
  };
  return [
    http.put(url, async ({ request, params }) => {
      const body = (await request
        .clone()
        .json()
        .catch(() => null)) as { email?: string; role?: string } | null;
      const email = body?.email?.trim().toLowerCase() ?? "";
      const set = of(params.id);
      if (body?.role !== "commenter") {
        set.delete(email);
        return undefined;
      }
      const res = await getResponse(
        [...base()],
        new Request(request.url, {
          method: "PUT",
          headers: request.headers,
          body: JSON.stringify({ ...body, role: "viewer" }),
        }),
      );
      if (!res?.ok) return res;
      set.add(email);
      const out = (await res.json()) as Record<string, unknown>;
      return HttpResponse.json(
        { ...out, role: "commenter" },
        { status: res.status },
      );
    }),
    http.get(url, async ({ request, params }) => {
      const set = commenters.get(String(params.id));
      if (!set?.size) return undefined;
      const res = await getResponse([...base()], request);
      if (!res?.ok) return res;
      const list = (await res.json()) as { email: string; role: string }[];
      return HttpResponse.json(
        list.map((x) =>
          set.has(x.email.toLowerCase()) ? { ...x, role: "commenter" } : x,
        ),
      );
    }),
    http.delete(`${url}/:email`, ({ params }) => {
      commenters
        .get(String(params.id))
        ?.delete(decodeURIComponent(String(params.email)).toLowerCase());
      return undefined;
    }),
  ];
}
