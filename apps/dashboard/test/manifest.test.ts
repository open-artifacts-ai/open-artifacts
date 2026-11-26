// iOS delivers Web Push only to a Home Screen web app: it needs a standalone
// manifest, its PNG icons, and a <link rel="manifest"> in the shell (#3024).
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { SW_SCOPE } from "../src/foryou/push";

const file = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url));
const html = file("index.html").toString("utf8");
const manifest = JSON.parse(
  file("public/manifest.webmanifest").toString("utf8"),
);

/** Width and height from a PNG's IHDR chunk. */
const pngSize = (b: Buffer) => {
  expect(b.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
};

it("index.html links the manifest and the standalone meta tags", () => {
  expect(html).toContain(
    '<link rel="manifest" href="/manifest.webmanifest" />',
  );
  expect(html).toContain(
    '<meta name="apple-mobile-web-app-capable" content="yes" />',
  );
  expect(html).toContain(
    '<meta name="mobile-web-app-capable" content="yes" />',
  );
  expect(html).toContain(
    '<meta name="apple-mobile-web-app-title" content="Artifacts" />',
  );
  expect(html).toContain(
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
  );
});

it("the manifest is a standalone app at the origin root", () => {
  expect(manifest).toMatchObject({
    name: "Open Artifacts",
    short_name: "Artifacts",
    start_url: "/",
    scope: "/",
    display: "standalone",
  });
  // The push service worker's scope sits inside the manifest's.
  expect(SW_SCOPE.startsWith(manifest.scope)).toBe(true);
});

it("every manifest icon is a PNG of the size it declares", () => {
  const got = manifest.icons.map(
    (i: { src: string; sizes: string; type: string; purpose: string }) => {
      expect(i.type).toBe("image/png");
      expect(pngSize(file(`public${i.src}`))).toBe(i.sizes);
      return `${i.sizes} ${i.purpose}`;
    },
  );
  expect(got).toEqual(["192x192 any", "512x512 any", "512x512 maskable"]);
});
