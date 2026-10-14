// DR-0035 §5: セッションへの入力の送信結果を、入力欄の振る舞い (文を消すか残すか)
// と人に見せる文言に落とす pure 層 (components/session-input.ts) の仕様。
import { describe, expect, test } from "bun:test";
import type { SessionInputReason } from "@ccmsg/protocol";
import {
  classifySessionInputReply,
  formatSentAt,
  inputReadinessNotice,
  sendExcerpt,
  sessionInputNotice,
  sessionInputReadiness,
  sessionInputSendFailure,
  shouldClearAfter,
  terminalAbsenceNotice,
} from "../src/client/components/session-input.ts";
import { defined } from "./helpers.ts";

const ALL_REASONS: SessionInputReason[] = [
  "dialog",
  "no_composer",
  "refused",
  "no_terminal",
  "not_submitted",
  "enter_failed",
  "session_changed",
  "no_module",
];

describe("classifySessionInputReply", () => {
  // 何を保証するか: daemon の 3 つの outcome がそのまま結果になり、
  // not_delivered は reason を落とさない。
  test("maps the daemon's three outcomes", () => {
    expect(classifySessionInputReply({ ok: true, outcome: "accepted" })).toEqual({
      kind: "accepted",
    });
    expect(
      classifySessionInputReply({ ok: true, outcome: "not_delivered", reason: "dialog" }),
    ).toEqual({ kind: "not_delivered", reason: "dialog" });
    expect(classifySessionInputReply({ ok: true, outcome: "unconfirmed" })).toEqual({
      kind: "unconfirmed",
    });
  });

  // 何を保証するか: 依頼を書いた後に接続が切れた (connection_closed) のは、
  // セッションに入ったかもしれないので unconfirmed。failed にすると人が
  // 「届いていない」と読んで送り直し、二重に入りうる。
  test("treats a reply lost to a closed connection as unconfirmed", () => {
    expect(
      classifySessionInputReply({
        ok: false,
        error: { code: "connection_closed", msg: "ws connection closed" },
      }),
    ).toEqual({ kind: "unconfirmed" });
  });

  // 何を保証するか: webui 側の期限切れ (request_timeout) も、依頼は書いた後
  // なので unconfirmed。
  test("treats a reply lost to the client's timeout as unconfirmed", () => {
    expect(
      classifySessionInputReply({
        ok: false,
        error: { code: "request_timeout", msg: "no reply within 15000 ms" },
      }),
    ).toEqual({ kind: "unconfirmed" });
  });

  // 何を保証するか (対極): daemon が依頼を拒んだエラーは、セッションに何も
  // 入っていないので failed で、daemon の文言を含める。
  test("treats a refused request as failed, keeping the daemon's message", () => {
    const got = classifySessionInputReply({
      ok: false,
      error: { code: "bad_request", msg: "op 'session_input' requires user role" },
    });
    expect(got.kind).toBe("failed");
    expect(got.kind === "failed" && got.message).toContain("requires user role");
  });
});

describe("shouldClearAfter (DR-0035 §5 確認が取れるまで文を消さない)", () => {
  // 何を保証するか: 入力欄と下書きを消すのは accepted だけ。
  test("clears only after accepted", () => {
    expect(shouldClearAfter({ kind: "accepted" })).toBe(true);
    for (const reason of ALL_REASONS) {
      expect(shouldClearAfter({ kind: "not_delivered", reason })).toBe(false);
    }
    expect(shouldClearAfter({ kind: "unconfirmed" })).toBe(false);
    expect(shouldClearAfter(sessionInputSendFailure())).toBe(false);
  });
});

describe("sessionInputNotice", () => {
  // 何を保証するか: accepted は注記を出さない (送った文は Timeline に人の発言
  // として現れる)。
  test("shows nothing after accepted", () => {
    expect(sessionInputNotice({ kind: "accepted" })).toBeNull();
  });

  // 何を保証するか: どの reason でも「届きませんでした」の danger 注記になり、
  // reason ごとの固有の説明が付く (全 reason が同じ文言に潰れていない)。
  test("gives every reason its own danger detail", () => {
    const details = new Set<string>();
    for (const reason of ALL_REASONS) {
      const notice = sessionInputNotice({ kind: "not_delivered", reason });
      expect(notice?.tone).toBe("danger");
      expect(notice?.title).toBe("届きませんでした");
      expect(notice?.detail).not.toBe("");
      details.add(defined(notice, "the notice").detail);
    }
    expect(details.size).toBe(ALL_REASONS.length);
  });

  // 何を保証するか: 人が次に取れる行動を reason ごとに示す。その場で直せる
  // もの (ダイアログを閉じる) はその操作を、環境の対処が要るもの (plugin の
  // 更新、hyoui での起動、対話モード) は具体的な手順を書く。
  test("names the next step for each reason", () => {
    const detail = (reason: SessionInputReason) =>
      defined(sessionInputNotice({ kind: "not_delivered", reason }), "the notice").detail;
    expect(detail("dialog")).toContain("ダイアログを閉じてから送り直して");
    expect(detail("no_terminal")).toContain("hyoui run 経由で起動し直して");
    expect(detail("no_module")).toContain("plugin を更新してセッションを起動し直して");
    expect(detail("session_changed")).toContain("切り替わった先のセッションを開いて送って");
    expect(detail("no_composer")).toContain("対話モードで起動したセッションに送って");
    expect(detail("refused")).toContain("送り直して");
    expect(detail("refused")).toContain("他の plugin を確認して");
    expect(detail("not_submitted")).toContain("送り直して");
    expect(detail("enter_failed")).toContain("送り直して");
  });

  // 何を保証するか: unconfirmed は danger でなく warn で、「送信済みかもしれない」
  // ことと、Timeline で確かめてから送り直す判断材料を示す。
  test("marks unconfirmed as maybe-sent, pointing at the Timeline", () => {
    const notice = sessionInputNotice({ kind: "unconfirmed" });
    expect(notice?.tone).toBe("warn");
    expect(notice?.title).toBe("届いたか確認できませんでした");
    expect(notice?.detail).toContain("送信済みかもしれません");
    expect(notice?.detail).toContain("Timeline");
  });

  // 何を保証するか: 送れなかった (daemon 未接続) は danger で、再接続を促す。
  test("reports a send that never left as failed", () => {
    const notice = sessionInputNotice(sessionInputSendFailure());
    expect(notice?.tone).toBe("danger");
    expect(notice?.title).toBe("送れませんでした");
    expect(notice?.detail).toContain("再接続");
  });
});

describe("formatSentAt", () => {
  // 何を保証するか: 同じ日の送信は時:分だけ、日を跨いだら月/日を前に付ける
  // (注記の「(HH:MM の送信)」が別の日の送信を今日のものと誤読させない)。
  test("omits the date on the same day and adds it across days", () => {
    const sent = new Date(2026, 9, 8, 9, 5).toISOString();
    const sameDay = new Date(2026, 9, 8, 23, 0).getTime();
    const nextDay = new Date(2026, 9, 9, 1, 0).getTime();
    expect(formatSentAt(sent, sameDay)).not.toContain("10/8");
    expect(formatSentAt(sent, sameDay)).toMatch(/09.05|9.05/);
    expect(formatSentAt(sent, nextDay)).toMatch(/^10\/8 /);
  });
});

describe("sendExcerpt", () => {
  // 何を保証するか: 未確認の注記でどの送信かを見分けられるよう、最初の行の
  // 冒頭を出し、続きがあれば … を付ける。
  test("shows the head of the first line", () => {
    expect(sendExcerpt("短い文")).toBe("短い文");
    expect(sendExcerpt("1 行目\n2 行目")).toBe("1 行目…");
    expect(sendExcerpt("あ".repeat(50))).toBe(`${"あ".repeat(40)}…`);
    // 絵文字 (複数の code point からなる書記素) を途中で切らない。
    expect(sendExcerpt("👨‍👩‍👧".repeat(41))).toBe(`${"👨‍👩‍👧".repeat(40)}…`);
  });
});

describe("inputReadinessNotice", () => {
  // 何を保証するか: 受け取れる時と判定が無い時は何も出さない (入力欄の近くに
  // 出すのは届かないと分かっている時だけ)。
  test("says nothing when ready or unknown", () => {
    expect(inputReadinessNotice({ kind: "ready" })).toBeNull();
    expect(inputReadinessNotice(undefined)).toBeNull();
  });

  test("names the cause and the next step", () => {
    expect(inputReadinessNotice({ kind: "no_module" })).toContain(
      "plugin を更新してセッションを起動し直して",
    );
    expect(inputReadinessNotice({ kind: "no_terminal" })).toContain("hyoui run 経由で起動し直して");
    expect(inputReadinessNotice({ kind: "session_changed" })).toContain(
      "切り替わった先のセッションを開いて送って",
    );
  });

  // 何を保証するか: 送る前に出す 1 行と、送って同じ理由で届かなかった時の
  // 注記が同じ文言 (同じ原因と対処) になる。
  test("speaks the words the failed send would", () => {
    for (const kind of ["no_module", "no_terminal", "session_changed"] as const) {
      const sent = sessionInputNotice({ kind: "not_delivered", reason: kind });
      expect(inputReadinessNotice({ kind })).toBe(defined(sent, "the notice").detail);
    }
  });

  test("says the session ended", () => {
    expect(inputReadinessNotice({ kind: "ended" })).toBe("セッションは終了しています。");
  });
});

describe("terminalAbsenceNotice", () => {
  // 何を保証するか: 端末が無い・分からないと判定が言っている時 (hyoui の外で
  // 起動、端末を名乗る module が無い、終了) だけ iframe の代わりに理由と次の
  // 行動を出し、それ以外は iframe に任せる。端末は module が名乗る事実なので
  // (DR-0035 §3)、module の無いセッションは入力欄と同じ原因と対処を言う。
  test("speaks only when the terminal is known to be missing", () => {
    expect(terminalAbsenceNotice({ kind: "no_terminal" })).toContain(
      "hyoui run 経由で起動し直して",
    );
    expect(terminalAbsenceNotice({ kind: "no_module" })).toContain(
      "plugin を更新してセッションを起動し直して",
    );
    expect(terminalAbsenceNotice({ kind: "ended" })).toBe("セッションは終了しています。");
    for (const kind of ["ready", "session_changed"] as const) {
      expect(terminalAbsenceNotice({ kind })).toBeNull();
    }
    expect(terminalAbsenceNotice(undefined)).toBeNull();
  });
});

describe("sessionInputReadiness", () => {
  const peer = (input_readiness?: { kind: "ready" | "no_terminal" }) => ({
    sid: "s",
    repo: "",
    ws: "",
    cwd: "",
    ...(input_readiness ? { input_readiness } : {}),
  });
  const status = { todos: [], workflows: [], background: [] };

  // 何を保証するか: peers の行の判定を先に使い (status を購読していない
  // セッションにもある)、行が無い・まだ判定が無い時は status の判定を使う。
  test("takes the peer row first, then the status", () => {
    expect(
      sessionInputReadiness(peer({ kind: "ready" }), {
        ...status,
        input_readiness: { kind: "no_module" },
      }),
    ).toEqual({ kind: "ready" });
    expect(
      sessionInputReadiness(undefined, { ...status, input_readiness: { kind: "ended" } }),
    ).toEqual({ kind: "ended" });
    expect(
      sessionInputReadiness(peer(), { ...status, input_readiness: { kind: "no_terminal" } }),
    ).toEqual({ kind: "no_terminal" });
    expect(sessionInputReadiness(undefined, undefined)).toBeUndefined();
  });
});
