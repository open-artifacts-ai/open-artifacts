import type { CommentAuthor } from "@oa/shared";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AuthorFace,
  AuthorSub,
  PRESENCE_COLORS,
} from "../src/viewer/comments/AuthorFace";

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
    expect(f?.style.backgroundColor).not.toBe("");
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
    expect(PRESENCE_COLORS).toHaveLength(9);
    const c = face({ ...linked, animal: { id: "duck", color: 11 } });
    expect(
      c.querySelector<HTMLElement>('[data-avatar="agent"]')?.style
        .backgroundColor,
    ).not.toBe("");
  });
});
