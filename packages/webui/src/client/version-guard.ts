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
  /** 不一致で、その場でリロードした。 */
  | "reloaded"
  /** 不一致。次のユーザ操作による画面遷移をフルリロードに差し替える
   *  (navigation.ts) 予約を立て、それまでは画面をそのまま使わせる。 */
  | "on-navigation"
  /** 不一致だが自動リロードの予約もしない。ユーザがボタンを押した時だけ。 */
  | "manual";

/** 不一致を抱えたタブの状態。AppState.versionMismatch に入る。 */
export interface VersionMismatch {
  daemonVersion: string;
  /** 次の遷移でフルリロードしてよいか (= outcome が "on-navigation")。 */
  reloadOnNavigation: boolean;
}

/** 判定結果を AppState に載る形へ。リロード済み / 一致は「不一致なし」。 */
export function mismatchOf(
  outcome: VersionGuardOutcome,
  daemonVersion: string,
): VersionMismatch | null {
  if (outcome === "on-navigation") return { daemonVersion, reloadOnNavigation: true };
  if (outcome === "manual") return { daemonVersion, reloadOnNavigation: false };
  return null;
}

/** topbar のリロードボタンの title。不一致は専用のボックスを増やさず、常設の
 *  リロードボタンの見た目 (色 + 控えめな動き) と、この文言だけで伝える
 *  (kawaz r273 m27: 見出しの上に箱が出てレイアウトが変わるのが邪魔)。
 *
 *  押した時にすることは 3 状態とも同じ「今すぐ読み直す」なので、文言の差は
 *  **押さなかった場合に何が起きるか**だけにする — 予約が立っていれば放って
 *  おいても次の画面移動で反映され、立っていなければ古いまま残る。 */
export function reloadButtonTitle(mismatch: VersionMismatch | null): string {
  if (mismatch === null) return "ページを再読み込み";
  const head = `新しい版 v${mismatch.daemonVersion} — 押すと今すぐ反映`;
  return mismatch.reloadOnNavigation
    ? `${head} / 次の画面移動で自動反映`
    : `${head} (押すまでこの画面は古いまま)`;
}

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
 *  テストは実 DOM なしで全分岐を回せる。
 *
 *  `handshakeOk` が false = hello 自体が拒否された = この bundle は daemon と
 *  もう会話できない (以降の全 op が bad_request)。画面は何も更新されないまま
 *  沈黙するので、この時だけは即リロードする。hello が通っているなら表示は
 *  生きているので、リロードは「次の画面遷移」まで待たせる (kawaz r273m9:
 *  入力中・操作中に画面を捨てられる方が損失が大きい)。 */
export function reactToDaemonVersion(
  daemonVersion: string,
  env: VersionGuardEnv,
  handshakeOk = true,
): VersionGuardOutcome {
  const diff = compareVersions(daemonVersion, env.bundleVersion);
  if (diff === 0) return "match";
  if (diff < 0) return "bundle-newer";

  // 2 回目の不一致 = リロードしても bundle が入れ替わらなかった (中間キャッシュ
  // / Service Worker / daemon が古い build を掴んだまま等)。ここで自動の
  // リロードを再び予約するとリロードループ (遷移するたびに読み直して、なお
  // 古いまま) になるので、以後は導線だけ出してユーザの操作を待つ。
  if (env.readReloadedVersion() === daemonVersion) return "manual";

  if (!handshakeOk) {
    // 書きかけを抱えたタブを黙って捨てない。壊れたタブでも、打ち込み中の
    // 本文をユーザが取り出す時間は残す (導線のボタンから自分で読み直せる)。
    if (env.hasUnsentInput()) return "manual";
    env.writeReloadedVersion(daemonVersion);
    env.reload();
    return "reloaded";
  }
  // 予約の段階では書きかけの有無を見ない。実際に読み直すかは遷移の瞬間に
  // navigation.ts が hasUnsentInput() を見て決めるので、検出時にたまたま
  // 書きかけがあっただけで以後ずっと予約なしになる (送信して空になっても
  // 追従しない) のを避ける。
  return "on-navigation";
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
  return { outcome: reactToDaemonVersion(daemonVersion, env, hello.ok === true), daemonVersion };
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

/** 実際にリロードへ踏み切る側 (遷移フック / topbar のボタン) が、その事実を
 *  このタブに記録する。記録がないと、リロードしても bundle が入れ替わらな
 *  かった時に同じ判定が何度でも成立してループになる。 */
export function markReloadedForVersion(daemonVersion: string): void {
  writeSession(RELOADED_FOR_VERSION_KEY, daemonVersion);
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
