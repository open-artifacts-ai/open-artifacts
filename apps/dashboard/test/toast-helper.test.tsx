// findVisibleToast: Sonner commits a toast at opacity 0 and fades it in from
// an effect, so a toast assertion waits for the visible state.
import { act, render } from "@testing-library/react";
import { expect, it } from "vitest";
import { Toaster, toast } from "../src/layout/toast";
import { findVisibleToast } from "./harness";

it("resolves to the toast's text once the toast shows", async () => {
  render(<Toaster />);
  act(() => {
    toast({ title: "Saved the thing", tone: "success" });
  });
  const el = await findVisibleToast("Saved the thing");
  expect(el).toBeVisible();
  expect(el.closest("[data-sonner-toast]")).toHaveAttribute(
    "data-mounted",
    "true",
  );
});

it("rejects text that isn't in a toast", async () => {
  render(<p>Plain text</p>);
  await expect(
    findVisibleToast("Plain text", { timeout: 200 }),
  ).rejects.toThrow();
});
