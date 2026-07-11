// DR-0011 §1-4 drag payload build/parse. bun's runtime has no DOM globals, so
// these tests exercise the module against a minimal in-memory DataTransfer
// stand-in rather than a real one (see ws.test.ts's MockWebSocket for the
// same rationale applied to the WS client).
import { describe, expect, test } from "bun:test";
import {
  hasSidDragPayload,
  parseSidDragPayload,
  setSidDragPayload,
  SID_DRAG_MIME,
} from "../src/client/dnd.ts";

class FakeDataTransfer {
  private store = new Map<string, string>();

  setData(format: string, data: string): void {
    this.store.set(format, data);
  }

  getData(format: string): string {
    return this.store.get(format) ?? "";
  }

  get types(): string[] {
    return [...this.store.keys()];
  }
}

describe("setSidDragPayload / parseSidDragPayload round trip", () => {
  test("a payload set by setSidDragPayload parses back to the same sid", () => {
    const dt = new FakeDataTransfer();
    setSidDragPayload(dt, "sess-abc123");
    expect(parseSidDragPayload(dt)).toBe("sess-abc123");
  });

  test("setSidDragPayload writes both the custom MIME and text/plain", () => {
    const dt = new FakeDataTransfer();
    setSidDragPayload(dt, "sess-1");
    expect(dt.getData(SID_DRAG_MIME)).toBe("sess-1");
    expect(dt.getData("text/plain")).toBe("sess-1");
  });
});

describe("hasSidDragPayload (dragover accept-check)", () => {
  test("true once the custom MIME has been set (types is readable pre-drop)", () => {
    const dt = new FakeDataTransfer();
    setSidDragPayload(dt, "sess-1");
    expect(hasSidDragPayload(dt)).toBe(true);
  });

  test("false for a drag that never carried our custom MIME (e.g. a plain text/link drag)", () => {
    const dt = new FakeDataTransfer();
    dt.setData("text/plain", "https://example.com/");
    expect(hasSidDragPayload(dt)).toBe(false);
  });

  test("false for an empty drag (no data set at all)", () => {
    const dt = new FakeDataTransfer();
    expect(hasSidDragPayload(dt)).toBe(false);
  });
});

describe("parseSidDragPayload fallback / rejection", () => {
  // Safari can strip a drag's custom MIME entries across the OS pasteboard
  // boundary while text/plain survives — parseSidDragPayload falls back to
  // it so the drop still resolves to a sid in that case.
  test("falls back to text/plain when the custom MIME payload is absent", () => {
    const dt = new FakeDataTransfer();
    dt.setData("text/plain", "sess-fallback");
    expect(parseSidDragPayload(dt)).toBe("sess-fallback");
  });

  test("returns null for a drag carrying neither the custom MIME nor text/plain", () => {
    const dt = new FakeDataTransfer();
    dt.setData("text/uri-list", "https://example.com/");
    expect(parseSidDragPayload(dt)).toBeNull();
  });

  test("returns null for a completely empty DataTransfer", () => {
    const dt = new FakeDataTransfer();
    expect(parseSidDragPayload(dt)).toBeNull();
  });
});
