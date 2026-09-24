import { describe, expect, expectTypeOf, it } from "vitest";
import type { JsonValue, PrivacyMode, RiskState } from "../../src/core/primitives.js";
import {
  DomainInvariantError,
  normalizeStringList,
  normalizeJsonRecord,
  optionalNonBlank,
  requireInteger,
  requireNonBlank,
  requireTimestampOrder,
  requireUtcTimestamp,
} from "../../src/core/primitives.js";

describe("validation primitives", () => {
  it("keeps a stable error code and field when required text is blank", () => {
    expect(() => requireNonBlank(" ", "title")).toThrow(
      new DomainInvariantError("required", "title is required", "title"),
    );
    expect(new DomainInvariantError("required", "title is required", "title")).toMatchObject({
      name: "DomainInvariantError",
      code: "required",
      field: "title",
    });
    expect(requireNonBlank(" title ", "title")).toBe("title");
    expect(optionalNonBlank(undefined, "description")).toBeUndefined();
    expect(optionalNonBlank(" details ", "description")).toBe("details");
  });

  it("bounds lists and copied entries without changing the original", () => {
    const input = [" first ", "second"];
    const values = normalizeStringList(input, "criteria", 2, 6);
    input[0] = "changed";
    expect(values).toEqual(["first", "second"]);
    expect(Object.isFrozen(values)).toBe(true);
    expect(() => normalizeStringList(["first", "second"], "criteria", 1)).toThrow(
      DomainInvariantError,
    );
    expect(() => normalizeStringList(["too long"], "criteria", 1, 3)).toThrow(DomainInvariantError);
    expect(() => normalizeStringList([" "], "criteria")).toThrow(/criteria\[0\]/u);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe or nonpositive integers: %s",
    (value) => {
      expect(() => requireInteger(value, "points", 1)).toThrow(DomainInvariantError);
    },
  );
  it("accepts integer boundaries", () => {
    expect(requireInteger(0, "target", 0)).toBe(0);
    expect(requireInteger(Number.MAX_SAFE_INTEGER, "version", 1)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    ["2024-02-29T23:59:59Z", "2024-02-29T23:59:59.000Z"],
    ["2000-02-29T00:00:00.1Z", "2000-02-29T00:00:00.100Z"],
    ["2026-09-24T12:00:00.12Z", "2026-09-24T12:00:00.120Z"],
    ["2026-09-24T12:00:00.123Z", "2026-09-24T12:00:00.123Z"],
  ])("normalizes valid UTC timestamp %s", (input, expected) => {
    expect(requireUtcTimestamp(input, "time")).toBe(expected);
  });

  it.each([
    "not-a-date",
    "2026-09-24",
    "2026-09-24Z",
    "September 24, 2026Z",
    "2026-09-24T12:00:00+00:00",
    "2026-09-24T12:00:00-07:00",
    "2026-09-24T12:00Z",
    "2026-09-24T12:00:00.1234Z",
    "2026-02-29T12:00:00Z",
    "1900-02-29T12:00:00Z",
    "2026-04-31T12:00:00Z",
    "2026-13-01T12:00:00Z",
    "2026-01-00T12:00:00Z",
    "2026-09-24T24:00:00Z",
    "2026-09-24T12:60:00Z",
    "2026-09-24T12:00:60Z",
  ])("rejects malformed or nonexistent UTC timestamp %s", (input) => {
    expect(() => requireUtcTimestamp(input, "time")).toThrow(DomainInvariantError);
  });

  it("applies strict ordering to intervals and permits equal event times", () => {
    const start = "2026-09-24T12:00:00Z";
    const end = "2026-09-24T13:00:00Z";
    expect(() => {
      requireTimestampOrder(start, end, "endAt", false);
    }).not.toThrow();
    expect(() => {
      requireTimestampOrder(start, start, "updatedAt");
    }).not.toThrow();
    expect(() => {
      requireTimestampOrder(start, start, "endAt", false);
    }).toThrow(DomainInvariantError);
    expect(() => {
      requireTimestampOrder(end, start, "endAt");
    }).toThrow(DomainInvariantError);
  });
});

describe("types", () => {
  describe("public shared types", () => {
    it("expresses provider-neutral values", () => {
      expectTypeOf<PrivacyMode>().toEqualTypeOf<"metadata_only" | "selected_content">();
      expectTypeOf<RiskState>().toEqualTypeOf<"healthy" | "uncertain" | "at_risk" | "blocked">();
      expectTypeOf<{ nested: readonly JsonValue[] }>().toExtend<JsonValue>();
    });
  });
});

describe("immutable JSON metadata", () => {
  it("copies nested values and shared references without changing the originals", () => {
    const shared = { enabled: true, note: "  unchanged  " };
    const input = { values: [null, 2.5, shared], again: shared };
    const result = normalizeJsonRecord(input, "metadata");
    shared.enabled = false;
    input.values.push(4);
    expect(result).toEqual({
      values: [null, 2.5, { enabled: true, note: "  unchanged  " }],
      again: { enabled: true, note: "  unchanged  " },
    });
    for (const value of [result, result["values"], result["again"]])
      expect(Object.isFrozen(value)).toBe(true);
  });

  it("accepts null prototypes and treats __proto__ as a data key", () => {
    const input = Object.assign(Object.create(null) as Record<string, JsonValue>, { valid: true });
    Object.defineProperty(input, "__proto__", { value: { injected: true }, enumerable: true });
    const result = normalizeJsonRecord(input, "metadata");
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result["injected"]).toBeUndefined();
    expect(Object.isFrozen(result["__proto__"])).toBe(true);
  });

  it.each([null, [], false, "text", 42])("rejects a non-record root: %j", (invalid) => {
    expect(() => normalizeJsonRecord(invalid, "metadata")).toThrow(DomainInvariantError);
  });

  it.each([
    undefined,
    Number.NaN,
    Infinity,
    1n,
    Symbol("value"),
    () => true,
    new Date(),
    new Map(),
  ])("rejects non-JSON nested values %#", (value) => {
    expect(() => normalizeJsonRecord({ value }, "metadata")).toThrow(DomainInvariantError);
  });

  it("rejects cycles without rejecting repeated acyclic references", () => {
    const cycle: Record<string, JsonValue> = {};
    cycle["self"] = cycle;
    expect(() => normalizeJsonRecord(cycle, "metadata")).toThrow(/cycles/u);
    const list: JsonValue[] = [];
    list.push(list);
    expect(() => normalizeJsonRecord({ list }, "metadata")).toThrow(/cycles/u);
  });

  it("rejects accessors without calling them, symbols, and hidden data", () => {
    let called = false;
    const accessor = {
      get value() {
        called = true;
        return 1;
      },
    };
    expect(() => normalizeJsonRecord(accessor, "metadata")).toThrow(DomainInvariantError);
    expect(called).toBe(false);
    expect(() => normalizeJsonRecord({ [Symbol("hidden")]: true }, "metadata")).toThrow(
      DomainInvariantError,
    );
    expect(() =>
      normalizeJsonRecord(Object.defineProperty({}, "hidden", { value: 1 }), "metadata"),
    ).toThrow(DomainInvariantError);
  });

  it("rejects sparse arrays and extra array properties instead of silently discarding data", () => {
    expect(() => normalizeJsonRecord({ list: Array<JsonValue>(2) }, "metadata")).toThrow(
      DomainInvariantError,
    );
    expect(() =>
      normalizeJsonRecord({ list: Object.assign([1], { extra: true }) }, "metadata"),
    ).toThrow(DomainInvariantError);
  });

  it("bounds total text, values, and depth", () => {
    expect(normalizeJsonRecord({ x: "x".repeat(99_999) }, "metadata")["x"]).toHaveLength(99_999);
    expect(() => normalizeJsonRecord({ x: "x".repeat(100_000) }, "metadata")).toThrow(
      DomainInvariantError,
    );
    expect(
      normalizeJsonRecord({ list: Array.from({ length: 9_998 }, () => null) }, "metadata")["list"],
    ).toHaveLength(9_998);
    expect(() =>
      normalizeJsonRecord({ list: Array.from({ length: 9_999 }, () => null) }, "metadata"),
    ).toThrow(DomainInvariantError);
    let nested: JsonValue = null;
    for (let index = 0; index < 19; index += 1) nested = { nested };
    expect(() => normalizeJsonRecord({ nested }, "metadata")).not.toThrow();
    expect(() => normalizeJsonRecord({ nested: { nested } }, "metadata")).toThrow(
      DomainInvariantError,
    );
  });
});
