// Terminal タブ (issue 2026-07-21-webui-terminal-tab-embed) の embed URL
// 組み立てを固定する。gateway URL は daemon config.json → hello response
// 経由で AppState に載る (旧 localStorage 方式は r46m7 で撤去)。ここでは
// 純関数の URL 組み立てだけを検証し、AppState 反映は ws.ts のハンドシェイク
// テスト側で見る。
import { describe, expect, test } from "bun:test";
import {
  buildTerminalEmbedUrl,
  buildTerminalPageUrl,
} from "../src/client/terminal-gateway-store.ts";

describe("buildTerminalPageUrl", () => {
  test("returns null when gateway or sessionId is missing", () => {
    expect(buildTerminalPageUrl(null, "sid-1")).toBeNull();
    expect(buildTerminalPageUrl("https://gw", null)).toBeNull();
    expect(buildTerminalPageUrl("https://gw", "")).toBeNull();
    expect(buildTerminalPageUrl("https://gw", undefined)).toBeNull();
  });

  test("returns null for invalid / non-http URL", () => {
    expect(buildTerminalPageUrl("not-a-url", "sid")).toBeNull();
    expect(buildTerminalPageUrl("ftp://gw.example", "sid")).toBeNull();
    expect(buildTerminalPageUrl("javascript:alert(1)", "sid")).toBeNull();
  });

  test("builds /sessions/<id> with no embed query", () => {
    expect(buildTerminalPageUrl("https://hyoui.example", "run-34816-f05d6019")).toBe(
      "https://hyoui.example/sessions/run-34816-f05d6019",
    );
    expect(buildTerminalPageUrl("http://127.0.0.1:43690", "sid-42")).toBe(
      "http://127.0.0.1:43690/sessions/sid-42",
    );
  });

  test("base の trailing slash / path / query / hash は落として path を差し替える", () => {
    expect(buildTerminalPageUrl("https://gw.example/", "s")).toBe("https://gw.example/sessions/s");
    expect(buildTerminalPageUrl("https://gw.example/old/path?a=1#frag", "s")).toBe(
      "https://gw.example/sessions/s",
    );
  });

  test("sessionId is percent-encoded", () => {
    expect(buildTerminalPageUrl("https://gw.example", "a b/c")).toBe(
      "https://gw.example/sessions/a%20b%2Fc",
    );
  });
});

describe("buildTerminalEmbedUrl", () => {
  test("returns null when gateway or sessionId is missing", () => {
    expect(buildTerminalEmbedUrl(null, "sid-1")).toBeNull();
    expect(buildTerminalEmbedUrl("https://gw", null)).toBeNull();
    expect(buildTerminalEmbedUrl("https://gw", "")).toBeNull();
    expect(buildTerminalEmbedUrl("https://gw", undefined)).toBeNull();
  });

  test("returns null for invalid / non-http URL", () => {
    expect(buildTerminalEmbedUrl("not-a-url", "sid")).toBeNull();
    expect(buildTerminalEmbedUrl("ftp://gw.example", "sid")).toBeNull();
    expect(buildTerminalEmbedUrl("javascript:alert(1)", "sid")).toBeNull();
  });

  test("builds /sessions/<id>?embed=1 from https base URL", () => {
    expect(buildTerminalEmbedUrl("https://hyoui.example", "abc123")).toBe(
      "https://hyoui.example/sessions/abc123?embed=1&resize=1&fab=right:16,bottom:64,size:51,bg:%233b82f6",
    );
  });

  test("builds URL from http base with port", () => {
    expect(buildTerminalEmbedUrl("http://127.0.0.1:43690", "sid-42")).toBe(
      "http://127.0.0.1:43690/sessions/sid-42?embed=1&resize=1&fab=right:16,bottom:64,size:51,bg:%233b82f6",
    );
  });

  test("trailing slash / existing path on base is normalized (path replaced)", () => {
    expect(buildTerminalEmbedUrl("https://gw.example/", "s")).toBe(
      "https://gw.example/sessions/s?embed=1&resize=1&fab=right:16,bottom:64,size:51,bg:%233b82f6",
    );
    // path が付いていても最終的な pathname は /sessions/<id> に差し替わる
    expect(buildTerminalEmbedUrl("https://gw.example/old/path", "s")).toBe(
      "https://gw.example/sessions/s?embed=1&resize=1&fab=right:16,bottom:64,size:51,bg:%233b82f6",
    );
  });

  test("sessionId is percent-encoded", () => {
    expect(buildTerminalEmbedUrl("https://gw.example", "a b/c")).toBe(
      "https://gw.example/sessions/a%20b%2Fc?embed=1&resize=1&fab=right:16,bottom:64,size:51,bg:%233b82f6",
    );
  });
});
