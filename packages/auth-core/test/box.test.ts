import { describe, expect, it } from "vitest";
import { boxKeyPair, openFromBroker, sealToInstall } from "../src/box.js";

describe("box (tokens sealed to the requesting install)", () => {
  it("opens only with the recipient key, install id and key id", async () => {
    const me = await boxKeyPair();
    const box = await sealToInstall(me.pub, "inst-a", "kid1", "secret");
    expect(JSON.stringify(box)).not.toContain("secret");
    expect(await openFromBroker(me, "inst-a", "kid1", box)).toBe("secret");
    await expect(openFromBroker(me, "inst-b", "kid1", box)).rejects.toThrow();
    await expect(openFromBroker(me, "inst-a", "kid2", box)).rejects.toThrow();
    await expect(
      openFromBroker(await boxKeyPair(), "inst-a", "kid1", box),
    ).rejects.toThrow();
    await expect(
      openFromBroker(me, "inst-a", "kid1", { ...box, ct: `${box.ct}A` }),
    ).rejects.toThrow();
  });

  it("uses a fresh broker key and IV per seal", async () => {
    const me = await boxKeyPair();
    const a = await sealToInstall(me.pub, "i", "k", "x");
    const b = await sealToInstall(me.pub, "i", "k", "x");
    expect(a.epk).not.toBe(b.epk);
    expect(a.iv).not.toBe(b.iv);
  });

  it("refuses a malformed recipient key", async () => {
    await expect(sealToInstall("short", "i", "k", "x")).rejects.toThrow();
  });
});
