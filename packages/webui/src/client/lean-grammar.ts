// Lean 4: shiki に同梱の文法 (shiki/langs/lean.mjs) を、属性の 2 つの規則と
// 行コメントの規則だけ差し替えて使う。
//
// Design rationale: 文法を写して持たずに、崩れる規則だけを置き換え、他の規則
// (キーワード・ブロックコメント・文字列・宣言の名前) は上流のものをそのまま使う。
// 置き換える先は今の中身で探し、見つからなければ (shiki の更新で文法が変わった
// 時) その規則は置き換えない。その時は test/lean-grammar.test.ts の属性や行
// コメントのテストが落ちる。崩れる規則は次の 2 つ。
// - 属性 (`@[...]` と `attribute [...]`): 上流の規則は `\[[^]\s]*` で、最初の
//   空白で切れる。そのため `@[simp, inline]`・`attribute [local simp] …`・行を
//   またぐ属性は、`@` と最初の語にしか属性の色が付かず、`[` と残りは素の色に
//   なる。閉じ括弧までを 1 つの属性として取る規則 (行をまたげるよう begin /
//   end) に置き換える。
// - 行コメント (`-- …`、repository の `dashComment`): 上流の規則は中身の規則に
//   `source.lean4.markdown` の include だけを持つが、その文法は shiki に同梱
//   されていない。vscode-textmate は、解決できない include しか持たない begin /
//   end の規則を丸ごと捨てるので (RuleFactory._compilePatterns の skipRule)、
//   `--` が行コメントにならない。ドキュメントコメント `/-- … -/` は中身に
//   `#blockComment` も持つので捨てられず、残る。行コメントは中身の規則を持たない
//   同じ begin / end・同じ scope の規則に置き換える。
import type { LanguageRegistration } from "shiki/core";

type Rule = LanguageRegistration["patterns"][number];

/** 上流の属性の規則の `match` と、置き換える規則。scope は上流と同じ。 */
const ATTRIBUTE_REPLACEMENTS: ReadonlyMap<string, Rule> = new Map([
  [
    "(@)(?:(\\[[^]\\s]*])|\\[([^]\\s]*))",
    { begin: "@\\[", end: "]", name: "storage.modifier.lean4" },
  ],
  [
    "\\b(attribute\\b\\s*)(?:(\\[[^]\\s]*])|\\[([^]\\s]*))",
    { begin: "\\battribute\\b\\s*\\[", end: "]", name: "storage.modifier.lean4" },
  ],
]);

const DASH_COMMENT = "dashComment";
const DASH_COMMENT_SCOPE = "comment.line.double-dash.lean4";
/** shiki に同梱されていない、上流の行コメントが中身に持つ文法。 */
const MISSING_EMBEDDED = "source.lean4.markdown";

function attributeReplacementOf(rule: Rule): Rule | undefined {
  return typeof rule.match === "string" ? ATTRIBUTE_REPLACEMENTS.get(rule.match) : undefined;
}

/** 属性の 2 つの規則を置き換えた patterns。2 つとも 1 回ずつ見つからなければ
 * 渡された patterns をそのまま返す。 */
function withWholeAttributes(patterns: Rule[]): Rule[] {
  const found = patterns.filter((rule) => attributeReplacementOf(rule) !== undefined);
  const distinct = new Set(found.map((rule) => rule.match));
  if (found.length !== ATTRIBUTE_REPLACEMENTS.size || distinct.size !== ATTRIBUTE_REPLACEMENTS.size)
    return patterns;
  return patterns.map((rule) => attributeReplacementOf(rule) ?? rule);
}

/** 中身に同梱されていない文法の include だけを持つ行コメントの規則を、中身の
 * 規則の無い規則に置き換えた repository。その形の規則が無ければ渡された
 * repository をそのまま返す。 */
function withDashComment(
  repository: LanguageRegistration["repository"],
): LanguageRegistration["repository"] {
  const rule = repository[DASH_COMMENT];
  if (
    rule === undefined ||
    rule.begin !== "--" ||
    rule.end !== "$" ||
    rule.name !== DASH_COMMENT_SCOPE ||
    rule.patterns?.length !== 1 ||
    rule.patterns[0]?.include !== MISSING_EMBEDDED
  )
    return repository;
  const fixed: LanguageRegistration["repository"] = { ...repository };
  fixed[DASH_COMMENT] = { begin: "--", end: "$", name: DASH_COMMENT_SCOPE };
  return fixed;
}

/** 属性の 2 つの規則と行コメントの規則を直した文法。置き換える先が見つからない
 * 規則は置き換えない。 */
export function withLeanFixes(grammars: LanguageRegistration[]): LanguageRegistration[] {
  return grammars.map((grammar) => {
    const patterns = withWholeAttributes(grammar.patterns);
    const repository = withDashComment(grammar.repository);
    if (patterns === grammar.patterns && repository === grammar.repository) return grammar;
    return { ...grammar, patterns, repository };
  });
}

/** highlight.ts の GRAMMARS から呼ぶ。文法は他の言語と同じく、初めて使う時に
 * 別の chunk として読み込む。 */
export async function loadLeanGrammar(): Promise<LanguageRegistration[]> {
  return withLeanFixes((await import("shiki/langs/lean.mjs")).default);
}
