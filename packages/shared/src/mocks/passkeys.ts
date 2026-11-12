/**
 * Passkey mocks (#2263), opt-in via createHandlers({ passkeys }):
 * - "none": no passkey; the switches show but can't be used.
 * - "cooling": one passkey added an hour ago (usable in 23 hours).
 * - "usable": one passkey added three days ago, and one used yesterday.
 * Stateful: add and remove change the list; the mock accepts any assertion or
 * credential (no cryptography), so a virtual authenticator is enough.
 */
import { type HttpHandler, HttpResponse, http } from "msw";
import type { z } from "zod";
import type { ErrorCode } from "../errors.js";
import { PASSKEY_COOLING_MS } from "../passkeys.js";
import { R } from "../routes.js";
import {
  type Passkey,
  PasskeyRegisterBodySchema,
  type PasskeySettings,
  PasskeySettingsPatchSchema,
} from "../schemas.js";

export type PasskeyMockState = "none" | "cooling" | "usable";

type Deps = {
  err: (code: ErrorCode, message: string, details?: unknown) => Response;
  body: <T extends z.ZodType>(
    request: Request,
    schema: T,
  ) => Promise<
    | { data: z.infer<T>; error?: undefined }
    | { error: Response; data?: undefined }
  >;
};

const HOUR = 3600_000;
const MAX = 10;

const b64url = (n: number) =>
  btoa(
    String.fromCharCode(
      ...Array.from({ length: n }, (_, i) => (i * 7 + 3) % 256),
    ),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export function createPasskeyMock(state: PasskeyMockState, d: Deps) {
  const at = (ago: number) => new Date(Date.now() - ago).toISOString();
  const row = (
    id: string,
    label: string,
    age: number,
    used: number | null,
  ): Passkey => {
    const created = Date.now() - age;
    const usableAt = new Date(created + PASSKEY_COOLING_MS);
    return {
      id,
      label,
      createdAt: new Date(created).toISOString(),
      lastUsedAt: used === null ? null : at(used),
      usableAt: usableAt.toISOString(),
      usable: usableAt.getTime() <= Date.now(),
    };
  };
  let keys: Passkey[] =
    state === "none"
      ? []
      : state === "cooling"
        ? [row("pk_cool", "This laptop", HOUR, null)]
        : [
            row("pk_a", "MacBook", 3 * 24 * HOUR, 24 * HOUR),
            row("pk_b", "Phone", 3 * 24 * HOUR, null),
          ];
  let actions = {
    merge: true,
    deploy: true,
    delete: true,
    share: true,
    public: true,
    command: true,
  };
  let everyPick = false;
  let n = 0;

  const settings = (): PasskeySettings => ({
    actions,
    everyPick,
    locked: ["command"],
    hasPasskey: keys.length > 0,
    hasUsablePasskey: keys.some((k) => k.usable),
  });
  // No allowCredentials: the mock's ids are not real credential ids, so any
  // passkey on the device (a virtual authenticator in tests) may answer.
  const assertOptions = () => ({
    options: {
      challenge: b64url(32),
      rpId: "localhost",
      timeout: 120_000,
      userVerification: "required",
    },
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  });
  const refuse = () => {
    if (!keys.length) return d.err("no_passkey", "Add a passkey first.");
    const usable = keys.filter((k) => k.usable);
    if (!usable.length) {
      const until = keys
        .map((k) => k.usableAt)
        .sort()
        .at(0);
      return d.err("passkey_cooling", "Your new passkey is not ready yet.", {
        until,
      });
    }
    return null;
  };

  const handlers: HttpHandler[] = [
    http.get(`*${R.passkeys}`, () => HttpResponse.json(keys)),
    http.get(`*${R.passkeySettings}`, () => HttpResponse.json(settings())),
    http.post(`*${R.passkeySettingsChallenge}`, async ({ request }) => {
      const r = await d.body(request, PasskeySettingsPatchSchema);
      if (r.error) return r.error;
      return refuse() ?? HttpResponse.json(assertOptions());
    }),
    http.patch(`*${R.passkeySettings}`, async ({ request }) => {
      const r = await d.body(request, PasskeySettingsPatchSchema);
      if (r.error) return r.error;
      const next = r.data.actions as typeof actions;
      if (!next.command)
        return d.err(
          "bad_request",
          "Always on: this runs code on your computer.",
        );
      const off =
        (Object.keys(actions) as (keyof typeof actions)[]).some(
          (k) => actions[k] && !next[k],
        ) ||
        (everyPick && !r.data.everyPick);
      if (off) {
        const no = refuse();
        if (no) return no;
        if (!r.data.assertion)
          return d.err("passkey_required", "Confirm with your passkey.");
      }
      actions = next;
      everyPick = r.data.everyPick;
      return HttpResponse.json(settings());
    }),
    http.post(`*${R.passkeyRegisterBegin}`, () => {
      if (keys.length >= MAX)
        return d.err("bad_request", "You can add up to 10 passkeys.");
      return HttpResponse.json({
        options: {
          challenge: b64url(32),
          rp: { name: "Open Artifacts", id: "localhost" },
          user: { id: b64url(16), name: "you@example.com", displayName: "You" },
          pubKeyCredParams: [
            { type: "public-key", alg: -7 },
            { type: "public-key", alg: -257 },
          ],
          timeout: 120_000,
          attestation: "none",
          authenticatorSelection: {
            residentKey: "preferred",
            userVerification: "required",
          },
          excludeCredentials: keys.map((k) => ({
            type: "public-key",
            id: k.id,
          })),
        },
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      });
    }),
    http.post(`*${R.passkeyRegisterFinish}`, async ({ request }) => {
      const r = await d.body(request, PasskeyRegisterBodySchema);
      if (r.error) return r.error;
      n += 1;
      const k = row(`pk_new${n}`, r.data.label ?? "Passkey", 0, null);
      keys = [...keys, k];
      return HttpResponse.json(k, { status: 201 });
    }),
    http.post(`*/api/v1/passkeys/:id/challenge`, ({ params }) => {
      const k = keys.find((x) => x.id === params.id);
      if (!k) return d.err("not_found", "Not found");
      return HttpResponse.json(assertOptions());
    }),
    http.delete(`*/api/v1/passkeys/:id`, ({ params }) => {
      if (!keys.some((x) => x.id === params.id))
        return d.err("not_found", "Not found");
      keys = keys.filter((x) => x.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
  ];
  return { handlers };
}
