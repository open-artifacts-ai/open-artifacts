// #3007: the browser half. A comment picture is downscaled before upload only
// when it is past the worker's limits (longest side 1,568 px, or 3 MB); under
// both, the picked file goes up byte for byte.
//
// jsdom cannot draw: there is no `createImageBitmap` and no 2d context. The
// cases below therefore split in two, and each says which path it ran:
// - the decision (`fitForUpload`, `outputType`, `fitSide`): the real code, no
//   stubs at all;
// - `shrink` end to end with a stubbed `createImageBitmap` and a stubbed
//   canvas (`getContext`/`drawImage`/`toBlob` no-ops), which proves which
//   branch ran, what size and kind were asked for, and what the upload would
//   receive, but not that pixels were actually resampled. Real rasterisation is
//   proven in the browser: e2e/picture-shrink.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fitForUpload,
  fitSide,
  outputType,
  shrink,
  UPLOAD_LIMITS,
} from "../src/viewer/comments/pictures/shrink";

const MB = 1024 * 1024;
const file = (bytes: number, type = "image/png", name = "shot.png") =>
  new File([new Uint8Array(bytes)], name, { type });

/** A picture the browser "decodes": `createImageBitmap` stands in. */
let bitmap: { w: number; h: number };
const closed = vi.fn();
/** What each `toBlob` call is asked for, and how big it answers. */
let drawn: { w: number; h: number; type?: string }[] = [];
let encoded = 400 * 1024;

const drawCanvas = () => {
  drawn = [];
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({
      width: bitmap.w,
      height: bitmap.h,
      close: closed,
    })),
  );
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag !== "canvas") return document.createElementNS(null, tag);
    const c = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => {} }),
      toBlob: (cb: (b: Blob | null) => void, type?: string) => {
        drawn.push({ w: c.width, h: c.height, type });
        cb(new Blob([new Uint8Array(encoded)], { type: type ?? "image/png" }));
      },
    };
    return c as unknown as HTMLElement;
  }) as typeof document.createElement);
};

beforeEach(() => {
  bitmap = { w: 4000, h: 3000 };
  encoded = 400 * 1024;
  closed.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("the decision", () => {
  it("sends a picture at or under both limits untouched", () => {
    expect(
      fitForUpload({ w: 1568, h: 1568, bytes: 3 * MB, type: "image/png" }),
    ).toEqual({ scale: false });
    expect(
      fitForUpload({ w: 800, h: 600, bytes: 200 * 1024, type: "image/png" }),
    ).toEqual({ scale: false });
    // Judged on the longest side, either way round.
    expect(
      fitForUpload({ w: 300, h: 1568, bytes: 1024, type: "image/png" }),
    ).toEqual({ scale: false });
  });

  it("downscales one pixel or one byte over, to the side cap", () => {
    expect(
      fitForUpload({ w: 1569, h: 100, bytes: 1024, type: "image/png" }),
    ).toEqual({ scale: true, w: 1568, h: 100 });
    expect(
      fitForUpload({ w: 4000, h: 3000, bytes: 1024, type: "image/png" }),
    ).toEqual({ scale: true, w: 1568, h: 1176 });
    expect(
      fitForUpload({ w: 800, h: 600, bytes: 3 * MB + 1, type: "image/png" }),
    ).toEqual({ scale: true, w: 800, h: 600 });
    expect(
      fitForUpload({ w: 100, h: 3136, bytes: 1024, type: "image/png" }),
    ).toEqual({ scale: true, w: 50, h: 1568 });
  });

  it("the limits are the worker's: 1,568 px and 3 MB", () => {
    expect(UPLOAD_LIMITS).toEqual({ side: 1568, bytes: 3 * MB });
  });

  it("keeps the source kind, and PNG for a GIF", () => {
    expect(outputType("image/jpeg")).toBe("image/jpeg");
    expect(outputType("image/webp")).toBe("image/webp");
    expect(outputType("image/png")).toBe("image/png");
    expect(outputType("image/gif")).toBe("image/png");
  });
});

describe("shrink (stubbed canvas: the branch, not the pixels)", () => {
  it("a small picture is handed on as the picked file, byte for byte", async () => {
    bitmap = { w: 800, h: 600 };
    drawCanvas();
    const f = file(200 * 1024);
    const s = await shrink(f);
    expect(s.blob).toBe(f);
    expect(s.scaled).toBe(false);
    expect(s.type).toBe("image/png");
    expect(s.w).toBe(800);
    expect(s.h).toBe(600);
    expect(drawn).toEqual([]); // Nothing was drawn: no re-encode at all.
  });

  it("a large picture is drawn at the capped size, same kind", async () => {
    drawCanvas();
    const s = await shrink(file(6 * MB, "image/png", "board.png"));
    expect(s.scaled).toBe(true);
    expect(drawn.at(0)).toEqual({ w: 1568, h: 1176, type: "image/png" });
    expect(s.w).toBe(1568);
    expect(s.h).toBe(1176);
    expect(s.blob.size).toBe(encoded);
    expect(s.blob.size).toBeLessThan(6 * MB);
    expect(closed).toHaveBeenCalled(); // The bitmap is released.
  });

  it("a JPEG stays a JPEG, at quality (its own kind out of the canvas)", async () => {
    drawCanvas();
    const s = await shrink(file(6 * MB, "image/jpeg", "photo.jpg"));
    expect(drawn.at(0)?.type).toBe("image/jpeg");
    expect(s.type).toBe("image/jpeg");
  });

  it("over 3 MB with the side already inside the cap: a smaller frame", async () => {
    bitmap = { w: 1500, h: 1000 };
    drawn = [];
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({
        width: bitmap.w,
        height: bitmap.h,
        close: closed,
      })),
    );
    // The first frame is still over the byte limit; the second is not.
    let n = 0;
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      if (tag !== "canvas") return document.createElementNS(null, tag);
      const c = {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => {} }),
        toBlob: (cb: (b: Blob | null) => void, type?: string) => {
          drawn.push({ w: c.width, h: c.height, type });
          cb(new Blob([new Uint8Array(n++ === 0 ? 4 * MB : 900 * 1024)]));
        },
      };
      return c as unknown as HTMLElement;
    }) as typeof document.createElement);
    const s = await shrink(file(5 * MB));
    expect(drawn).toHaveLength(2);
    expect(drawn[1]).toEqual({ w: 1050, h: 700, type: "image/png" });
    expect(s.blob.size).toBe(900 * 1024);
    expect(s.w).toBe(1050);
    expect(s.h).toBe(700);
  });

  it("nothing decodable: the original goes up, and nothing is drawn", async () => {
    drawCanvas();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new Error("cannot decode");
      }),
    );
    const f = file(6 * MB, "image/webp", "anim.webp");
    const s = await shrink(f);
    expect(s.blob).toBe(f);
    expect(s.scaled).toBe(false);
    expect(drawn).toEqual([]);
  });

  it("no canvas: the original goes up, not a failure", async () => {
    drawCanvas();
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      if (tag !== "canvas") return document.createElementNS(null, tag);
      return { getContext: () => null } as unknown as HTMLElement;
    }) as typeof document.createElement);
    const f = file(6 * MB);
    const s = await shrink(f);
    expect(s.blob).toBe(f);
    expect(s.scaled).toBe(false);
  });

  it("an encoder that answers nothing: the original goes up", async () => {
    drawCanvas();
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      if (tag !== "canvas") return document.createElementNS(null, tag);
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => {} }),
        toBlob: (cb: (b: Blob | null) => void) => cb(null),
      } as unknown as HTMLElement;
    }) as typeof document.createElement);
    const f = file(6 * MB);
    const s = await shrink(f);
    expect(s.blob).toBe(f);
  });

  it("a copy no smaller than the original is dropped for the original", async () => {
    drawCanvas();
    encoded = 7 * MB; // The "downscaled" PNG came out bigger than the input.
    const f = file(6 * MB);
    const s = await shrink(f);
    expect(s.blob).toBe(f);
    expect(s.scaled).toBe(false);
  });

  it("fitSide at the cap keeps the shape", () => {
    expect(fitSide(4000, 3000, 1568)).toEqual({ w: 1568, h: 1176 });
  });
});
