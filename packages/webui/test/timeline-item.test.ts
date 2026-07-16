import { describe, expect, test } from "bun:test";
import { shouldRenderAsMarkdown } from "../src/client/components/timeline-item-markdown.ts";

describe("shouldRenderAsMarkdown (r26 mid=8: RoomView msg 本文の markdown レンダリング分岐)", () => {
  // u1 (ADMIN_ID, kawaz spec) 発は既存のプレーン表示を変えない — 改行維持が
  // 仕様の CLI 貼り付けテキスト等をリンク/強調記法として誤解釈させないため。
  test("from が u1 (ADMIN_ID) のときは false (プレーンのまま)", () => {
    expect(shouldRenderAsMarkdown("u1")).toBe(false);
  });

  // agent (u1 以外の任意の sid) 発は markdown レンダリング対象。sid の形式は
  // 問わない — "u1" と一致しないことだけが判定条件。
  test("from が u1 以外 (agent) のときは true", () => {
    expect(shouldRenderAsMarkdown("s1")).toBe(true);
    expect(shouldRenderAsMarkdown("claude-worker-3")).toBe(true);
  });
});
