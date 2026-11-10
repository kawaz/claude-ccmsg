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
  requestValueTexts,
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
  engine: { model: "claude-opus-5-5[1m]", effort: "high" },
};
const NONE = { model: null, effort: null };
/** The state a module reports with nothing set: the session's own values. */
const OWN: RequestOverrideState = {
  session: { model: "claude-opus-5-5[1m]", effort: "high" },
  once: NONE,
};

// The ctx line's model and effort are the text their selects show at rest, as
// the Status tab's MODEL / EFFORT are: one label, nothing added to it.
describe("requestValueTexts", () => {
  const restLabel = (
    field: "model" | "effort",
    ctx: SessionContextUsage,
    state: RequestOverrideState | undefined,
  ) =>
    overrideGroups(field, state, ctx, { turn: false, shorten: shortModel })[0]?.options[0]?.label;

  test("without an override: the session's own, shortened", () => {
    const own = { model: "opus-5-5[1m]", effort: "high" };
    expect(requestValueTexts(CTX, undefined, shortModel)).toEqual(own);
    expect(requestValueTexts(CTX, OWN, shortModel)).toEqual(own);
  });

  test("a value other than the session's own carries the mark of its override, as the select's label does", () => {
    const state: RequestOverrideState = {
      session: { model: "sonnet", effort: "low" },
      once: { model: null, effort: "max" },
    };
    const texts = requestValueTexts(CTX, state, shortModel);
    expect(texts).toEqual({ model: "📌sonnet[1m]", effort: "⏱️max" });
    expect(restLabel("model", CTX, state)).toBe(texts.model);
    expect(restLabel("effort", CTX, state)).toBe("⏱️max");
  });

  test("an override that names the session's own value reads as no override", () => {
    expect(
      requestValueTexts(
        CTX,
        { session: { model: "opus", effort: "high" }, once: NONE },
        shortModel,
      ),
    ).toEqual(requestValueTexts(CTX, undefined, shortModel));
  });

  test("an effort only an override names, for a session that names none", () => {
    const { effort: _own, ...ran } = CTX;
    const noEffort = { ...ran, engine: { model: "claude-opus-5-5[1m]" } };
    expect(requestValueTexts(noEffort, undefined, shortModel).effort).toBeNull();
    expect(
      requestValueTexts(
        noEffort,
        { session: { model: null, effort: "low" }, once: NONE },
        shortModel,
      ).effort,
    ).toBe("📌low");
  });

  test("without the module's facts: what the requests ran on", () => {
    const { engine: _engine, ...bare } = CTX;
    expect(requestValueTexts(bare, undefined, shortModel)).toEqual({
      model: "opus-5-5[1m]",
      effort: "high",
    });
  });

  // The session names itself by an alias with no version (`fable[1m]`); the
  // model that answered is the same model with its version, so that is shown.
  test("the session's own model is the ID that answered, not the alias it was started with", () => {
    const aliased = {
      ...CTX,
      model: "claude-fable-5-2",
      engine: { model: "fable[1m]", effort: "high" },
    };
    expect(requestValueTexts(aliased, undefined, shortModel).model).toBe("fable-5-2[1m]");
    expect(restLabel("model", aliased, undefined)).toBe("fable-5-2[1m]");
  });

  // After /model, or under a model override, the last answer is another
  // model's: the session's own is then only known by the name it goes by.
  test("where the last answer was another model's, the session's own is the name it goes by", () => {
    const switched = {
      ...CTX,
      model: "claude-sonnet-5-5",
      engine: { model: "fable[1m]", effort: "high" },
    };
    expect(requestValueTexts(switched, undefined, shortModel).model).toBe("fable[1m]");
  });

  test("without a measured window the model has no brackets", () => {
    const { window: _window, engine: _engine, ...unmeasured } = CTX;
    expect(requestValueTexts(unmeasured, undefined, shortModel).model).toBe("opus-5-5");
  });

  test("the ctx line carries those texts; its hover says what the requests ran on", () => {
    const formatted = formatContextUsage(CTX, {
      session: { model: CTX.model, effort: "low" },
      once: NONE,
    });
    expect(formatted.text).toBe("10% / opus-5-5[1m] / 📌low");
    // The hover says what the requests ran on, and nothing of the override:
    // the mark in the text is what says it.
    expect(formatted.title).toBe(
      "100,000 tokens / context window 1,000,000 / model claude-opus-5-5 / effort high",
    );
    const [line] = miniSummaryLines(
      { todos: [], workflows: [], background: [], context: CTX },
      [],
      { ...OWN, once: { model: "haiku", effort: null } },
    );
    expect(line?.text).toBe("10% / ⏱️haiku[1m] / high");
    expect(line?.context?.usage?.model).toBe("⏱️haiku[1m]");
  });
});

/** A select's groups as their labels and their options' labels. */
const shownGroups = (groups: readonly OverrideGroup[]) =>
  groups.map((group) => [group.label, group.options.map((option) => option.label)]);

// DR-0041 §6.1, §6.2: one select per field, its groups default / turn /
// session, each value marked with what it is.
describe("the selects", () => {
  /** A fable / low session (the example of §6.2). */
  const FABLE_LOW: SessionContextUsage = {
    ...CTX,
    model: "claude-fable-5-1",
    effort: "low",
    engine: { model: "claude-fable-5-1", effort: "low" },
  };
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
      ["default", ["fable-5-1[1m]"]],
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
      "📌sonnet[1m]",
    );
    expect(label({ session: { model: "fable", effort: "low" }, once: NONE }, "model")).toBe(
      "fable-5-1[1m]",
    );
    expect(
      label(
        { session: { model: "fable", effort: "low" }, once: { model: "haiku", effort: null } },
        "model",
      ),
    ).toBe("⏱️haiku[1m]");
  });

  // §6.1 (kawaz 2026-10-28): a session's own value outside the vocabulary
  // has no 🏛️ to stand for it, so every value is offered with 📌.
  test("a session's own value outside the vocabulary: no 🏛️, every value 📌", () => {
    const other = { ...CTX, engine: { model: "gpt-9", effort: "minimal" } };
    expect(shownGroups(overrideGroups("model", undefined, other, STATUS))[1]).toEqual([
      "session",
      ["📌fable", "📌opus", "📌sonnet", "📌haiku"],
    ]);
    expect(shownGroups(overrideGroups("effort", undefined, other, STATUS))[1]).toEqual([
      "session",
      ["📌low", "📌medium", "📌high", "📌xhigh", "📌max"],
    ]);
    const { effort: _, ...ran } = CTX;
    const noEffort = { ...ran, engine: { model: "claude-opus-5-5[1m]" } };
    expect(shownGroups(overrideGroups("effort", undefined, noEffort, STATUS))).toEqual([
      ["default", ["—"]],
      ["session", ["📌low", "📌medium", "📌high", "📌xhigh", "📌max"]],
    ]);
    // No module's facts (no module, or one just loaded again): the session's
    // own is not known, so no 🏛️; the default shows what the requests ran on.
    const { engine: _engine, ...noFacts } = FABLE_LOW;
    expect(shownGroups(overrideGroups("effort", undefined, noFacts, STATUS))).toEqual([
      ["default", ["low"]],
      ["session", ["📌low", "📌medium", "📌high", "📌xhigh", "📌max"]],
    ]);
    expect(shownGroups(overrideGroups("effort", undefined, undefined, STATUS))[1]).toEqual([
      "session",
      ["📌low", "📌medium", "📌high", "📌xhigh", "📌max"],
    ]);
  });

  // The transcript's model is the one that answered: under 📌sonnet it is
  // sonnet, while the session's own (the engine) stays fable.
  test("after a response under an override: 🏛️ and the default stay on the session's own", () => {
    const answered = { ...FABLE_LOW, model: "claude-sonnet-5-5", effort: "max" };
    const sonnet: RequestOverrideState = {
      session: { model: "sonnet", effort: "low" },
      once: NONE,
    };
    expect(shownGroups(overrideGroups("model", sonnet, answered, STATUS))).toEqual([
      ["default", ["📌sonnet[1m]"]],
      ["session", ["🏛️fable", "📌opus", "📌sonnet", "📌haiku"]],
    ]);
    // Cleared: the default is the session's own, not the model that answered
    // last, and nothing is marked.
    const cleared: RequestOverrideState = {
      session: { model: "claude-fable-5-1", effort: "low" },
      once: NONE,
    };
    expect(overrideGroups("model", cleared, answered, STATUS)[0]?.options[0]?.label).toBe(
      "fable-5-1[1m]",
    );
    expect(overrideGroups("effort", cleared, answered, STATUS)[0]?.options[0]?.label).toBe("low");
    // The ctx line shows the same as the selects: the override's with its
    // mark, and once cleared the session's own.
    expect(requestValueTexts(answered, sonnet, shortModel).model).toBe("📌sonnet[1m]");
    expect(requestValueTexts(answered, cleared, shortModel)).toEqual({
      model: "fable-5-1[1m]",
      effort: "low",
    });
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
