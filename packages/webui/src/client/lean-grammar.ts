// Lean 4: shiki に同梱の文法 (shiki/langs/lean.mjs) を、属性の 2 つの規則だけ
// 差し替えて使う。
//
// Design rationale: 上流の属性の規則 (`@[...]` と `attribute [...]`) は
// `\[[^]\s]*` で、最初の空白で切れる。そのため `@[simp, inline]`・
// `attribute [local simp] …`・行をまたぐ属性は、`@` と最初の語にしか属性の色が
// 付かず、`[` と残りは素の色になる。文法を写して持たずに、その 2 つだけを
// 閉じ括弧までを 1 つの属性として取る規則 (行をまたげるよう begin / end) に
// 置き換え、他の規則 (キーワード・コメント・文字列・宣言の名前) は上流のものを
// そのまま使う。置き換える先は今の正規表現で探し、見つからなければ (shiki の
// 更新で文法が変わった時) 文法をそのまま返す。その時は test/lean-grammar.test.ts
// の属性のテストが落ちる。
import type { LanguageRegistration } from "shiki/core";

type Rule = LanguageRegistration["patterns"][number];

/** 上流の属性の規則の `match` と、置き換える規則。scope は上流と同じ。 */
const REPLACEMENTS: ReadonlyMap<string, Rule> = new Map([
  [
    "(@)(?:(\\[[^]\\s]*])|\\[([^]\\s]*))",
    { begin: "@\\[", end: "]", name: "storage.modifier.lean4" },
  ],
  [
    "\\b(attribute\\b\\s*)(?:(\\[[^]\\s]*])|\\[([^]\\s]*))",
    { begin: "\\battribute\\b\\s*\\[", end: "]", name: "storage.modifier.lean4" },
  ],
]);

function replacementOf(rule: Rule): Rule | undefined {
  return typeof rule.match === "string" ? REPLACEMENTS.get(rule.match) : undefined;
}

/** 属性の 2 つの規則を、閉じ括弧までを 1 つの属性として取る規則に置き換えた
 * 文法。2 つとも 1 回ずつ見つからなければ、渡された文法をそのまま返す。 */
export function withWholeAttributes(grammars: LanguageRegistration[]): LanguageRegistration[] {
  return grammars.map((grammar) => {
    const found = grammar.patterns.filter((rule) => replacementOf(rule) !== undefined);
    const distinct = new Set(found.map((rule) => rule.match));
    if (found.length !== REPLACEMENTS.size || distinct.size !== REPLACEMENTS.size) return grammar;
    return {
      ...grammar,
      patterns: grammar.patterns.map((rule) => replacementOf(rule) ?? rule),
    };
  });
}

/** highlight.ts の GRAMMARS から呼ぶ。文法は他の言語と同じく、初めて使う時に
 * 別の chunk として読み込む。 */
export async function loadLeanGrammar(): Promise<LanguageRegistration[]> {
  return withWholeAttributes((await import("shiki/langs/lean.mjs")).default);
}
