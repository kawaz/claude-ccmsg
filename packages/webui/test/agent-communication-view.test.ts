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
  // 通常 peer は inbound card を保つ。方向はカードヘッダに独立表示し、右上 badge は
  // 通信の分類を示す従来の役割から変えない。
  test("normal peer message keeps its semantic badge", () => {
    expect(
      peerMessagePresentation({
        display: "peer",
        from: "worker",
        summary: "完了報告",
        category: "message",
        body: "done",
      }),
    ).toEqual({ kind: "card", marker: "🤖←", badge: "受信" });
  });

  // 制御系 peer の右上 badge も用途ラベルだけを表示し、方向 marker と混ぜない。
  test("task and lifecycle peers keep their semantic badges", () => {
    expect(
      peerMessagePresentation({
        display: "peer",
        from: "worker",
        summary: null,
        category: "task-assignment",
        body: "task",
      }),
    ).toEqual({ kind: "card", marker: "🤖←", badge: "タスク指示" });
    expect(
      peerMessagePresentation({
        display: "peer",
        from: "worker",
        summary: null,
        category: "lifecycle",
        body: "shutdown",
      }),
    ).toEqual({ kind: "card", marker: "🤖←", badge: "状態変更" });
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
