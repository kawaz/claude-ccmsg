// The one word an agent's response body is when it has nothing to tell the
// person (DR-0062 §5).
// 何を保証するか:
//   - この 1 語 (NOTHING_TO_REPLY_TEXT) は、ccmsg の skill がエージェントに書かせる語と同じ
//     (webui はこの語で応答を畳むので、skill だけ変わると畳まれなくなる)
import { describe, expect, test } from "bun:test";
import { NOTHING_TO_REPLY_TEXT } from "../src/nothing-to-reply.ts";

describe("the word a response with nothing to tell is", () => {
  test("is nothing_to_reply, the one the ccmsg skill tells the agent to write", async () => {
    expect(NOTHING_TO_REPLY_TEXT).toBe("nothing_to_reply");
    const skill = await Bun.file(new URL("../../../skills/ccmsg/SKILL.md", import.meta.url)).text();
    expect(skill).toContain(`\`${NOTHING_TO_REPLY_TEXT}\``);
  });
});
