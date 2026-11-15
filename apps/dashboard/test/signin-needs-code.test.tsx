// #2590 G2: Google turned a guest away, so the server sends them to
// /sign-in?error=needs_code&link=1. No address travels in the URL: the page
// asks GET /auth/code/link for the masked address (the oa_glink cookie's),
// then asks for a code with { link: true }, same-origin. A 404 means the
// link is gone: start over at sign-in. PROVISIONAL routes (codeLink.ts).
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it, vi } from "vitest";
import { NEEDS_CODE } from "../src/pages/SignIn";
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
  expect(await screen.findByText("s***@partner.org")).toBeVisible();
  expect(screen.getByText(NEEDS_CODE)).toBeVisible();
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

it("a link that's gone (404) starts over at sign-in, keeping next", async () => {
  const router = mountHosted(URL_IN, true, undefined, linkRoutes(null));
  await waitFor(() =>
    expect(router.state.location.search).toEqual({ next: "/a/X1" }),
  );
  expect(router.state.location.pathname).toBe("/sign-in");
  expect(screen.queryByText(NEEDS_CODE)).toBeNull();
});

it("needs_code without link=1: the note as a banner on the usual page", async () => {
  mountHosted("/sign-in?error=needs_code", true, undefined, linkRoutes("x"));
  expect(await screen.findByText(NEEDS_CODE)).toBeVisible();
  expect(screen.queryByText("x")).toBeNull();
});
