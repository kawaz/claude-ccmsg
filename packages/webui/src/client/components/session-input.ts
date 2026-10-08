// セッションへの人の入力 (DR-0035 §1, §5) の送信結果を、入力欄が取るべき
// 振る舞いと人に見せる文言に落とす pure な層。SessionInputComposer はこの
// 結果だけを見て「文を消す / 残す」と表示を決める。JSX を通さず bun test から
// 直接叩けるよう .ts に切り出している (composer-keydown.ts と同じ流儀)。
import type { ErrorResponse, SessionInputReason, SessionInputResponse } from "@ccmsg/protocol";

/** 1 回の送信がどう終わったか。
 *
 * - `accepted`: セッションが人の入力として受け取った。文を消してよい唯一の結果
 * - `not_delivered`: 届かなかった (`reason`)。別の経路には落ちていない
 * - `unconfirmed`: 届いたかどうか分からない。daemon の待ちが切れたか、依頼を
 *   書いた後に接続が切れて返事を失った。届いていれば Timeline に人の発言として出る
 * - `failed`: 依頼がセッションまで行っていない (daemon に繋がっていない、daemon が
 *   依頼を受け付けなかった)。セッションには何も入っていない */
export type SessionInputOutcome =
  | { kind: "accepted" }
  | { kind: "not_delivered"; reason: SessionInputReason }
  | { kind: "unconfirmed" }
  | { kind: "failed"; message: string };

/** daemon の返事を結果に分類する。
 *
 * `connection_closed` は ws.ts が「依頼を書いた後、返事が来る前に接続が切れた」
 * 時に返すもので、daemon は依頼を受け取ってサイドカーに書いたかもしれない。
 * 届いた可能性を消せないので `unconfirmed` に入れる (DR-0035 §5 の「成功も失敗も
 * 返らない時」)。それ以外のエラーは daemon が依頼を拒んだもので、セッションには
 * 何も届いていない。 */
export function classifySessionInputReply(
  reply: SessionInputResponse | ErrorResponse,
): SessionInputOutcome {
  if (!reply.ok) {
    if (reply.error.code === "connection_closed") return { kind: "unconfirmed" };
    return { kind: "failed", message: `daemon が受け付けませんでした: ${reply.error.msg}` };
  }
  switch (reply.outcome) {
    case "accepted":
      return { kind: "accepted" };
    case "not_delivered":
      return { kind: "not_delivered", reason: reply.reason };
    case "unconfirmed":
      return { kind: "unconfirmed" };
    default:
      // この webui が知らない outcome (新しい daemon)。届いたかどうか判断
      // できないので、文を残す側の `unconfirmed` に倒す。
      return { kind: "unconfirmed" };
  }
}

/** ws.ts の send が reject した時の結果。reject は依頼を socket に書く前
 * (未接続 / 接続待ちの間に切れた) にしか起きないので、何も送られていない。 */
export function sessionInputSendFailure(): SessionInputOutcome {
  return {
    kind: "failed",
    message: "daemon に繋がっていないため送れませんでした。再接続してから送り直してください。",
  };
}

/** 入力欄の文と保存済みの下書きを消してよいか。DR-0035 §5: 成功の確認が取れた
 * 時だけ消す。 */
export function shouldClearAfter(outcome: SessionInputOutcome): boolean {
  return outcome.kind === "accepted";
}

/** 届かなかった理由ごとの、何が起きたかと次に人が取れる行動。 */
const REASON_DETAIL: Record<SessionInputReason, string> = {
  dialog:
    "セッションでダイアログが開いていたため、入力欄に入れられませんでした。Terminal タブなどでダイアログを閉じてから送り直してください。",
  no_composer: "このセッションは入力欄を持たない起動 (-p / SDK) のため、人の入力を受け付けません。",
  refused:
    "別の plugin の hook が入力欄への書き込みを止めました。セッションに入っている plugin を確かめてから送り直してください。",
  no_terminal:
    "このセッションは hyoui の外で起動されたため、Enter を送る端末がありません。hyoui で起動したセッションにだけ送れます。",
  not_submitted:
    "入力欄に入れた文が Enter で送信されませんでした (入力欄は元に戻してあります)。セッションの様子を確かめてから送り直してください。",
  enter_failed:
    "端末への Enter の送出に失敗しました (入力欄は元に戻してあります)。セッションの端末が動いているか確かめてから送り直してください。",
  no_module:
    "セッション側で入力を受け取る仕組みが動いていません。ccmsg plugin が古いか hooks module が読まれていない、またはセッションが終了しています。plugin を更新してセッションを起動し直してください。",
};

export interface SessionInputNotice {
  /** `danger` は届いていないことが確定している時、`warn` は届いたか分からない時。 */
  tone: "danger" | "warn";
  title: string;
  detail: string;
}

/** 結果を入力欄の下に出す文言にする。`accepted` は出すものが無い (文が消え、
 * 送った文が Timeline に人の発言として現れる)。 */
export function sessionInputNotice(outcome: SessionInputOutcome): SessionInputNotice | null {
  switch (outcome.kind) {
    case "accepted":
      return null;
    case "not_delivered":
      return {
        tone: "danger",
        title: "届きませんでした",
        detail:
          REASON_DETAIL[outcome.reason] ??
          `セッションが入力を受け取れませんでした (${outcome.reason})。`,
      };
    case "unconfirmed":
      return {
        tone: "warn",
        title: "届いたか確認できませんでした",
        detail:
          "送信済みかもしれません。届いていれば Timeline に人の発言として出ます。出ていない時だけ送り直してください。",
      };
    case "failed":
      return { tone: "danger", title: "送れませんでした", detail: outcome.message };
  }
}
