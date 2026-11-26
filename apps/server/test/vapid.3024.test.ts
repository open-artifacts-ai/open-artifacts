import { afterEach, expect, it, vi } from "vitest";
import { deriveVapidPair } from "../src/auth/keys.js";
import { b64urlEncode } from "../src/util/crypto.js";

const fixture = { SESSION_SECRET: "synthetic-secret-one-0123456789abcdef" };
// Public SEC1 points calculated independently with Node's hkdfSync and
// createECDH("prime256v1"), using 48 bytes reduced modulo the P-256 order.
const expected = {
  vapid:
    "BNo1sT3szhILDYKo4b2pE6wXDfhW973TMgO_IvwHBDjAiV3Q0ufflwcHl_sknl4f8sGmomRA9LHUemnZZhPD_5M",
  alternate:
    "BGRHqc8xW5vL7wMfZxB4yNKBRLHHP7ZeZKj38YZPUuLHnuUeuodtULms4QNFy8195NxjCH1MmWDLyRou_w9w3UE",
  retry:
    "BFnWQVJmTdUlgimN_UCh6sZP3RVNk2kXdBkTAq_J-2KpGUwttSuoffnQZQQgFHv4uAkWyozPy5H494fAhC4W5gA",
};

afterEach(() => vi.restoreAllMocks());

it("uses the VAPID label and computes the matching public point in workerd", async () => {
  const { publicKey, signKey } = await deriveVapidPair(fixture);
  expect(b64urlEncode(publicKey)).toBe(expected.vapid);
  expect(signKey.extractable).toBe(false);
  const deriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "deriveBits").mockImplementationOnce(
    (algorithm, key, length) =>
      deriveBits(
        {
          ...(algorithm as HkdfParams),
          info: new TextEncoder().encode("oa:fixture-only"),
        },
        key,
        length,
      ),
  );
  const other = await deriveVapidPair(fixture);
  expect(b64urlEncode(other.publicKey)).toBe(expected.alternate);
  expect(b64urlEncode(other.publicKey)).not.toBe(b64urlEncode(publicKey));
});

it("retries a zero scalar with the next counter in the HKDF label", async () => {
  vi.spyOn(crypto.subtle, "deriveBits").mockResolvedValueOnce(
    new ArrayBuffer(48),
  );
  const { publicKey } = await deriveVapidPair(fixture);
  expect(b64urlEncode(publicKey)).toBe(expected.retry);
});
