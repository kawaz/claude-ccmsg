// 開きっぱなしのタブが古い bundle のまま新 daemon と喋り続ける問題
// (issue 2026-09-03) の判定ロジック。判定は version 2 つの純粋比較なので、
// 実 DOM なしで全分岐を直接回せる。
import { describe, expect, test } from "bun:test";
import {
  type DaemonProbe,
  mismatchOf,
  reactToDaemonVersion,
  reactToHandshakeVersion,
  reloadButtonClass,
  reloadButtonTitle,
  type VersionGuardOutcome,
} from "../src/client/version-guard.ts";

const BUNDLE_VERSION = "0.136.0";
const BUNDLE_PROTOCOL = { major: 2, minor: 0 };
const BUNDLE = { version: BUNDLE_VERSION, protocol: BUNDLE_PROTOCOL };

describe("reactToDaemonVersion", () => {
  test("同じ version なら何もしない", () => {
    expect(reactToDaemonVersion(BUNDLE_VERSION, BUNDLE_VERSION)).toBe(
      "match" satisfies VersionGuardOutcome,
    );
  });

  // 画面を捨てる判断は常にユーザ。入力中・操作中にページが
  // 消えるのがそもそもの不具合なので、不一致でも "manual" に落ちるのが要。
  test("daemon が新しければ手動リロード待ちになる", () => {
    expect(reactToDaemonVersion("0.137.0", BUNDLE_VERSION)).toBe("manual");
  });

  // bundle の方が新しい = 古い daemon に繋がった状態。daemon の入れ替えは CLI
  // 側の version-mismatch upgrade (DR-0002 §4) の担当で、ページを読み直しても
  // 相手は変わらないので webui は何もしない。
  test("bundle の方が新しければ通知しない", () => {
    expect(reactToDaemonVersion("0.135.0", BUNDLE_VERSION)).toBe("bundle-newer");
  });

  test("mismatchOf は不一致だけを AppState に載る形へ移す", () => {
    expect(mismatchOf("manual", "0.137.0")).toEqual({
      daemonVersion: "0.137.0",
      protocolChanged: false,
    });
    expect(mismatchOf("protocol", "0.137.0")).toEqual({
      daemonVersion: "0.137.0",
      protocolChanged: true,
    });
    expect(mismatchOf("match", "0.137.0")).toBeNull();
    expect(mismatchOf("bundle-newer", "0.137.0")).toBeNull();
  });
});

// hello 自体が拒否される upgrade (protocol の major の変更) こそこの guard が
// 要る場面なのに、hello 応答の version しか見ないと判定材料が無いまま沈黙する。
// ping は hello 不要で version と protocol を返すので、そこから拾い直せることを
// 押さえる。
describe("reactToHandshakeVersion", () => {
  const refused = { ok: false } as const;
  const never = async (): Promise<DaemonProbe | null> => {
    throw new Error("probe must not run when hello already named a version");
  };
  const pinged =
    (version: string, protocol?: DaemonProbe["protocol"]) =>
    async (): Promise<DaemonProbe | null> => ({
      version,
      ...(protocol !== undefined ? { protocol } : {}),
    });

  test("hello が成功していれば ping を打たずにその version で判定する", async () => {
    const res = await reactToHandshakeVersion({ ok: true, version: "0.137.0" }, never, BUNDLE);
    expect(res).toEqual({ outcome: "manual", daemonVersion: "0.137.0" });
  });

  test("hello 拒否なら ping から version を拾い直す", async () => {
    const res = await reactToHandshakeVersion(refused, pinged("0.137.0", BUNDLE_PROTOCOL), BUNDLE);
    expect(res).toEqual({ outcome: "manual", daemonVersion: "0.137.0" });
  });

  // bundle は daemon が配るので、major が違えば版の新旧によらずリロードで揃う。
  test("hello 拒否 + ping の protocol の major が違えば、版の新旧によらず protocol", async () => {
    const nextMajor = { major: BUNDLE_PROTOCOL.major + 1, minor: 0 };
    for (const version of ["0.137.0", "0.135.0", BUNDLE_VERSION]) {
      const res = await reactToHandshakeVersion(refused, pinged(version, nextMajor), BUNDLE);
      expect(res).toEqual({ outcome: "protocol", daemonVersion: version });
    }
  });

  // protocol を名乗らない ping は major 1 の daemon (UNANNOUNCED_PROTOCOL_MAJOR)。
  test("hello 拒否 + ping が protocol を名乗らなければ major 1 として比べる", async () => {
    const res = await reactToHandshakeVersion(refused, pinged("0.135.0"), BUNDLE);
    expect(res).toEqual({ outcome: "protocol", daemonVersion: "0.135.0" });
  });

  // minor の違いは webui の要求を断る理由にならない。版の比較に戻る。
  test("hello 拒否 + ping の protocol が同じ major なら版で比べる", async () => {
    const res = await reactToHandshakeVersion(
      refused,
      pinged("0.137.0", { major: BUNDLE_PROTOCOL.major, minor: 5 }),
      BUNDLE,
    );
    expect(res).toEqual({ outcome: "manual", daemonVersion: "0.137.0" });
  });

  test("hello 拒否 + ping も版数を返せなければ何もしない", async () => {
    expect(await reactToHandshakeVersion(refused, async () => null, BUNDLE)).toBeNull();
  });

  test("hello が ok でも version を名乗らなければ ping に落ちる", async () => {
    const res = await reactToHandshakeVersion(
      { ok: true },
      pinged("0.137.0", BUNDLE_PROTOCOL),
      BUNDLE,
    );
    expect(res?.daemonVersion).toBe("0.137.0");
    expect(res?.outcome).toBe("manual");
  });

  test("hello 拒否 + ping が同じ version を返したら不一致なし", async () => {
    const res = await reactToHandshakeVersion(
      refused,
      pinged(BUNDLE_VERSION, BUNDLE_PROTOCOL),
      BUNDLE,
    );
    expect(res).toEqual({ outcome: "match", daemonVersion: BUNDLE_VERSION });
  });
});

// 不一致の知らせは topbar のリロードボタンの title に載る (専用のボックスを
// 増やさない)。読み直す瞬間はユーザが決めるので、文言は
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

  test("protocol の major が違えば、protocol が変わったのでリロードを、と言う", () => {
    const title = reloadButtonTitle(mismatchOf("protocol", "0.220.0"));
    expect(title).toContain("ccmsg の protocol が変わった。リロードしてください");
    expect(title).toContain("v0.220.0");
  });
});

// 色はボタンの class で付く: 版の違いは青、protocol の major の違いは赤 (app.css)。
describe("reloadButtonClass", () => {
  test("不一致なしは class なし、版の違いは update、protocol の違いは protocol", () => {
    expect(reloadButtonClass(null)).toBeUndefined();
    expect(reloadButtonClass(mismatchOf("manual", "0.137.0"))).toBe("app-reload-update");
    expect(reloadButtonClass(mismatchOf("protocol", "0.137.0"))).toBe("app-reload-protocol");
  });
});
