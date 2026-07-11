// highlight.ts unit tests: extension -> language detection, the
// highlight-eligibility gate (size threshold + binary/no-lang fallback), and
// tokenizeLines' flat-token-stream -> per-line span reflow (FileViewer.tsx
// renders these spans directly as JSX text nodes, never through an
// innerHTML path — see highlight.ts for why).
import { describe, expect, test } from "bun:test";
import {
  detectLanguage,
  HIGHLIGHT_MAX_BYTES,
  isHighlightEligible,
  tokenizeLines,
} from "../src/client/highlight.ts";

describe("detectLanguage", () => {
  // Same-value axis: extensions that should resolve to their language.
  test("recognized extensions map to their speed-highlight language key", () => {
    expect(detectLanguage("src/foo.ts")).toBe("ts");
    expect(detectLanguage("src/foo.tsx")).toBe("ts");
    expect(detectLanguage("src/foo.js")).toBe("js");
    expect(detectLanguage("src/foo.jsx")).toBe("js");
    expect(detectLanguage("data.json")).toBe("json");
    expect(detectLanguage("style.css")).toBe("css");
    expect(detectLanguage("index.html")).toBe("html");
    expect(detectLanguage("README.md")).toBe("md");
    expect(detectLanguage("deploy.sh")).toBe("bash");
    expect(detectLanguage("config.yml")).toBe("yaml");
    expect(detectLanguage("config.yaml")).toBe("yaml");
  });

  test("extension matching is case-insensitive", () => {
    expect(detectLanguage("src/Foo.TS")).toBe("ts");
    expect(detectLanguage("README.MD")).toBe("md");
  });

  test("unrecognized extension -> null (plain-viewer fallback)", () => {
    expect(detectLanguage("data.bin")).toBeNull();
    expect(detectLanguage("archive.tar.gz")).toBeNull(); // last segment ".gz" is unmapped
  });

  // Dotfiles: the leading dot is the filename, not an extension separator.
  test("dotfile with no further extension -> null", () => {
    expect(detectLanguage(".gitignore")).toBeNull();
    expect(detectLanguage(".env")).toBeNull();
  });

  test("dotfile with a recognized extension after the leading dot -> detected", () => {
    expect(detectLanguage(".prettierrc.json")).toBe("json");
  });

  test("extension-less filename -> null", () => {
    expect(detectLanguage("Dockerfile")).toBeNull();
    expect(detectLanguage("Makefile")).toBeNull();
  });

  test("nested path uses only the final path segment's extension", () => {
    expect(detectLanguage("packages/webui/src/client/highlight.ts")).toBe("ts");
    // A dot in a directory segment must not leak into detection.
    expect(detectLanguage("v1.2/notes")).toBeNull();
  });
});

describe("isHighlightEligible", () => {
  // Decision table: {lang, binary, size vs threshold} -> eligible?
  test("recognized language, text, within threshold -> eligible", () => {
    expect(isHighlightEligible("ts", "const x = 1;", false)).toBe(true);
  });

  test("no recognized language -> not eligible regardless of size", () => {
    expect(isHighlightEligible(null, "hello", false)).toBe(false);
  });

  test("binary file -> not eligible even with a recognized language", () => {
    expect(isHighlightEligible("json", "\x00\x01", true)).toBe(false);
  });

  // Boundary: exactly at HIGHLIGHT_MAX_BYTES is still eligible ("<=", not "<").
  test("content length exactly at HIGHLIGHT_MAX_BYTES -> eligible", () => {
    const content = "x".repeat(HIGHLIGHT_MAX_BYTES);
    expect(isHighlightEligible("js", content, false)).toBe(true);
  });

  test("content length one byte over HIGHLIGHT_MAX_BYTES -> not eligible (plain fallback)", () => {
    const content = "x".repeat(HIGHLIGHT_MAX_BYTES + 1);
    expect(isHighlightEligible("js", content, false)).toBe(false);
  });
});

describe("tokenizeLines", () => {
  test("single-line source with keyword and string tokens", async () => {
    const lines = await tokenizeLines('const x = "hi";', "js");
    expect(lines.length).toBe(1);
    // The exact token split is speed-highlight's grammar (implementation
    // detail); what matters is that the concatenation reproduces the source
    // and at least one token carries a non-plain type.
    expect(lines[0]!.map((s) => s.text).join("")).toBe('const x = "hi";');
    expect(lines[0]!.some((s) => s.type !== undefined)).toBe(true);
  });

  test("multi-line source splits into one span-array per line", async () => {
    const src = "const a = 1;\nconst b = 2;\n";
    const lines = await tokenizeLines(src, "js");
    // Trailing "\n" does not produce an extra trailing empty line, mirroring
    // FileViewer's plain-line splitting (splitLines in FileViewer.tsx).
    expect(lines.length).toBe(2);
    expect(lines[0]!.map((s) => s.text).join("")).toBe("const a = 1;");
    expect(lines[1]!.map((s) => s.text).join("")).toBe("const b = 2;");
  });

  test("source without a trailing newline keeps the last line", async () => {
    const lines = await tokenizeLines("const a = 1;", "js");
    expect(lines.length).toBe(1);
  });

  test("a token spanning multiple lines (block comment) still lands on the correct lines", async () => {
    const src = "/* a\nb */\nconst c = 1;";
    const lines = await tokenizeLines(src, "js");
    expect(lines.length).toBe(3);
    expect(lines[0]!.map((s) => s.text).join("")).toBe("/* a");
    expect(lines[1]!.map((s) => s.text).join("")).toBe("b */");
    expect(lines[2]!.map((s) => s.text).join("")).toBe("const c = 1;");
  });

  test("empty source -> a single empty line (caller special-cases '' before calling this)", async () => {
    const lines = await tokenizeLines("", "js");
    expect(lines).toEqual([[]]);
  });
});
