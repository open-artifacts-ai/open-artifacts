/** A Workers SHA-256 sink: pipe bytes in, then `hex()` once the pipe has closed. */
export function sha256Sink(): {
  writable: WritableStream<Uint8Array>;
  hex: () => Promise<string>;
} {
  // DigestStream is a Workers extension the DOM-less lib types omit.
  const ds = new (
    crypto as unknown as {
      DigestStream: new (
        algo: string,
      ) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> };
    }
  ).DigestStream("SHA-256");
  return {
    writable: ds,
    hex: async () =>
      Array.from(new Uint8Array(await ds.digest), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(""),
  };
}
