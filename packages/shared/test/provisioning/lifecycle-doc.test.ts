import { describe, expect, it } from "vitest";
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  InstallStateSchema,
  JOB_ERROR_CODES,
  JOB_STEPS,
  LIFECYCLE_DOC_URI,
  lifecycleDoc,
  STATE_PRECEDENCE,
  TokenScopeSchema,
  TRANSITIONS,
} from "../../src/provisioning/index.js";

describe("lifecycle doc (oa-admin://docs/lifecycle)", () => {
  const doc = lifecycleDoc();

  it("is markdown with no data and no em dash", () => {
    expect(LIFECYCLE_DOC_URI).toBe("oa-admin://docs/lifecycle");
    expect(doc.startsWith("# ")).toBe(true);
    expect(doc).not.toContain("—");
    expect(doc).not.toMatch(/\bi[a-z0-9]{11}\b/);
    expect(lifecycleDoc()).toBe(doc);
  });

  it("states in precedence order", () => {
    expect(STATE_PRECEDENCE.map((s) => s.state).sort()).toEqual(
      [...InstallStateSchema.options].sort(),
    );
    const at = STATE_PRECEDENCE.map((s) => doc.indexOf(`| ${s.state} |`));
    for (const i of at) expect(i).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("every transition, job's steps, error code and scope", () => {
    for (const [from, row] of Object.entries(TRANSITIONS))
      for (const [kind, t] of Object.entries(row))
        expect(doc, `${from} ${kind}`).toContain(
          `| ${from} | ${kind} | ${t?.actors.join(", ")} | ${t?.to.join(", ")} |`,
        );
    for (const [kind, steps] of Object.entries(JOB_STEPS))
      expect(doc, kind).toContain(`| ${kind} | ${steps.join(" > ")} |`);
    for (const c of API_ERROR_CODES)
      expect(doc, c).toContain(`| ${c} | ${API_ERROR_STATUS[c]} |`);
    for (const c of JOB_ERROR_CODES) expect(doc, c).toContain(`| ${c} |`);
    for (const s of TokenScopeSchema.options)
      expect(doc, s).toContain(`\`${s}\``);
    expect(doc).toContain("every 2 s");
  });
});
