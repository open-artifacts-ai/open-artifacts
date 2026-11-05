// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

const sent: unknown[] = [];
vi.mock("@oa/shared", async (orig) => ({
  ...(await orig<typeof import("@oa/shared")>()),
  sendToShell: (m: unknown) => sent.push(m),
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "/_oa/w.mjs",
}));
let releaseDoc: () => void = () => {};
const getDocument = vi.fn();
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: (...a: unknown[]) => getDocument(...a),
}));

import { renderCode } from "../src/code";
import { prepareMarkdown, renderMarkdown } from "../src/markdown";
import { renderPdf } from "../src/pdf";

afterEach(() => {
  sent.length = 0;
  vi.unstubAllGlobals();
  // No pdf state carries into the next test.
  releaseDoc = () => {};
  getDocument.mockReset();
});

/** Until renderPdf has asked pdf.js for the document (so releaseDoc is its). */
const loading = () =>
  vi.waitFor(() => expect(getDocument).toHaveBeenCalledTimes(1));

describe("B11 adversarial: shiki on hostile code", () => {
  // Measured: one 20 KB line takes ~26 s (quadratic); a 500 KB line (under the 512 KB cap) hangs for hours.
  it("renderCode on a 8 KB single line finishes quickly", async () => {
    // Warm up first: the budget is for the line, not the cold highlighter
    // build and grammar import.
    await renderCode("a", "ts");
    const t = performance.now();
    await renderCode("a".repeat(8_000), "ts");
    expect(performance.now() - t).toBeLessThan(1000);
  }, 20_000);

  it("a markdown fence with a 8 KB line finishes quickly (fences have no size cap)", async () => {
    const md = "```ts\n" + "a".repeat(8_000) + "\n```\n";
    await prepareMarkdown(md);
    const t = performance.now();
    renderMarkdown(md);
    expect(performance.now() - t).toBeLessThan(1000);
  }, 20_000);
});

describe("B11 adversarial: pdf", () => {
  function setup() {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
      },
    );
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array([1])));
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 100 * scale,
        height: 100 * scale,
      }),
      render: () => ({ promise: Promise.resolve(), cancel() {} }),
      getTextContent: async () => ({ items: [{ str: "hi", hasEOL: false }] }),
      cleanup() {},
    };
    const doc = { numPages: 1, getPage: vi.fn(async () => page) };
    getDocument.mockImplementation((opts: unknown) => ({
      opts,
      promise: new Promise((r) => {
        releaseDoc = () => r(doc);
      }),
    }));
    HTMLCanvasElement.prototype.getContext = (() => ({
      fillRect() {},
    })) as never;
    HTMLCanvasElement.prototype.toDataURL = () => "data:image/webp;base64,AAAA";
    return doc;
  }

  // FE11: the shell sends thumb.request right after `hello`; boot() sends hello before pdf.js/fetch/parse finish.
  it("answers a thumb.request that arrives while the PDF is still loading", async () => {
    setup();
    const p = renderPdf("/a/v1/x.pdf", document.body);
    await loading();
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window.parent,
        data: { oa: 1, type: "thumb.request" },
      }),
    );
    releaseDoc();
    await p;
    await vi.waitFor(() =>
      expect(
        sent.some((m) => (m as { type: string }).type === "thumb.ready"),
      ).toBe(true),
    );
  });

  it("disables eval in pdf.js (defense in depth; CSP has no script-src)", async () => {
    setup();
    const p = renderPdf("/a/v1/x.pdf", document.body);
    await loading();
    releaseDoc();
    await p;
    expect(getDocument.mock.calls[0]?.[0]).toMatchObject({
      isEvalSupported: false,
    });
  });
});
