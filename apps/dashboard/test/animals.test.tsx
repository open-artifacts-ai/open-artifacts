import { ANIMALS, type AnimalId } from "@oa/shared";
import { render } from "@testing-library/react";
import { Cat } from "lucide-react";
import { describe, expect, it } from "vitest";
import { AnimalIcon } from "../src/viewer/presence/animals";

const svgOf = (id: AnimalId) => {
  const { container } = render(<AnimalIcon id={id} />);
  const svg = container.querySelector("svg");
  if (!svg) throw new Error(`no svg for ${id}`);
  return svg;
};

const drawn = ANIMALS.filter((a) => !a.lucide);

describe("AnimalIcon", () => {
  it("every ANIMALS id has an icon", () => {
    expect(ANIMALS).toHaveLength(58);
    for (const a of ANIMALS) {
      const svg = svgOf(a.id);
      expect(svg.getAttribute("viewBox"), a.id).toBe("0 0 24 24");
      expect(svg.getAttribute("aria-hidden"), a.id).toBe("true");
      expect(
        svg.querySelectorAll("path,circle,ellipse").length,
        a.id,
      ).toBeGreaterThan(0);
    }
  });

  it("lucide: true ids render the lucide-react icon", () => {
    const { container } = render(<Cat aria-hidden="true" />);
    const ref = container.querySelector("svg");
    const mine = svgOf("cat");
    expect(mine.innerHTML).toBe(ref?.innerHTML);
    expect(mine.getAttribute("class")).toContain("lucide");
    expect(ANIMALS.filter((a) => a.lucide)).toHaveLength(13);
  });

  it("drawn icons are stroke only, with the shared stroke style", () => {
    expect(drawn).toHaveLength(45);
    for (const a of drawn) {
      const svg = svgOf(a.id);
      expect(svg.getAttribute("fill"), a.id).toBe("none");
      expect(svg.getAttribute("stroke"), a.id).toBe("currentColor");
      expect(svg.getAttribute("stroke-width"), a.id).toBe("2");
      expect(svg.getAttribute("stroke-linecap"), a.id).toBe("round");
      expect(svg.getAttribute("stroke-linejoin"), a.id).toBe("round");
      for (const el of svg.querySelectorAll("[fill]")) {
        expect(el.getAttribute("fill"), a.id).toBe("none");
      }
    }
  });

  it("no two drawn icons share path data", () => {
    const seen = new Map<string, string>();
    for (const a of drawn) {
      const d = svgOf(a.id).innerHTML;
      expect(seen.get(d), `${a.id} duplicates ${seen.get(d)}`).toBeUndefined();
      seen.set(d, a.id);
    }
  });
});
