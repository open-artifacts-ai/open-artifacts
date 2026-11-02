import { describe, expect, test } from "vitest";
import { brokerRedeemRequest, pkceChallenge } from "../src/broker-redeem.js";
import {
  flowHash,
  keyId,
  publicFromPkcs8,
  verifyRedeem,
} from "../src/ed25519.js";

// brokerRedeemRequest moved from apps/server (design v7 4.3 step 3): the
// server and the provisioning Worker sign a redeem the same way.

const KEY = Buffer.concat([
  Buffer.from("302e020100300506032b657004220420", "hex"),
  Buffer.alloc(32, 9),
]).toString("base64url");

describe("brokerRedeemRequest", () => {
  test("a signed POST /google/redeem binding the flow", async () => {
    const req = await brokerRedeemRequest(
      {
        url: "https://auth.hosted.test",
        installId: "i000000admin",
        signingKey: KEY,
      },
      { code: "c", verifier: "v", nonce: "n", bstate: "b" },
      1234,
    );
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://auth.hosted.test/google/redeem");
    expect(req.redirect).toBe("manual");
    const body = await req.text();
    expect(JSON.parse(body)).toEqual({
      install: "i000000admin",
      code: "c",
      verifier: "v",
      ts: 1234,
      bstate: "b",
      h: await flowHash("n", await pkceChallenge("v")),
    });
    const x = await publicFromPkcs8(KEY);
    const kid = req.headers.get("x-oa-kid") ?? "";
    expect(kid).toBe(await keyId(x));
    expect(
      await verifyRedeem(x, kid, body, req.headers.get("x-oa-sig") ?? ""),
    ).toBe(true);
  });

  test("no bstate sends an empty one", async () => {
    const req = await brokerRedeemRequest(
      { url: "https://b.test", installId: "iabcdefghijk", signingKey: KEY },
      { code: "c", verifier: "v", nonce: "n" },
    );
    expect(JSON.parse(await req.text()).bstate).toBe("");
  });

  test("pkceChallenge is S256 base64url (43 chars)", async () => {
    // RFC 7636 appendix B.
    expect(
      await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});
