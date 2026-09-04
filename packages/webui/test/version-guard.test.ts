// 開きっぱなしのタブが古い bundle のまま新 daemon と喋り続ける問題
// (issue 2026-09-03) の判定ロジック。reload / sessionStorage / 書きかけ検出は
// すべて env 越しなので、実 DOM なしで全分岐を直接回せる。
import { beforeEach, describe, expect, test } from "bun:test";
import {
  mismatchOf,
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

  // 画面を捨てる判断はユーザの次の操作まで待つ (kawaz r273m9)。入力中・操作中
  // にページが消えるのがそもそもの不具合なので、ここで reload が 0 回である
  // ことがこの機能の要。
  test("daemon が新しくても hello が通っていれば遷移まで待つ", () => {
    const h = harness();
    expect(reactToDaemonVersion("0.137.0", h.env)).toBe("on-navigation");
    expect(h.reloads).toBe(0);
    // 記録は実際にリロードする側 (遷移フック / ボタン) が付ける。予約の段階で
    // 付けると、1 度も読み直さないまま「もう試した」扱いになる。
    expect(h.session.size).toBe(0);
  });

  // hello 拒否 = 以降の全 op が失敗する = 画面が更新されないまま沈黙する。
  // 待たせても得るものがないので、この分岐だけ即リロードを残す。
  test("hello 自体が拒否されていれば即リロードし、そのことを記録する", () => {
    const h = harness();
    expect(reactToDaemonVersion("0.137.0", h.env, false)).toBe("reloaded");
    expect(h.reloads).toBe(1);
    expect(h.session.get("k")).toBe("0.137.0");
  });

  // リロードしても bundle が入れ替わらない (中間キャッシュ等) 場合にループへ
  // 落ちないことが、この機能で一番怖い失敗なので単独で押さえる。遷移のたびに
  // 読み直すループは、ユーザが画面を移動できなくなる分より悪い。
  test("同じ daemon version でリロード済みなら予約もせず手動に落ちる", () => {
    const h = harness();
    h.session.set("k", "0.137.0");
    expect(reactToDaemonVersion("0.137.0", h.env)).toBe("manual");
    expect(reactToDaemonVersion("0.137.0", h.env, false)).toBe("manual");
    expect(h.reloads).toBe(0);
  });

  // 記録は version ごと。1 度リロード済みでも、さらに新しい daemon が来たら
  // もう一度だけ自動で追従する。
  test("さらに新しい daemon version なら記録があっても再び予約する", () => {
    const h = harness();
    h.session.set("k", "0.137.0");
    expect(reactToDaemonVersion("0.138.0", h.env)).toBe("on-navigation");
  });

  // 予約はあくまで予約で、読み直すかどうかは遷移の瞬間に navigation.ts が
  // 決める。検出時の書きかけを理由に予約を落とすと、送信してフォームが空に
  // なった後も二度と追従しないタブができる。
  test("検出時に書きかけがあっても予約はする (遷移時に改めて見る)", () => {
    const h = harness({ hasUnsentInput: () => true });
    expect(reactToDaemonVersion("0.137.0", h.env)).toBe("on-navigation");
    expect(h.reloads).toBe(0);
  });

  test("hello 拒否で書きかけがあるタブは即リロードせず手動に落ちる", () => {
    const h = harness({ hasUnsentInput: () => true });
    expect(reactToDaemonVersion("0.137.0", h.env, false)).toBe("manual");
    expect(h.reloads).toBe(0);
    // 見送りを「リロード済み」と誤記録すると、書き終えて再接続した時に
    // 自動追従の 1 回分を失う。
    expect(h.session.size).toBe(0);
  });

  test("mismatchOf は予約の有無を AppState に載る形へ移す", () => {
    expect(mismatchOf("on-navigation", "0.137.0")).toEqual({
      daemonVersion: "0.137.0",
      reloadOnNavigation: true,
    });
    expect(mismatchOf("manual", "0.137.0")).toEqual({
      daemonVersion: "0.137.0",
      reloadOnNavigation: false,
    });
    // 一致・リロード済みのタブに導線は要らない。
    expect(mismatchOf("match", "0.137.0")).toBeNull();
    expect(mismatchOf("bundle-newer", "0.137.0")).toBeNull();
    expect(mismatchOf("reloaded", "0.137.0")).toBeNull();
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
    expect(res).toEqual({ outcome: "on-navigation", daemonVersion: "0.137.0" });
    expect(h.reloads).toBe(0);
  });

  test("hello 拒否 + ping が新しい version を返したら 1 度だけリロードする", async () => {
    const h = harness();
    const res = await reactToHandshakeVersion(refused, async () => "0.137.0", h.env);
    expect(res).toEqual({ outcome: "reloaded", daemonVersion: "0.137.0" });
    expect(h.reloads).toBe(1);

    // 2 度目 (再接続で同じ拒否を踏む) はリロードループに落ちない。
    const again = await reactToHandshakeVersion(refused, async () => "0.137.0", h.env);
    expect(again?.outcome).toBe("manual");
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
    // hello 自体は通っているので即リロードはしない。
    expect(res?.outcome).toBe("on-navigation");
    expect(h.reloads).toBe(0);
  });

  test("hello 拒否 + ping が同じ version を返したらリロードしない", async () => {
    const h = harness();
    const res = await reactToHandshakeVersion(refused, async () => BUNDLE, h.env);
    expect(res).toEqual({ outcome: "match", daemonVersion: BUNDLE });
    expect(h.reloads).toBe(0);
  });
});
