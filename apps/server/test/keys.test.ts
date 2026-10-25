import { describe, expect, test } from "vitest";
import {
  CONTENT_KEY_LABELS,
  type ContentKeyLabel,
  contentKey,
  deriveKey,
  directoryKey,
  KEY_LABELS,
} from "../src/auth/keys.js";

const secret = { SESSION_SECRET: "x".repeat(32) };
const isContent = (l: string): l is ContentKeyLabel =>
  (CONTENT_KEY_LABELS as readonly string[]).includes(l);

describe("deriveKey", () => {
  test("is pinned: HKDF-SHA256, salt open-artifacts/hkdf/v1, 32 bytes", async () => {
    // Computed independently with Node's crypto.hkdfSync.
    expect(await deriveKey(secret, "oa:session")).toBe(
      "yXeICrivwL9bXFq_zsp5_7RovBx9ThtWf_cqvN9nHOg",
    );
  });

  test("labels give distinct keys", async () => {
    // One secret for both kinds here, so every label is compared.
    const both = {
      SESSION_SECRET: secret.SESSION_SECRET,
      CONTENT_SIGNING_KEY: secret.SESSION_SECRET,
      DIRECTORY_TOKEN_KEY: secret.SESSION_SECRET,
    };
    const ks = await Promise.all(
      KEY_LABELS.map((l) =>
        isContent(l)
          ? contentKey(both, l)
          : l === "oa:directory-token"
            ? directoryKey(both)
            : deriveKey(both, l),
      ),
    );
    expect(new Set(ks).size).toBe(KEY_LABELS.length);
    expect(KEY_LABELS).toEqual([
      "oa:session",
      "oa:oidc-state",
      "oa:code-cookie",
      "oa:login-codes",
      "oa:code-email",
      "oa:audit-cursor",
      "oa:directory-state",
      "oa:content-url",
      "oa:upload",
      "oa:directory-token",
    ]);
  });

  test("content keys derive from CONTENT_SIGNING_KEY, never equal it, and need 32+ chars", async () => {
    const c = { CONTENT_SIGNING_KEY: "c".repeat(32) };
    const url = await contentKey(c, "oa:content-url");
    const up = await contentKey(c, "oa:upload");
    expect(url).not.toBe(up);
    expect(url).not.toBe(c.CONTENT_SIGNING_KEY);
    expect(
      await contentKey({ CONTENT_SIGNING_KEY: "d".repeat(32) }, "oa:upload"),
    ).not.toBe(up);
    await expect(
      contentKey({ CONTENT_SIGNING_KEY: "short" }, "oa:upload"),
    ).rejects.toThrow("CONTENT_SIGNING_KEY must be at least 32 characters");
  });

  test("depends on the secret", async () => {
    expect(
      await deriveKey({ SESSION_SECRET: "y".repeat(32) }, "oa:session"),
    ).not.toBe(await deriveKey(secret, "oa:session"));
  });

  test("refuses an empty secret, derives from a short one", async () => {
    await expect(
      deriveKey({ SESSION_SECRET: "" }, "oa:session"),
    ).rejects.toThrow("SESSION_SECRET is not set");
    // HKDF accepts any length: a short secret is weak, not unusable.
    await expect(
      deriveKey({ SESSION_SECRET: "short" }, "oa:session"),
    ).resolves.toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("refuses every content label, so content subkeys only come from contentKey", async () => {
    expect(CONTENT_KEY_LABELS).toEqual(["oa:content-url", "oa:upload"]);
    for (const l of CONTENT_KEY_LABELS)
      await expect(
        // Typed out; cast past it to check the runtime guard.
        deriveKey(secret, l as unknown as Parameters<typeof deriveKey>[1]),
      ).rejects.toThrow(`${l} is a content key label; use contentKey`);
  });

  test("session labels still derive and contentKey is unaffected", async () => {
    for (const l of KEY_LABELS) {
      if (isContent(l) || l === "oa:directory-token") continue;
      await expect(deriveKey(secret, l)).resolves.toMatch(/^[A-Za-z0-9_-]+$/);
    }
    const c = { CONTENT_SIGNING_KEY: "c".repeat(32) };
    for (const l of CONTENT_KEY_LABELS)
      await expect(contentKey(c, l)).resolves.toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
