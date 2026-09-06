// 開きっぱなしのタブが古い bundle のまま新しい daemon と喋り続けるのを防ぐ
// (issue 2026-09-03)。webui の bundle は daemon プロセスが serve 時に 1 度だけ
// build して持つので、daemon が新 version で再起動した瞬間、既に開いている
// タブの JS だけが古いまま取り残される。v0.136.0 の request_id 必須化のように
// wire protocol が動くと、そのタブは全要求が bad_request になって沈黙する。
//
// 判定材料は hello 応答の `version` と、bundle に焼き込まれた VERSION
// (@ccmsg/protocol、build 時の package.json 由来)。ws.ts が接続 (と再接続)
// のたびに hello の直後で呼ぶ。読み直す瞬間はユーザが決める — 不一致は
// topbar のリロードボタンの色と title で知らせるだけで、ページは捨てない。
import { compareVersions } from "@ccmsg/protocol";

export type VersionGuardOutcome =
  /** bundle と daemon が同じ。何もしない。 */
  | "match"
  /** bundle の方が新しい。daemon の入れ替えは CLI 側の version-mismatch
   *  upgrade (DR-0002 §4) の仕事で、ページを読み直しても何も変わらない。 */
  | "bundle-newer"
  /** 不一致。ユーザがリロードボタンを押すまで、このタブは古いまま。 */
  | "manual";

/** 不一致を抱えたタブの状態。AppState.versionMismatch に入る。 */
export interface VersionMismatch {
  daemonVersion: string;
}

/** 判定結果を AppState に載る形へ。不一致でなければ null。 */
export function mismatchOf(
  outcome: VersionGuardOutcome,
  daemonVersion: string,
): VersionMismatch | null {
  return outcome === "manual" ? { daemonVersion } : null;
}

/** topbar のリロードボタンの title。不一致は専用のボックスを増やさず、常設の
 *  リロードボタンの見た目 (色 + 控えめな動き) と、この文言だけで伝える
 *  (kawaz r273 m27: 見出しの上に箱が出てレイアウトが変わるのが邪魔)。 */
export function reloadButtonTitle(mismatch: VersionMismatch | null): string {
  if (mismatch === null) return "ページを再読み込み";
  return `新しい版 v${mismatch.daemonVersion} — 押すと今すぐ反映 (押すまでこの画面は古いまま)`;
}

/** hello が名乗った daemon version と、この bundle が焼き込んでいる version を
 *  突き合わせる。純粋関数なので、テストは実 DOM なしで全分岐を回せる。 */
export function reactToDaemonVersion(
  daemonVersion: string,
  bundleVersion: string,
): VersionGuardOutcome {
  const diff = compareVersions(daemonVersion, bundleVersion);
  if (diff === 0) return "match";
  if (diff < 0) return "bundle-newer";
  return "manual";
}

/** Run the guard against a handshake that may not have completed.
 *
 * `reactToDaemonVersion` needs a version, and the hello reply is where one
 * normally comes from — but the upgrade that most needs this guard is exactly
 * the one that keeps the hello from succeeding. A daemon that changed the wire
 * protocol (the v0.136.0 `request_id` requirement, a `protocol` generation the
 * bundle does not speak) answers this tab's hello with `bad_request`, and a
 * guard that only reads `hello.version` learns nothing and leaves the tab
 * talking to a daemon it cannot talk to.
 *
 * So a refused hello falls back to `ping`, which needs no hello (it is outside
 * the daemon's IDENTITY_OPS) and has carried `version` since the first
 * generation. `probeVersion` resolving to null — ping refused too, or the
 * socket gone — returns null: nothing was learned, and the caller's reconnect
 * backoff is the remaining answer.
 */
export async function reactToHandshakeVersion(
  hello: { ok?: boolean; version?: string },
  probeVersion: () => Promise<string | null>,
  bundleVersion: string,
): Promise<{ outcome: VersionGuardOutcome; daemonVersion: string } | null> {
  const daemonVersion = hello.ok && hello.version ? hello.version : await probeVersion();
  if (!daemonVersion) return null;
  return { outcome: reactToDaemonVersion(daemonVersion, bundleVersion), daemonVersion };
}
