import { describe, expect, it } from "vitest";
import {
  renderConfirmPage,
  renderReachConfirm,
  renderRoleConfirm,
} from "../../src/bus/approve-page";

const common = {
  instanceHost: "h.example",
  userEmail: "a@b.c",
  csrf: "c",
  switchUrl: "#",
  minutesLeft: 5,
  machineLabel: "m",
  proposedAt: 0,
};
const evil = "github.com/o/<b>x</b>";
const ok = ["github.com/o/a", "github.com/o/b", evil];

/** The namespace spans, in order. */
const lines = (h: string) =>
  [...h.matchAll(/<span class="ns mono wrap">([^<]*)<\/span>/g)].map(
    (m) => m[1],
  );

describe("reach and role cards list namespaces one per line, escaped", () => {
  it("reach card: What it allows and Never seen", () => {
    const h = renderReachConfirm({
      ...common,
      roleName: "r",
      roleNamespace: "github.com/o/home",
      holderName: "h",
      namespaces: ok,
      unknown: [evil],
      noop: false,
    });
    const esc = "github.com/o/&lt;b&gt;x&lt;/b&gt;";
    expect(lines(h)).toEqual([...ok.slice(0, 2), esc, esc]);
    expect(h).not.toContain("<b>x</b>");
    // "They can reply." is its own line after the list.
    expect(h).toMatch(/<\/span>They can reply\./);
    expect(h).not.toMatch(/<\/span>, <span class="ns/);
  });
  it("role card: reach list", () => {
    const h = renderRoleConfirm({
      ...common,
      action: "repoint",
      namespace: "n",
      name: "r",
      priorHolderName: "a",
      priorHolderGone: false,
      agentName: "b",
      reach: ok,
    });
    expect(lines(h)).toHaveLength(3);
    expect(h).not.toContain("<b>x</b>");
  });
  it("the served shell is one card, and the script swaps it for the fetched card", () => {
    const h = renderConfirmPage({
      instanceHost: "h",
      title: "t",
      base: "/b",
      csrf: "c",
      nonce: "n",
    });
    expect(h).toContain('id="c"');
    expect(h.match(/class="slot card"/g)).toHaveLength(1);
    expect(h).toContain('c.className="slot";c.innerHTML=j.html');
  });
});
