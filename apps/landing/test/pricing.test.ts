import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { money, perMonth, priceStrings } from "../src/lib/pricing";

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

  it("opens on Yearly: the per-month figure, with the monthly price one click away", () => {
    const amounts = [
      ...pricing.matchAll(/<b data-m="([^"]+)" data-y="([^"]+)">([^<]+)<\/b>/g),
    ].map((m) => [m[1], m[2], m[3]]);
    expect(amounts).toEqual([
      ["$1", "$0.83", "$0.83"],
      ["$10", "$8.33", "$8.33"],
      ["$25", "$20.83", "$20.83"],
    ]);
    expect(pricing).toContain("<b>Free</b>");
  });

  it("says per creator, and what is billed yearly, under each price", () => {
    expect(pricing).toContain("<small>a month</small>");
    expect(pricing.match(/<small>per creator a month<\/small>/g)).toHaveLength(
      2,
    );
    expect(pricing).toContain(
      'data-m="Billed monthly" data-y="$10 billed yearly">$10 billed yearly</i>',
    );
    expect(pricing).toContain(
      'data-m="Billed monthly" data-y="$100 per creator, billed yearly">$100 per creator, billed yearly</i>',
    );
    expect(pricing).toContain(
      'data-m="Billed monthly" data-y="$250 per creator, billed yearly">$250 per creator, billed yearly</i>',
    );
    expect(pricing).toContain('<i class="bill">Open source, MIT</i>');
  });

  it("keeps the strings in one place: the yearly total over twelve, to the cent", () => {
    expect(perMonth(10)).toBe(0.83);
    expect(perMonth(100)).toBe(8.33);
    expect(perMonth(250)).toBe(20.83);
    expect(money(10)).toBe("$10");
    expect(money(0.83)).toBe("$0.83");
    expect(
      priceStrings({ monthly: 10, yearly: 100, perCreator: true }),
    ).toEqual({
      price: { m: "$10", y: "$8.33" },
      bill: { m: "Billed monthly", y: "$100 per creator, billed yearly" },
      unit: "per creator a month",
    });
  });

  it("has the Monthly / Yearly toggle with real, pressed buttons, Yearly pressed", () => {
    expect(pricing).toMatch(
      /<button[^>]*data-p="m"[^>]*aria-pressed="false"[^>]*>Monthly<\/button>/,
    );
    expect(pricing).toMatch(
      /<button[^>]*data-p="y"[^>]*aria-pressed="true"[^>]*>Yearly/,
    );
    expect(pricing).toContain("2 months free");
  });

  it("keeps the note under the table and the free-viewers line", () => {
    expect(pricing).toContain("Viewers and sharing are free on every plan.");
    expect(pricing).toContain(
      "Solo is per account; Team and Business are per creator.",
    );
    expect(pricing).toContain(
      "A creator is someone who publishes or edits; viewers and commenters are free.",
    );
  });

  it("has a sideways-scrolling wrapper with a sticky first column", () => {
    expect(pricing).toMatch(/class="tw"[^>]*tabindex="0"/);
  });
});
