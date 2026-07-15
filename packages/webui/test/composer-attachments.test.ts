// DR-0015 Composer attachment pure helpers spec.
//
// Composer.tsx の JSX / XHR 経路は DOM 依存で bun test の scope 外だが、
// テキスト操作 / clipboard 抽出 / 送信可否 判定は pure なので単体テスト可能に
// 抽出している (composer-attachments.ts)。webui/test の他 suite と同じく
// `.ts` import 慣習を維持し、JSX runtime を巻き込まない。
import { describe, expect, test } from "bun:test";
import {
  extractPastedImages,
  hasPendingUpload,
  insertPlaceholder,
  maxPlaceholderNumber,
  nextAttachmentNumber,
  removePlaceholder,
  substitutePlaceholders,
  type ComposerAttachment,
} from "../src/client/components/composer-attachments.ts";

function att(overrides: Partial<ComposerAttachment>): ComposerAttachment {
  return { n: 1, name: "file", status: "uploading", progress: 0, ...overrides };
}

describe("nextAttachmentNumber", () => {
  // 何もなければ 1 から始まる — 最初の添付は必ず FILE1。
  test("returns 1 for an empty list", () => {
    expect(nextAttachmentNumber([])).toBe(1);
  });

  // max(n) + 1 = 番号は既存の最大より 1 大きい。順序に依存しない (削除で穴が
  // あってもリサイクルしない、DR-0015 §2.4 の連番仕様を stable にするため)。
  test("returns max(n)+1, not length+1 (holes not reused)", () => {
    const a = [att({ n: 1 }), att({ n: 3 })];
    expect(nextAttachmentNumber(a)).toBe(4);
    // n=1 が消えて n=3 だけ残っている状態で追加 → 4 (1 の再利用なし)
    expect(nextAttachmentNumber([att({ n: 3 })])).toBe(4);
  });
});

describe("insertPlaceholder", () => {
  // 空 textarea で caret=0: 先頭に置かれる。空メッセージから添付だけ送る経路。
  test("empty text, caret=0: inserted at the very start", () => {
    expect(insertPlaceholder("", 0, 1)).toBe("[FILE1]");
  });

  // caret 位置での挿入。前後の text は保持される。
  test("caret in the middle splits text and inserts the placeholder there", () => {
    expect(insertPlaceholder("hello world", 6, 2)).toBe("hello [FILE2]world");
  });

  // caret が末尾なら末尾に足す。
  test("caret at end appends the placeholder", () => {
    expect(insertPlaceholder("hi", 2, 1)).toBe("hi[FILE1]");
  });

  // caret が out-of-range (負 or 末尾超え) は末尾 fallback。
  // Composer.tsx が textarea ref を掴めなかった時の safe default。
  test("caret out of range falls back to append", () => {
    expect(insertPlaceholder("hi", -1, 1)).toBe("hi[FILE1]");
    expect(insertPlaceholder("hi", 999, 1)).toBe("hi[FILE1]");
  });
});

describe("removePlaceholder", () => {
  // 同じ番号を全て消す (user が本文をコピペで複製している可能性への保険、
  // 送信時に「path 未確定なのに link 化された」文字列が残ると事故)。
  test("removes every occurrence of the same placeholder", () => {
    expect(removePlaceholder("a [FILE2] b [FILE2] c", 2)).toBe("a  b  c");
  });

  // 別番号は影響を受けない (prefix 一致で誤マッチしないことの確認)。
  test("different numbers are untouched", () => {
    expect(removePlaceholder("[FILE1] [FILE10] [FILE100]", 1)).toBe(" [FILE10] [FILE100]");
    // 逆も同様: 10 を消しても 1 / 100 は残る (正規表現で完全一致マッチ)
    expect(removePlaceholder("[FILE1] [FILE10] [FILE100]", 10)).toBe("[FILE1]  [FILE100]");
  });

  // 該当なしは text 変化なし。
  test("no-op when the placeholder is absent", () => {
    expect(removePlaceholder("plain text", 5)).toBe("plain text");
  });
});

describe("substitutePlaceholders", () => {
  // 送信時に done + path 揃った添付だけ link 化する。DR-0015 §2.4 の
  // `[FILE<N>:<name>](<path>)` 形式。
  test("substitutes done attachments with markdown link format", () => {
    const text = "これ見て [FILE1] と [FILE2] を確認";
    const attachments = [
      att({
        n: 1,
        name: "diagram.png",
        status: "done",
        path: "/tmp/claude-ccmsg-501/attachment/abc.png",
      }),
      att({
        n: 2,
        name: "notes.pdf",
        status: "done",
        path: "/tmp/claude-ccmsg-501/attachment/def.pdf",
      }),
    ];
    expect(substitutePlaceholders(text, attachments)).toBe(
      "これ見て [FILE1:diagram.png](/tmp/claude-ccmsg-501/attachment/abc.png) と [FILE2:notes.pdf](/tmp/claude-ccmsg-501/attachment/def.pdf) を確認",
    );
  });

  // 送信中 (uploading) や失敗 (error) の entry は skip、placeholder が
  // 残ったまま jsonl に載る形になる — が、実際は Composer.tsx が
  // hasPendingUpload で send button を disable + error は × で削除、で
  // ここに到達しない設計。到達した場合の safety net として動作固定。
  test("skips attachments that are still uploading or errored", () => {
    const text = "[FILE1] [FILE2] [FILE3]";
    const attachments = [
      att({ n: 1, name: "a.png", status: "done", path: "/tmp/a.png" }),
      att({ n: 2, name: "b.png", status: "uploading" }), // path 未確定
      att({ n: 3, name: "c.png", status: "error", errorMsg: "..." }),
    ];
    // 1 だけ置換、2/3 は placeholder のまま残る。
    expect(substitutePlaceholders(text, attachments)).toBe(
      "[FILE1:a.png](/tmp/a.png) [FILE2] [FILE3]",
    );
  });

  // 添付ゼロの通常送信は無変換。
  test("empty attachments returns text unchanged", () => {
    expect(substitutePlaceholders("plain", [])).toBe("plain");
  });

  // 同じ番号を持つ複数出現も全部置換 (removePlaceholder と対称的動作)。
  test("multi-occurrence of the same placeholder is fully substituted", () => {
    const attachments = [att({ n: 1, name: "x", status: "done", path: "/p" })];
    expect(substitutePlaceholders("[FILE1] and [FILE1]", attachments)).toBe(
      "[FILE1:x](/p) and [FILE1:x](/p)",
    );
  });
});

describe("hasPendingUpload", () => {
  // 送信 disable 判定は uploading の有無で。error は disable 対象外
  // (× で消せば済むし、error 残置で送信不可はユーザ体験が悪い)。
  test("true only when at least one attachment is uploading", () => {
    expect(hasPendingUpload([])).toBe(false);
    expect(hasPendingUpload([att({ status: "done", path: "/p" })])).toBe(false);
    expect(hasPendingUpload([att({ status: "error", errorMsg: "x" })])).toBe(false);
    expect(hasPendingUpload([att({ status: "uploading", progress: 40 })])).toBe(true);
    // 複数混在で 1 つでも uploading があれば true。
    expect(
      hasPendingUpload([att({ status: "done", path: "/p" }), att({ status: "uploading" })]),
    ).toBe(true);
  });
});

describe("extractPastedImages", () => {
  // クリップボード paste で image mime を持つ file を全部拾う。DR-0015 §2.5
  // の clipboard 経路の core spec。
  function fakeItem(kind: string, type: string, file: File | null) {
    return { kind, type, getAsFile: () => file };
  }

  test("extracts every image/* file item, skipping non-file / non-image entries", () => {
    const png = new File([new Uint8Array([1])], "clip.png", { type: "image/png" });
    const jpg = new File([new Uint8Array([2])], "clip.jpg", { type: "image/jpeg" });
    const items = [
      fakeItem("file", "image/png", png),
      fakeItem("string", "text/plain", null), // kind != file → skip
      fakeItem("file", "text/html", null), // image でない → skip
      fakeItem("file", "image/jpeg", jpg),
    ];
    const got = extractPastedImages(items);
    expect(got.length).toBe(2);
    expect(got[0]).toBe(png);
    expect(got[1]).toBe(jpg);
  });

  // getAsFile が null を返す壊れた entry を除外 (browser の実装差分への保険)。
  test("skips items whose getAsFile returns null even when kind/type match", () => {
    const items = [fakeItem("file", "image/png", null)];
    expect(extractPastedImages(items)).toEqual([]);
  });

  // image を含まない paste (通常のテキスト paste) は空配列 →
  // Composer.tsx は browser default の text paste にそのまま任せる。
  test("returns [] when the paste has no image (text paste falls through)", () => {
    const items = [fakeItem("string", "text/plain", null)];
    expect(extractPastedImages(items)).toEqual([]);
  });
});

describe("maxPlaceholderNumber", () => {
  // 何を保証するか (kawaz r17 mid=33 の実事故対策): 採番は attachments 配列
  // だけでなく本文中の [FILE<N>] とも衝突してはいけない。1on1 の draft 復元は
  // text ([FILE1] 入り) を戻すが attachments は空リセットするため、本文側の
  // max を採番の下限に使う (Composer/OneOnOneComposer の beginUpload)。
  // stale placeholder は番号がずれることで substitute の global regex に
  // 巻き込まれず、設計通りリテラルのまま残る。
  test("returns the largest [FILE<N>] in the text", () => {
    expect(maxPlaceholderNumber("a [FILE1] b [FILE3] c")).toBe(3);
  });
  test("returns 0 when the text has no placeholder", () => {
    expect(maxPlaceholderNumber("no placeholders here")).toBe(0);
  });
  // 置換済みの markdown link 形 ([FILE1:name](path)) は「未解決 placeholder」
  // ではないので対象外 — 送信済み本文を引用しても採番を無駄に押し上げない。
  test("ignores already-substituted [FILE<N>:name](path) links", () => {
    expect(maxPlaceholderNumber("[FILE2:img.png](/tmp/x.png)")).toBe(0);
  });
});
