// どの Claude config dir のセッションを daemon が受け持つか (agents.ts
// servedConfigDirs)。既定の state dir の daemon だけが `$HOME/.claude*` を受け
// 持ち、試験や /verify で別の state dir に立てた daemon は明示されない限り何も
// 受け持たない (実セッションに試験のメッセージを届けないため)。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { servedConfigDirs } from "../src/agents.ts";

const tmpDir = perTestTmpDir();
const DETECTED = ["/home/u/.claude-a", "/home/u/.claude-b"];
const detect = (): string[] => DETECTED;

describe("servedConfigDirs", () => {
  test("既定の state dir の daemon は検出した $HOME/.claude* を受け持つ", () => {
    const xdg = tmpDir("ccmsg-served-");
    const env = { XDG_STATE_HOME: xdg };
    expect(servedConfigDirs(path.join(xdg, "ccmsg"), env, detect)).toEqual(DETECTED);
    // CCMSG_STATE_DIR が既定と同じ場所を指すだけなら既定の daemon のまま
    const same = { ...env, CCMSG_STATE_DIR: path.join(xdg, "ccmsg") };
    expect(servedConfigDirs(path.join(xdg, "ccmsg"), same, detect)).toEqual(DETECTED);
  });

  test("既定の state dir を symlink 越しに指す daemon も既定の daemon", () => {
    const xdg = tmpDir("ccmsg-served-");
    fs.mkdirSync(path.join(xdg, "ccmsg"));
    const link = path.join(tmpDir("ccmsg-served-link-"), "state");
    fs.symlinkSync(path.join(xdg, "ccmsg"), link);
    expect(servedConfigDirs(link, { XDG_STATE_HOME: xdg }, detect)).toEqual(DETECTED);
  });

  test("別の state dir の daemon (隔離 daemon) は何も受け持たない", () => {
    const xdg = tmpDir("ccmsg-served-");
    const isolated = tmpDir("ccmsg-served-isolated-");
    expect(
      servedConfigDirs(isolated, { XDG_STATE_HOME: xdg, CCMSG_STATE_DIR: isolated }, detect),
    ).toEqual([]);
  });

  test("CCMSG_CLAUDE_CONFIG_DIRS は state dir に関わらず受け持つ dir をそのまま決める", () => {
    const xdg = tmpDir("ccmsg-served-");
    const isolated = tmpDir("ccmsg-served-isolated-");
    const env = { XDG_STATE_HOME: xdg, CCMSG_STATE_DIR: isolated };
    expect(
      servedConfigDirs(isolated, { ...env, CCMSG_CLAUDE_CONFIG_DIRS: "/c/one:/c/two" }, detect),
    ).toEqual(["/c/one", "/c/two"]);
    // 既定の daemon でも検出は使わない
    expect(
      servedConfigDirs(
        path.join(xdg, "ccmsg"),
        { XDG_STATE_HOME: xdg, CCMSG_CLAUDE_CONFIG_DIRS: "/c/one" },
        detect,
      ),
    ).toEqual(["/c/one"]);
    // 空は「何も受け持たない」、相対パスと空要素は dir を名指していないので読まない
    expect(servedConfigDirs(isolated, { ...env, CCMSG_CLAUDE_CONFIG_DIRS: "" }, detect)).toEqual(
      [],
    );
    expect(
      servedConfigDirs(isolated, { ...env, CCMSG_CLAUDE_CONFIG_DIRS: "rel::/c/abs" }, detect),
    ).toEqual(["/c/abs"]);
  });
});
