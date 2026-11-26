// #3007: the browser half, proven in a real browser. A picture past the
// worker's limits (longest side 1,568 px, or 3 MB) is downscaled before the
// upload; one within them goes up byte for byte.
//
// The bytes are read back from the mock upload store (src/mockPictures.ts
// keeps what the PUT sent and serves it at the picture route), so the
// assertions read what actually went up, not what the app meant to send. The
// store is also where the reservation's `bytes` came from: the mock records
// the POST's claim and serves it as the picture's `bytes`.
import { expect, type Locator, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const SIDE_MAX = 1568;

/** A PNG drawn in the page, as bytes. */
async function png(page: Page, w: number, h: number, hue = 220) {
  const b64 = await page.evaluate(
    ([hue, w, h]) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d") as CanvasRenderingContext2D;
      g.fillStyle = `hsl(${hue} 60% 80%)`;
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#fff";
      g.fillRect(w * 0.08, h * 0.12, w * 0.5, h * 0.1);
      g.fillRect(w * 0.08, h * 0.32, w * 0.84, h * 0.5);
      for (let i = 0; i < 40; i++) {
        g.fillStyle = `hsl(${(hue + i * 9) % 360} 70% 60%)`;
        g.fillRect((w / 40) * i, h * 0.86, w / 40, h * 0.08);
      }
      return c.toDataURL("image/png").split(",")[1] ?? "";
    },
    [hue, w, h] as const,
  );
  return Buffer.from(b64, "base64");
}

/** A PNG's pixel size, read from its IHDR (bytes 16..24). */
const pngSize = (b: Buffer) => ({
  w: b.readUInt32BE(16),
  h: b.readUInt32BE(20),
});

type Shot = { id: string; bytes: number; type: string };

/** The picture the mock stored for a thread's first comment. */
async function stored(page: Page, body: string) {
  // The list is the mock's: the post lands a tick after the box clears.
  let shot: Shot | undefined;
  await expect
    .poll(
      async () => {
        const list = await page.evaluate(async (id) => {
          const r = await fetch(`/api/v1/artifacts/${id}/comments`);
          return r.json();
        }, ID);
        const thread = (
          list as {
            threads: { comments: { body: string; pictures?: Shot[] }[] }[];
          }
        ).threads.find((t) => t.comments.some((c) => c.body.includes(body)));
        shot = thread?.comments.flatMap((c) => c.pictures ?? [])[0];
        return shot?.id ?? null;
      },
      { timeout: 15_000 },
    )
    .not.toBeNull();
  const id = (shot as Shot).id;
  let bytes = Buffer.alloc(0);
  await expect
    .poll(
      async () => {
        const b64 = await page.evaluate(async (url) => {
          const r = await fetch(url);
          if (!r.ok) return "";
          const buf = new Uint8Array(await r.arrayBuffer());
          let s = "";
          for (const x of buf) s += String.fromCharCode(x);
          return btoa(s);
        }, `/api/v1/artifacts/${ID}/pictures/${id}`);
        bytes = Buffer.from(b64, "base64");
        return bytes.length;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
  return { shot: shot as Shot, sent: bytes };
}

async function open(page: Page) {
  await page.goto(`/a/${ID}?mock=agents`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  const box = page.getByRole("textbox", { name: "Comment on the whole page" });
  await expect(box).toBeVisible();
  const card = box.locator(
    "xpath=ancestor::div[.//input[@data-attach-input]][1]",
  );
  return { box, card };
}

/** Attach one picture, post the comment, and hand back what went up. */
async function attachAndPost(
  page: Page,
  card: Locator,
  box: Locator,
  buffer: Buffer,
  name: string,
  body: string,
) {
  await card.locator("[data-attach-input]").setInputFiles({
    name,
    mimeType: "image/png",
    buffer,
  });
  await expect(card.locator('[data-attached-picture="done"]')).toHaveCount(1);
  await box.fill(body);
  await card.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(card.locator("[data-attached-picture]")).toHaveCount(0);
  return stored(page, body);
}

test.use({ colorScheme: "light", viewport: { width: 1280, height: 800 } });

test("a large picture goes up downscaled to 1,568 px", async ({ page }) => {
  const { box, card } = await open(page);
  const big = await png(page, 2400, 1600);
  expect(pngSize(big)).toEqual({ w: 2400, h: 1600 });

  const { shot, sent } = await attachAndPost(
    page,
    card,
    box,
    big,
    "big-shot.png",
    "The toolbar on the wide shot.",
  );

  const size = pngSize(sent);
  // The bytes that went up are the scaled picture, not the picked one.
  expect(Math.max(size.w, size.h)).toBeLessThanOrEqual(SIDE_MAX);
  expect(size).toEqual({ w: 1568, h: 1045 });
  expect(sent.length).toBeLessThan(big.length / 2);
  // The reservation was asked for with the scaled size, and it is what stored.
  expect(shot.bytes).toBe(sent.length);
  console.log(
    `#3007 large: picked ${big.length} B ${pngSize(big).w}x${pngSize(big).h} -> sent ${sent.length} B ${size.w}x${size.h}`,
  );
});

test("a small picture goes up byte for byte", async ({ page }) => {
  const { box, card } = await open(page);
  const small = await png(page, 480, 320, 140);
  expect(pngSize(small)).toEqual({ w: 480, h: 320 });

  const { shot, sent } = await attachAndPost(
    page,
    card,
    box,
    small,
    "small-shot.png",
    "The toolbar, zoomed out.",
  );

  expect(sent.equals(small)).toBe(true);
  expect(shot.bytes).toBe(small.length);
  expect(pngSize(sent)).toEqual({ w: 480, h: 320 });
  console.log(
    `#3007 small: picked ${small.length} B 480x320 -> sent ${sent.length} B 480x320 (identical)`,
  );
});

/** A PNG of pure noise: it compresses to nothing, so it is big in bytes. */
async function noisePng(page: Page, w: number, h: number) {
  const b64 = await page.evaluate(
    ([w, h]) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d") as CanvasRenderingContext2D;
      const img = g.createImageData(w, h);
      // mulberry32: no repeats to compress, and the same bytes every run.
      let a = 0x9e3779b9;
      const next = () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) & 255;
      };
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = next();
        img.data[i + 1] = next();
        img.data[i + 2] = next();
        img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      return c.toDataURL("image/png").split(",")[1] ?? "";
    },
    [w, h] as const,
  );
  return Buffer.from(b64, "base64");
}

test("a picture over 3 MB goes up smaller, by its bytes", async ({ page }) => {
  const { box, card } = await open(page);
  const big = await noisePng(page, 1500, 1000);
  expect(pngSize(big)).toEqual({ w: 1500, h: 1000 });
  expect(big.length).toBeGreaterThan(3 * 1024 * 1024);

  const { sent } = await attachAndPost(
    page,
    card,
    box,
    big,
    "noise.png",
    "The noisy one.",
  );

  const size = pngSize(sent);
  expect(sent.length).toBeLessThanOrEqual(3 * 1024 * 1024);
  expect(Math.max(size.w, size.h)).toBeLessThanOrEqual(SIDE_MAX);
  expect(sent.length).toBeLessThan(big.length);
  console.log(
    `#3007 noise: picked ${big.length} B 1500x1000 -> sent ${sent.length} B ${size.w}x${size.h}`,
  );
});
