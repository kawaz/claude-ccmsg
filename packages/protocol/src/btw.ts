// A btw (DR-0060): a side question or request a person puts to a session from
// the webui as a btw comment (DR-0062 §14), answered by a fork of the
// session's main conversation that the session's hooks module starts
// (`fork.ask`, sidecar.ts) and kept out of the session's own conversation.
// What the fork is asked: the prefix before the person's text.
//
// Imports nothing, as the other schema files import nothing but valibot and
// the files beside them.

/** What goes before the person's text in the btw's prompt (DR-0060 §3). The
 * fork is a subagent that starts from the session's conversation with this
 * prompt as its task, and holds the session's tools. */
export const BTW_PROMPT_PREFIX = [
  "<btw>",
  "これは btw (本体の会話の横道) です。ここまでの会話の文脈を踏まえて、下の質問・依頼に答えてください。このやりとりは本体の会話には残らず、答えは人が webui で直接読みます。",
  "- 下の質問・依頼に頼まれたことだけをする。依頼に無い本体の作業の続きはしない",
  "- 答えは親のエージェントへの報告でなく、質問した人が直接読む答えとして、質問した人の言語で書く (課題の言い直しの行や報告の見出しを付けない)",
  "- 本体は止まっていない。本体は独立に作業を続けていて、turn の途中ならまだ作業している (書きかけの分はここに見えない)",
  "- 既定では say / PushNotification / ccmsg の send・comment_reply 等で人や他のセッションに知らせず、結果は答えの本文に書く (依頼に知らせ方の指示があればそれに従う)",
  "</btw>",
].join("\n");

/** The whole prompt of a btw: the prefix, then the person's text as written. */
export function btwPrompt(text: string): string {
  return `${BTW_PROMPT_PREFIX}\n\n${text}`;
}
