// Where a version shown in the webui opens (DR-0048 §5): its entry's anchor in
// the CHANGELOG on GitHub. Claude Code's is the one GitHub gives the heading
// (`## 2.1.318` is `#21318`, seen on its page 2026-11-06); ccmsg's is the
// explicit `<a id="v<version>">` on the heading line, so it keeps the dots.
import { describe, expect, test } from "bun:test";
import {
  ccmsgChangelogUrl,
  claudeCodeChangelogUrl,
  githubHeadingAnchor,
} from "../src/client/changelog-url.ts";

describe("githubHeadingAnchor", () => {
  test("drops the dots of a version", () => {
    expect(githubHeadingAnchor("2.1.318")).toBe("21318");
  });

  // GitHub's rule: lowercase, punctuation other than `-` and `_` dropped,
  // each space a `-` (so ` - ` is `---`).
  test("lowercases, keeps - and _, and turns spaces into -", () => {
    expect(githubHeadingAnchor("V1.0.0-RC.1")).toBe("v100-rc1");
    expect(githubHeadingAnchor("[1.0.0] - 2017-06-20")).toBe("100---2017-06-20");
    expect(githubHeadingAnchor("a_b c")).toBe("a_b-c");
  });
});

describe("ccmsgChangelogUrl", () => {
  test("is ccmsg's CHANGELOG at the version's explicit anchor, dots kept", () => {
    expect(ccmsgChangelogUrl("0.215.0")).toBe(
      "https://github.com/kawaz/claude-ccmsg/blob/main/CHANGELOG.md#v0.215.0",
    );
  });

  // A version string is from outside the page (the daemon): whatever it holds
  // stays inside the fragment.
  test("keeps an odd version inside the fragment", () => {
    expect(ccmsgChangelogUrl("0.215.0 ä/?#x")).toBe(
      "https://github.com/kawaz/claude-ccmsg/blob/main/CHANGELOG.md#v0.215.0%20%C3%A4%2F%3F%23x",
    );
  });
});

describe("claudeCodeChangelogUrl", () => {
  test("is Claude Code's CHANGELOG at the version's `## <version>` heading", () => {
    expect(claudeCodeChangelogUrl("2.1.318")).toBe(
      "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21318",
    );
  });

  // A version string is from outside the page (the process row): whatever it
  // holds stays inside the fragment.
  test("keeps an odd version inside the fragment", () => {
    expect(claudeCodeChangelogUrl("2.1.318 (Claude Code)")).toBe(
      "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21318-claude-code",
    );
    expect(claudeCodeChangelogUrl("ä/?#x")).toBe(
      "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#%C3%A4x",
    );
  });
});
