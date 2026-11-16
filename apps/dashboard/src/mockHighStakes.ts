// Mock-only (#2661 part A): one ask on the PROVISIONAL high-stakes contract
// (api/highStakes.ts) on top of the shared mocks. ?mock=highstakes&hs=
//   marked  — "Send it" is high stakes and needs this viewer's passkey
//   off     — "Send it" is marked; the viewer's switch is off (no passkey)
//   every   — nothing is marked; "every answer" is on (every option needs it)
//   two     — two options are marked, each needs the passkey
//   missing — "Send it" needs a passkey the viewer doesn't have yet
//   person  — Sam Rivera asks Ada, with "Send it" marked (item 7's mark)
// Answers go through this mock: a passkey option needs the assertion.
import { getResponse, type HttpHandler, HttpResponse, http } from "msw";

const SEND = "Picking Send emails all 240 customers. It can't be undone.";
const TOMORROW = "Picking Send tomorrow emails all 240 customers at 9:00.";

export function highStakesHandlers(
  main: HttpHandler[],
  params: URLSearchParams,
  me: { id: string; name: string },
): HttpHandler[] {
  const mode = params.get("hs") ?? "marked";
  const mark = (reason: string, needs: boolean) => ({
    highStakes: { reason },
    ...(needs ? { passkey: true as const } : {}),
  });
  const every = mode === "every";
  const all = every ? { passkey: true as const } : {};
  const options = [
    {
      id: "send",
      label: "Send it",
      detail: "Email the proposal to every customer on the list.",
      ...(every ? all : mark(SEND, mode !== "off")),
    },
    ...(mode === "two"
      ? [
          {
            id: "tomorrow",
            label: "Send tomorrow",
            detail: "Schedule it for 9:00.",
            ...mark(TOMORROW, true),
          },
        ]
      : []),
    { id: "changes", label: "Changes first", ...all },
    { id: "no", label: "No", ...all },
  ];
  const self = { kind: "user", id: me.id, name: me.name, me: true };
  const author =
    mode === "person"
      ? { kind: "user", id: "sam", name: "Sam Rivera", me: false }
      : {
          kind: "agent",
          id: me.id,
          name: "OA Bus",
          for: me.name,
          linked: true,
          product: "Claude Code",
          animal: { id: "duck", color: 6 },
          me: false,
        };
  const at = new Date(Date.UTC(2026, 10, 16, 15, 0)).toISOString();
  const comment = {
    id: "hsc1",
    body: "The proposal is ready. Pick what happens next.",
    author,
    createdAt: at,
    editedAt: null,
    typed: author.kind === "user",
    can: { edit: false, delete: false },
    ask: {
      question: "Send the proposal to Acme's customers?",
      options,
      to: [self],
      decider: self,
      role: "decide",
      picks: [] as object[],
      closed: false,
      ...(mode === "missing" ? { passkeyMissing: true } : {}),
    } as Record<string, unknown>,
  };
  const thread = {
    id: "hst1",
    anchor: { kind: "note" },
    version: 1,
    status: "open",
    resolvedBy: null,
    resolvedAt: null,
    createdAt: at,
    comments: [comment],
  };
  const base = "*/api/v1/artifacts/:id/comments/hst1/comments/hsc1";
  const needs = (id: string) =>
    options.some((o) => o.id === id && "passkey" in o);
  return [
    http.post(`${base}/answer/challenge`, async ({ request }) => {
      const b = (await request.json()) as { optionId: string };
      if (mode === "missing" && needs(b.optionId))
        return HttpResponse.json(
          {
            error: {
              code: "no_passkey",
              message: "Add a passkey to approve this",
            },
          },
          { status: 409 },
        );
      return HttpResponse.json({
        options: { challenge: "bW9jay1jaGFsbGVuZ2U", rpId: "localhost" },
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      });
    }),
    http.post(`${base}/answer`, async ({ request }) => {
      const b = (await request.json()) as {
        optionId: string;
        assertion?: unknown;
      };
      if (needs(b.optionId) && !b.assertion)
        return HttpResponse.json(
          {
            error: {
              code: "passkey_required",
              message: "This pick needs a passkey",
            },
          },
          { status: 403 },
        );
      const pick = {
        // Never verified without an assertion.
        ...(b.assertion ? { verified: "passkey" } : {}),
        by: self,
        optionId: b.optionId,
        at: new Date().toISOString(),
        typed: true,
      };
      comment.ask.picks = [pick];
      comment.ask.answer = { ...pick, yes: false };
      return HttpResponse.json(comment);
    }),
    http.get("*/api/v1/artifacts/:id/comments", async ({ request }) => {
      const res = await getResponse(main, request);
      if (!res?.ok) return res;
      const list = (await res.json()) as {
        threads: object[];
        open: number;
      };
      return HttpResponse.json({
        ...list,
        threads: [thread, ...list.threads],
        open: list.open + 1,
      });
    }),
  ];
}
