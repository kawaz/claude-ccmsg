// issue-ref.ts unit tests (kawaz r259 m1): the `#NNN` recognizer that
// markdown-view turns into GitHub issue links. Split from the renderer tests
// because the interesting part here is the token boundary — which shapes are a
// reference and which are a fragment / an id / a heading run.
import { describe, expect, test } from "bun:test";
import { issueRefUrl, splitTextForIssueRefs } from "../src/client/issue-ref.ts";

const REPO = "kawaz/claude-ccmsg";

/** The linked substrings, in order. */
function refs(text: string, repo: string | undefined = REPO): string[] {
  return splitTextForIssueRefs(text, repo)
    .filter((p) => p.href)
    .map((p) => p.text);
}

describe("splitTextForIssueRefs", () => {
  test("links a reference wherever a token can start", () => {
    expect(refs("see #123 for details")).toEqual(["#123"]);
    expect(refs("#1")).toEqual(["#1"]);
    expect(refs("(#12)")).toEqual(["#12"]);
    expect(refs("closes #12.")).toEqual(["#12"]);
    expect(refs("#7, #8 と #9")).toEqual(["#7", "#8", "#9"]);
    expect(refs("issue「#42」の件")).toEqual(["#42"]);
  });

  test("a `#` continuing another token is not a reference", () => {
    expect(refs("foo#123")).toEqual([]);
    expect(refs("docs/spec.md#123")).toEqual([]);
    expect(refs("##123")).toEqual([]);
    expect(refs("v1/#3")).toEqual([]);
    expect(refs("#12a")).toEqual([]);
    expect(refs("# 123")).toEqual([]);
    expect(refs("#abc")).toEqual([]);
  });

  test("pieces reassemble to the input exactly", () => {
    const text = "fix #12 and #34, not foo#5";
    expect(
      splitTextForIssueRefs(text, REPO)
        .map((p) => p.text)
        .join(""),
    ).toBe(text);
  });

  test("no repo, or a repo that is not `owner/name`, links nothing", () => {
    expect(splitTextForIssueRefs("see #123", undefined)).toEqual([
      { text: "see #123", href: null },
    ]);
    expect(refs("see #123", "")).toEqual([]);
    expect(refs("see #123", "claude-ccmsg")).toEqual([]);
    expect(refs("see #123", "a/b/c")).toEqual([]);
  });

  test("a text run with no reference comes back as one untouched piece", () => {
    const pieces = splitTextForIssueRefs("plain text", REPO);
    expect(pieces).toEqual([{ text: "plain text", href: null }]);
  });

  test("consecutive calls do not carry regex state (lastIndex reset)", () => {
    expect(refs("#1 #2")).toEqual(["#1", "#2"]);
    expect(refs("#1 #2")).toEqual(["#1", "#2"]);
  });
});

describe("issueRefUrl", () => {
  test("points at the repo's issue", () => {
    expect(issueRefUrl(REPO, "123")).toBe("https://github.com/kawaz/claude-ccmsg/issues/123");
  });

  test("rejects anything that is not an `owner/name` slug", () => {
    expect(issueRefUrl("claude-ccmsg", "1")).toBeNull();
    expect(issueRefUrl("owner/name/extra", "1")).toBeNull();
    expect(issueRefUrl("../evil", "1")).toBeNull();
  });
});
