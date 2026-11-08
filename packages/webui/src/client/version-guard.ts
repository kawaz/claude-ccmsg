// 開きっぱなしのタブが古い bundle のまま新しい daemon と喋り続けるのを防ぐ
// (issue 2026-09-03)。webui の bundle は daemon プロセスが serve 時に 1 度だけ
// build して持つので、daemon が新 version で再起動した瞬間、既に開いている
// タブの JS だけが古いまま取り残される。v0.136.0 の request_id 必須化のように
// wire protocol が動くと、そのタブは全要求が bad_request になって沈黙する。
//
// 判定材料は hello 応答の `version` と、bundle に焼き込まれた VERSION
// (@ccmsg/protocol、build 時の package.json 由来)。hello が断られた時は ping
// の `version` と `protocol` で、protocol の major が bundle と違えば
// (DR-0002 §4) このタブの要求はどれも通らないので、それを別の色で知らせる。
// ws.ts が接続 (と再接続) のたびに hello の直後で呼ぶ。読み直す瞬間はユーザが
// 決める — 不一致は topbar のリロードボタンの色と title で知らせるだけで、
// ページは捨てない。
import { claimedProtocol, compareVersions, type ProtocolVersion } from "@ccmsg/protocol";

export type VersionGuardOutcome =
  /** bundle と daemon が同じ。何もしない。 */
  | "match"
  /** bundle の方が新しい。daemon の入れ替えは CLI 側の version-mismatch
   *  upgrade (DR-0002 §4) の仕事で、ページを読み直しても何も変わらない。 */
  | "bundle-newer"
  /** 不一致。ユーザがリロードボタンを押すまで、このタブは古いまま。 */
  | "manual"
  /** daemon の protocol の major が bundle と違う。このタブの要求は daemon に
   *  断られ続け、リロードして daemon の bundle を読み込むまで何も動かない
   *  (bundle は daemon が配るので、version の新旧によらずリロードで揃う)。 */
  | "protocol";

/** 不一致を抱えたタブの状態。AppState.versionMismatch に入る。
 *  `protocolChanged` は protocol の major が違う (`"protocol"`) こと。 */
export interface VersionMismatch {
  daemonVersion: string;
  protocolChanged: boolean;
}

/** 判定結果を AppState に載る形へ。不一致でなければ null。 */
export function mismatchOf(
  outcome: VersionGuardOutcome,
  daemonVersion: string,
): VersionMismatch | null {
  if (outcome === "protocol") return { daemonVersion, protocolChanged: true };
  return outcome === "manual" ? { daemonVersion, protocolChanged: false } : null;
}

/** topbar のリロードボタンの title。不一致は専用のボックスを増やさず、常設の
 *  リロードボタンの見た目 (色 + 控えめな動き) と、この文言だけで伝える
 *  (kawaz r273 m27: 見出しの上に箱が出てレイアウトが変わるのが邪魔)。 */
export function reloadButtonTitle(mismatch: VersionMismatch | null): string {
  if (mismatch === null) return "ページを再読み込み";
  if (mismatch.protocolChanged) {
    return `ccmsg の protocol が変わった。リロードしてください (daemon v${mismatch.daemonVersion})`;
  }
  return `新しい版 v${mismatch.daemonVersion} — 押すと今すぐ反映 (押すまでこの画面は古いまま)`;
}

/** topbar のリロードボタンの class。protocol の major 違いは赤、版の違いは
 *  青 (app.css)。 */
export function reloadButtonClass(mismatch: VersionMismatch | null): string | undefined {
  if (mismatch === null) return undefined;
  return mismatch.protocolChanged ? "app-reload-protocol" : "app-reload-update";
}

/** daemon が ping で名乗る自分の版。`protocol` の無い daemon は major 1
 *  (`UNANNOUNCED_PROTOCOL_MAJOR`)。 */
export interface DaemonProbe {
  version: string;
  protocol?: ProtocolVersion;
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
 * the one that keeps the hello from succeeding. A daemon of another protocol
 * major than the bundle (DR-0002 §4) answers this tab's hello with
 * `bad_request`, and a guard that only reads `hello.version` learns nothing
 * and leaves the tab talking to a daemon it cannot talk to.
 *
 * So a refused hello falls back to `ping`, which needs no hello (it is outside
 * the daemon's IDENTITY_OPS) and carries the daemon's `version` and
 * `protocol`. A major other than the bundle's is `"protocol"`, whichever
 * version is newer. A served hello is of the bundle's major by construction.
 * `probe` resolving to null — ping refused too, or the socket gone — returns
 * null: nothing was learned, and the caller's reconnect backoff is the
 * remaining answer.
 */
export async function reactToHandshakeVersion(
  hello: { ok?: boolean; version?: string },
  probe: () => Promise<DaemonProbe | null>,
  bundle: { version: string; protocol: ProtocolVersion },
): Promise<{ outcome: VersionGuardOutcome; daemonVersion: string } | null> {
  if (hello.ok && hello.version) {
    return {
      outcome: reactToDaemonVersion(hello.version, bundle.version),
      daemonVersion: hello.version,
    };
  }
  const daemon = await probe();
  if (daemon === null) return null;
  if (claimedProtocol(daemon.protocol).major !== bundle.protocol.major) {
    return { outcome: "protocol", daemonVersion: daemon.version };
  }
  return {
    outcome: reactToDaemonVersion(daemon.version, bundle.version),
    daemonVersion: daemon.version,
  };
}
