import { createTextAnchor, resolveTextAnchor } from "@oa/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  flatText,
  indexText,
  nodeAtIndex,
  offsetsToRange,
  rangeFromIndex,
  rangeToOffsets,
} from "../src/text-range.js";

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML =
    '<div id="r"><p>Hello <b>brave</b> new</p><p>world 😀 end</p></div>';
  root = document.getElementById("r") as HTMLElement;
});

describe("text-range", () => {
  it("flattens text nodes in document order", () => {
    expect(flatText(root)).toBe("Hello brave newworld 😀 end");
  });

  it("leaves out script, style, noscript, template and textarea text", () => {
    root.insertAdjacentHTML(
      "beforeend",
      "<style>p{color:red}</style><script>var a=1</script><noscript>nojs</noscript><template>tpl</template><textarea>secret</textarea><input type=hidden value=hid><p>tail</p>",
    );
    expect(flatText(root)).toBe("Hello brave newworld \u{1F600} endtail");
    const text = flatText(root);
    const r = offsetsToRange(root, text.indexOf("tail"), text.length);
    expect(r?.toString()).toBe("tail");
    expect(rangeToOffsets(root, r as Range)).toEqual({
      start: text.indexOf("tail"),
      end: text.length,
    });
  });

  it("round-trips a range across inline elements", () => {
    const b = root.querySelector("b")?.firstChild as Text;
    const r = document.createRange();
    r.setStart(root.firstChild?.firstChild as Text, 3); // "lo "
    r.setEnd(b, 3); // "bra"
    const o = rangeToOffsets(root, r);
    expect(o).toEqual({ start: 3, end: 9 });
    expect(offsetsToRange(root, 3, 9)?.toString()).toBe("lo bra");
  });

  it("handles element boundary points", () => {
    const r = document.createRange();
    r.setStart(root, 0);
    r.setEnd(root, 1); // all of first <p>
    expect(rangeToOffsets(root, r)).toEqual({ start: 0, end: 15 });
    r.setEnd(root, 2);
    expect(rangeToOffsets(root, r)).toEqual({
      start: 0,
      end: flatText(root).length,
    });
  });

  it("ends at the end of a node, not the start of the next", () => {
    const r = offsetsToRange(root, 6, 11);
    expect(r?.toString()).toBe("brave");
    expect(r?.endContainer.nodeValue).toBe("brave");
  });

  it("returns null outside root or out of bounds", () => {
    const r = document.createRange();
    r.selectNodeContents(document.body);
    expect(rangeToOffsets(document.createElement("div"), r)).toBeNull();
    expect(offsetsToRange(root, 0, 9999)).toBeNull();
    expect(offsetsToRange(root, 5, 2)).toBeNull();
  });

  it("works end to end with the anchor module, including emoji offsets", () => {
    const text = flatText(root);
    const sel = offsetsToRange(
      root,
      text.indexOf("world"),
      text.indexOf("end"),
    );
    const o = rangeToOffsets(root, sel as Range);
    const anchor = createTextAnchor(text, o?.start ?? 0, o?.end ?? 0, 1);
    expect(anchor.exact).toBe("world 😀 ");
    // the page changes: a new paragraph is added in front
    root.insertAdjacentHTML("afterbegin", "<p>Preface. </p>");
    const t2 = flatText(root);
    const res = resolveTextAnchor(t2, anchor);
    expect(res.state).toBe("exact");
    if (res.state === "exact")
      expect(offsetsToRange(root, res.start, res.end)?.toString()).toBe(
        "world 😀 ",
      );
  });

  it("leaves out svg style and script text too, and one index serves many lookups", () => {
    root.insertAdjacentHTML(
      "beforeend",
      "<svg><style>.a{fill:red}</style><script>var x</script></svg><i>tail</i>",
    );
    const idx = indexText(root);
    expect(idx.text).toBe("Hello brave newworld \u{1F600} endtail");
    expect(rangeFromIndex(idx, 6, 11)?.toString()).toBe("brave");
    expect(rangeFromIndex(idx, 0, idx.text.length)?.toString()).toBe(idx.text);
    expect(rangeFromIndex(idx, 0, idx.text.length + 1)).toBeNull();
    expect(nodeAtIndex(idx, 7)?.data).toBe("brave");
    expect(nodeAtIndex(idx, idx.text.length)).toBeNull();
  });
});
