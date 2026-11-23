// The btw's footer names what its fork cost (DR-0060 §6): the input read from
// the session's prompt cache first, which says whether the fork kept the
// session's cache, then what it wrote, its input and its output.
import { describe, expect, test } from "bun:test";
import { btwUsageText } from "../src/client/components/timeline/BtwBubble.tsx";

describe("btwUsageText", () => {
  test("the counts, the cache read first, with thousands separated", () => {
    expect(
      btwUsageText({
        input_tokens: 3,
        output_tokens: 1_204,
        cache_read_input_tokens: 63_729,
        cache_creation_input_tokens: 0,
      }),
    ).toBe("cache read 63,729 / write 0 / in 3 / out 1,204");
  });

  test("none for a btw that said no usage (running, or a failure before any request)", () => {
    expect(btwUsageText(undefined)).toBeNull();
  });
});
