import { describe, expectTypeOf, it } from "vitest";
import type { JsonValue, PrivacyMode, RiskState } from "../../src/core/primitives.js";

describe("types", () => {
  describe("public shared types", () => {
    it("expresses provider-neutral values", () => {
      expectTypeOf<PrivacyMode>().toEqualTypeOf<"metadata_only" | "selected_content">();
      expectTypeOf<RiskState>().toEqualTypeOf<"healthy" | "uncertain" | "at_risk" | "blocked">();
      expectTypeOf<{ nested: readonly JsonValue[] }>().toExtend<JsonValue>();
    });
  });
});
