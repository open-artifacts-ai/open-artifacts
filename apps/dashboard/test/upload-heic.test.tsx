// @vitest-environment jsdom
// #779: the dashboard converts an iPhone HEIC photo to JPEG before upload.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client";
import {
  convertHeicPhotos,
  heicToJpeg,
  isHeicPath,
  jpegPath,
} from "../src/upload/heic";
import { calls, findVisibleToast, installHarness, mount } from "./harness";

installHarness();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HEIC_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
]);
const photo = (name: string, rel?: string) => {
  const f = new File([HEIC_BYTES], name, { type: "image/heic" });
  if (rel) Object.defineProperty(f, "webkitRelativePath", { value: rel });
  return f;
};

/** This browser draws HEIF: a bitmap, a 2d context and a JPEG from the canvas. */
const decodeWorks = () => {
  vi.stubGlobal(
    "createImageBitmap",
    async () => ({ width: 4, height: 4, close() {} }) as unknown as ImageBitmap,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage() {},
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb) =>
    cb(new Blob(["jpeg"], { type: "image/jpeg" })),
  );
};

/** Pick `files` in the DropZone's picker. */
const pick = async (files: File[]) => {
  const input = (await screen.findByTestId("upload-files")) as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
};

/** The bytes of an upload PUT reach msw only through fetch here. */
const putViaFetch = () =>
  vi.spyOn(api, "putRaw").mockImplementation(async (url, _body, type) => {
    await fetch(url, { method: "PUT", headers: { "Content-Type": type } });
  });

describe("HEIC names", () => {
  it("reads a photo's extension, and swaps only that", () => {
    expect(isHeicPath("IMG_0042.heic")).toBe(true);
    expect(isHeicPath("photos/IMG_0042.HEIF")).toBe(true);
    expect(isHeicPath("IMG_0042.jpg")).toBe(false);
    expect(jpegPath("photos/IMG_0042.heic")).toBe("photos/IMG_0042.jpg");
    expect(jpegPath("no-extension")).toBe("no-extension.jpg");
  });
});

describe("convertHeicPhotos", () => {
  it("re-encodes a decodable photo as JPEG, keeping its path", async () => {
    decodeWorks();
    const out = await convertHeicPhotos([
      photo("IMG_0042.heic", "trip/IMG_0042.heic"),
    ]);
    expect(out.converted).toEqual(["trip/IMG_0042.heic"]);
    const [jpeg] = out.files as [File];
    expect(jpeg.name).toBe("IMG_0042.jpg");
    expect(jpeg.type).toBe("image/jpeg");
    expect(jpeg.webkitRelativePath).toBe("trip/IMG_0042.jpg");
  });

  it("a browser that can't decode HEIF leaves the file alone", async () => {
    // jsdom has no createImageBitmap: the conversion has nothing to work with.
    const original = photo("IMG_0042.heic");
    expect(await heicToJpeg(original)).toBeNull();
    const out = await convertHeicPhotos([original]);
    expect(out.converted).toEqual([]);
    expect(out.files[0]).toBe(original);
  });

  it("passes everything that isn't a photo straight through", async () => {
    const md = new File(["x"], "README.md", { type: "text/markdown" });
    const out = await convertHeicPhotos([md]);
    expect(out.converted).toEqual([]);
    expect(out.files[0]).toBe(md);
  });
});

describe("the upload dialog", () => {
  it("publishes the JPEG the photo became, and says so", async () => {
    putViaFetch();
    decodeWorks();
    const posts = calls("POST");
    mount("/");
    await pick([photo("IMG_0042.heic")]);
    expect(await screen.findByLabelText("Title")).toHaveValue("IMG_0042");
    await findVisibleToast("1 HEIC photo converted to JPEG");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posts.length).toBeGreaterThan(0));
    const publish = posts[posts.length - 1];
    expect(publish?.path).toBe("/api/v1/artifacts");
    expect(publish?.body).toMatchObject({
      entry: "IMG_0042.jpg",
      files: { "IMG_0042.jpg": { uploadId: expect.any(String) } },
    });
  });

  it("a browser that can't decode it keeps the export hint", async () => {
    mount("/");
    await pick([photo("IMG_0042.heic")]);
    const title = await screen.findByLabelText("Title");
    await waitFor(() => expect(title).toHaveValue("IMG_0042"));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "IMG_0042.heic can't be opened here. Export it as JPEG or PNG, then upload it again.",
    );
  });
});
