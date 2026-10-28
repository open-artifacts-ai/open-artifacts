import { describe, expect, it } from "vitest";
import {
  contentTypeFor,
  inferFormat,
  inferLanguage,
  isTextContentType,
} from "../src/formats.js";

describe("formats", () => {
  it("inferFormat", () => {
    expect(inferFormat("index.HTML")).toBe("html");
    expect(inferFormat("a.htm")).toBe("html");
    expect(inferFormat("notes.md")).toBe("markdown");
    expect(inferFormat("a.mdx")).toBe("markdown");
    expect(inferFormat("x.pdf")).toBe("pdf");
    expect(inferFormat("main.rs")).toBe("code");
  });
  it("inferFormat: code only for known text, else null", () => {
    for (const p of [
      "a.ts",
      "x/y.py",
      "notes.txt",
      "a.TEXT",
      "data.csv",
      "t.tsv",
      "app.log",
      "prod.env",
      "nginx.conf",
      "setup.cfg",
      "src/Makefile",
      "Dockerfile",
      "a.json",
      "rows.jsonl",
      "rows.ndjson",
      "api.proto",
      "A.scala",
      "Main.hs",
      "x.pl",
      "x.ps1",
      "run.bat",
      "flake.nix",
      "paper.tex",
      "subs.srt",
      "subs.vtt",
      "Cargo.lock",
    ])
      expect(inferFormat(p), p).toBe("code");
    for (const p of [
      "IMG_0042.JPG",
      "photo.jpeg",
      "a.zip",
      "a.bin",
      "a.mp4",
      "a.docx",
      "noext",
      "x.unknown",
    ])
      expect(inferFormat(p), p).toBeNull();
  });
  it("inferLanguage", () => {
    expect(inferLanguage("a.tsx")).toBe("tsx");
    expect(inferLanguage("src/Makefile")).toBe("makefile");
    expect(inferLanguage("x.unknown")).toBe("text");
    expect(inferLanguage("a.py")).toBe("py");
  });
  it("contentTypeFor", () => {
    expect(contentTypeFor("a/b.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("a.PNG")).toBe("image/png");
    expect(contentTypeFor("a.zzz")).toBe("application/octet-stream");
    expect(contentTypeFor("noext")).toBe("application/octet-stream");
  });
  it("isTextContentType", () => {
    expect(isTextContentType("text/html; charset=utf-8")).toBe(true);
    expect(isTextContentType("application/json")).toBe(true);
    expect(isTextContentType("image/svg+xml")).toBe(true);
    expect(isTextContentType("image/png")).toBe(false);
    expect(isTextContentType("application/pdf")).toBe(false);
  });
});
