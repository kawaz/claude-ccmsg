// Composer 入力欄の keydown 分岐を仕様として固定する unit test。
// kawaz 方針 (2026-07-13): Cmd+Enter (macOS) or Ctrl+Enter (Linux/Windows) で
// 送信、それ以外の Enter (素の Enter / Shift+Enter / Alt+Enter) はどれも
// textarea 既定の改行動作をそのまま (送信しない)。IME 変換確定 Enter
// (isComposing=true) は送信も改行も奪わず default に任せる。
//
// Composer.tsx の JSX 描画を通さず、pure 分岐を module 化した
// composer-keydown.ts の shouldSendOnKeyDown を直接叩く。webui/test は
// bun test の JSX runtime を巻き込まないため .ts の import に揃える慣習。
import { describe, expect, test } from "bun:test";
import { shouldSendOnKeyDown } from "../src/client/components/composer-keydown.ts";

describe("shouldSendOnKeyDown", () => {
  // key !== "Enter" は全て送信対象外 — Space や a などが flag 組合せで
  // 巻き込まれないことの安全網 (Cmd+A で送信されたら事故)。
  test("returns false for non-Enter keys, even with modifiers", () => {
    expect(shouldSendOnKeyDown({ key: "a", metaKey: true })).toBe(false);
    expect(shouldSendOnKeyDown({ key: " ", ctrlKey: true })).toBe(false);
    expect(shouldSendOnKeyDown({ key: "Escape" })).toBe(false);
  });

  // 素の Enter は改行 = 送信しない。以前 "Shift+Enter で送信" だったので、
  // 方針転換の regression 検知として明示。
  test("returns false for a bare Enter (newline, no modifier)", () => {
    expect(shouldSendOnKeyDown({ key: "Enter" })).toBe(false);
  });

  // Shift+Enter も改行 = 送信しない (方針転換後の新仕様。以前は送信だった)。
  test("returns false for Shift+Enter (newline, not send)", () => {
    expect(shouldSendOnKeyDown({ key: "Enter", shiftKey: true })).toBe(false);
  });

  // macOS 主経路: Cmd (metaKey) + Enter で送信。
  test("returns true for Cmd+Enter (macOS)", () => {
    expect(shouldSendOnKeyDown({ key: "Enter", metaKey: true })).toBe(true);
  });

  // Linux/Windows fallback 経路: Ctrl+Enter で送信。macOS でも Ctrl+Enter は
  // 送信扱いにする (キーボード配列に依存せず 1 方針で覆う)。
  test("returns true for Ctrl+Enter (Linux / Windows fallback)", () => {
    expect(shouldSendOnKeyDown({ key: "Enter", ctrlKey: true })).toBe(true);
  });

  // 両方同時押しは異常系だが、送信を優先する (どちらか一方で send 条件を
  // 満たしているので、AND ではなく OR)。
  test("returns true when both Cmd and Ctrl are held with Enter", () => {
    expect(shouldSendOnKeyDown({ key: "Enter", metaKey: true, ctrlKey: true })).toBe(true);
  });

  // IME 変換中 (isComposing) の Enter は、変換確定の UI と衝突しないよう
  // 送信も改行も奪わずに default に流す。Cmd+Enter + isComposing の異常系も
  // 送信しない (IME が優先)。
  test("returns false when isComposing is true, even with Cmd modifier", () => {
    expect(shouldSendOnKeyDown({ key: "Enter", isComposing: true })).toBe(false);
    expect(shouldSendOnKeyDown({ key: "Enter", isComposing: true, metaKey: true })).toBe(false);
    expect(shouldSendOnKeyDown({ key: "Enter", isComposing: true, ctrlKey: true })).toBe(false);
  });

  // Alt/Option+Enter は送信対象外 (kawaz spec: 「Cmd or Ctrl のみ」)。
  test("returns false for Alt+Enter (not a send modifier)", () => {
    expect(shouldSendOnKeyDown({ key: "Enter", altKey: true })).toBe(false);
  });
});
