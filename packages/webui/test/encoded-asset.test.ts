import { describe, expect, test } from "bun:test";
import { negotiateCoding } from "../src/encoded-asset.ts";

describe("negotiateCoding", () => {
  test("brotli when the client accepts it, gzip when only that, identity when neither", () => {
    expect(negotiateCoding("gzip, deflate, br, zstd")).toBe("br");
    expect(negotiateCoding("gzip, deflate")).toBe("gzip");
    expect(negotiateCoding("x-gzip")).toBe("gzip");
    expect(negotiateCoding("deflate")).toBe("identity");
    expect(negotiateCoding("")).toBe("identity");
    expect(negotiateCoding(null)).toBe("identity");
  });

  test("weights decide, q=0 excludes, and * stands for the codings not named", () => {
    expect(negotiateCoding("br;q=0.5, gzip;q=0.8")).toBe("gzip");
    expect(negotiateCoding("br;q=0, gzip")).toBe("gzip");
    expect(negotiateCoding("br;q=0, gzip;q=0")).toBe("identity");
    expect(negotiateCoding("*")).toBe("br");
    expect(negotiateCoding("br;q=0, *")).toBe("gzip");
    expect(negotiateCoding("*;q=0")).toBe("identity");
    expect(negotiateCoding("BR ; Q=1")).toBe("br");
  });
});
