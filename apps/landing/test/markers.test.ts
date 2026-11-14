import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GATES, gatesFor } from "../src/lib/release";
import { selectTools } from "../src/lib/tools";

// Platform's release gate blocks the production deploy while dist/ contains
// "TODO" or "OA-UNRELEASED". These markers keep known stand-ins from shipping.
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const manifest = fileURLToPath(
  new URL("../../server/src/mcp/tool-manifest.json", import.meta.url),
);
const src = fileURLToPath(new URL("../src/content/docs/", import.meta.url));
const read = (p: string) => readFileSync(`${dist}${p}`, "utf8");

const B14 = "<!-- TODO(B14): fallback tool list -->";
const META = '<meta name="oa-status" content="OA-UNRELEASED">';

describe("release-gate markers", () => {
  it("puts the agent-file markers on their own lines at the top", () => {
    const ids = gatesFor("llms");
    const top = ids.length
      ? `${ids.map((id) => `<!-- ${GATES[id].todo} -->\n`).join("")}OA-UNRELEASED: ${ids.map((id) => GATES[id].label).join(", ")}\n\n`
      : "";
    for (const file of ["llms.txt", "llms-full.txt"]) {
      expect(read(file).startsWith(`${top}# Open Artifacts\n`), file).toBe(
        true,
      );
    }
  });

  it("flags gated pages as unreleased with one meta tag, and no others", () => {
    for (const [id, page] of [
      ["index", "index.html"],
      ["mcp-tools", "docs/mcp-tools/index.html"],
      ["connect-agents", "docs/connect-agents/index.html"],
      ["setup", "docs/setup/index.html"],
      ["runtime-api", "docs/runtime-api/index.html"],
    ]) {
      const head = read(page).split("</head>")[0];
      const want = gatesFor(id).length ? 1 : 0;
      expect(head.split(META).length - 1, page).toBe(want);
    }
  });

  it("uses the fallback only when there is no manifest", () => {
    expect(selectTools([]).isFallback).toBe(true);
    const tool = { name: "get_artifact", description: "Get one." };
    expect(selectTools([[tool]])).toEqual({ tools: [tool], isFallback: false });
  });

  it("marks the fallback tool list, and only while it's in use", () => {
    const hasManifest = existsSync(manifest);
    for (const page of [
      "index.html",
      "docs/mcp-tools/index.html",
      "llms.txt",
      "llms-full.txt",
    ])
      expect(read(page).includes(B14), page).toBe(!hasManifest);
    expect(read("docs/setup/index.html")).not.toContain(B14);
  });

  // #70 added data.welcomeUrl, so the source-only Welcome TODO is gone.
  it("points the Welcome step at data.welcomeUrl", () => {
    expect(readFileSync(`${src}setup.md`, "utf8")).not.toContain("TODO");
    for (const page of ["docs/setup.md", "llms.txt"])
      expect(read(page), page).toContain("`data.welcomeUrl`");
  });

  it("has no B16 marker now that the setup docs follow scripts/setup", () => {
    for (const page of ["docs/setup/index.html", "llms.txt", "llms-full.txt"])
      expect(read(page), page).not.toMatch(/TODO\(B16\)|B16 setup flags/);
  });

  it("has no D6 marker now that the header uses the D6 logo", () => {
    for (const page of ["index.html", "docs/setup/index.html"]) {
      expect(read(page), page).not.toContain("TODO(D6)");
      expect(read(page), page).toMatch(
        /<img src="\/_astro\/logo\.[^"]+\.svg" alt="Open Artifacts"/,
      );
      expect(read(page), page).toMatch(
        /media="\(prefers-color-scheme: dark\)" srcset="\/_astro\/logo-dark\./,
      );
    }
  });

  it("references the D6 favicon, og image and theme color", () => {
    const head = read("index.html").split("</head>")[0];
    expect(head).toContain(
      '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    );
    // The home page has its own preview image (#1457); other pages keep og.png.
    expect(head).toContain(
      '<meta property="og:image" content="https://open-artifacts.com/og-home.png">',
    );
    expect(read("docs/setup/index.html").split("</head>")[0]).toContain(
      '<meta property="og:image" content="https://open-artifacts.com/og.png">',
    );
    expect(head).toContain(
      '<meta name="twitter:card" content="summary_large_image">',
    );
    expect(head).toMatch(/<meta name="theme-color"/);
    for (const f of ["favicon.svg", "og.png", "og-home.png"])
      expect(existsSync(`${dist}${f}`), f).toBe(true);
  });
});
