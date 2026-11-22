// Whether what a person sent has landed in the session's transcript as their
// prompt: the sent text against the prompts the transcript holds, each prompt
// taken by one send at most (DR-0035 §5). Pure, so whoever holds the sends
// (the webui's composer, for one) pairs them the same way.

/** A text with the time it was sent, or the time its transcript row was
 * written (ISO-8601). */
export interface TimedText {
  readonly text: string;
  readonly at: string;
}

/** Whether `written`, a prompt as the transcript holds it, is `sent`. The
 * harness drops trailing whitespace from a prompt before writing it (measured
 * with a trailing newline, spaces, a tab and an ideographic space: the set
 * `trimEnd` removes); leading whitespace and blank lines and tabs inside reach
 * it as sent. The same allowance as the hooks module's check of what it filled
 * (`samePrompt` in hooks/prompt-send.ts), nothing more. */
export function sameLandedText(sent: string, written: string): boolean {
  return written === sent || written === sent.trimEnd();
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
