// Mock-only (#2590 G2, PROVISIONAL like pages/codeLink.ts): a guest Google
// turned away. `address` stands for the oa_glink cookie's address: GET
// /auth/code/link answers it masked; POST /auth/code/request { link: true }
// asks `base` for a code for it. No address: 404 (start over).
import { getResponse, type HttpHandler, HttpResponse, http } from "msw";

const mask = (email: string) => {
  const [l = "", d = ""] = email.split("@");
  return `${l.slice(0, 1)}***@${d}`;
};

export function codeLinkHandlers(
  address: string | null,
  base: () => readonly HttpHandler[],
): HttpHandler[] {
  return [
    http.get("*/auth/code/link", () =>
      address
        ? HttpResponse.json({ maskedEmail: mask(address) })
        : HttpResponse.json(
            { error: { code: "not_found", message: "Not found" } },
            { status: 404 },
          ),
    ),
    http.post("*/auth/code/request", async ({ request }) => {
      const body = (await request
        .clone()
        .json()
        .catch(() => null)) as Record<string, unknown> | null;
      if (body?.link !== true) return undefined;
      if (!address)
        return HttpResponse.json(
          { error: { code: "not_found", message: "Not found" } },
          { status: 404 },
        );
      const { link: _, ...rest } = body;
      return getResponse(
        [...base()],
        new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify({ ...rest, email: address }),
        }),
      );
    }),
  ];
}
