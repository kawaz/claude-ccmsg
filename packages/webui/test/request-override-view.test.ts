// What the webui shows of the overrides of a session's requests (DR-0041 §5)
// and what its selects offer and send (§6).
import { describe, expect, test } from "bun:test";
import type { RequestOverrideState, SessionContextUsage } from "@ccmsg/protocol";
import {
  choicePatch,
  chosenOption,
  CURRENT_KEY,
  type OverrideGroup,
  overrideGroups,
  requestOverrideNotice,
  requestValueViews,
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

/** A select's groups as their labels and their options' labels. */
const shownGroups = (groups: readonly OverrideGroup[]) =>
  groups.map((group) => [group.label, group.options.map((option) => option.label)]);

// DR-0041 §6.1, §6.2: one select per field, its groups default / turn /
// session, each value marked with what it is.
describe("the selects", () => {
  /** A fable / low session (the example of §6.2). */
  const FABLE_LOW: SessionContextUsage = { ...CTX, model: "claude-fable-5-1", effort: "low" };
  const FAB = { turn: true, shorten: shortModel };
  const STATUS = { turn: false, shorten: shortModel };

  test("the FAB's effort, no override: §6.2's example", () => {
    expect(shownGroups(overrideGroups("effort", undefined, FABLE_LOW, FAB))).toEqual([
      ["default", ["low"]],
      ["turn", ["⏱️low", "⏱️medium", "⏱️high", "⏱️xhigh", "⏱️max"]],
      ["session", ["🏛️low", "📌medium", "📌high", "📌xhigh", "📌max"]],
    ]);
  });

  test("the Status tab's: no turn group; the model's 🏛️ is the family of the session's model ID", () => {
    const own = { session: { model: "claude-fable-5-1[1m]", effort: "low" }, once: NONE };
    expect(shownGroups(overrideGroups("model", own, FABLE_LOW, STATUS))).toEqual([
      ["default", ["fable-5-1"]],
      ["session", ["🏛️fable", "📌opus", "📌sonnet", "📌haiku"]],
    ]);
    expect(shownGroups(overrideGroups("effort", own, FABLE_LOW, STATUS))).toEqual([
      ["default", ["low"]],
      ["session", ["🏛️low", "📌medium", "📌high", "📌xhigh", "📌max"]],
    ]);
  });

  test("the default shows the layer in force and its value", () => {
    const label = (state: RequestOverrideState, field: "model" | "effort" = "effort") =>
      overrideGroups(field, state, FABLE_LOW, STATUS)[0]?.options[0]?.label;
    expect(label({ session: { model: "fable", effort: "high" }, once: NONE })).toBe("📌high");
    expect(
      label({ session: { model: "fable", effort: "high" }, once: { ...NONE, effort: "max" } }),
    ).toBe("⏱️max");
    // A session override that is the session's own value is no override.
    expect(label({ session: { model: "fable", effort: "low" }, once: NONE })).toBe("low");
    expect(label({ session: { model: "sonnet", effort: "low" }, once: NONE }, "model")).toBe(
      "📌sonnet",
    );
    expect(label({ session: { model: "fable", effort: "low" }, once: NONE }, "model")).toBe(
      "fable-5-1",
    );
    expect(
      label(
        { session: { model: "fable", effort: "low" }, once: { model: "haiku", effort: null } },
        "model",
      ),
    ).toBe("⏱️haiku");
  });

  // §6.1 (kawaz 2026-10-28): a session's own value outside the vocabulary
  // has no 🏛️ to stand for it, so every value is offered with 📌.
  test("a session's own value outside the vocabulary: no 🏛️, every value 📌", () => {
    const other = { ...CTX, model: "gpt-9", effort: "minimal" };
    expect(shownGroups(overrideGroups("model", undefined, other, STATUS))[1]).toEqual([
      "session",
      ["📌fable", "📌opus", "📌sonnet", "📌haiku"],
    ]);
    expect(shownGroups(overrideGroups("effort", undefined, other, STATUS))[1]).toEqual([
      "session",
      ["📌low", "📌medium", "📌high", "📌xhigh", "📌max"],
    ]);
    const { effort: _, ...noEffort } = CTX;
    expect(shownGroups(overrideGroups("effort", undefined, noEffort, STATUS))).toEqual([
      ["default", ["—"]],
      ["session", ["📌low", "📌medium", "📌high", "📌xhigh", "📌max"]],
    ]);
    expect(shownGroups(overrideGroups("effort", undefined, undefined, STATUS))[1]).toEqual([
      "session",
      ["📌low", "📌medium", "📌high", "📌xhigh", "📌max"],
    ]);
  });

  test("what each choice sends: ⏱️ with the prompt, 📌 the value, 🏛️ null; the default nothing", () => {
    const groups = overrideGroups("effort", undefined, FABLE_LOW, FAB);
    const choice = (key: string) => chosenOption(groups, key).choice;
    expect(choice(CURRENT_KEY)).toEqual({ kind: "current" });
    expect(choice("once:high")).toEqual({ kind: "once", override: { effort: "high" } });
    expect(choice("session:high")).toEqual({ kind: "session", patch: { effort: "high" } });
    expect(choice("engine")).toEqual({ kind: "engine", patch: { effort: null } });
    expect(choicePatch(choice(CURRENT_KEY))).toBeNull();
    expect(choicePatch(choice("once:high"))).toBeNull();
    expect(choicePatch(choice("session:high"))).toEqual({ effort: "high" });
    expect(choicePatch(choice("engine"))).toEqual({ effort: null });
    expect(
      chosenOption(overrideGroups("model", undefined, FABLE_LOW, STATUS), "engine").choice,
    ).toEqual({ kind: "engine", patch: { model: null } });
    // A key the options no longer have (the session's own value moved under
    // the choice) is the default.
    expect(chosenOption(groups, "session:low")).toMatchObject({ key: CURRENT_KEY, label: "low" });
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
});
