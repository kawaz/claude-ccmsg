// DR-0035 §5: セッションへの入力の送信結果を、入力欄の振る舞い (文を消すか残すか)
// と人に見せる文言に落とす pure 層 (components/session-input.ts) の仕様。
import { describe, expect, test } from "bun:test";
import type { SessionInputReason } from "@ccmsg/protocol";
import {
  classifySessionInputReply,
  sessionInputNotice,
  sessionInputSendFailure,
  shouldClearAfter,
} from "../src/client/components/session-input.ts";

const ALL_REASONS: SessionInputReason[] = [
  "dialog",
  "no_composer",
  "refused",
  "no_terminal",
  "not_submitted",
  "enter_failed",
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

  // 何を保証するか: この webui が知らない outcome は、届いたか判断できないので
  // 文を残す側 (unconfirmed) に倒す。消す側に倒すと文を失いうる。
  test("leans an unknown outcome to unconfirmed", () => {
    const reply = { ok: true, outcome: "queued" } as unknown as Parameters<
      typeof classifySessionInputReply
    >[0];
    expect(classifySessionInputReply(reply)).toEqual({ kind: "unconfirmed" });
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
      details.add(notice!.detail);
    }
    expect(details.size).toBe(ALL_REASONS.length);
  });

  // 何を保証するか: 人が次に取れる行動を reason ごとに示す (委譲元の例示:
  // dialog → ダイアログを閉じて送り直す、no_terminal → hyoui の外では送れない、
  // no_module → plugin が古い / hooks module が読まれていない)。
  test("names the next step for the reasons a person can act on", () => {
    const detail = (reason: SessionInputReason) =>
      sessionInputNotice({ kind: "not_delivered", reason })!.detail;
    expect(detail("dialog")).toContain("ダイアログを閉じてから送り直して");
    expect(detail("no_terminal")).toContain("hyoui の外");
    expect(detail("no_module")).toContain("plugin が古い");
    expect(detail("no_module")).toContain("hooks module");
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
