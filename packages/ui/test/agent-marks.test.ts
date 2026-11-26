// agy S6: one set of agent app marks for the landing row and the Agents page.
import { describe, expect, it } from "vitest";
import {
  AGENT_MARKS,
  agentMark,
  agentMarkSvg,
  agentMarkUrl,
  hasOwnMark,
} from "../src/brand/agent-marks";

describe("agent marks", () => {
  it("has a mark for every app the server names, and a neutral one for the rest", () => {
    for (const p of [
      "Claude Code",
      "Codex",
      "OpenCode",
      "Pi",
      "Hermes",
      "OpenClaw",
      "Antigravity",
    ]) {
      expect(hasOwnMark(p), p).toBe(true);
      expect(agentMark(p)).toBe(AGENT_MARKS[p as keyof typeof AGENT_MARKS]);
    }
    for (const p of [undefined, "kiro", "oh-my-pi", "toString", "Agent"]) {
      expect(hasOwnMark(p), String(p)).toBe(false);
      expect(agentMark(p)).toBe(AGENT_MARKS.Agent);
    }
  });

  it("text-colour marks are mono; colour marks keep their own colours", () => {
    const mono = Object.entries(AGENT_MARKS)
      .filter(([, m]) => "mono" in m && m.mono)
      .map(([n]) => n);
    expect(mono.sort()).toEqual(
      ["Agent", "Antigravity", "Codex", "Cursor", "OpenCode"].sort(),
    );
    expect(agentMarkSvg(AGENT_MARKS["Claude Code"])).toContain(
      'fill="#D97757"',
    );
  });

  it("every mark is self-contained: no outside URL, no script", () => {
    for (const [n, m] of Object.entries(AGENT_MARKS)) {
      const url = agentMarkUrl(m);
      expect(url, n).toMatch(/^data:image\/(svg\+xml|png)/);
      if ("body" in m) {
        expect(m.body, n).not.toMatch(/https?:|<script|href=|on\w+=/i);
        expect(agentMarkSvg(m)).toMatch(
          /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/,
        );
      }
    }
  });
});
