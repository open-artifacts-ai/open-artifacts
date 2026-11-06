import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REPO_URL } from "@oa/shared";
import { describe, expect, it } from "vitest";

// Runs against the built site: `pnpm test` builds first.
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const manifest = fileURLToPath(
  new URL("../../server/src/mcp/tool-manifest.json", import.meta.url),
);
const fallback = fileURLToPath(
  new URL("../src/data/tools.fallback.json", import.meta.url),
);

const llms = readFileSync(`${dist}llms.txt`, "utf8");
const tools: { name: string }[] = JSON.parse(
  readFileSync(existsSync(manifest) ? manifest : fallback, "utf8"),
);

describe("llms.txt", () => {
  it("has the exact headings, in order", () => {
    // Release-gate marker lines (markers.test.ts) may come first.
    expect(
      llms.replace(/^(<!-- TODO\(.+ -->\n)*(OA-UNRELEASED: .+\n\n)?/, ""),
    ).toMatch(/^# Open Artifacts\n\n/);
    const headings = llms.match(/^##? .+$/gm);
    expect(headings).toEqual([
      "# Open Artifacts",
      "## Set up Open Artifacts for your user",
      "## Update an existing install",
      "## Connect another agent",
      "## Tools",
      "## Docs",
    ]);
  });

  it("tells agents a 'set up this file' request means install, not host", () => {
    expect(llms).toContain(
      "If the user asked you to install or set up this file, optionally 'at', 'on' or 'under' a hostname, they want Open Artifacts installed with that hostname as --app-host. Don't copy or host this file.",
    );
  });

  it("lists every MCP tool", () => {
    expect(tools.length).toBeGreaterThan(0);
    for (const { name } of tools) expect(llms).toContain(`\`${name}\``);
  });

  it("runs setup non-interactively", () => {
    expect(llms).toContain("pnpm --reporter=silent oa:setup --json");
  });

  it("names the repo once, as the clone source of the latest tag", () => {
    expect(llms.split(REPO_URL).length - 1).toBe(1);
    expect(llms).toContain(`REPO=${REPO_URL}\n`);
    expect(llms).toContain('git clone --depth 1 --branch "$TAG" "$REPO"');
  });

  // GitHub's /releases/latest excludes pre-releases (and drafts) server-side,
  // so a pre-release like v0.1.0 is never installed. No fallback by design.
  it("installs the latest stable release, or stops", () => {
    const api = `${REPO_URL.replace("https://github.com/", "https://api.github.com/repos/")}/releases/latest`;
    const lines = llms.match(/^ *TAG=\$\(curl -fsSL \S+ \| .*\)$/gm) ?? [];
    expect(lines).toHaveLength(2); // setup and update
    expect(new Set(lines.map((l) => l.trim())).size).toBe(1);
    expect(lines[0]).toContain(`curl -fsSL ${api} | `);
    expect(llms).not.toContain("ls-remote");
    expect(llms).not.toContain("jq");
    expect(
      llms.split("Open Artifacts has no stable release yet; check back later.")
        .length - 1,
    ).toBe(2);

    // Run the docs' exact pipeline, minus curl, on stubbed response bodies.
    const sed = lines[0]?.match(/\| (sed .*)\)$/)?.[1] ?? "";
    const tagOf = (body: string) =>
      execFileSync("sh", ["-c", `printf '%s' "$BODY" | ${sed}`], {
        env: { ...process.env, BODY: body },
      })
        .toString()
        .trim();
    const release = JSON.stringify(
      {
        url: "https://api.github.com/x",
        tag_name: "v0.2.0",
        name: "v0.2.0",
        prerelease: false,
      },
      null,
      2,
    );
    expect(tagOf(release)).toBe("v0.2.0");
    expect(tagOf("")).toBe("");
    expect(tagOf('{"message":"Not Found","status":"404"}')).toBe("");
  });

  it("has no link that 404s in the built site", () => {
    const urls = [
      ...llms.matchAll(/https:\/\/open-artifacts\.com(\/[^\s)`"]*)?/g),
    ];
    expect(urls.length).toBeGreaterThan(0);
    for (const [, path = "/"] of urls) {
      const file = path.endsWith("/") ? `${path}index.html` : path;
      expect(existsSync(`${dist}${file.slice(1)}`), path).toBe(true);
    }
  });
});
