// #2590 G2: Google turned a guest away, so the server sends them to
// /sign-in?error=needs_code&email=<addr>. The page prefills the address,
// offers an emailed code (same-origin, so the oa_glink cookie goes along)
// and takes the address out of the URL.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { NEEDS_CODE } from "../src/pages/SignIn";
import { calls, installHarness, mountHosted } from "./harness";

installHarness();
vi.stubGlobal("turnstile", undefined);

const URL_IN =
  "/sign-in?error=needs_code&email=sam%40partner.org&next=%2Fa%2FX1";

it("prefills the address, offers Email me a code, and drops email from the URL", async () => {
  const router = mountHosted(URL_IN);
  expect(await screen.findByText(NEEDS_CODE)).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Email" })).toHaveValue(
    "sam@partner.org",
  );
  expect(screen.getByRole("button", { name: "Email me a code" })).toBeVisible();
  // Off the URL (replaced, not pushed), the rest kept.
  await waitFor(() =>
    expect(router.state.location.search).toEqual({
      error: "needs_code",
      next: "/a/X1",
    }),
  );
  expect(router.history.location.href).not.toContain("partner.org");
  // Still prefilled after the URL changed.
  expect(screen.getByRole("textbox", { name: "Email" })).toHaveValue(
    "sam@partner.org",
  );
});

it("sends the code request same-origin for that address and next", async () => {
  const posts = calls("POST");
  mountHosted(URL_IN);
  fireEvent.click(
    await screen.findByRole("button", { name: "Email me a code" }),
  );
  await screen.findByRole("textbox", { name: "Code" });
  const req = posts.find((c) => c.path === "/auth/code/request");
  expect(req?.body).toEqual({ email: "sam@partner.org", next: "/a/X1" });
});

it("an email param that isn't an address is dropped", async () => {
  mountHosted("/sign-in?error=needs_code&email=not-an-address");
  // Nothing to prefill: the usual page, with the note as its banner.
  expect(await screen.findByText(NEEDS_CODE)).toBeVisible();
  expect(screen.queryByDisplayValue("not-an-address")).toBeNull();
});
