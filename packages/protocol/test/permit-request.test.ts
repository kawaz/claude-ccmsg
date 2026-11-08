// The `permit` tool's input and what `ccmsg sidecar permit` takes (DR-0040
// §2, §6): `voice`, the call the speakers say, goes from the tool to the
// daemon. And a `permit` call as a reader of the transcript shows it (§4):
// the call read for what the person is shown, and its result telling whether
// a request went out.
import { describe, expect, test } from "bun:test";
import {
  ccmsgPermitCall,
  permitRequested,
  permitRequestedBy,
} from "../src/ccmsg-direct-transcript.ts";
import { parseWith } from "../src/parse.ts";
import { CCMSG_TOOLS } from "../src/peer-tools.ts";
import {
  PERMIT_REQUESTED_TEXT,
  PERMIT_VOICE_MAX_LENGTH,
  PermitInputSchema,
  PermitToolInputSchema,
} from "../src/permit-request.ts";

const VOICE = "push の許可をお願いします。";
const REQUEST_BODY = { blocked: "`git push` が止められた", commands: [{ command: "git push" }] };
const REQUEST = { ...REQUEST_BODY, voice: VOICE };

/** The reasons `value` does not read as the tool's input, by field path;
 * empty when it reads. */
function toolIssues(value: object): Record<string, string> {
  const read = parseWith(PermitToolInputSchema, value);
  if (read.ok) return {};
  return Object.fromEntries(read.failure.issues.map((issue) => [issue.path, issue.message]));
}

describe("permit voice", () => {
  // 何を保証するか: tool の入力では voice は必須で、無ければ voice の field で
  // 断られる。上限ちょうどまでの文は読める。daemon 側 (sidecar の入力) は
  // 固定文へのフォールバックのため voice 無しも読む。
  test("the tool requires a voice, up to the limit", () => {
    expect(Object.keys(toolIssues(REQUEST_BODY))).toEqual(["voice"]);
    expect(parseWith(PermitInputSchema, REQUEST_BODY).ok).toBe(true);
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

  // 何を保証するか: Edit / Read / Write の rule の path が ~/ で始まるものは
  // permissions.allow で効かないので、add でも remove でも rule の位置で断られ、
  // 絶対パスで書き直せる理由が付く。Bash の中の ~/ は通る。
  test("a file rule under ~/ is refused, a Bash command naming ~/ is not", () => {
    const reason =
      "~/ は permissions.allow では効かない。絶対パスで書く (例 Edit(/Users/<user>/.config/foo/bar.toml))";
    for (const tool of ["Edit", "Read", "Write"]) {
      expect(
        toolIssues({ ...REQUEST, project_permissions: [{ add: `${tool}(~/.config/a.toml)` }] }),
      ).toEqual({ "project_permissions.0.add": reason });
      expect(toolIssues({ ...REQUEST, project_permissions: [{ remove: `${tool}(~/a)` }] })).toEqual(
        { "project_permissions.0.remove": reason },
      );
    }
    for (const rule of ["Bash(ls ~/x)", "Edit(/Users/u/.config/a.toml)", "Edit(~a)"]) {
      expect(toolIssues({ ...REQUEST, project_permissions: [{ add: rule }] })).toEqual({});
    }
    expect(
      parseWith(PermitInputSchema, { ...REQUEST, project_permissions: [{ add: "Edit(~/a)" }] }).ok,
    ).toBe(false);
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
    const alone = { blocked: "x", voice: VOICE, project_permissions: [{ add: "Bash(a)" }] };
    expect(parseWith(PermitToolInputSchema, alone).ok).toBe(true);
    expect(parseWith(PermitInputSchema, alone).ok).toBe(true);
    expect(toolIssues({ blocked: "x", voice: VOICE, project_permissions: [] })).toEqual({
      "": "ask for at least one of intents and commands, or project_permissions",
    });
  });
});

describe("a permit call as the transcript holds it", () => {
  // 何を保証するか: permit の呼び出しは、無い list を空にして読める形に整え、
  // voice は落とす (読み上げ専用でバブルに出さない)。他の tool と、blocked の
  // 無い入力は null。
  test("reads the call for what the person is shown, the lists it left out empty", () => {
    expect(
      ccmsgPermitCall(CCMSG_TOOLS.permit, {
        blocked: "x",
        commands: [{ command: "git push", description: "公開する" }, { command: "ls" }],
        project_permissions: [{ add: "Bash(ls)" }, { remove: "Bash(old)" }],
        voice: "聞いて",
      }),
    ).toEqual({
      blocked: "x",
      attachments: [],
      intents: [],
      commands: [{ command: "git push", description: "公開する" }, { command: "ls" }],
      project_permissions: [{ add: "Bash(ls)" }, { remove: "Bash(old)" }],
    });
    expect(ccmsgPermitCall(CCMSG_TOOLS.say, { blocked: "x", intents: ["y"] })).toBeNull();
    expect(ccmsgPermitCall(CCMSG_TOOLS.permit, { intents: ["y"] })).toBeNull();
  });

  // 何を保証するか: 依頼が出たのは、結果がエラーでなく PERMIT_REQUESTED_TEXT の
  // ものだけ (text でも text の block の list でも)。断りの文・エラーの結果は
  // 依頼でない。
  test("a call made a request when its result says so, and only then", () => {
    expect(permitRequested(PERMIT_REQUESTED_TEXT, false)).toBe(true);
    expect(permitRequested(PERMIT_REQUESTED_TEXT, true)).toBe(false);
    expect(permitRequested("permit は subagent からは使えない。", false)).toBe(false);
    const block = (content: string | { type: "text"; text: string }[], is_error?: boolean) => ({
      type: "tool_result" as const,
      tool_use_id: "toolu_01",
      content,
      ...(is_error !== undefined ? { is_error } : {}),
    });
    expect(permitRequestedBy(block(PERMIT_REQUESTED_TEXT))).toBe(true);
    expect(permitRequestedBy(block([{ type: "text", text: PERMIT_REQUESTED_TEXT }]))).toBe(true);
    expect(permitRequestedBy(block(PERMIT_REQUESTED_TEXT, true))).toBe(false);
    expect(permitRequestedBy(block("許可依頼を出せなかった: x"))).toBe(false);
  });
});
