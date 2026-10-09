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
 *   書いた後に返事を失った (接続が切れた、webui 側の期限までに返事が来なかった)。
 *   届いていれば Timeline に人の発言として出る
 * - `failed`: 依頼がセッションまで行っていない (daemon に繋がっていない、daemon が
 *   依頼を受け付けなかった)。セッションには何も入っていない */
export type SessionInputOutcome =
  | { kind: "accepted" }
  | { kind: "not_delivered"; reason: SessionInputReason }
  | { kind: "unconfirmed" }
  | { kind: "failed"; message: string };

/** ws.ts が「依頼を書いた後、返事を受け取れなかった」時に返すエラーコード。
 * `connection_closed` は返事の前に接続が切れた、`request_timeout` は接続は
 * 生きているが期限までに返事が来なかった。どちらも daemon は依頼を受け取って
 * セッションに渡したかもしれない。 */
const REPLY_LOST_CODES = new Set(["connection_closed", "request_timeout"]);

/** daemon の返事を結果に分類する。
 *
 * 依頼を書いた後に返事を失ったものは、届いた可能性を消せないので
 * `unconfirmed` に入れる (DR-0035 §5 の「成功も失敗も返らない時」)。それ以外の
 * エラーは daemon が依頼を拒んだもので、セッションには何も届いていない。 */
export function classifySessionInputReply(
  reply: SessionInputResponse | ErrorResponse,
): SessionInputOutcome {
  if (!reply.ok) {
    if (REPLY_LOST_CODES.has(reply.error.code)) return { kind: "unconfirmed" };
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

/** 届かなかった理由ごとの、何が起きたかと次の行動。人がその場で直せるもの
 * (ダイアログを閉じる等) は先にそれを書き、環境の対処が要るもの (plugin の
 * 更新、起動のし直し) はその具体的な手順を書く。 */
const REASON_DETAIL: Record<SessionInputReason, string> = {
  dialog:
    "セッションで選択や確認のダイアログが開いていたため、入力できませんでした。セッションの画面 (Terminal タブなど) でダイアログを閉じてから送り直してください。",
  no_composer:
    "このセッションは入力欄の無い起動 (-p など) のため、人の入力を受け付けません。対話モードで起動したセッションに送ってください。",
  refused:
    "セッション側で入力が拒否されました。セッションの画面で入力できる状態か確かめてから送り直してください。続く場合は、セッションに入っている他の plugin を確認してください (入力欄への書き込みを止める hook があります)。",
  no_terminal:
    "このセッションには webui から入力を届ける端末がありません。webui から送れるのは hyoui で起動したセッションだけです。このセッションへは端末から直接入力してください。",
  not_submitted:
    "入力した文が送信されませんでした (セッションの入力欄は元に戻してあります)。セッションの画面を確かめてから送り直してください。",
  enter_failed:
    "セッションの端末に送信の操作を届けられませんでした (入力欄は元に戻してあります)。セッションの端末 (Terminal タブなど) が動いているか確かめてから送り直してください。",
  session_changed:
    "セッションが切り替わった (/clear や /resume) ため、入力欄に入れずに止めました。届いていません。送り直してください。",
  no_module:
    "セッション側に入力の受け口がありません。セッションが終了していないか確かめてください。動いている場合は、ccmsg plugin を更新してからセッションを起動し直してください (古い plugin のままでは受け取れません)。",
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
          `セッションが入力を受け取れませんでした (理由: ${outcome.reason})。セッションの画面を確かめてから送り直してください。続く場合は、この画面を再読み込みし、ccmsg plugin を更新してください。`,
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

/** 時刻を注記に出す形 (同じ日なら時:分、日を跨いだら月/日 時:分)。 */
export function formatSentAt(iso: string, now: number = Date.now()): string {
  const at = new Date(iso);
  const hm = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return new Date(now).toDateString() === at.toDateString()
    ? hm
    : `${at.getMonth() + 1}/${at.getDate()} ${hm}`;
}

const EXCERPT_MAX = 40;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 送った文を注記の中で見分けるための冒頭 (最初の行、長ければ省略)。文字数は
 * 書記素で数え、絵文字などを途中で切らない。 */
export function sendExcerpt(text: string): string {
  const firstLine = text.trim().split("\n", 1)[0] ?? "";
  const chars = Array.from(graphemes.segment(firstLine), (s) => s.segment);
  const more = chars.length > EXCERPT_MAX || text.trim().includes("\n");
  return chars.slice(0, EXCERPT_MAX).join("") + (more ? "…" : "");
}
