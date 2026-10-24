// The shared confirm: an alert dialog with Cancel and one action, no ×; with
// `pending`, it stays open and the action reads the pending label while busy.
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ConfirmDialog } from "../src/settings/ConfirmDialog";

const base = {
  open: true,
  onClose: vi.fn(),
  title: "Delete artifact?",
  body: <p>"Page" will be recoverable for 30 days.</p>,
  confirm: "Delete",
  danger: true,
};

it("is an alert dialog with Cancel and the action, and no close button", () => {
  render(<ConfirmDialog {...base} onConfirm={vi.fn()} />);
  const d = screen.getByRole("alertdialog", { name: "Delete artifact?" });
  expect(d).toHaveAccessibleDescription(
    '"Page" will be recoverable for 30 days.',
  );
  expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
});

it("with pending, the action keeps it open; busy, it reads the label and is disabled", () => {
  const onClose = vi.fn();
  const onConfirm = vi.fn();
  const { rerender } = render(
    <ConfirmDialog
      {...base}
      onClose={onClose}
      onConfirm={onConfirm}
      pending="Deleting…"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
  rerender(
    <ConfirmDialog
      {...base}
      onClose={onClose}
      onConfirm={onConfirm}
      pending="Deleting…"
      busy
    />,
  );
  const b = screen.getByRole("button", { name: "Deleting…" });
  expect(b).toBeDisabled();
  expect(b).toHaveAttribute("aria-busy", "true");
});
