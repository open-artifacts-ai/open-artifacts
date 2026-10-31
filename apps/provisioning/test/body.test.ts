import { describe, expect, it } from "vitest";
import { BODY_CAP, readJsonBody } from "../src/body.js";
import { ApiError } from "../src/errors.js";

// 3.1: writes need application/json (415), at most 16 KiB (413), and parse.

const post = (
  body: BodyInit | null,
  type: string | null = "application/json",
) =>
  new Request("https://api.hosted.test/v1/installs", {
    method: "POST",
    body,
    headers: type ? { "content-type": type } : {},
  });
const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e instanceof ApiError ? e.code : String(e)),
  );

describe("readJsonBody", () => {
  it("parses a JSON object", async () => {
    expect(await readJsonBody(post('{"a":1}'))).toEqual({ a: 1 });
    expect(
      await readJsonBody(post('{"a":1}', "application/json; charset=utf-8")),
    ).toEqual({ a: 1 });
  });

  it("415 without application/json", async () => {
    expect(await code(readJsonBody(post("{}", "text/plain")))).toBe(
      "unsupported_media_type",
    );
    expect(await code(readJsonBody(post("{}", null)))).toBe(
      "unsupported_media_type",
    );
  });

  it("413 over 16 KiB, by length header or by bytes read", async () => {
    expect(BODY_CAP).toBe(16 * 1024);
    const big = `{"a":"${"x".repeat(BODY_CAP)}"}`;
    expect(await code(readJsonBody(post(big)))).toBe("payload_too_large");
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    expect(await code(readJsonBody(post(stream)))).toBe("payload_too_large");
    const exact = `{"a":"${"x".repeat(BODY_CAP - 8)}"}`;
    expect(new TextEncoder().encode(exact).length).toBe(BODY_CAP);
    expect(await code(readJsonBody(post(exact)))).toBe("ok");
  });

  it("bad JSON is 400 invalid_input; an empty body is undefined", async () => {
    expect(await code(readJsonBody(post("{nope")))).toBe("invalid_input");
    expect(await readJsonBody(post(""))).toBeUndefined();
  });
});
