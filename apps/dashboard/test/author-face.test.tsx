import { type CommentAuthor, PRESENCE_PALETTE_SIZE } from "@oa/shared";
import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthorFace, AuthorSub } from "../src/viewer/comments/AuthorFace";

const base = { me: false } as const;
const linked: CommentAuthor = {
  ...base,
  kind: "agent",
  name: "OA Product",
  for: "Leo Urbina",
  linked: true,
  product: "Claude Code",
  animal: { id: "duck", color: 2 },
};
const unlinked: CommentAuthor = {
  ...base,
  kind: "agent",
  name: "OA Product",
  for: "Leo Urbina",
  linked: false,
};
const face = (a: CommentAuthor) =>
  render(
    <>
      <AuthorFace a={a} />
      <AuthorSub a={a} />
    </>,
  ).container;

describe("#1822 author face", () => {
  it("a linked agent is the animal in a square tile, colored from the palette, with product and for-line", () => {
    const c = face(linked);
    const f = c.querySelector<HTMLElement>('[data-avatar="agent"]');
    expect(f?.dataset.linked).toBe("true");
    expect(f?.dataset.animal).toBe("duck");
    expect(f?.style.backgroundColor).toBe("var(--oa-presence-2)");
    expect(f?.className).toMatch(/rounded-(md|\[)/);
    expect(f?.className).not.toMatch(/rounded-full/);
    expect(c.textContent).toContain("Claude Code");
    expect(c.textContent).toContain("for Leo Urbina");
  });
  it("an unlinked agent has no animal: dashed outline mark, not linked, for-line", () => {
    const c = face(unlinked);
    const f = c.querySelector<HTMLElement>('[data-avatar="agent"]');
    expect(f?.dataset.linked).toBe("false");
    expect(f?.dataset.animal).toBeUndefined();
    expect(f?.style.backgroundColor).toBe("");
    expect(f?.className).toMatch(/border-dashed/);
    expect(c.textContent).toContain("not linked");
    expect(c.textContent).toContain("for Leo Urbina");
  });
  it("a person keeps initials in a circle and no agent line", () => {
    const c = face({ ...base, kind: "user", name: "Maya Singh" });
    const f = c.querySelector<HTMLElement>("[data-avatar]");
    expect(f?.dataset.avatar).toBe("");
    expect(f?.textContent).toBe("MS");
    expect(f?.className).toMatch(/rounded-full/);
    expect(c.textContent).toBe("MS");
  });
  it("same name, linked vs unlinked, render differently", () => {
    const a = face(linked).innerHTML;
    const b = face(unlinked).innerHTML;
    expect(a).not.toBe(b);
    expect(b).not.toContain("duck");
  });
  it("linked without an animal falls back to the unlinked look", () => {
    const c = face({ ...linked, animal: undefined });
    const f = c.querySelector<HTMLElement>('[data-avatar="agent"]');
    expect(f?.dataset.linked).toBe("false");
    expect(f?.dataset.animal).toBeUndefined();
    expect(c.textContent).toContain("not linked");
  });
  it("a palette index past the end wraps", () => {
    const c = face({ ...linked, animal: { id: "duck", color: 11 } });
    expect(
      c.querySelector<HTMLElement>('[data-avatar="agent"]')?.style
        .backgroundColor,
    ).toBe(`var(--oa-presence-${11 % PRESENCE_PALETTE_SIZE})`);
  });
  it("a negative palette index stays in range", () => {
    const c = face({ ...linked, animal: { id: "duck", color: -1 } });
    expect(
      c.querySelector<HTMLElement>('[data-avatar="agent"]')?.style
        .backgroundColor,
    ).toBe(`var(--oa-presence-${PRESENCE_PALETTE_SIZE - 1})`);
  });
  it("a linked agent is announced as linked, even with no product", () => {
    const c = face({ ...linked, product: undefined });
    expect(c.querySelector(".sr-only")?.textContent).toBe("linked, ");
    expect(c.textContent).toContain("for Leo Urbina");
    expect(face(unlinked).querySelector(".sr-only")).toBeNull();
  });

  it("a linked agent's app shows its mark beside the product, for every kind (agy S6)", () => {
    for (const [product, tag] of [
      ["Claude Code", "IMG"],
      ["Codex", "SPAN"],
      ["Antigravity", "SPAN"],
      ["oh-my-pi", "SPAN"],
      ["pi", "IMG"],
      ["Hermes", "IMG"],
    ] as const) {
      const c = face({ ...linked, product });
      const line = c.querySelector("[data-for]") as HTMLElement;
      const mark = within(line).getByRole("img", { name: product });
      expect(mark.tagName, product).toBe(tag);
      // The name is read once: from the mark, not again from the word.
      expect(line.textContent).toBe(`linked, ${product} · for Leo Urbina`);
      expect(within(line).getByText(product)).toHaveAttribute(
        "aria-hidden",
        "true",
      );
    }
  });
  it("a kind the server has no product for: its token with a first-letter tile (agy S6)", () => {
    const c = face({ ...linked, product: undefined, appKind: "kiro" });
    const line = c.querySelector("[data-for]") as HTMLElement;
    expect(line.textContent).toBe("linked, kiro · for Leo Urbina");
    const mark = within(line).getByRole("img", { name: "kiro" });
    expect(mark.style.maskImage).toContain(encodeURIComponent(">K</text>"));
  });
  it("no mark for an unlinked agent, or a linked one with no app (agy S6)", () => {
    expect(face(unlinked).querySelector('[role="img"], img')).toBeNull();
    const c = face({ ...linked, product: undefined });
    expect(c.querySelector("[data-for]")?.textContent).toBe(
      "linked, for Leo Urbina",
    );
    expect(c.querySelector("[data-for] [role=img], [data-for] img")).toBeNull();
  });
});

describe("#3132 an agent shown as its role", () => {
  it("names the role; the session and who holds the role now are small print", () => {
    const c = face({
      ...linked,
      name: "OA Platform",
      session: "OA Platform L",
      role: { name: "OA Platform" },
    });
    expect(c.querySelector("[data-role-session]")?.textContent).toBe(
      "OA Platform L · ",
    );
    const moved = face({
      ...linked,
      name: "OA Platform",
      session: "OA Platform L",
      role: { name: "OA Platform", holder: "OA Platform W" },
    });
    expect(moved.querySelector("[data-role-session]")?.textContent).toBe(
      "OA Platform L · now OA Platform W · ",
    );
    expect(moved.textContent).toContain("for Leo Urbina");
  });

  it("an agent with no role shows no session line", () => {
    expect(face(linked).querySelector("[data-role-session]")).toBeNull();
  });
});
