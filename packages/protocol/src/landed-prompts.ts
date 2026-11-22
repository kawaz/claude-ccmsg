// Whether what a person sent has landed in the session's transcript as their
// prompt: the sent text against the prompts the transcript holds, each prompt
// taken by one send at most (DR-0035 §5). Pure, so whoever holds the sends
// (the webui's composer, for one) pairs them the same way. Imported by the
// hooks module (its bundle takes this file in), so it imports nothing.

/** A text with the time it was sent, or the time its transcript row was
 * written (ISO-8601). */
export interface TimedText {
  readonly text: string;
  readonly at: string;
}

/** A person's prompt as it goes into the composer (DR-0035 §1): when its
 * first character past the leading whitespace is `/`, that `/` and the ASCII
 * word characters right after it (`/rename`, `/` alone) are put in
 * backquotes, so Claude Code takes the text as a prompt rather than a slash
 * command (`/rename red` goes in as "`/rename` red"). The composer reads a
 * text whose first character past the whitespace is `/` as a command, with
 * no way to have it typed as text (measured on 2.1.330). Anything else is
 * left as it is, the whitespace included. */
export function quoteLeadingSlash(text: string): string {
  return text.replace(/^(\s*)(\/\w*)/, "$1`$2`");
}

/** A prompt's text as it is compared: without the whitespace at its two
 * ends. The harness drops it when it takes a prompt (measured on 2.1.330 with
 * user_prompt: a prompt entered while the session waits loses the trailing
 * whitespace and newlines, one entered during a turn loses the leading
 * whitespace too); blank lines, tabs and the whitespace that starts a line
 * inside reach it as sent, and a long prompt is not folded. A leading slash is
 * quoted as it goes in (quoteLeadingSlash), so a text as the person wrote it
 * and as it landed compare the same. The one normalization of a person's
 * prompt, for what the hooks module filled (`samePrompt` in
 * hooks/prompt-send.ts) as for what landed in a transcript. */
export function promptTextKey(text: string): string {
  return quoteLeadingSlash(text.trim());
}

/** Whether `written`, a prompt as the harness took it, is `sent`. */
export function sameLandedText(sent: string, written: string): boolean {
  return promptTextKey(sent) === promptTextKey(written);
}

/** The sends of `sent` that landed, each with the prompt of `landed` it landed
 * as. A prompt lands a send when its text is the send's (sameLandedText) and
 * it was written at or after the send. Each prompt is taken by one send: the
 * oldest send first takes the earliest prompt it can, so the same text sent
 * twice is landed once per prompt. Times that do not read land nothing. */
export function pairLandedPrompts<S extends TimedText, L extends TimedText>(
  sent: readonly S[],
  landed: readonly L[],
): { sent: S; landed: L }[] {
  const prompts = landed
    .map((prompt) => ({ prompt, at: Date.parse(prompt.at) }))
    .filter(({ at }) => Number.isFinite(at))
    .sort((a, b) => a.at - b.at);
  const taken = new Set<number>();
  const sends = sent
    .map((send) => ({ send, at: Date.parse(send.at) }))
    .filter(({ at }) => Number.isFinite(at))
    .sort((a, b) => a.at - b.at);
  const pairs: { sent: S; landed: L }[] = [];
  for (const { send, at } of sends) {
    const index = prompts.findIndex(
      (p, i) => !taken.has(i) && p.at >= at && sameLandedText(send.text, p.prompt.text),
    );
    const found = prompts[index];
    if (found === undefined) continue;
    taken.add(index);
    pairs.push({ sent: send, landed: found.prompt });
  }
  return pairs;
}
