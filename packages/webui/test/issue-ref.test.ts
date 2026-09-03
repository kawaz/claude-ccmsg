// issue-ref.ts unit tests (kawaz r259 m1 / m45): the reference recognizer that
// markdown-view turns into GitHub issue links. Split from the renderer tests
// because the interesting part here is the token boundary — which shapes are a
// reference and which are an id / a heading run — and how a written repo name
// or fragment resolves.
import { describe, expect, test } from "bun:test";
import { issueRefUrl, splitTextForIssueRefs } from "../src/client/issue-ref.ts";

const REPO = "kawaz/claude-ccmsg";

// `repo` is required on these two so that passing `undefined` means "no session
// repo" rather than silently falling back to a default parameter.
/** The linked substrings, in order. */
function refsIn(text: string, repo: string | undefined): string[] {
  return splitTextForIssueRefs(text, repo)
    .filter((p) => p.href)
    .map((p) => p.text);
}

/** The hrefs, in order. */
function hrefsIn(text: string, repo: string | undefined): (string | null)[] {
  return splitTextForIssueRefs(text, repo)
    .filter((p) => p.href)
    .map((p) => p.href);
}

const refs = (text: string) => refsIn(text, REPO);
const hrefs = (text: string) => hrefsIn(text, REPO);

describe("splitTextForIssueRefs", () => {
  // Rule 1: bare `#N` against the session's repo.
  test("links a bare reference wherever a token can start", () => {
    expect(refs("see #123 for details")).toEqual(["#123"]);
    expect(refs("#1")).toEqual(["#1"]);
    expect(refs("(#12)")).toEqual(["#12"]);
    expect(refs("closes #12.")).toEqual(["#12"]);
    expect(refs("#7, #8 と #9")).toEqual(["#7", "#8", "#9"]);
    expect(refs("issue「#42」の件")).toEqual(["#42"]);
    expect(hrefs("see #123")).toEqual(["https://github.com/kawaz/claude-ccmsg/issues/123"]);
  });

  // Rule 2: `name#N` keeps the session's owner.
  test("a repo name takes the session's owner", () => {
    expect(hrefs("see foo#12")).toEqual(["https://github.com/kawaz/foo/issues/12"]);
    expect(hrefs("xfoo#1")).toEqual(["https://github.com/kawaz/xfoo/issues/1"]);
    expect(hrefs("kuu.mbt#3")).toEqual(["https://github.com/kawaz/kuu.mbt/issues/3"]);
    // Ambiguity with a file fragment is accepted: the name wins, and links.
    expect(hrefs("README.md#12")).toEqual(["https://github.com/kawaz/README.md/issues/12"]);
  });

  // Rule 3: `owner/name#N` is self-contained.
  test("a fully qualified reference links even with no session repo", () => {
    expect(hrefs("bar/foo#1")).toEqual(["https://github.com/bar/foo/issues/1"]);
    expect(hrefsIn("bar/foo#1", undefined)).toEqual(["https://github.com/bar/foo/issues/1"]);
    expect(hrefsIn("bar/foo#1", "not-a-slug")).toEqual(["https://github.com/bar/foo/issues/1"]);
  });

  // Rule 4: a trailing `#fragment` is carried over verbatim.
  test("a fragment is appended to the issue URL", () => {
    expect(hrefs("#12#issuecomment-345")).toEqual([
      "https://github.com/kawaz/claude-ccmsg/issues/12#issuecomment-345",
    ]);
    expect(refs("#12#issuecomment-345")).toEqual(["#12#issuecomment-345"]);
    expect(hrefs("foo#12#issuecomment-345")).toEqual([
      "https://github.com/kawaz/foo/issues/12#issuecomment-345",
    ]);
    expect(hrefs("bar/foo#12#issuecomment-345")).toEqual([
      "https://github.com/bar/foo/issues/12#issuecomment-345",
    ]);
  });

  // Rule 5: a space separates the word from a bare reference.
  test("`name #N` is a word plus a reference to the session's repo", () => {
    expect(refs("foo #12")).toEqual(["#12"]);
    expect(hrefs("foo #12")).toEqual(["https://github.com/kawaz/claude-ccmsg/issues/12"]);
  });

  // Rule 6: exclusions.
  test("shapes that are not a reference", () => {
    expect(refs("##123")).toEqual([]);
    expect(refs("v1/#3")).toEqual([]);
    expect(refs("#12a")).toEqual([]);
    expect(refs("# 123")).toEqual([]);
    expect(refs("#abc")).toEqual([]);
    expect(refs("a/b/c#1")).toEqual([]);
    expect(refs("https://github.com/bar/foo#1")).toEqual([]);
  });

  // Rule 7: the matched text is the link text, unchanged.
  test("pieces reassemble to the input exactly", () => {
    for (const text of [
      "fix #12 and #34, not foo #5",
      "bar/foo#1 と foo#2 と #3#issuecomment-4 の件",
    ]) {
      expect(
        splitTextForIssueRefs(text, REPO)
          .map((p) => p.text)
          .join(""),
      ).toBe(text);
    }
  });

  test("the short forms need a usable session repo", () => {
    expect(splitTextForIssueRefs("see #123", undefined)).toEqual([
      { text: "see #123", href: null },
    ]);
    expect(refsIn("see #123", "")).toEqual([]);
    expect(refsIn("see #123", "claude-ccmsg")).toEqual([]);
    expect(refsIn("see #123", "a/b/c")).toEqual([]);
    expect(refsIn("see foo#1", undefined)).toEqual([]);
    expect(refsIn("see foo#1", "a/b/c")).toEqual([]);
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
    expect(issueRefUrl(REPO, "123", "issuecomment-45")).toBe(
      "https://github.com/kawaz/claude-ccmsg/issues/123#issuecomment-45",
    );
  });

  test("rejects anything that is not an `owner/name` slug", () => {
    expect(issueRefUrl("claude-ccmsg", "1")).toBeNull();
    expect(issueRefUrl("owner/name/extra", "1")).toBeNull();
    expect(issueRefUrl("../evil", "1")).toBeNull();
  });

  test("rejects a fragment that is not fragment-shaped", () => {
    expect(issueRefUrl(REPO, "1", "a/b")).toBeNull();
    expect(issueRefUrl(REPO, "1", "")).toBeNull();
  });
});
