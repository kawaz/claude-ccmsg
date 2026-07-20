// Terminal タブ (issue 2026-07-21-webui-terminal-tab-embed) の gateway URL
// 保存と embed URL 組み立ての固定。localStorage 直の I/O と URL 組み立ての
// 純関数の 2 点で、SessionView 側のタブ表示条件 (hyoui_session_id の有無)
// とは独立に検証する。
import { beforeEach, describe, expect, test } from "bun:test";
import {
  buildTerminalEmbedUrl,
  loadTerminalGatewayUrl,
  saveTerminalGatewayUrl,
  TERMINAL_GATEWAY_STORAGE_KEY,
} from "../src/client/terminal-gateway-store.ts";

class MemStorage {
  private data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  key(i: number): string | null {
    return [...this.data.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
  clear(): void {
    this.data.clear();
  }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();
});

describe("terminal gateway URL storage", () => {
  test("round-trip through localStorage", () => {
    expect(loadTerminalGatewayUrl()).toBeNull();
    saveTerminalGatewayUrl("https://gw.example");
    expect(loadTerminalGatewayUrl()).toBe("https://gw.example");
  });

  test("save trims whitespace", () => {
    saveTerminalGatewayUrl("  http://127.0.0.1:43690  ");
    expect(localStorage.getItem(TERMINAL_GATEWAY_STORAGE_KEY)).toBe("http://127.0.0.1:43690");
  });

  test("saving null / empty removes the key", () => {
    saveTerminalGatewayUrl("https://gw.example");
    saveTerminalGatewayUrl(null);
    expect(loadTerminalGatewayUrl()).toBeNull();
    saveTerminalGatewayUrl("https://gw.example");
    saveTerminalGatewayUrl("   ");
    expect(loadTerminalGatewayUrl()).toBeNull();
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
      "https://hyoui.example/sessions/abc123?embed=1",
    );
  });

  test("builds URL from http base with port", () => {
    expect(buildTerminalEmbedUrl("http://127.0.0.1:43690", "sid-42")).toBe(
      "http://127.0.0.1:43690/sessions/sid-42?embed=1",
    );
  });

  test("trailing slash / existing path on base is normalized (path replaced)", () => {
    expect(buildTerminalEmbedUrl("https://gw.example/", "s")).toBe(
      "https://gw.example/sessions/s?embed=1",
    );
    // path が付いていても最終的な pathname は /sessions/<id> に差し替わる
    expect(buildTerminalEmbedUrl("https://gw.example/old/path", "s")).toBe(
      "https://gw.example/sessions/s?embed=1",
    );
  });

  test("sessionId is percent-encoded", () => {
    expect(buildTerminalEmbedUrl("https://gw.example", "a b/c")).toBe(
      "https://gw.example/sessions/a%20b%2Fc?embed=1",
    );
  });
});
