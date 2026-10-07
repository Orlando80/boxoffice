import { describe, expect, it } from "vitest";
import { HOLD_STATUSES, MAX_EXTENSIONS, canTransition, checkExtension } from "../../src/index.js";

describe("AC2 state machine", () => {
  const pairs = HOLD_STATUSES.flatMap((s) =>
    (["release", "expire"] as const).map((a) => [s, a] as const),
  );
  it.each(pairs)("%s + %s", (status, action) => {
    expect(canTransition(status, action)).toBe(status === "active");
  });
  it("ended states are terminal", () => {
    for (const s of ["released", "expired"] as const) {
      expect(canTransition(s, "release")).toBe(false);
      expect(canTransition(s, "expire")).toBe(false);
    }
  });
});

describe("extensions", () => {
  it("counts down from 9 to 0 remaining across the 10 allowed extensions", () => {
    for (let used = 0; used < MAX_EXTENSIONS; used++) {
      expect(checkExtension(used)).toEqual({
        ok: true,
        value: { extensionsRemaining: MAX_EXTENSIONS - used - 1 },
      });
    }
  });
  it("the 11th extension is rejected with extension_limit", () => {
    expect(checkExtension(10)).toEqual({ ok: false, error: "extension_limit" });
    expect(checkExtension(11)).toEqual({ ok: false, error: "extension_limit" });
  });
});
