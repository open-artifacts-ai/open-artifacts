// Hosted P4 Task 14: the SPA's sign-in page (Google, emailed codes, Turnstile).
import { fixtures } from "@oa/shared/mocks";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { beforeEach, expect, it, vi } from "vitest";
import { codeLengthOf, isCompleteCode } from "../src/pages/CodeSignIn";
import { calls, installHarness, mount, mountHosted, server } from "./harness";

installHarness();

/** The Cloudflare widget's callbacks, captured from the `window.turnstile` stub. */
let turnstileToken: ((token: string) => void) | null = null;
let turnstileOptions: Record<string, unknown>[] = [];
const turnstileReset = vi.fn();
const turnstileCallback = (token: string) => turnstileToken?.(token);
beforeEach(() => {
  turnstileToken = null;
  turnstileOptions = [];
  turnstileReset.mockClear();
  let n = 0;
  vi.stubGlobal("turnstile", {
    render: (
      _el: HTMLElement,
      o: { callback: (t: string) => void } & Record<string, unknown>,
    ) => {
      turnstileToken = o.callback;
      turnstileOptions.push(o);
      return `widget-${++n}`;
    },
    reset: turnstileReset,
    remove: vi.fn(),
  });
});

/** The email step's field and button: the trial's ("Work email", "Email me a code") or the guest page's ("Email", "Send code"). */
const EMAIL_FIELD = /^(Work email|Email)$/;
const SEND = /^(Email me a code|Send code)$/;

/** Types the email, clicks send, waits for "Code". */
const requestThroughUi = async (email: string) => {
  fireEvent.change(await screen.findByRole("textbox", { name: EMAIL_FIELD }), {
    target: { value: email },
  });
  fireEvent.click(screen.getByRole("button", { name: SEND }));
  await screen.findByRole("textbox", { name: "Code" });
};

/** Fills "Code", clicks "Verify" and waits for the verify to settle. */
const typeCode = async (code: string) => {
  fireEvent.change(screen.getByRole("textbox", { name: "Code" }), {
    target: { value: code },
  });
  fireEvent.click(screen.getByRole("button", { name: "Verify" }));
  await waitFor(() =>
    expect(document.querySelector('form[aria-busy="true"]')).toBeNull(),
  );
};

/** The stub the page installs: check the widget was reset after each request. */
const resetAfter = async (n: number) =>
  waitFor(() => expect(turnstileReset).toHaveBeenCalledTimes(n));

it("providers 404 renders today's page", async () => {
  server.use(
    http.get("*/auth/providers", () => new HttpResponse(null, { status: 404 })),
  );
  mount("/sign-in");
  expect(
    await screen.findByRole("link", {
      name: "Continue with Cloudflare Access",
    }),
  ).toHaveAttribute("href", "/auth/login");
});

it("access mode renders today's page", async () => {
  mountHosted("/sign-in", { mode: "access" });
  expect(
    await screen.findByRole("link", {
      name: "Continue with Cloudflare Access",
    }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Email me a code" })).toBeNull();
});

it("an unknown ?error= shows the failed copy and never echoes the value", async () => {
  mountHosted("/sign-in?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Sign-in didn't work. Try again.",
  );
  expect(document.body.innerHTML).not.toContain("<script>alert(1)");
  expect(document.body.textContent).not.toContain("alert(1)");
});

it("a hostile next never reaches the Google link or the code request", async () => {
  const seen = calls("POST");
  mountHosted("/sign-in?method=code&next=%2F%2Fevil.example");
  expect(
    await screen.findByRole("link", { name: "Continue with Google" }),
  ).toHaveAttribute("href", "/auth/login/google?next=%2F");
  await requestThroughUi("bob@example.com");
  expect(seen.find((c) => c.path === "/auth/code/request")!.body).toEqual({
    email: "bob@example.com",
    next: "/",
  });
});

it("a hostile next from the server is never assigned", async () => {
  const assign = vi.fn();
  vi.stubGlobal("location", { ...location, assign });
  mountHosted("/sign-in?method=code&next=%2Fmine", true, undefined, [
    http.post("*/auth/code/verify", () =>
      HttpResponse.json({
        next: "//evil.example",
        user: fixtures.members[1],
        readOnly: false,
      }),
    ),
  ]);
  await requestThroughUi("bob@example.com");
  await typeCode("24681357");
  await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
  vi.unstubAllGlobals();
});

it("direct: Google navigates to its start with next; no Access or self-hosted copy", async () => {
  mountHosted("/sign-in?next=%2Fa%2FDe6gHjKmNp7qRsTu");
  expect(
    await screen.findByRole("link", { name: "Continue with Google" }),
  ).toHaveAttribute("href", "/auth/login/google?next=%2Fa%2FDe6gHjKmNp7qRsTu");
  expect(screen.queryByText(/Cloudflare Access/)).toBeNull();
  expect(screen.queryByText("Self-hosted on Cloudflare")).toBeNull();
});

it.each([
  [
    "tenant",
    "That Google account isn't part of Acme Artifacts. Use your example.com account.",
  ],
  [
    "identity_conflict",
    "This email is linked to a different Google account. Ask your admin to reset the link.",
  ],
  [
    "removed",
    "Your access to Acme Artifacts was removed. Ask your admin if this is a mistake.",
  ],
  ["no_access", "You don't have access yet. Ask your admin to invite you."],
  ["expired", "Sign-in took too long. Try again."],
  ["failed", "Sign-in didn't work. Try again."],
])("error=%s", async (error, copy) => {
  mountHosted(`/sign-in?error=${error}`);
  expect(await screen.findByRole("alert")).toHaveTextContent(copy); // Design D8, 2026-10-21
});

const providersWith = (providers: unknown[]) =>
  http.get("*/auth/providers", () =>
    HttpResponse.json({ mode: "direct", providers }),
  );
const ACCESS = { id: "access", start: "/auth/login?via=access" };

it("direct: no hosting line (self-hosted installs run direct too)", async () => {
  mountHosted("/sign-in");
  await screen.findByRole("link", { name: "Continue with Google" });
  expect(screen.queryByText("Hosted by Open Artifacts")).toBeNull();
  expect(screen.queryByText("Self-hosted on Cloudflare")).toBeNull();
});

it("direct with Access and Google: an Access button keeps via and adds next", async () => {
  mountHosted("/sign-in?next=%2Fmine", true, undefined, [
    providersWith([
      { id: "google", start: "/auth/login/google", domains: ["example.com"] },
      ACCESS,
    ]),
  ]);
  expect(
    await screen.findByRole("link", {
      name: "Continue with Cloudflare Access",
    }),
  ).toHaveAttribute("href", "/auth/login?via=access&next=%2Fmine");
  expect(
    screen.getByRole("link", { name: "Continue with Google" }),
  ).toHaveAttribute("href", "/auth/login/google?next=%2Fmine");
});

it("direct with Access and an unusable Google: Access, not 'isn't set up'", async () => {
  mountHosted("/sign-in?next=%2Fmine", true, undefined, [
    providersWith([
      { id: "google", start: "https://evil.example/login", domains: [] },
      ACCESS,
    ]),
  ]);
  expect(
    await screen.findByRole("link", {
      name: "Continue with Cloudflare Access",
    }),
  ).toHaveAttribute("href", "/auth/login?via=access&next=%2Fmine");
  expect(screen.queryByText(/isn't set up yet/)).toBeNull();
  expect(screen.queryByText("Continue with Google")).toBeNull();
});

it("direct with a hostile Access start: dropped", async () => {
  mountHosted("/sign-in", true, undefined, [
    providersWith([{ id: "access", start: "//evil.example/login?via=access" }]),
  ]);
  expect(
    await screen.findByText("Sign-in isn't set up yet. Ask your admin."),
  ).toBeVisible();
  expect(screen.queryByText(/Cloudflare Access/)).toBeNull();
});

it("empty providers says sign-in is not set up", async () => {
  server.use(
    http.get("*/auth/providers", () =>
      HttpResponse.json({ mode: "direct", providers: [] }),
    ),
  );
  mount("/sign-in");
  expect(
    await screen.findByText("Sign-in isn't set up yet. Ask your admin."),
  ).toBeVisible();
});

it("request shows the masked address, resend timer and expiry", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mountHosted("/sign-in?method=code");
  await requestThroughUi("bob@example.com");
  expect(
    screen.getByText(
      "If b***@example.com can sign in here, we sent it a code.",
    ),
  ).toBeVisible();
  // Muted text while the timer runs: nothing to click.
  expect(screen.getByText("Resend in 60s").tagName).toBe("SPAN");
  expect(screen.queryByRole("button", { name: /Resend/ })).toBeNull();
  expect(screen.getByText("The code works for 10 minutes.")).toBeVisible();
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(screen.getByRole("button", { name: "Resend code" })).toBeEnabled();
  vi.useRealTimers();
});

it("isCompleteCode", () => {
  expect(isCompleteCode("2468-1357", 8)).toBe(true);
  expect(isCompleteCode("2468 1357", 8)).toBe(true);
  expect(isCompleteCode("2468135", 8)).toBe(false);
  expect(isCompleteCode("2468135a", 8)).toBe(false);
  expect(isCompleteCode("246813579", 8)).toBe(false);
});

it("codeLengthOf keeps 4..12 and falls back to CODE_POLICY.length", () => {
  expect(codeLengthOf(4)).toBe(4);
  expect(codeLengthOf(12)).toBe(12);
  expect(codeLengthOf(8)).toBe(8);
  expect(codeLengthOf(3)).toBe(8);
  expect(codeLengthOf(13)).toBe(8);
  expect(codeLengthOf(1e9)).toBe(8);
  expect(codeLengthOf(6.5)).toBe(8);
  expect(codeLengthOf(Number.NaN)).toBe(8);
  expect(codeLengthOf(-1)).toBe(8);
});

it("isCompleteCode never builds a regex from an out-of-range length", () => {
  expect(isCompleteCode("24681357", 1e9)).toBe(true); // falls back to 8
  expect(isCompleteCode("246813", 1e9)).toBe(false);
  expect(isCompleteCode("", 0)).toBe(false);
  expect(isCompleteCode("1234", 4)).toBe(true);
  expect(isCompleteCode("123456789012", 12)).toBe(true);
});

it("a hostile codeLength from the server falls back to 8 digits", async () => {
  const seen = calls("POST");
  mountHosted("/sign-in?method=code", true, undefined, [
    http.post("*/auth/code/request", () =>
      HttpResponse.json(
        {
          maskedEmail: "b***@example.com",
          expiresIn: 600,
          resendAfter: 60,
          codeLength: 100000,
        },
        { status: 202 },
      ),
    ),
  ]);
  await requestThroughUi("bob@example.com");
  expect(screen.getByRole("textbox", { name: "Code" })).toHaveAttribute(
    "placeholder",
    "1234 5678",
  );
  await typeCode("246813");
  expect(await screen.findByText("Enter all 8 digits.")).toBeVisible();
  expect(seen.some((c) => c.path === "/auth/code/verify")).toBe(false);
});

it("a hostile Google start is dropped: no Google link to it", async () => {
  for (const start of [
    "https://evil.example/login",
    "//evil.example",
    "javascript:alert(1)",
  ]) {
    cleanup();
    mountHosted("/sign-in", true, undefined, [
      http.get("*/auth/providers", () =>
        HttpResponse.json({
          mode: "direct",
          providers: [
            { id: "google", start, domains: ["example.com"] },
            { id: "email", domainCodes: false, guests: true },
          ],
        }),
      ),
    ]);
    await screen.findByRole("heading", { name: /^Sign in to / });
    expect(
      screen.queryByRole("link", { name: "Continue with Google" }),
    ).toBeNull();
    for (const a of document.querySelectorAll("a"))
      expect(a.getAttribute("href") ?? "").not.toMatch(/evil|javascript/);
  }
});

it("retryAfter is clamped to an hour: a huge value still re-enables", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mountHosted("/sign-in?method=code", true, undefined, [
    http.post("*/auth/code/request", () =>
      HttpResponse.json(
        {
          error: {
            code: "rate_limited",
            message: "Too many",
            details: { retryAfter: 1e12, scope: "email" },
          },
        },
        { status: 429 },
      ),
    ),
  ]);
  fireEvent.change(await screen.findByRole("textbox", { name: EMAIL_FIELD }), {
    target: { value: "bob@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: SEND }));
  await screen.findByRole("status");
  expect(screen.getByRole("button", { name: SEND })).toBeDisabled();
  await act(() => vi.advanceTimersByTimeAsync(3_500_000));
  expect(screen.getByRole("button", { name: SEND })).toBeDisabled();
  await act(() => vi.advanceTimersByTimeAsync(200_000));
  expect(screen.getByRole("button", { name: SEND })).toBeEnabled();
  vi.useRealTimers();
});

it("retryAfter of 0 or less still holds for a second", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mountHosted("/sign-in?method=code", true, undefined, [
    http.post("*/auth/code/request", () =>
      HttpResponse.json(
        {
          error: {
            code: "rate_limited",
            message: "Too many",
            details: { retryAfter: -5, scope: "email" },
          },
        },
        { status: 429 },
      ),
    ),
  ]);
  fireEvent.change(await screen.findByRole("textbox", { name: EMAIL_FIELD }), {
    target: { value: "bob@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: SEND }));
  await screen.findByRole("status");
  expect(screen.getByRole("button", { name: SEND })).toBeDisabled();
  await act(() => vi.advanceTimersByTimeAsync(1_100));
  expect(screen.getByRole("button", { name: SEND })).toBeEnabled();
  vi.useRealTimers();
});

it("a 404 from the code request says codes aren't available", async () => {
  mountHosted("/sign-in?method=code", true, undefined, [
    http.post("*/auth/code/request", () =>
      HttpResponse.json(
        { error: { code: "not_found", message: "Not found" } },
        { status: 404 },
      ),
    ),
  ]);
  fireEvent.change(await screen.findByRole("textbox", { name: EMAIL_FIELD }), {
    target: { value: "bob@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: SEND }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Sign-in by email code isn't available right now. Use Continue with Google, or ask your admin.",
  ); // Design D8, 2026-10-21
});

it.each(["2468-1357", "2468 1357", " 24681357 "])(
  "code %j verifies and navigates to the server's next",
  async (typed) => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...location, assign });
    mountHosted("/sign-in?method=code&next=%2Fmine");
    await requestThroughUi("bob@example.com");
    await typeCode(typed);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/mine"));
    vi.unstubAllGlobals();
  },
);

it("a short code is refused before sending", async () => {
  const seen = calls("POST");
  mountHosted("/sign-in?method=code");
  await requestThroughUi("bob@example.com");
  await typeCode("246813");
  expect(await screen.findByText("Enter all 8 digits.")).toBeVisible();
  expect(seen.some((c) => c.path === "/auth/code/verify")).toBe(false);
});

it("invalid_code says so, with no try count, and clears the code", async () => {
  mountHosted("/sign-in?method=code");
  await requestThroughUi("bob@example.com");
  await typeCode("11111111");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "That code didn't work. Check it and try again.",
  );
  expect(screen.getByRole("alert").textContent).toBe(
    "That code didn't work. Check it and try again.",
  );
  expect(document.body.textContent).not.toMatch(/tries left|try left/);
  expect(screen.getByRole("textbox", { name: "Code" })).toHaveValue("");
});

it("the fifth wrong code expires it", async () => {
  mountHosted("/sign-in?method=code");
  await requestThroughUi("bob@example.com");
  for (let i = 0; i < 5; i++) await typeCode("11111111");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Too many tries, or the code expired. Request a new code.",
  );
});

it("no_pending returns to the email step with the email kept", async () => {
  mountHosted("/sign-in?method=code", true, undefined, [
    http.post("*/auth/code/verify", () =>
      HttpResponse.json(
        {
          error: {
            code: "unauthorized",
            message: "Start over",
            details: { reason: "no_pending" },
          },
        },
        { status: 401 },
      ),
    ),
  ]);
  await requestThroughUi("bob@example.com");
  await typeCode("24681357");
  expect(await screen.findByRole("textbox", { name: EMAIL_FIELD })).toHaveValue(
    "bob@example.com",
  );
});

it("rate_limited (scope email) says to wait and holds the button for Retry-After", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mountHosted("/sign-in?method=code", true, undefined, [
    http.post("*/auth/code/request", () =>
      HttpResponse.json(
        {
          error: {
            code: "rate_limited",
            message: "Too many",
            details: { retryAfter: 3600, scope: "email" },
          },
        },
        { status: 429, headers: { "Retry-After": "3600" } },
      ),
    ),
  ]);
  fireEvent.change(await screen.findByRole("textbox", { name: EMAIL_FIELD }), {
    target: { value: "bob@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: SEND }));
  const notice = await screen.findByRole("status");
  expect(notice).toHaveTextContent(
    "Too many codes for this address. Wait a bit, then try again.",
  ); // Design D8: generic copy, no lock state
  // The inline warning: polite, with its icon, and never an alert.
  expect(notice).toHaveAttribute("aria-live", "polite");
  expect(notice).toHaveAttribute("data-tone", "warning");
  expect(notice.querySelector("svg[aria-hidden='true']")).not.toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: SEND })).toBeDisabled();
  await act(() => vi.advanceTimersByTimeAsync(3_500_000));
  // Never a disabled button without the reason; no countdown.
  expect(screen.getByRole("button", { name: SEND })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Too many codes for this address. Wait a bit, then try again.",
  );
  expect(document.body.textContent).not.toMatch(
    /\d+ ?(s|sec|seconds|min|minutes)\b/,
  );
  await act(() => vi.advanceTimersByTimeAsync(100_000));
  expect(screen.getByRole("button", { name: SEND })).toBeEnabled();
  vi.useRealTimers();
});

it("rate_limited (scope ip) on request: the network copy, held for Retry-After", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mountHosted("/sign-in?method=code", true, undefined, [
    http.post("*/auth/code/request", () =>
      HttpResponse.json(
        {
          error: {
            code: "rate_limited",
            message: "Too many",
            details: { retryAfter: 600, scope: "ip" },
          },
        },
        { status: 429, headers: { "Retry-After": "600" } },
      ),
    ),
  ]);
  fireEvent.change(await screen.findByRole("textbox", { name: EMAIL_FIELD }), {
    target: { value: "bob@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: SEND }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Too many tries. Wait a bit, then request a new code.",
  );
  await act(() => vi.advanceTimersByTimeAsync(500_000));
  expect(screen.getByRole("button", { name: SEND })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Too many tries. Wait a bit, then request a new code.",
  );
  await act(() => vi.advanceTimersByTimeAsync(100_000));
  expect(screen.getByRole("button", { name: SEND })).toBeEnabled();
  vi.useRealTimers();
});

it("a held button never loses its reason: Use a different email after a 429", async () => {
  mountHosted("/sign-in?method=code", true, undefined, [
    http.post("*/auth/code/verify", () =>
      HttpResponse.json(
        {
          error: {
            code: "rate_limited",
            message: "Too many",
            details: { retryAfter: 900, scope: "ip" },
          },
        },
        { status: 429, headers: { "Retry-After": "900" } },
      ),
    ),
  ]);
  await requestThroughUi("bob@example.com");
  await typeCode("24681357");
  await screen.findByRole("status");
  fireEvent.click(
    screen.getByRole("button", { name: "Use a different email" }),
  );
  expect(screen.getByRole("button", { name: SEND })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Too many tries. Wait a bit, then request a new code.",
  );
});

it("an unknown address gets the same 202 and the normal code step", async () => {
  mountHosted("/sign-in?method=code");
  await requestThroughUi("nobody@unknown.example");
  expect(
    screen.getByRole("heading", { name: "Check your email" }),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.getByText("No email? Check spam, or ask the person who shared it."),
  ).toBeVisible();
});

it("the code step: Code, Verify and the spam hint", async () => {
  mountHosted("/sign-in?method=code");
  await requestThroughUi("bob@example.com");
  const code = screen.getByRole("textbox", { name: "Code" });
  expect(code).toHaveAttribute("inputmode", "numeric");
  expect(code).toHaveAttribute("autocomplete", "one-time-code");
  expect(code).toHaveAttribute("placeholder", "1234 5678");
  expect(screen.getByRole("button", { name: "Verify" })).toBeVisible();
  expect(
    screen.getByText("No email? Check spam, or ask the person who shared it."),
  ).toBeVisible();
});

it("the Turnstile widget renders with action code_request", async () => {
  mountHosted("/sign-in?method=code", { turnstile: true });
  await screen.findByTestId("turnstile");
  await waitFor(() => expect(turnstileOptions).toHaveLength(1));
  expect(turnstileOptions[0]).toMatchObject({
    sitekey: "1x00000000000000000000AA",
    action: "code_request",
  });
});

it("Turnstile slot renders with a site key, sends the token once, then resets", async () => {
  const seen = calls("POST");
  mountHosted("/sign-in?method=code", { turnstile: true });
  expect(await screen.findByTestId("turnstile")).toHaveAttribute(
    "data-sitekey",
    "1x00000000000000000000AA",
  );
  act(() => turnstileCallback("tok-1"));
  await requestThroughUi("bob@example.com");
  expect(
    seen.filter((c) => c.path === "/auth/code/request").map((c) => c.body),
  ).toEqual([{ email: "bob@example.com", next: "/", turnstileToken: "tok-1" }]);
  await resetAfter(1); // tokens are single-use
});

it("Resend resets the widget and sends a fresh token", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const seen = calls("POST");
  mountHosted("/sign-in?method=code", { turnstile: true });
  await screen.findByTestId("turnstile");
  act(() => turnstileCallback("tok-1"));
  await requestThroughUi("bob@example.com");
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  act(() => turnstileCallback("tok-2"));
  fireEvent.click(screen.getByRole("button", { name: "Resend code" }));
  await waitFor(() =>
    expect(
      seen
        .filter((c) => c.path === "/auth/code/request")
        .map((c) => (c.body as { turnstileToken: string }).turnstileToken),
    ).toEqual(["tok-1", "tok-2"]),
  );
  await resetAfter(2);
  vi.useRealTimers();
});

it("no site key: no widget and no token", async () => {
  const seen = calls("POST");
  mountHosted("/sign-in?method=code");
  await requestThroughUi("bob@example.com");
  expect(screen.queryByTestId("turnstile")).toBeNull();
  expect(seen.find((c) => c.path === "/auth/code/request")!.body).toEqual({
    email: "bob@example.com",
    next: "/",
  });
  expect(turnstileReset).not.toHaveBeenCalled();
});

it("turnstile_failed keeps the email and resets the widget", async () => {
  mountHosted("/sign-in?method=code", { turnstile: true });
  await screen.findByTestId("turnstile");
  act(() => turnstileCallback("fail"));
  fireEvent.change(screen.getByRole("textbox", { name: EMAIL_FIELD }), {
    target: { value: "bob@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: SEND }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The check didn't go through. Try it again.",
  );
  expect(screen.getByRole("textbox", { name: EMAIL_FIELD })).toHaveValue(
    "bob@example.com",
  );
  await resetAfter(1);
});

it("turnstile_required shows at the slot and sends nothing more", async () => {
  const seen = calls("POST");
  mountHosted("/sign-in?method=code", { turnstile: true });
  await screen.findByTestId("turnstile");
  fireEvent.change(screen.getByRole("textbox", { name: EMAIL_FIELD }), {
    target: { value: "bob@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: SEND }));
  const slot = screen.getByTestId("turnstile").parentElement!;
  expect(
    await within(slot).findByText(
      "Finish the check above, then send the code again.",
    ),
  ).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Code" })).toBeNull(); // still on the email step
  expect(seen.filter((c) => c.path === "/auth/code/request")).toHaveLength(1);
});

it("a 429 verify (scope ip) says to wait and holds Verify for Retry-After", async () => {
  mountHosted("/sign-in?method=code", true, undefined, [
    http.post("*/auth/code/verify", () =>
      HttpResponse.json(
        {
          error: {
            code: "rate_limited",
            message: "Locked",
            details: { retryAfter: 900, scope: "ip" },
          },
        },
        { status: 429, headers: { "Retry-After": "900" } },
      ),
    ),
  ]);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  await requestThroughUi("bob@example.com");
  await typeCode("24681357");
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Too many tries. Wait a bit, then request a new code.",
  ); // Design D8: generic copy, no lock state
  expect(screen.getByRole("button", { name: "Verify" })).toBeDisabled();
  await act(() => vi.advanceTimersByTimeAsync(800_000));
  expect(screen.getByRole("button", { name: "Verify" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Too many tries. Wait a bit, then request a new code.",
  );
  await act(() => vi.advanceTimersByTimeAsync(100_000));
  expect(screen.getByRole("button", { name: "Verify" })).toBeEnabled();
  vi.useRealTimers();
});

const codeUnavailable = (path: string) =>
  http.post(path, () =>
    HttpResponse.json(
      {
        error: {
          code: "code_unavailable",
          message: "Emailed codes are off",
        },
      },
      { status: 503 },
    ),
  );
const CODES_OFF =
  "Sign-in by email code isn't available right now. Ask your admin for help.";
const CODES_OFF_GOOGLE =
  "Sign-in by email code isn't available right now. Use Continue with Google, or ask your admin.";

it("code_unavailable on request (Google on): inline on the email step, Google stays live", async () => {
  mountHosted("/sign-in?method=code&next=%2Fmine", true, undefined, [
    codeUnavailable("*/auth/code/request"),
  ]);
  fireEvent.change(await screen.findByRole("textbox", { name: EMAIL_FIELD }), {
    target: { value: "bob@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: SEND }));
  expect(await screen.findByRole("alert")).toHaveTextContent(CODES_OFF_GOOGLE);
  expect(screen.getByRole("textbox", { name: EMAIL_FIELD })).toHaveValue(
    "bob@example.com",
  );
  expect(
    screen.getByRole("link", { name: "Continue with Google" }),
  ).toHaveAttribute("href", "/auth/login/google?next=%2Fmine");
});

it("code_unavailable on request (no Google): the admin copy", async () => {
  mountHosted("/sign-in", { providers: ["email"] }, undefined, [
    codeUnavailable("*/auth/code/request"),
  ]);
  fireEvent.change(await screen.findByRole("textbox", { name: EMAIL_FIELD }), {
    target: { value: "bob@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: SEND }));
  expect(await screen.findByRole("alert")).toHaveTextContent(CODES_OFF);
  expect(
    screen.queryByRole("link", { name: "Continue with Google" }),
  ).toBeNull();
});

it("code_unavailable on verify: back to the email step, email kept, Google live", async () => {
  mountHosted("/sign-in?method=code", true, undefined, [
    codeUnavailable("*/auth/code/verify"),
  ]);
  await requestThroughUi("bob@example.com");
  await typeCode("24681357");
  expect(await screen.findByRole("alert")).toHaveTextContent(CODES_OFF_GOOGLE);
  expect(screen.getByRole("textbox", { name: EMAIL_FIELD })).toHaveValue(
    "bob@example.com",
  );
  expect(screen.queryByRole("textbox", { name: "Code" })).toBeNull();
  expect(
    screen.getByRole("link", { name: "Continue with Google" }),
  ).toHaveAttribute("href", "/auth/login/google?next=%2F");
});

it("self-hosted: ?error= shows today's banner and never echoes the value", async () => {
  mount("/sign-in?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
  expect(
    await screen.findByRole("link", {
      name: "Continue with Cloudflare Access",
    }),
  ).toHaveAttribute("href", "/auth/login");
  expect(screen.getByText("Sign-in didn't finish.")).toBeVisible();
  expect(
    screen.getByText("The login link expired or was cancelled. Try again."),
  ).toBeVisible();
  expect(screen.getByText("Self-hosted on Cloudflare")).toBeVisible();
  expect(screen.queryByText("Continue with Google")).toBeNull();
  expect(document.body.textContent).not.toContain("alert(1)");
});

it("self-hosted: no ?error= shows no banner", async () => {
  mount("/sign-in");
  await screen.findByRole("link", { name: "Continue with Cloudflare Access" });
  expect(screen.queryByText("Sign-in didn't finish.")).toBeNull();
  expect(screen.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

it("a numeric ?error= in Access mode still shows today's banner", async () => {
  mountHosted("/sign-in?error=1", { mode: "access" });
  expect(await screen.findByText("Sign-in didn't finish.")).toBeVisible();
});

it("Google only: one Google button, a guest link carrying next, no code form", async () => {
  mountHosted("/sign-in?next=%2Fmine");
  expect(
    await screen.findByRole("link", { name: "Continue with Google" }),
  ).toHaveAttribute("href", "/auth/login/google?next=%2Fmine");
  expect(
    screen.getByText(
      (_, el) =>
        el?.tagName === "P" &&
        el.textContent ===
          "Invited as a guest? If someone shared an artifact with your email, use a code.",
    ),
  ).toBeVisible();
  // A full-width outlined secondary button, not an inline link.
  expect(screen.getByRole("link", { name: "Get a sign-in code" })).toHaveClass(
    "oa-split-btn",
  );
  expect(
    screen.getByRole("link", { name: "Get a sign-in code" }),
  ).toHaveAttribute("href", "/sign-in?method=code&next=%2Fmine");
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: SEND })).toBeNull();
  expect(screen.queryByTestId("turnstile")).toBeNull();
});

it("Google only: a hostile next is dropped from the guest link", async () => {
  mountHosted("/sign-in?next=%2F%2Fevil.example");
  expect(
    await screen.findByRole("link", { name: "Get a sign-in code" }),
  ).toHaveAttribute("href", "/sign-in?method=code&next=%2F");
});

it("Google on, guests off: no guest link, and ?method=code stays Google only", async () => {
  mountHosted("/sign-in?method=code", true, undefined, [
    http.get("*/auth/providers", () =>
      HttpResponse.json({
        mode: "direct",
        providers: [
          {
            id: "google",
            start: "/auth/login/google",
            domains: ["example.com"],
          },
          { id: "email", domainCodes: false, guests: false },
        ],
      }),
    ),
  ]);
  await screen.findByRole("link", { name: "Continue with Google" });
  expect(screen.queryByText(/Invited as a guest\?/)).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("?method=code: the guest email step, Back keeps next, Google stays a way in", async () => {
  mountHosted("/sign-in?method=code&next=%2Fmine");
  expect(
    await screen.findByRole("heading", { name: "Get a sign-in code" }),
  ).toBeVisible();
  expect(
    screen.getByText("Use the email address the link was shared with."),
  ).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Email" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Send code" })).toBeVisible();
  expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute(
    "href",
    "/sign-in?next=%2Fmine",
  );
  expect(
    screen.getByRole("link", { name: "Continue with Google" }),
  ).toHaveAttribute("href", "/auth/login/google?next=%2Fmine");
  expect(screen.queryByText(/Invited as a guest\?/)).toBeNull();
});

it("guest page footer names the Google domain", async () => {
  mountHosted("/sign-in?method=code");
  await screen.findByRole("heading", { name: "Get a sign-in code" });
  const footer = screen.getByRole("link", { name: "Continue with Google" })
    .parentElement!;
  expect(footer.textContent).toBe(
    "Have an example.com account? Continue with Google. Codes don't go to example.com addresses.",
  );
  expect(document.body.textContent).not.toContain("Work at");
});

it("guest page footer without a Google domain", async () => {
  mountHosted("/sign-in?method=code", true, undefined, [
    http.get("*/auth/providers", () =>
      HttpResponse.json({
        mode: "direct",
        providers: [
          { id: "google", start: "/auth/login/google", domains: [] },
          { id: "email", domainCodes: false, guests: true },
        ],
      }),
    ),
  ]);
  await screen.findByRole("heading", { name: "Get a sign-in code" });
  const footer = screen.getByRole("link", { name: "Continue with Google" })
    .parentElement!;
  expect(footer.textContent).toBe(
    "Have a work Google account? Continue with Google.",
  );
});

it('guest page footer: "a" before a consonant domain', async () => {
  mountHosted("/sign-in?method=code", true, undefined, [
    http.get("*/auth/providers", () =>
      HttpResponse.json({
        mode: "direct",
        providers: [
          {
            id: "google",
            start: "/auth/login/google",
            domains: ["finqore.com"],
          },
          { id: "email", domainCodes: false, guests: true },
        ],
      }),
    ),
  ]);
  await screen.findByRole("heading", { name: "Get a sign-in code" });
  expect(
    screen.getByRole("link", { name: "Continue with Google" }).parentElement!
      .textContent,
  ).toBe(
    "Have a finqore.com account? Continue with Google. Codes don't go to finqore.com addresses.",
  );
});

it("guest flow: the link, the email step, the code, then the server's next", async () => {
  const assign = vi.fn();
  vi.stubGlobal("location", { ...location, assign });
  const seen = calls("POST");
  mountHosted("/sign-in?next=%2Fa%2FDe6gHjKmNp7qRsTu");
  fireEvent.click(
    await screen.findByRole("link", { name: "Get a sign-in code" }),
  );
  await screen.findByRole("heading", { name: "Get a sign-in code" });
  await requestThroughUi("sam@northwind.example");
  expect(seen.find((c) => c.path === "/auth/code/request")!.body).toEqual({
    email: "sam@northwind.example",
    next: "/a/De6gHjKmNp7qRsTu",
  });
  await typeCode("2468 1357");
  await waitFor(() =>
    expect(assign).toHaveBeenCalledWith("/a/De6gHjKmNp7qRsTu"),
  );
  vi.unstubAllGlobals();
});

it("trial: codes are the main path, no guest link", async () => {
  mountHosted("/sign-in", { providers: ["email"] });
  expect(
    await screen.findByRole("textbox", { name: "Work email" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Email me a code" })).toBeVisible();
  expect(screen.queryByText(/Invited as a guest\?/)).toBeNull();
  expect(screen.queryByRole("link", { name: /Google/ })).toBeNull();
});

it("direct mode: /no-access redirects to /sign-in?error=no_access", async () => {
  const router = mountHosted("/no-access");
  await waitFor(() =>
    expect(router.state.location.href).toBe("/sign-in?error=no_access"),
  );
});

it("Access mode keeps today's /no-access page", async () => {
  mount("/no-access");
  expect(
    await screen.findByRole("heading", {
      name: "You're signed in, but there's nothing here for you yet",
    }),
  ).toBeVisible();
});

it("no copy contains an em dash", async () => {
  mountHosted("/sign-in?error=tenant");
  await screen.findByRole("alert");
  expect(document.body.textContent).not.toContain("\u2014");
});
