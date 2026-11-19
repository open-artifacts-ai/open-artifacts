// Moved from e2e/favicon.spec.ts (#2711): the head declares the icons and theme color.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

it("document head declares the icons and theme color", () => {
  expect(html).toContain(
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
  );
  expect(html).toContain(
    '<link rel="icon" href="/favicon.ico" sizes="32x32" />',
  );
  expect(html).toContain(
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
  );
  expect(html).toContain(
    '<meta name="theme-color" content="#EEF0F3" media="(prefers-color-scheme: light)" />',
  );
  expect(html).toContain(
    '<meta name="theme-color" content="#131518" media="(prefers-color-scheme: dark)" />',
  );
});
