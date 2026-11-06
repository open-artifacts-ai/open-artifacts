import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The setup docs must match scripts/setup: every oa:setup flag and step the
// docs mention has to exist in the code, and the flag table lists them all.
const setupSrc = fileURLToPath(
  new URL("../../../scripts/setup/src/", import.meta.url),
);
const docsDir = fileURLToPath(new URL("../src/content/docs/", import.meta.url));
const doc = (name: string) => readFileSync(`${docsDir}${name}`, "utf8");

const index = readFileSync(`${setupSrc}index.ts`, "utf8");
const options = index.match(/options: \{\n([\s\S]*?)\n {4}\},/)?.[1] ?? "";
const codeFlags = new Set(
  [...options.matchAll(/^\s+"?([a-z][a-z-]*)"?: \{ type:/gm)].map(
    ([, f]) => `--${f}`,
  ),
);
const stepNames = readdirSync(`${setupSrc}steps`).map(
  (f) =>
    readFileSync(`${setupSrc}steps/${f}`, "utf8").match(
      /: Step = \{\n\s+name: "([^"]+)"/,
    )?.[1],
);

/** Flags in `oa:setup` commands and in inline code that starts with `--`. */
function docFlags(md: string): string[] {
  const spans = [
    ...[...md.matchAll(/`([^`\n]+)`/g)]
      .map(([, c]) => c)
      .filter((c) => c.startsWith("--") || c.includes("oa:setup")),
    ...md.split("\n").filter((l) => l.includes("oa:setup")),
  ];
  // `--reporter=silent` belongs to pnpm, not to oa:setup.
  return spans.flatMap((s) =>
    (s.match(/--[a-z][a-z-]*/g) ?? []).filter((f) => f !== "--reporter"),
  );
}

describe("setup docs match scripts/setup", () => {
  it("reads the flags and steps from the code", () => {
    expect(codeFlags).toContain("--json");
    expect(codeFlags.size).toBeGreaterThanOrEqual(9);
    expect(stepNames).not.toContain(undefined);
  });

  it("mentions only flags that exist", () => {
    for (const name of ["setup.md", "upgrade.md", "connect-agents.md"]) {
      const flags = docFlags(doc(name));
      expect(flags.length, name).toBeGreaterThan(0);
      for (const f of flags) expect(codeFlags, `${name}: ${f}`).toContain(f);
    }
  });

  it("lists every flag in the setup flag table", () => {
    const table = doc("setup.md").split("## Setup flags")[1]?.split("\n## ")[0];
    const listed = [...(table ?? "").matchAll(/^\| `(--[a-z-]+)` \|/gm)].map(
      ([, f]) => f,
    );
    expect(new Set(listed)).toEqual(codeFlags);
  });

  it("names every setup step", () => {
    const setup = doc("setup.md");
    for (const step of stepNames) expect(setup).toContain(`\`${step}\``);
  });
});
