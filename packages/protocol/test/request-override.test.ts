// The override of a session's requests (DR-0041): which value a request is
// sent with, and how an overridden family names its model.
import { describe, expect, test } from "bun:test";
import { parseWith } from "../src/parse.ts";
import {
  overrideInForce,
  overrideModel,
  overridesAnything,
  patchOverride,
  RequestOverrideSchema,
} from "../src/request-override.ts";

describe("RequestOverrideSchema", () => {
  test("the launch's models and efforts, each one optional", () => {
    for (const value of [
      {},
      { model: "haiku" },
      { effort: "xhigh" },
      { model: "fable", effort: "low" },
    ] as const) {
      expect(parseWith(RequestOverrideSchema, value)).toEqual({ ok: true, value });
    }
    for (const value of [
      { model: "claude-opus-5-5" },
      { model: "opus[1m]" },
      { effort: "minimal" },
      { effort: 32_000 },
      { model: null },
    ]) {
      expect(parseWith(RequestOverrideSchema, value).ok).toBe(false);
    }
  });
});

describe("overrideModel", () => {
  // The engine resolves the alias; the module only keeps the context window.
  test("the family's alias, with the request's own [1m] kept", () => {
    expect(overrideModel("claude-opus-5-5[1m]", "sonnet")).toBe("sonnet[1m]");
    expect(overrideModel("claude-opus-5-5", "sonnet")).toBe("sonnet");
    expect(overrideModel("claude-haiku-5-5", "fable")).toBe("fable");
    expect(overrideModel(undefined, "haiku")).toBe("haiku");
  });
});

describe("overrideInForce", () => {
  test("per field: the one-shot override, else the session override", () => {
    expect(overrideInForce({ session: {} })).toEqual({});
    expect(overrideInForce({ session: { model: "opus", effort: "high" } })).toEqual({
      model: "opus",
      effort: "high",
    });
    expect(
      overrideInForce({ session: { model: "opus", effort: "high" }, once: { effort: "low" } }),
    ).toEqual({ model: "opus", effort: "low" });
    expect(overrideInForce({ session: {}, once: { model: "haiku" } })).toEqual({ model: "haiku" });
  });

  test("patchOverride: absent keeps, null clears, a value sets", () => {
    expect(patchOverride({ model: "opus", effort: "low" }, {})).toEqual({
      model: "opus",
      effort: "low",
    });
    expect(patchOverride({ model: "opus", effort: "low" }, { effort: null })).toEqual({
      model: "opus",
    });
    expect(patchOverride({}, { model: "haiku", effort: "max" })).toEqual({
      model: "haiku",
      effort: "max",
    });
  });

  test("overridesAnything: a field set", () => {
    expect(overridesAnything({})).toBe(false);
    expect(overridesAnything({ effort: "low" })).toBe(true);
    expect(overridesAnything({ model: "opus" })).toBe(true);
  });
});
