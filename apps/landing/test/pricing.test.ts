import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const index = readFileSync(
  fileURLToPath(new URL("../dist/index.html", import.meta.url)),
  "utf8",
);
const pricing = index.slice(
  index.indexOf('id="pricing"'),
  index.indexOf("</section>", index.indexOf('id="pricing"')),
);

describe("pricing", () => {
  it("has the four columns, each with a button", () => {
    const head = pricing.slice(
      pricing.indexOf("<thead"),
      pricing.indexOf("</thead>"),
    );
    for (const name of ["Solo", "Team", "Business", "Self-host"])
      expect(head).toContain(`<span class="pn">${name}</span>`);
    expect(head.match(/<a class="btn[^"]*" href="[^"]+">/g)).toHaveLength(4);
    expect(head).toContain(">Start free for 30 days</a>");
    expect(head).toMatch(/href="#self-host">Self-host it<\/a>/);
  });

  it("has monthly and yearly amounts for each paid plan", () => {
    const amounts = [
      ...pricing.matchAll(/<b data-m="([^"]+)" data-y="([^"]+)">([^<]+)<\/b>/g),
    ].map((m) => [m[1], m[2], m[3]]);
    expect(amounts).toEqual([
      ["$1", "$10", "$1"],
      ["$10", "$100", "$10"],
      ["$25", "$250", "$25"],
    ]);
    expect(pricing).toContain("<b>Free</b>");
  });

  it("has the Monthly / Yearly toggle with real, pressed buttons", () => {
    expect(pricing).toMatch(
      /<button[^>]*data-p="m"[^>]*aria-pressed="true"[^>]*>Monthly<\/button>/,
    );
    expect(pricing).toMatch(
      /<button[^>]*data-p="y"[^>]*aria-pressed="false"[^>]*>Yearly/,
    );
    expect(pricing).toContain("2 months free");
  });

  it("keeps the note under the table and the free-viewers line", () => {
    expect(pricing).toContain("Viewers and sharing are free on every plan.");
    expect(pricing).toContain(
      "Solo is per account; Team and Business are per creator.",
    );
  });

  it("has a sideways-scrolling wrapper with a sticky first column", () => {
    expect(pricing).toMatch(/class="tw"[^>]*tabindex="0"/);
  });
});
