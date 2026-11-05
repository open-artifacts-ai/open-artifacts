// The shadcn Checkbox with its Label: named by the label, toggles from it.
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { LabelledCheckbox } from "../src/layout/LabelledCheckbox";

it("is named by its label, and clicking the label toggles it", () => {
  const on = vi.fn();
  render(
    <LabelledCheckbox
      id="x"
      label="Database"
      checked={false}
      onCheckedChange={on}
    />,
  );
  const box = screen.getByRole("checkbox", { name: "Database" });
  expect(box).not.toBeChecked();
  fireEvent.click(screen.getByText("Database"));
  expect(on).toHaveBeenCalledWith(true);
});

it("is described by its hint when one is given", () => {
  render(
    <>
      <LabelledCheckbox
        id="z"
        label="Allow anonymous writes"
        checked={false}
        disabled
        describedBy="z-hint"
        onCheckedChange={vi.fn()}
      />
      <small id="z-hint">Public and database only.</small>
    </>,
  );
  expect(
    screen.getByRole("checkbox", { name: "Allow anonymous writes" }),
  ).toHaveAccessibleDescription("Public and database only.");
});

it("disabled, it can't change", () => {
  const on = vi.fn();
  render(
    <LabelledCheckbox
      id="y"
      label="Viewer"
      checked
      disabled
      onCheckedChange={on}
    />,
  );
  const box = screen.getByRole("checkbox", { name: "Viewer" });
  expect(box).toBeChecked();
  expect(box).toBeDisabled();
  fireEvent.click(box);
  expect(on).not.toHaveBeenCalled();
});
