// 開きっぱなしのタブが古い bundle のまま新しい daemon と喋り続けるのを防ぐ
// (issue 2026-09-03)。webui の bundle は daemon プロセスが serve 時に 1 度だけ
// build して持つので、daemon が新 version で再起動した瞬間、既に開いている
// タブの JS だけが古いまま取り残される。v0.136.0 の request_id 必須化のように
// wire protocol が動くと、そのタブは全要求が bad_request になって沈黙する。
//
// 判定材料は hello 応答の `version` と、bundle に焼き込まれた VERSION
// (@ccmsg/protocol、build 時の package.json 由来)。ws.ts が接続 (と再接続)
// のたびに hello の直後で呼ぶ。
import { compareVersions } from "@ccmsg/protocol";

/** sessionStorage の key。tab ごとに独立しているのが要点 — 別タブのリロード
 *  実績をこのタブの「もう試した」判定に流用しない。 */
export const RELOADED_FOR_VERSION_KEY = "ccmsg:reloaded-for-daemon-version";

export type VersionGuardOutcome =
  /** bundle と daemon が同じ。何もしない。 */
  | "match"
  /** bundle の方が新しい。daemon の入れ替えは CLI 側の version-mismatch
   *  upgrade (DR-0002 §4) の仕事で、ページを読み直しても何も変わらない。 */
  | "bundle-newer"
  /** 不一致で、リロードした。 */
  | "reloaded"
  /** 不一致だが自動リロードは見送り、ユーザに委ねた。 */
  | "notified";

export interface VersionGuardEnv {
  /** この bundle が焼き込んでいる version。 */
  bundleVersion: string;
  /** リロードで失われる書きかけがあるか。 */
  hasUnsentInput: () => boolean;
  /** このタブが「どの daemon version のために既にリロードしたか」。 */
  readReloadedVersion: () => string | null;
  writeReloadedVersion: (version: string) => void;
  reload: () => void;
}

/** hello が名乗った daemon version に対して、このタブが取るべき行動を決めて
 *  実行する。副作用 (reload / sessionStorage 書き込み) は env 越しなので、
 *  テストは実 DOM なしで全分岐を回せる。 */
export function reactToDaemonVersion(
  daemonVersion: string,
  env: VersionGuardEnv,
): VersionGuardOutcome {
  const diff = compareVersions(daemonVersion, env.bundleVersion);
  if (diff === 0) return "match";
  if (diff < 0) return "bundle-newer";

  // 2 回目の不一致 = リロードしても bundle が入れ替わらなかった (中間キャッシュ
  // / Service Worker / daemon が古い build を掴んだまま等)。ここで再度
  // location.reload() を打つとリロードループになるので、以後は通知に落として
  // ユーザの操作を待つ。
  if (env.readReloadedVersion() === daemonVersion) return "notified";

  // 書きかけを抱えたタブを黙って捨てない。壊れた状態で喋り続けるのも困るが、
  // 打ち込み中の本文が消える方がユーザにとっては損失が大きいので、判断を
  // 渡す (通知のボタンからならユーザ自身のタイミングでリロードできる)。
  if (env.hasUnsentInput()) return "notified";

  env.writeReloadedVersion(daemonVersion);
  env.reload();
  return "reloaded";
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
  env: VersionGuardEnv,
): Promise<{ outcome: VersionGuardOutcome; daemonVersion: string } | null> {
  const daemonVersion = hello.ok && hello.version ? hello.version : await probeVersion();
  if (!daemonVersion) return null;
  return { outcome: reactToDaemonVersion(daemonVersion, env), daemonVersion };
}

/** sessionStorage を try/catch で包む (private mode / quota で例外が飛ぶ環境が
 *  ある)。読めない環境では「まだリロードしていない」に degrade する — 1 回は
 *  自動リロードが走り、書き込みも失敗するので 2 回目以降もリロードし続ける
 *  可能性は残るが、そこは storage が使えない環境の既知の degrade として
 *  他の localStorage ヘルパ (storage.ts) と同じ posture を取る。 */
function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // storage unavailable — 自動リロード自体は成立するので握り潰す
  }
}

/** ブラウザ実環境用の env。 */
export function browserVersionGuardEnv(
  bundleVersion: string,
  hasUnsentInput: () => boolean,
): VersionGuardEnv {
  return {
    bundleVersion,
    hasUnsentInput,
    readReloadedVersion: () => readSession(RELOADED_FOR_VERSION_KEY),
    writeReloadedVersion: (version) => writeSession(RELOADED_FOR_VERSION_KEY, version),
    reload: () => {
      location.reload();
    },
  };
}
