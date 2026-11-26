// agy S6: one set of agent app marks for the landing row and the Agents page.
import { describe, expect, it } from "vitest";
import {
  AGENT_MARKS,
  agentMark,
  agentMarkSvg,
  agentMarkUrl,
  hasOwnMark,
  letterMark,
} from "../src/brand/agent-marks";

describe("agent marks", () => {
  it("has a mark for every app the server names, and a neutral one for the rest", () => {
    for (const p of [
      "Claude Code",
      "Codex",
      "OpenCode",
      "pi",
      "oh-my-pi",
      "Hermes",
      "OpenClaw",
      "Antigravity",
    ]) {
      expect(hasOwnMark(p), p).toBe(true);
      expect(agentMark(p)).toBe(AGENT_MARKS[p as keyof typeof AGENT_MARKS]);
    }
    for (const p of [undefined, "kiro", "Pi", "toString", "Agent"]) {
      expect(hasOwnMark(p), String(p)).toBe(false);
      expect(agentMark(p)).toBe(AGENT_MARKS.Agent);
    }
  });

  it("an unknown kind gets a tile with its first letter; oh-my-pi has its own (agy S6)", () => {
    expect(agentMark(undefined, "kiro")).toEqual(letterMark("K"));
    expect(agentMark(undefined, "-9lives")).toEqual(letterMark("9"));
    expect(agentMark(undefined, "émoji ✨ zed")).toEqual(letterMark("M"));
    expect(agentMark(undefined, "<>")).toBe(AGENT_MARKS.Agent);
    expect(agentMark(undefined, "")).toBe(AGENT_MARKS.Agent);
    // A known product wins over the kind.
    expect(agentMark("Codex", "codex")).toBe(AGENT_MARKS.Codex);
    const k = agentMarkSvg(letterMark("K"), "#123456");
    expect(k).toContain(">K</text>");
    expect(k).toContain('color="#123456"');
    // A letter tile never draws anything but one A-Z or 0-9.
    expect(letterMark("<b>").body).toContain(">?</text>");
    // oh-my-pi's tile is not the plain tile, nor a letter tile.
    const omp = AGENT_MARKS["oh-my-pi"];
    expect(omp.body).toContain(">omp</text>");
    expect(omp).not.toEqual(AGENT_MARKS.Agent);
    expect(omp).not.toEqual(letterMark("O"));
  });

  it("text-colour marks are mono; colour marks keep their own colours", () => {
    const mono = Object.entries(AGENT_MARKS)
      .filter(([, m]) => "mono" in m && m.mono)
      .map(([n]) => n);
    expect(mono.sort()).toEqual(
      [
        "Agent",
        "Antigravity",
        "Codex",
        "Cursor",
        "OpenCode",
        "oh-my-pi",
      ].sort(),
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
