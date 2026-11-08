import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ActionRowOutlet,
  ActionRowProvider,
  useActionRowSlot,
} from "../src/viewer/comments/actionRow";

/** A composer: says where its row would render, and portals nothing. */
function Claim({ active }: { active: boolean }) {
  const slot = useActionRowSlot(active);
  return <span>{slot ? "in the outlet" : "in the card"}</span>;
}

function Sheet({ active }: { active: boolean }) {
  return (
    <ActionRowProvider>
      <Claim active={active} />
      <ActionRowOutlet />
    </ActionRowProvider>
  );
}

/** #1711: one composer at a time owns the sheet's row slot. */
describe("comments: the sheet's action row outlet", () => {
  it("hands the outlet to a claiming composer and takes it back", () => {
    const view = render(<Sheet active={false} />);
    // Nothing claims it: the slot is out of the flow, and the row stays in
    // the card.
    expect(screen.getByText("in the card")).toBeInTheDocument();
    expect(document.querySelector("[data-oa-action-outlet]")).toHaveClass(
      "hidden",
    );
    // Claimed: the slot takes the row, stuck to the sheet's bottom edge and
    // clear of a phone's home indicator.
    view.rerender(<Sheet active />);
    expect(screen.getByText("in the outlet")).toBeInTheDocument();
    const outlet = document.querySelector("[data-oa-action-outlet]") as Element;
    expect(outlet).not.toHaveClass("hidden");
    expect(outlet.className).toContain("sticky");
    expect(outlet.className).toContain("bottom-0");
    expect(outlet.className).toContain("safe-area-inset-bottom");
    // Released: the row goes back to the card.
    view.rerender(<Sheet active={false} />);
    expect(screen.getByText("in the card")).toBeInTheDocument();
    expect(document.querySelector("[data-oa-action-outlet]")).toHaveClass(
      "hidden",
    );
  });
});
