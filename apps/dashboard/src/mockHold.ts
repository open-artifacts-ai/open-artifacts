// Mock-only (#3095): &hold=comments holds the viewer's comments list fetches
// (`?status=all`) until the test calls `window.__oaReleaseComments()`. Each
// answer is taken when its request arrives, so a fetch that started before a
// reply answers without it. `window.__oaCommentsHeld` turns true once one is
// held. Other comments requests pass. Loaded only with VITE_MOCK.
import { getResponse, type HttpHandler, http, type RequestHandler } from "msw";

declare global {
  interface Window {
    __oaCommentsHeld?: boolean;
    __oaReleaseComments?: () => void;
  }
}

export function holdHandlers(
  rest: RequestHandler[],
  params: URLSearchParams,
): HttpHandler[] {
  if (params.get("hold") !== "comments") return [];
  let release!: () => void;
  const released = new Promise<void>((r) => {
    release = r;
  });
  window.__oaReleaseComments = () => release();
  return [
    http.get("*/api/v1/artifacts/:id/comments", async ({ request }) => {
      if (new URL(request.url).searchParams.get("status") !== "all") return;
      const res = await getResponse(rest, request);
      window.__oaCommentsHeld = true;
      await released;
      return res;
    }),
  ];
}
