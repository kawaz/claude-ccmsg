// What the webui shows of the overrides of a session's requests and what its
// pickers send (DR-0041 §5).
import { describe, expect, test } from "bun:test";
import type { RequestOverrideState, SessionContextUsage } from "@ccmsg/protocol";
import {
  onceOverride,
  overridePatch,
  overrideText,
  requestOverrideNotice,
  requestValueViews,
  sessionPickerValue,
  withPicked,
} from "../src/client/request-override-view.ts";
import {
  formatContextUsage,
  miniSummaryLines,
  shortModel,
} from "../src/client/session-status-view.ts";

const CTX: SessionContextUsage = {
  tokens: 100_000,
  window: 1_000_000,
  model: "claude-opus-5-5",
  effort: "high",
  timestamp: "t",
};
const NONE = { model: null, effort: null };
/** The state a module reports with nothing set: the session's own values. */
const OWN: RequestOverrideState = {
  session: { model: "claude-opus-5-5[1m]", effort: "high" },
  once: NONE,
};

describe("requestValueViews", () => {
  test("without an override: the session's own, shortened, unmarked", () => {
    const own = {
      model: { text: "opus-5-5", title: "model claude-opus-5-5" },
      effort: { text: "high", title: "effort high" },
    };
    expect(requestValueViews(CTX, undefined, shortModel)).toEqual(own);
    expect(requestValueViews(CTX, OWN, shortModel)).toEqual(own);
  });

  test("a value other than the session's own is marked and says which override", () => {
    const views = requestValueViews(
      CTX,
      { session: { model: "sonnet", effort: "low" }, once: { model: null, effort: "max" } },
      shortModel,
    );
    expect(views.model).toEqual({
      text: "sonnet⁺",
      by: "session",
      title: "model sonnet (通しの上書き。セッション自身は claude-opus-5-5)",
    });
    expect(views.effort).toEqual({
      text: "max⁺",
      by: "once",
      title: "effort max (単発の上書き。セッション自身は high)",
    });
  });

  // The mark says the requests run on other than the session's own.
  test("an override that names the session's own value is not marked", () => {
    expect(
      requestValueViews(
        CTX,
        { session: { model: "opus", effort: "high" }, once: NONE },
        shortModel,
      ),
    ).toEqual(requestValueViews(CTX, undefined, shortModel));
  });

  test("an effort only an override names, for a session that names none", () => {
    const { effort: _own, ...noEffort } = CTX;
    expect(requestValueViews(noEffort, undefined, shortModel).effort).toBeNull();
    expect(
      requestValueViews(
        noEffort,
        { session: { model: null, effort: "low" }, once: NONE },
        shortModel,
      ).effort,
    ).toEqual({
      text: "low⁺",
      by: "session",
      title: "effort low (通しの上書き。セッション自身の値はまだ分からない)",
    });
  });

  test("the ctx line and its title carry the values the requests are sent with", () => {
    const formatted = formatContextUsage(CTX, {
      session: { model: CTX.model, effort: "low" },
      once: NONE,
    });
    expect(formatted.text).toBe("10%[1m] / opus-5-5 / low⁺");
    expect(formatted.title).toContain("effort low (通しの上書き。セッション自身は high)");
    const [line] = miniSummaryLines(
      { todos: [], workflows: [], background: [], context: CTX },
      [],
      { ...OWN, once: { model: "haiku", effort: null } },
    );
    expect(line?.text).toBe("10%[1m] / haiku⁺ / high");
    expect(line?.context?.model.by).toBe("once");
  });
});

describe("the pickers", () => {
  test("the session pickers show the fields set to other than the session's own", () => {
    expect(sessionPickerValue(OWN, CTX)).toEqual({});
    expect(sessionPickerValue(undefined, CTX)).toEqual({});
    expect(
      sessionPickerValue({ session: { model: "sonnet", effort: "high" }, once: NONE }, CTX),
    ).toEqual({ model: "sonnet" });
    expect(
      sessionPickerValue({ session: { model: CTX.model, effort: "low" }, once: NONE }, CTX),
    ).toEqual({ effort: "low" });
    expect(onceOverride({ ...OWN, once: { model: "haiku", effort: null } })).toEqual({
      model: "haiku",
    });
    expect(onceOverride(undefined)).toEqual({});
  });

  test("a pick sets or clears one field and keeps the other", () => {
    expect(withPicked({}, "effort", "low")).toEqual({ effort: "low" });
    expect(withPicked({ effort: "low" }, "model", "fable")).toEqual({
      model: "fable",
      effort: "low",
    });
    expect(withPicked({ model: "fable", effort: "low" }, "effort", "")).toEqual({ model: "fable" });
    // Outside the vocabulary is no override of that field.
    expect(withPicked({ model: "fable" }, "model", "gpt")).toEqual({});
  });

  test("the patch: one field's value, or null to clear", () => {
    expect(overridePatch("model", "sonnet")).toEqual({ model: "sonnet" });
    expect(overridePatch("model", "")).toEqual({ model: null });
    expect(overridePatch("effort", "xhigh")).toEqual({ effort: "xhigh" });
    expect(overridePatch("effort", "")).toEqual({ effort: null });
  });

  test("what a reply says: nothing when applied, else what became of it", () => {
    expect(requestOverrideNotice({ ok: true, delivery: "applied" })).toBeNull();
    expect(requestOverrideNotice({ ok: true, delivery: "no_module" })).toContain(
      "受け口 (hooks module) が無い",
    );
    expect(requestOverrideNotice({ ok: true, delivery: "unconfirmed" })).toContain(
      "確認できていない",
    );
    expect(
      requestOverrideNotice({ ok: false, error: { code: "invalid_args", msg: "effort: x" } }),
    ).toBe("変更できなかった (invalid_args): effort: x");
  });

  test("the values as a line", () => {
    expect(overrideText({})).toBe("なし");
    expect(overrideText({ model: "opus", effort: "low" })).toBe("model opus · effort low");
  });
});
