// The `permit` tool's input and what `ccmsg sidecar permit` takes (DR-0040
// §2, §6): `voice`, the call the speakers say, goes from the tool to the
// daemon's record.
import { describe, expect, test } from "bun:test";
import { parseWith } from "../src/parse.ts";
import {
  PERMIT_VOICE_MAX_LENGTH,
  PermitInputSchema,
  PermitToolInputSchema,
} from "../src/permit-request.ts";

const REQUEST = { blocked: "`git push` が止められた", commands: [{ command: "git push" }] };

/** The reasons `value` does not read as the tool's input, by field path;
 * empty when it reads. */
function toolIssues(value: object): Record<string, string> {
  const read = parseWith(PermitToolInputSchema, value);
  if (read.ok) return {};
  return Object.fromEntries(read.failure.issues.map((issue) => [issue.path, issue.message]));
}

describe("permit voice", () => {
  // 何を保証するか: voice は任意で、上限ちょうどまでの文は読める。
  test("a request reads without a voice, and with one up to the limit", () => {
    expect(toolIssues(REQUEST)).toEqual({});
    expect(toolIssues({ ...REQUEST, voice: "push してもいいですか" })).toEqual({});
    expect(toolIssues({ ...REQUEST, voice: "あ".repeat(PERMIT_VOICE_MAX_LENGTH) })).toEqual({});
  });

  // 何を保証するか: 空・空白だけ・上限超えの voice は voice の field で断られ、
  // 言い直せる理由が付く (固定文に黙って落とさない)。
  test("an empty, a whitespace-only and a too long voice are refused on voice", () => {
    for (const voice of ["", "  ", "あ".repeat(PERMIT_VOICE_MAX_LENGTH + 1)]) {
      const issues = toolIssues({ ...REQUEST, voice });
      expect(Object.keys(issues)).toEqual(["voice"]);
    }
    expect(toolIssues({ ...REQUEST, voice: "あ".repeat(PERMIT_VOICE_MAX_LENGTH + 1) })).toEqual({
      voice: `voice is a short call of at most ${PERMIT_VOICE_MAX_LENGTH} characters`,
    });
  });

  // 何を保証するか: voice は sidecar permit の入力 (daemon が記録するもの) に
  // そのまま通り、tool の入力と同じ規則で断られる。
  test("ccmsg sidecar permit's input takes a voice, under the same rules", () => {
    expect(parseWith(PermitInputSchema, { ...REQUEST, voice: "プッシュしてもいいですか" }).ok).toBe(
      true,
    );
    expect(parseWith(PermitInputSchema, { ...REQUEST, voice: "" }).ok).toBe(false);
    expect(
      parseWith(PermitInputSchema, { ...REQUEST, voice: "あ".repeat(PERMIT_VOICE_MAX_LENGTH + 1) })
        .ok,
    ).toBe(false);
  });
});
