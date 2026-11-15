// #2590 G2: Google turned a guest away, so the server sends them to
// /sign-in?error=needs_code&link=1. No address travels in the URL: the page
// asks GET /auth/code/link for the masked address (the oa_glink cookie's),
// then asks for a code with { link: true }, same-origin. A 404 means the
// link is gone: start over at sign-in. PROVISIONAL routes (codeLink.ts).
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it, vi } from "vitest";
import {
  NEEDS_CODE,
  needsCode,
  needsCodeNoCodes,
  WRONG_ACCOUNT,
} from "../src/pages/SignIn";
import { calls, installHarness, mountHosted } from "./harness";

installHarness();
vi.stubGlobal("turnstile", undefined);

const URL_IN = "/sign-in?error=needs_code&link=1&next=%2Fa%2FX1";
const linkRoutes = (masked: string | null) => [
  http.get("*/auth/code/link", () =>
    masked
      ? HttpResponse.json({ maskedEmail: masked })
      : HttpResponse.json(
          { error: { code: "not_found", message: "Not found" } },
          { status: 404 },
        ),
  ),
  http.post("*/auth/code/request", () =>
    HttpResponse.json(
      {
        maskedEmail: "s***@partner.org",
        expiresIn: 600,
        resendAfter: 30,
        codeLength: 8,
      },
      { status: 202 },
    ),
  ),
];

it("shows the masked address the link names, with no field to type in", async () => {
  const router = mountHosted(
    URL_IN,
    true,
    undefined,
    linkRoutes("s***@partner.org"),
  );
  // Product: the masked address in the note.
  expect(
    await screen.findByText(
      "Google couldn't confirm s***@partner.org. We'll email a code to that address. After that, Google works.",
    ),
  ).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Email" })).toBeNull();
  expect(screen.getByRole("button", { name: "Email me a code" })).toBeVisible();
  // Nothing about the address in the URL.
  expect(router.history.location.href).not.toContain("partner");
});

it("asks for the code with { link: true } and no address, same-origin", async () => {
  const posts = calls("POST");
  mountHosted(URL_IN, true, undefined, linkRoutes("s***@partner.org"));
  fireEvent.click(
    await screen.findByRole("button", { name: "Email me a code" }),
  );
  await screen.findByRole("textbox", { name: "Code" });
  const req = posts.find((c) => c.path === "/auth/code/request");
  await waitFor(() => expect(req?.body).toEqual({ link: true, next: "/a/X1" }));
});

it("a link that's gone (404): the usual sign-in, with That took too long. Start again.", async () => {
  const router = mountHosted(URL_IN, true, undefined, linkRoutes(null));
  await waitFor(() =>
    expect(router.state.location.search).toEqual({
      error: "needs_code",
      next: "/a/X1",
    }),
  );
  expect(
    await screen.findByText("That took too long. Start again."),
  ).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Continue with Google" }),
  ).toBeVisible();
});

it("needs_code without link=1: the usual sign-in with That took too long. Start again.", async () => {
  mountHosted("/sign-in?error=needs_code", true, undefined, linkRoutes("x"));
  expect(await screen.findByText(NEEDS_CODE)).toBeVisible();
  expect(NEEDS_CODE).toBe("That took too long. Start again.");
  expect(
    screen.getByRole("link", { name: "Continue with Google" }),
  ).toBeVisible();
});

it("(a) with codes off: only what to ask for, no button", async () => {
  mountHosted(
    URL_IN,
    { providers: ["google"] },
    undefined,
    linkRoutes("s***@partner.org"),
  );
  expect(
    await screen.findByText(
      "Google couldn't confirm s***@partner.org. Ask the person who shared this page to use your Gmail or Google Workspace address.",
    ),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Email me a code" })).toBeNull();
  // Design: a quiet way back to Google.
  expect(
    screen.getByRole("link", { name: "Try another account" }),
  ).toHaveAttribute("href", "/auth/login/google?next=%2Fa%2FX1");
  expect(needsCodeNoCodes("a")).toContain(
    "Ask the person who shared this page",
  );
  expect(needsCode("a")).toContain("After that, Google works.");
});

it("(b) no_access from Google: try another account, or a code at an empty field", async () => {
  mountHosted("/sign-in?error=no_access&via=google&next=%2Fa%2FX1");
  expect(await screen.findByText(WRONG_ACCOUNT)).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Try another account" }),
  ).toHaveAttribute("href", "/auth/login/google?next=%2Fa%2FX1");
  fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
  expect(await screen.findByRole("textbox", { name: "Email" })).toHaveValue("");
});

it("(b) with codes off: Product's codes-off line, Try another account only", async () => {
  mountHosted("/sign-in?error=no_access&via=google&next=%2Fa%2FX1", {
    providers: ["google"],
  });
  expect(
    await screen.findByText(
      "That Google account doesn't have access. Log in with the account for the address this page was shared with.",
    ),
  ).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Try another account" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Email me a code" })).toBeNull();
});

it("no_access from Google without a page link in next: the member line, not (b)", async () => {
  mountHosted("/sign-in?error=no_access&via=google&next=%2Fsettings");
  expect(
    await screen.findByText(
      "This Google account doesn't have access here yet. Ask an admin to invite you, or log in with another Google account.",
    ),
  ).toBeVisible();
  expect(screen.queryByText(WRONG_ACCOUNT)).toBeNull();
  expect(
    screen.queryByRole("link", { name: "Try another account" }),
  ).toBeNull();
});
