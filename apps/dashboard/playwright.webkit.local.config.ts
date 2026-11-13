import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Local only: the same mock-API specs in WebKit.
export default defineConfig({
  ...base,
  use: { ...base.use, browserName: "webkit" },
});
