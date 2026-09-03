// 開きっぱなしのタブが古い bundle のまま新 daemon と喋り続ける問題
// (issue 2026-09-03) の判定ロジック。reload / sessionStorage / 書きかけ検出は
// すべて env 越しなので、実 DOM なしで 4 分岐を直接回せる。
import { beforeEach, describe, expect, test } from "bun:test";
import {
  reactToDaemonVersion,
  reactToHandshakeVersion,
  type VersionGuardEnv,
  type VersionGuardOutcome,
} from "../src/client/version-guard.ts";
import {
  hasUnsentInput,
  registerUnsentInput,
  resetUnsentInput,
} from "../src/client/unsent-input.ts";

const BUNDLE = "0.136.0";

interface Harness {
  env: VersionGuardEnv;
  reloads: number;
  session: Map<string, string>;
}

function harness(overrides: Partial<VersionGuardEnv> = {}): Harness {
  const h: Harness = {
    reloads: 0,
    session: new Map(),
    env: {} as VersionGuardEnv,
  };
  h.env = {
    bundleVersion: BUNDLE,
    hasUnsentInput: () => false,
    readReloadedVersion: () => h.session.get("k") ?? null,
    writeReloadedVersion: (v) => {
      h.session.set("k", v);
    },
    reload: () => {
      h.reloads++;
    },
    ...overrides,
  };
  return h;
}

describe("reactToDaemonVersion", () => {
  test("同じ version なら何もしない", () => {
    const h = harness();
    expect(reactToDaemonVersion(BUNDLE, h.env)).toBe("match" satisfies VersionGuardOutcome);
    expect(h.reloads).toBe(0);
    expect(h.session.size).toBe(0);
  });

  test("daemon が新しければ 1 度だけリロードし、そのことを記録する", () => {
    const h = harness();
    expect(reactToDaemonVersion("0.137.0", h.env)).toBe("reloaded");
    expect(h.reloads).toBe(1);
    expect(h.session.get("k")).toBe("0.137.0");
  });

  // リロードしても bundle が入れ替わらない (中間キャッシュ等) 場合にループへ
  // 落ちないことが、この機能で一番怖い失敗なので単独で押さえる。
  test("同じ daemon version で 2 度目の不一致を見たらリロードせず通知に落ちる", () => {
    const h = harness();
    reactToDaemonVersion("0.137.0", h.env);
    expect(reactToDaemonVersion("0.137.0", h.env)).toBe("notified");
    expect(h.reloads).toBe(1);
  });

  // 記録は version ごと。1 度リロード済みでも、さらに新しい daemon が来たら
  // もう一度だけ自動で追従する。
  test("さらに新しい daemon version なら記録があっても再びリロードする", () => {
    const h = harness();
    reactToDaemonVersion("0.137.0", h.env);
    expect(reactToDaemonVersion("0.138.0", h.env)).toBe("reloaded");
    expect(h.reloads).toBe(2);
    expect(h.session.get("k")).toBe("0.138.0");
  });

  test("書きかけがあるタブは自動リロードせず通知だけ、記録も残さない", () => {
    const h = harness({ hasUnsentInput: () => true });
    expect(reactToDaemonVersion("0.137.0", h.env)).toBe("notified");
    expect(h.reloads).toBe(0);
    // 見送りを「リロード済み」と誤記録すると、書き終えて再接続した時に
    // 自動リロードの 1 回分を失う。
    expect(h.session.size).toBe(0);
  });

  // bundle の方が新しい = 古い daemon に繋がった状態。daemon の入れ替えは CLI
  // 側の version-mismatch upgrade (DR-0002 §4) の担当で、ページを読み直しても
  // 相手は変わらないので webui は何もしない。
  test("bundle の方が新しければリロードも通知もしない", () => {
    const h = harness();
    expect(reactToDaemonVersion("0.135.0", h.env)).toBe("bundle-newer");
    expect(h.reloads).toBe(0);
  });
});

describe("unsent-input registry", () => {
  beforeEach(() => {
    resetUnsentInput();
  });

  test("登録がある間だけ true、解除で戻る", () => {
    expect(hasUnsentInput()).toBe(false);
    const release = registerUnsentInput();
    expect(hasUnsentInput()).toBe(true);
    release();
    expect(hasUnsentInput()).toBe(false);
  });

  test("複数の書きかけは全部解除されるまで true のまま", () => {
    const a = registerUnsentInput();
    const b = registerUnsentInput();
    a();
    expect(hasUnsentInput()).toBe(true);
    b();
    expect(hasUnsentInput()).toBe(false);
  });

  test("同じ解除関数を二度呼んでもカウンタが負に振れない", () => {
    const release = registerUnsentInput();
    release();
    release();
    expect(hasUnsentInput()).toBe(false);
    const other = registerUnsentInput();
    expect(hasUnsentInput()).toBe(true);
    other();
  });
});

// hello 自体が拒否される upgrade (今回の protocol 世代変更、v0.136.0 の
// request_id 必須化) こそこの guard が要る場面なのに、hello 応答の version
// しか見ないと判定材料が無いまま沈黙する。ping は hello 不要で version を
// 返すので、そこから拾い直せることを押さえる。
describe("reactToHandshakeVersion", () => {
  const refused = { ok: false } as const;
  const never = async (): Promise<string | null> => {
    throw new Error("probe must not run when hello already named a version");
  };

  test("hello が成功していれば ping を打たずにその version で判定する", async () => {
    const h = harness();
    const res = await reactToHandshakeVersion({ ok: true, version: "0.137.0" }, never, h.env);
    expect(res).toEqual({ outcome: "reloaded", daemonVersion: "0.137.0" });
    expect(h.reloads).toBe(1);
  });

  test("hello 拒否 + ping が新しい version を返したら 1 度だけリロードする", async () => {
    const h = harness();
    const res = await reactToHandshakeVersion(refused, async () => "0.137.0", h.env);
    expect(res).toEqual({ outcome: "reloaded", daemonVersion: "0.137.0" });
    expect(h.reloads).toBe(1);

    // 2 度目 (再接続で同じ拒否を踏む) はリロードループに落ちない。
    const again = await reactToHandshakeVersion(refused, async () => "0.137.0", h.env);
    expect(again?.outcome).toBe("notified");
    expect(h.reloads).toBe(1);
  });

  test("hello 拒否 + ping も版数を返せなければ何もしない", async () => {
    const h = harness();
    expect(await reactToHandshakeVersion(refused, async () => null, h.env)).toBeNull();
    expect(h.reloads).toBe(0);
    expect(h.session.size).toBe(0);
  });

  test("hello が ok でも version を名乗らなければ ping に落ちる", async () => {
    const h = harness();
    const res = await reactToHandshakeVersion({ ok: true }, async () => "0.137.0", h.env);
    expect(res?.daemonVersion).toBe("0.137.0");
    expect(h.reloads).toBe(1);
  });

  test("hello 拒否 + ping が同じ version を返したらリロードしない", async () => {
    const h = harness();
    const res = await reactToHandshakeVersion(refused, async () => BUNDLE, h.env);
    expect(res).toEqual({ outcome: "match", daemonVersion: BUNDLE });
    expect(h.reloads).toBe(0);
  });
});
