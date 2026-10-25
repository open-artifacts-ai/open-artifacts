import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// /privacy and /terms, built. Google's OAuth verification checks these.
const page = (p: string) =>
  readFileSync(
    fileURLToPath(new URL(`../dist/${p}/index.html`, import.meta.url)),
    "utf8",
  );
const privacy = page("privacy");
const terms = page("terms");
const home = readFileSync(
  fileURLToPath(new URL("../dist/index.html", import.meta.url)),
  "utf8",
);

describe("legal pages", () => {
  it("the privacy policy has Google's Limited Use statement and names every scope", () => {
    expect(privacy).toContain(
      "use and transfer of information received from Google APIs to any other app will adhere to the",
    );
    expect(privacy).toContain(
      "https://developers.google.com/terms/api-services-user-data-policy",
    );
    expect(privacy).toContain("Limited Use requirements");
    for (const scope of [
      "openid",
      "email",
      "profile",
      "admin.directory.user.readonly",
      "admin.directory.group.readonly",
      "admin.directory.domain.readonly",
      "admin.reports.audit.readonly",
    ])
      expect(privacy).toContain(`<code>${scope}</code>`);
    expect(privacy).toMatch(/don.t use it to develop, improve or train AI/);
  });

  it("both pages say self-hosted instances are the operator's", () => {
    expect(privacy).toContain("Self-hosted instances aren");
    expect(terms).toContain("self-hosted");
  });

  it("the footer links both pages", () => {
    expect(home).toContain('href="/privacy/"');
    expect(home).toContain('href="/terms/"');
  });

  it("uses no em dashes", () => {
    for (const html of [privacy, terms]) expect(html).not.toContain("—");
  });
});
