// fileIconKind is FileTree's sole "name + entry type (+ expand state) ->
// icon kind" decision point (see FileIcon.tsx doc comment) — every DirNode/
// FileNode row goes through it. Covers the dir/symlink branches plus the
// extension-based classification kawaz specified explicitly.
import { describe, expect, test } from "bun:test";
import { fileIconKind } from "../src/client/components/FileIcon.tsx";

describe("fileIconKind", () => {
  test("dir: closed (not expanded) -> dir-closed", () => {
    expect(fileIconKind("src", "dir", false)).toBe("dir-closed");
  });

  test("dir: expanded -> dir-open", () => {
    expect(fileIconKind("src", "dir", true)).toBe("dir-open");
  });

  test("dir: expand state ignored when omitted (defaults to closed)", () => {
    expect(fileIconKind("src", "dir")).toBe("dir-closed");
  });

  test("symlink: gets its own icon regardless of the name's extension — a symlink's target type isn't known here (see FileNode's doc comment in FileTree.tsx), so it's never classified as markdown/image/code", () => {
    expect(fileIconKind("README.md", "symlink")).toBe("symlink");
  });

  // --- extension-based classification (file, not dir/symlink) --- //

  test("markdown: .md", () => {
    expect(fileIconKind("README.md", "file")).toBe("markdown");
  });

  test("image: .png", () => {
    expect(fileIconKind("logo.png", "file")).toBe("image");
  });

  test("image: .svg (vector, still an image kind here — not treated as code despite being XML/markup)", () => {
    expect(fileIconKind("icon.svg", "file")).toBe("image");
  });

  test("code: .ts", () => {
    expect(fileIconKind("index.ts", "file")).toBe("code");
  });

  test("code: .mbt (MoonBit, part of the explicit code-extension list)", () => {
    expect(fileIconKind("main.mbt", "file")).toBe("code");
  });

  test("other (unrecognized extension): .zip falls through to the generic file icon, not a dedicated archive icon — out of scope for this task's icon set", () => {
    expect(fileIconKind("bundle.zip", "file")).toBe("file");
  });

  test("no extension at all (e.g. Makefile, LICENSE) -> generic file icon", () => {
    expect(fileIconKind("LICENSE", "file")).toBe("file");
  });

  // --- dotfiles --- //

  test("dotfile with no further extension (.gitignore): the leading dot is at index 0, treated as extension-less rather than reading the whole name as its own extension, per FileIcon.tsx's doc comment", () => {
    expect(fileIconKind(".gitignore", "file")).toBe("file");
  });

  test("dotfile with a real extension after the leading dot (.bashrc.sh): the leading dot doesn't suppress classification of the actual trailing extension", () => {
    expect(fileIconKind(".bashrc.sh", "file")).toBe("code");
  });

  // --- case sensitivity --- //

  test("uppercase extension (.PNG) still classifies as image — matching mirrors utils.ts's isMarkdownPath, case-insensitive because case-insensitive filesystems make Foo.PNG unremarkable", () => {
    expect(fileIconKind("Screenshot.PNG", "file")).toBe("image");
  });

  test("mixed-case extension (.Md) still classifies as markdown", () => {
    expect(fileIconKind("Notes.Md", "file")).toBe("markdown");
  });
});
