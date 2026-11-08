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

describe("permit project_permissions", () => {
  // 何を保証するか: 1 要素は add か remove のどちらか 1 つで、書いた通りに読める。
  // 無い時は今までどおり読める (任意の field)。
  test("an entry is an add or a remove, and the field is optional", () => {
    expect(toolIssues(REQUEST)).toEqual({});
    const permissions = [{ add: "Bash(just deploy)" }, { remove: "Edit(/w/a.toml)" }];
    const read = parseWith(PermitToolInputSchema, { ...REQUEST, project_permissions: permissions });
    expect(read.ok && read.value.project_permissions).toEqual(permissions);
    expect(parseWith(PermitInputSchema, { ...REQUEST, project_permissions: permissions }).ok).toBe(
      true,
    );
  });

  // 何を保証するか: add と remove の両方を持つ要素、どちらも持たない要素は
  // その要素の位置で断られ、理由はどちらか 1 つと言う (黙ってどちらかに寄せない)。
  test("an entry with both, or neither, is refused at the entry", () => {
    for (const entry of [{ add: "Bash(a)", remove: "Bash(b)" }, {}, { allow: "Bash(a)" }]) {
      expect(toolIssues({ ...REQUEST, project_permissions: [entry] })).toEqual({
        "project_permissions.0": "each project permission is { add } or { remove }, one of the two",
      });
    }
  });

  // 何を保証するか: * を含む rule も読める。* がワイルドカードかコマンドの
  // 文字列の一部 (find -name \*.json) かは形で分からないので、判断は人がバブルで
  // 見てする。
  test("a rule with a * reads, whatever the * means", () => {
    for (const entry of [{ add: "Bash(find . -name \\*.json)" }, { remove: "Bash(git push:*)" }]) {
      expect(toolIssues({ ...REQUEST, project_permissions: [entry] })).toEqual({});
    }
    expect(
      parseWith(PermitInputSchema, { ...REQUEST, project_permissions: [{ add: "Bash(*)" }] }).ok,
    ).toBe(true);
  });

  // 何を保証するか: 空・空白だけのルールと、同じルールを 2 度名指すもの (add と
  // remove に分けても) は断られる (1 つのルールにボタンは 1 つ)。
  test("an empty rule and a rule named twice are refused", () => {
    expect(toolIssues({ ...REQUEST, project_permissions: [{ add: " " }] })).not.toEqual({});
    expect(
      toolIssues({
        ...REQUEST,
        project_permissions: [{ add: "Bash(a)" }, { remove: "Bash(a)" }],
      }),
    ).toEqual({ project_permissions: "each project permission rule is named once" });
  });

  // 何を保証するか: project_permissions だけの依頼も読める (毎回止められる操作の
  // allow を足すことだけを求める依頼)。何も求めない依頼は今までどおり断られる。
  test("project permissions alone are a request, and nothing at all is not", () => {
    const alone = { blocked: "x", project_permissions: [{ add: "Bash(a)" }] };
    expect(parseWith(PermitToolInputSchema, alone).ok).toBe(true);
    expect(parseWith(PermitInputSchema, alone).ok).toBe(true);
    expect(toolIssues({ blocked: "x", project_permissions: [] })).toEqual({
      "": "ask for at least one of intents and commands, or project_permissions",
    });
  });
});
