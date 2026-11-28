import { describe, expect, it } from "vitest";
import { PendingVersionLinks } from "../../src/bus/late-version.js";

describe("late Codex version attribution", () => {
  const identity = {
    identityId: "identity",
    name: "Codex",
    kind: "codex",
    namespace: "project",
  };
  const version = { artifactId: "artifact", version: 3 };
  for (const proofFirst of [true, false]) {
    it(`links the exact committed version once (proof first: ${proofFirst})`, async () => {
      const writes: unknown[] = [];
      const links = new PendingVersionLinks<object>(
        async (...args) => {
          writes.push(args);
        },
        () => true,
      );
      const socket = {};
      links.start("ticket", socket, "call");
      if (proofFirst) await links.prove("ticket", socket, identity);
      await links.bind("ticket", version);
      if (!proofFirst) await links.prove("ticket", socket, identity);
      await links.prove("ticket", socket, identity);
      expect(writes).toEqual([["ticket", version, identity]]);
    });
  }
  it("discards a verified reply if the socket closes before commit", async () => {
    let open = true;
    const writes: unknown[] = [];
    const links = new PendingVersionLinks<object>(
      async (...args) => {
        writes.push(args);
      },
      () => open,
    );
    const socket = {};
    links.start("ticket", socket, "call");
    await links.prove("ticket", socket, identity);
    open = false;
    await links.bind("ticket", version);
    expect(writes).toEqual([["ticket", version, null]]);
  });

  it("ends the association when the original connection closes", async () => {
    const writes: unknown[] = [];
    const links = new PendingVersionLinks<object>(
      async (...args) => {
        writes.push(args);
      },
      () => true,
    );
    const socket = {};
    links.start("ticket", socket, "call");
    await links.bind("ticket", version);
    expect(links.start("other ticket", {}, "call")).toBe(false);
    await links.close(socket);
    expect(links.hasCall("call")).toBe(false);
    await links.prove("ticket", {}, identity);
    expect(writes).toEqual([["ticket", version, null]]);
  });
});
