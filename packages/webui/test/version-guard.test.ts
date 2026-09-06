// 開きっぱなしのタブが古い bundle のまま新 daemon と喋り続ける問題
// (issue 2026-09-03) の判定ロジック。判定は version 2 つの純粋比較なので、
// 実 DOM なしで全分岐を直接回せる。
import { describe, expect, test } from "bun:test";
import {
  mismatchOf,
  reactToDaemonVersion,
  reactToHandshakeVersion,
  reloadButtonTitle,
  type VersionGuardOutcome,
} from "../src/client/version-guard.ts";

const BUNDLE = "0.136.0";

describe("reactToDaemonVersion", () => {
  test("同じ version なら何もしない", () => {
    expect(reactToDaemonVersion(BUNDLE, BUNDLE)).toBe("match" satisfies VersionGuardOutcome);
  });

  // 画面を捨てる判断は常にユーザ (kawaz r273m81)。入力中・操作中にページが
  // 消えるのがそもそもの不具合なので、不一致でも "manual" に落ちるのが要。
  test("daemon が新しければ手動リロード待ちになる", () => {
    expect(reactToDaemonVersion("0.137.0", BUNDLE)).toBe("manual");
  });

  // bundle の方が新しい = 古い daemon に繋がった状態。daemon の入れ替えは CLI
  // 側の version-mismatch upgrade (DR-0002 §4) の担当で、ページを読み直しても
  // 相手は変わらないので webui は何もしない。
  test("bundle の方が新しければ通知しない", () => {
    expect(reactToDaemonVersion("0.135.0", BUNDLE)).toBe("bundle-newer");
  });

  test("mismatchOf は不一致だけを AppState に載る形へ移す", () => {
    expect(mismatchOf("manual", "0.137.0")).toEqual({ daemonVersion: "0.137.0" });
    expect(mismatchOf("match", "0.137.0")).toBeNull();
    expect(mismatchOf("bundle-newer", "0.137.0")).toBeNull();
  });
});

// hello 自体が拒否される upgrade (protocol 世代変更、v0.136.0 の request_id
// 必須化) こそこの guard が要る場面なのに、hello 応答の version しか見ないと
// 判定材料が無いまま沈黙する。ping は hello 不要で version を返すので、
// そこから拾い直せることを押さえる。
describe("reactToHandshakeVersion", () => {
  const refused = { ok: false } as const;
  const never = async (): Promise<string | null> => {
    throw new Error("probe must not run when hello already named a version");
  };

  test("hello が成功していれば ping を打たずにその version で判定する", async () => {
    const res = await reactToHandshakeVersion({ ok: true, version: "0.137.0" }, never, BUNDLE);
    expect(res).toEqual({ outcome: "manual", daemonVersion: "0.137.0" });
  });

  test("hello 拒否なら ping から version を拾い直す", async () => {
    const res = await reactToHandshakeVersion(refused, async () => "0.137.0", BUNDLE);
    expect(res).toEqual({ outcome: "manual", daemonVersion: "0.137.0" });
  });

  test("hello 拒否 + ping も版数を返せなければ何もしない", async () => {
    expect(await reactToHandshakeVersion(refused, async () => null, BUNDLE)).toBeNull();
  });

  test("hello が ok でも version を名乗らなければ ping に落ちる", async () => {
    const res = await reactToHandshakeVersion({ ok: true }, async () => "0.137.0", BUNDLE);
    expect(res?.daemonVersion).toBe("0.137.0");
    expect(res?.outcome).toBe("manual");
  });

  test("hello 拒否 + ping が同じ version を返したら不一致なし", async () => {
    const res = await reactToHandshakeVersion(refused, async () => BUNDLE, BUNDLE);
    expect(res).toEqual({ outcome: "match", daemonVersion: BUNDLE });
  });
});

// 不一致の知らせは topbar のリロードボタンの title に載る (kawaz r273 m27:
// 専用のボックスを増やさない)。読み直す瞬間はユーザが決めるので、文言は
// 「押さなければ古いまま」を伝える。
describe("reloadButtonTitle", () => {
  test("不一致なしなら、ただのリロードボタン", () => {
    expect(reloadButtonTitle(null)).toBe("ページを再読み込み");
  });

  test("不一致なら、押すまで古いままだと言う", () => {
    const title = reloadButtonTitle(mismatchOf("manual", "0.147.2"));
    expect(title).toContain("新しい版 v0.147.2");
    expect(title).toContain("今すぐ反映");
    expect(title).toContain("押すまでこの画面は古いまま");
  });
});
