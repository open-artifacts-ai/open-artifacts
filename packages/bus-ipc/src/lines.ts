import { StringDecoder } from "node:string_decoder";
import { MAX_LINE_BYTES } from "./frames.ts";

export class FrameTooLarge extends Error {}

/** Newline-delimited JSON decoder with a hard UTF-8 byte cap per line. */
export class LineDecoder {
  #decoder = new StringDecoder("utf8");
  #buffer = "";

  push(chunk: string | Buffer): unknown[] {
    this.#buffer +=
      typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    const out: unknown[] = [];
    let i = this.#buffer.indexOf("\n");
    while (i !== -1) {
      const line = this.#buffer.slice(0, i).trim();
      this.#buffer = this.#buffer.slice(i + 1);
      if (line) {
        if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES)
          throw new FrameTooLarge(`line exceeds ${MAX_LINE_BYTES} bytes`);
        out.push(JSON.parse(line));
      }
      i = this.#buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_LINE_BYTES) {
      throw new FrameTooLarge(`line exceeds ${MAX_LINE_BYTES} bytes`);
    }
    return out;
  }
}

export const writeFrame = (
  sock: { write: (s: string) => void },
  frame: unknown,
) => sock.write(`${JSON.stringify(frame)}\n`);
