import { describe, expect, test } from "bun:test";
import {
  agentDirectionMarker,
  peerMessagePresentation,
} from "../src/client/agent-communication-view.ts";

describe("agentDirectionMarker", () => {
  // agent 通信の向きはテキストだけで識別できる固定記号にする。CSS の左右寄せに
  // 依存しないため、狭い画面や読み上げでも送受信を区別できる。
  test("outbound is robot-right and inbound is robot-left", () => {
    expect(agentDirectionMarker("outbound")).toBe("🤖→");
    expect(agentDirectionMarker("inbound")).toBe("🤖←");
  });
});

describe("peerMessagePresentation", () => {
  // 通常 peer は inbound card を保ち、badge 自体にも方向を含める。summary だけで
  // なく展開後も受信だと判別できることを固定する。
  test("normal peer message is an inbound card", () => {
    expect(
      peerMessagePresentation({
        display: "peer",
        from: "worker",
        summary: "完了報告",
        category: "message",
        body: "done",
      }),
    ).toEqual({ kind: "card", marker: "🤖←", badge: "🤖←" });
  });

  // 制御系 peer も受信方向を失わず、既存の用途ラベルを後置する。
  test("task and lifecycle peers keep their semantic badge after the inbound marker", () => {
    expect(
      peerMessagePresentation({
        display: "peer",
        from: "worker",
        summary: null,
        category: "task-assignment",
        body: "task",
      }),
    ).toEqual({ kind: "card", marker: "🤖←", badge: "🤖← タスク指示" });
    expect(
      peerMessagePresentation({
        display: "peer",
        from: "worker",
        summary: null,
        category: "lifecycle",
        body: "shutdown",
      }),
    ).toEqual({ kind: "card", marker: "🤖←", badge: "🤖← 状態変更" });
  });

  // idle は会話カードではなく operational noise。identicon・bold・tabs を持つ card
  // 表現へ流さず、プレーン行に必要な marker/body だけ返す。
  test("idle peer becomes a lightweight plain row", () => {
    expect(
      peerMessagePresentation({
        display: "peer",
        from: "worker",
        summary: null,
        category: "idle",
        body: "待機通知 · available",
      }),
    ).toEqual({ kind: "idle", marker: "🤖←", text: "待機通知 · available" });
  });
});
