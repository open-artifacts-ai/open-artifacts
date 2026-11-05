import { describe, expect, it } from "vitest";
import {
  anchorSchema,
  createTextAnchor,
  createTextResolver,
  minSurvivingChars,
  type Resolution,
  resolveTextAnchor,
} from "../src/index.js";

const DOC =
  "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.";
const anchorOf = (text: string, quote: string, nth = 0) => {
  let i = -1;
  for (let k = 0; k <= nth; k++) i = text.indexOf(quote, i + 1);
  return createTextAnchor(text, i, i + quote.length, 1);
};

describe("createTextAnchor", () => {
  it("keeps about 32 chars of context and empty context at the edges", () => {
    const a = anchorOf(DOC, "quick");
    expect(a.exact).toBe("quick");
    expect(a.prefix).toBe("The ");
    expect(a.suffix).toBe(DOC.slice(9, 9 + 32));
    const end = anchorOf(DOC, "jugs.");
    expect(end.suffix).toBe("");
    expect(end.prefix).toHaveLength(32);
  });
  it("produces anchors the schema accepts and never splits a surrogate pair", () => {
    const t = "😀😀😀 hello 😀 world 😀😀";
    const a = createTextAnchor(t, 1, t.indexOf("hello") + 3, 2, { line: 1 });
    expect(a.exact.startsWith("😀")).toBe(true);
    expect(anchorSchema.safeParse(a).success).toBe(true);
  });
  it("cuts an over-long quote to the schema cap", () => {
    const t = "x".repeat(5000);
    const a = createTextAnchor(t, 10, 4000, 1);
    expect(a.exact).toHaveLength(1000);
    expect(anchorSchema.safeParse(a).success).toBe(true);
  });
  it("rejects an empty selection", () => {
    expect(() => createTextAnchor("abc", 1, 1, 1)).toThrow(RangeError);
  });
});

describe("anchorSchema caps", () => {
  const ok = { kind: "text", version: 1, exact: "a", prefix: "", suffix: "" };
  it.each([
    ["note", { kind: "note" }, true],
    ["text", ok, true],
    ["exact 1000", { ...ok, exact: "a".repeat(1000) }, true],
    ["exact 1001", { ...ok, exact: "a".repeat(1001) }, false],
    ["prefix 64", { ...ok, prefix: "a".repeat(64) }, true],
    ["prefix 65", { ...ok, prefix: "a".repeat(65) }, false],
    ["suffix 65", { ...ok, suffix: "a".repeat(65) }, false],
    ["path 256", { ...ok, block: { path: "p".repeat(256) } }, true],
    ["path 257", { ...ok, block: { path: "p".repeat(257) } }, false],
    [
      "pin edges",
      { kind: "pin", version: 1, x: 0, y: 1, contentHash: "h" },
      true,
    ],
    [
      "pin x>1",
      { kind: "pin", version: 1, x: 1.01, y: 0, contentHash: "h" },
      false,
    ],
    [
      "pin y<0",
      { kind: "pin", version: 1, x: 0, y: -0.1, contentHash: "h" },
      false,
    ],
    ["unknown key", { kind: "note", extra: 1 }, false],
  ])("%s", (_n, v, valid) => {
    expect(anchorSchema.safeParse(v).success).toBe(valid);
  });
});

const slice = (t: string, r: Resolution) =>
  r.state === "exact" || r.state === "partial"
    ? t.slice(r.start, r.end)
    : r.state;

describe("resolveTextAnchor", () => {
  const quote = "brown fox jumps";
  const anchor = anchorOf(DOC, quote);
  const cases: [string, string, Resolution["state"], string | number][] = [
    ["unchanged", DOC, "exact", quote],
    ["edit before", `Intro added. ${DOC}`, "exact", quote],
    ["edit after", `${DOC} More text.`, "exact", quote],
    ["moved", DOC.split(". ").reverse().join(". "), "exact", quote],
    [
      "whitespace collapsed",
      DOC.replace("brown fox", "brown   fox\n"),
      "exact",
      "brown   fox\n jumps".replace("\n ", "\n "),
    ],
    [
      "edit inside, most survives",
      DOC.replace("fox jumps", "fox jump"),
      "partial",
      "brown fox jump",
    ],
    ["quote replaced", DOC.replace(quote, "cat sleeps"), "collapsed", 10],
    ["quote deleted", DOC.replace(quote, ""), "collapsed", 10],
    [
      "everything gone",
      "Entirely different words, nothing alike at all.",
      "orphan",
      "orphan",
    ],
    ["empty doc", "", "orphan", "orphan"],
  ];
  it.each(cases)("%s", (_n, text, state, expected) => {
    const r = resolveTextAnchor(text, anchor);
    expect(r.state).toBe(state);
    if (state === "collapsed") expect(r).toEqual({ state, at: expected });
    else if (state === "exact" && _n === "whitespace collapsed") {
      expect(slice(text, r)).toContain("brown");
      expect(
        text
          .slice((r as { start: number }).start, (r as { end: number }).end)
          .replace(/\s+/g, " "),
      ).toBe(quote);
    } else if (state !== "orphan") expect(slice(text, r)).toBe(expected);
  });

  it("whitespace collapse in the document finds a quote that had a double space", () => {
    const t = "alpha  beta   gamma delta";
    const a = anchorOf(t, "beta   gamma");
    const r = resolveTextAnchor("alpha beta gamma delta", a);
    expect(r.state).toBe("exact");
    expect(slice("alpha beta gamma delta", r)).toBe("beta gamma");
  });

  describe("repeated quotes", () => {
    const t = "red apple. green apple. blue apple. green apple pie.";
    it("picks the match whose context agrees", () => {
      const second = anchorOf(t, "apple", 1);
      const r = resolveTextAnchor(t, second);
      expect(r).toEqual({
        state: "exact",
        start: t.indexOf("apple", 11),
        end: t.indexOf("apple", 11) + 5,
      });
      const fourth = anchorOf(t, "apple", 3);
      expect(resolveTextAnchor(t, fourth)).toMatchObject({
        start: t.lastIndexOf("apple"),
      });
    });
    it("still picks right after an edit before it", () => {
      const a = anchorOf(t, "apple", 2);
      const t2 = `Fruit: ${t}`;
      const r = resolveTextAnchor(t2, a);
      expect(r).toMatchObject({
        state: "exact",
        start: t2.indexOf("blue apple") + 5,
      });
    });
    it("uses the block line to break a context tie", () => {
      const lines = "x\nsame\nx\nsame\nx\nsame";
      const a = {
        ...anchorOf("a same b", "same"),
        prefix: "",
        suffix: "",
        block: { line: 4 },
      };
      const r = resolveTextAnchor(lines, a);
      expect(r).toMatchObject({
        state: "exact",
        start: lines.indexOf("same", 7),
      });
    });
    it("falls back to the earliest when nothing breaks the tie", () => {
      const a = { ...anchorOf("a same b", "same"), prefix: "", suffix: "" };
      expect(resolveTextAnchor("same same", a)).toMatchObject({ start: 0 });
    });
  });

  describe("unicode offsets", () => {
    it("emoji and CJK are UTF-16 offsets", () => {
      const t = "前置 😀 这是一个测试 句子 😀 end";
      const a = anchorOf(t, "这是一个测试");
      const t2 = `新增 😀😀 ${t}`;
      const r = resolveTextAnchor(t2, a);
      expect(r.state).toBe("exact");
      expect(slice(t2, r)).toBe("这是一个测试");
    });
    it("partial match never splits a surrogate pair", () => {
      const t = "before ##### 😀😀😀😀😀😀😀😀😀😀 after text here";
      const a = anchorOf(t, "😀😀😀😀😀😀😀😀😀😀");
      const t2 = t.replace("😀😀😀😀😀😀😀😀😀😀", "😀😀😀😀😀😀😀😀😀X");
      const r = resolveTextAnchor(t2, a);
      expect(r.state).toBe("partial");
      expect(slice(t2, r)).toBe("😀😀😀😀😀😀😀😀😀");
    });
  });

  describe("document edges", () => {
    it("empty prefix at the start", () => {
      const a = anchorOf(DOC, "The quick brown");
      expect(a.prefix).toBe("");
      expect(resolveTextAnchor(DOC, a)).toEqual({
        state: "exact",
        start: 0,
        end: 15,
      });
      expect(
        resolveTextAnchor(
          DOC.replace("The quick brown", "Gone entirely now"),
          a,
        ),
      ).toEqual({ state: "collapsed", at: 17 }); // the suffix says where
    });
    it("empty suffix at the end", () => {
      const a = anchorOf(DOC, "liquor jugs.");
      expect(a.suffix).toBe("");
      const t2 = DOC.replace("liquor jugs.", "");
      expect(resolveTextAnchor(t2, a)).toEqual({
        state: "collapsed",
        at: t2.length,
      });
    });
  });

  describe("partial threshold boundary", () => {
    it("minSurvivingChars is max(8, 30%)", () => {
      expect(minSurvivingChars(10)).toBe(8);
      expect(minSurvivingChars(40)).toBe(12);
      expect(minSurvivingChars(1000)).toBe(300);
    });
    // 40-char quote needs 12 surviving. Edit the middle so a run of n remains.
    const q = "abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    const t = `lead-in words here: ${q} :trailing words here`;
    const a = anchorOf(t, q);
    it.each([
      [12, "partial"],
      [11, "collapsed"],
    ])("a surviving run of %i of 40 chars is %s", (n, state) => {
      // keep the first n chars, destroy the rest with characters absent from q
      const t2 = t.replace(q, q.slice(0, n) + "!".repeat(40 - n));
      const r = resolveTextAnchor(t2, a);
      expect(r.state).toBe(state);
      if (r.state === "partial") expect(slice(t2, r)).toBe(q.slice(0, n));
    });
    it("a short quote is whole or collapsed, never partial", () => {
      const s = anchorOf(DOC, "lazy dog");
      expect(
        resolveTextAnchor(DOC.replace("lazy dog", "lazy cat"), s).state,
      ).toBe("collapsed");
    });
  });

  it("context edited on one side still finds the spot", () => {
    const a = anchorOf(DOC, "brown fox jumps");
    const t2 = DOC.replace("brown fox jumps", "cat").replace(
      "The quick ",
      "A fast ",
    );
    expect(resolveTextAnchor(t2, a).state).toBe("collapsed");
  });

  it("is deterministic", () => {
    const t2 = DOC.replace("fox jumps", "fox jump");
    expect(resolveTextAnchor(t2, anchor)).toEqual(
      resolveTextAnchor(t2, anchor),
    );
  });
});

describe("short quotes need context (M1)", () => {
  it("does not jump to the same words elsewhere when the context is found at the old spot", () => {
    const before = "Intro. Q3 revenue grew 4%. Later table: Q3 revenue | 12";
    const a = anchorOf(before, "Q3 revenue");
    const after = "Intro. Q4 revenue grew 4%. Later table: Q3 revenue | 12";
    const r = resolveTextAnchor(after, a);
    expect(r.state).not.toBe("exact");
    expect(r.state).toBe("partial"); // " revenue" survives at the old spot, not the table cell
    if (r.state === "partial") expect(r.start).toBeLessThan(20);
  });
  it("does not match inside a longer word", () => {
    const before = "We need art here.";
    const a = anchorOf(before, "art");
    const r = resolveTextAnchor("We need music here. A start.", a);
    expect(r).toEqual({ state: "collapsed", at: 8 });
  });
  it("still takes a bounded short quote when no context exists anywhere", () => {
    const a = anchorOf("alpha beta gamma delta", "beta");
    const r = resolveTextAnchor("Totally rewritten: beta.", a);
    expect(r).toMatchObject({ state: "exact", start: 19, end: 23 });
  });
  it("a short quote that moved with its context is still exact", () => {
    const a = anchorOf("one two three four five six seven", "four");
    const r = resolveTextAnchor("PRE one two three four five six seven", a);
    expect(r).toMatchObject({ state: "exact", start: 18 });
  });
});

describe("empty and weak context (M2)", () => {
  it("an empty prefix does not beat a surviving suffix", () => {
    const doc =
      "Opening sentence of the memo. Rest of the memo follows here, with more.";
    const a = anchorOf(doc, "Opening sentence of the memo.");
    expect(a.prefix).toBe("");
    const heading = `Heading\n${"x".repeat(500)}\n`;
    const after = heading + doc.replace("Opening sentence of the memo.", "");
    const r = resolveTextAnchor(after, a);
    expect(r).toEqual({ state: "collapsed", at: heading.length });
  });
  it("a short probe is taken only when unique", () => {
    const doc =
      "alpha. the quick one jumps on the second beta. gamma. delta on the end";
    const a = anchorOf(doc, "quick one jumps");
    // both sides edited, so only 8-char probes (' on the ') survive, at two places
    const edited = "ZZZ the. QQQ on the second beta. gamma delta on the end";
    const r = resolveTextAnchor(edited, {
      ...a,
      prefix: "xxxxxxxxxxxxxxxx, ok",
      suffix: " on the ",
    });
    expect(r.state).toBe("orphan");
  });
  it("a short probe repeated in the page is resolved by the block line", () => {
    const lines = ["on the a", "on the b", "on the c", "on the d"].join("\n");
    const a = {
      kind: "text" as const,
      version: 1,
      exact: "zzzzzzzzzzzz",
      prefix: "",
      suffix: "on the ",
      block: { line: 3 },
    };
    const r = resolveTextAnchor(lines, a);
    expect(r.state).toBe("collapsed");
    expect(r).toEqual({ state: "collapsed", at: lines.indexOf("on the c") });
  });
});

describe("many anchors on one text (B1)", () => {
  let seed = 99991;
  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const make = (n: number) => {
    const w: string[] = [];
    let size = 0;
    while (size < n) {
      const x = Math.floor(rnd() * 36 ** 6).toString(36);
      w.push(x);
      size += x.length + 1;
    }
    return w.join(" ");
  };

  it("200 KB with 100 edited anchors resolves quickly through one resolver", () => {
    const text = make(200_000);
    const anchors = Array.from({ length: 100 }, (_, i) => {
      const at = 1000 + i * 1900;
      return createTextAnchor(text, at, at + 60, 1);
    });
    // edit one character inside each quote
    let edited = text;
    for (let i = 99; i >= 0; i--) {
      const at = 1000 + i * 1900 + 30;
      edited = `${edited.slice(0, at)}#${edited.slice(at + 1)}`;
    }
    const t0 = performance.now();
    const resolve = createTextResolver(edited);
    const out = anchors.map((a) => resolve(a));
    const ms = performance.now() - t0;
    expect(out.every((r) => r.state === "partial")).toBe(true);
    expect(ms).toBeLessThan(3000);
  });

  it("long quotes over the work budget fall back to collapsed instead of stalling", () => {
    const text = make(50_000);
    const a = createTextAnchor(text, 20_000, 21_000, 1);
    const wide = `${text.slice(0, 20_500)}${"#".repeat(2500)}${text.slice(20_500)}`;
    const t0 = performance.now();
    const r = resolveTextAnchor(wide, a);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(["collapsed", "partial"]).toContain(r.state);
  });
});

describe("performance", () => {
  // Deterministic non-periodic ~1 MB of text (seeded xorshift), so quotes are unique.
  let seed = 2463534242;
  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const words: string[] = [];
  let size = 0;
  while (size < 1_000_000) {
    const w = Math.floor(rnd() * 36 ** 6).toString(36);
    words.push(w);
    size += w.length + 1;
  }
  const big = words.join(" ");

  it("resolves in 1 MB of text within a generous bound, in every state", () => {
    const at = 500_000;
    const a = createTextAnchor(big, at, at + 40, 1);
    const lq = createTextAnchor(big, 700_000, 701_000, 1);
    const edit = (text: string, i: number, n: number, rep: string) =>
      text.slice(0, i) + rep + text.slice(i + n);
    const t0 = performance.now();
    expect(resolveTextAnchor(big, a)).toMatchObject({
      state: "exact",
      start: at,
    });
    expect(resolveTextAnchor(edit(big, at + 20, 1, "#"), a).state).toBe(
      "partial",
    );
    expect(resolveTextAnchor(edit(big, at, 40, ""), a)).toEqual({
      state: "collapsed",
      at,
    });
    expect(resolveTextAnchor(edit(big, 700_500, 1, "#"), lq).state).toBe(
      "partial",
    );
    expect(resolveTextAnchor("unrelated ".repeat(100_000), a).state).toBe(
      "orphan",
    );
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});
