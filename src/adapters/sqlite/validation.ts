import { requireNonBlank, requireUtcTimestamp } from "../../core/primitives.js";

export type Decoder<T> = (value: unknown) => T;

export class SQLiteRecordError extends Error {
  override readonly name = "SQLiteRecordError";
  constructor(message = "Stored record is invalid") {
    super(message);
  }
}

export function invariant(condition: boolean, message?: string): asserts condition {
  if (!condition) throw new SQLiteRecordError(message);
}

export const text =
  (maximum = 8_000): Decoder<string> =>
  (value) => {
    invariant(typeof value === "string");
    // Keep persisted paths and text exact; domain constructors already normalize input.
    requireNonBlank(value, "stored text", maximum);
    invariant(value.length <= maximum);
    return value;
  };
export const id = text(200);
export const timestamp: Decoder<string> = (value) => {
  const result = text(24)(value);
  invariant(requireUtcTimestamp(result, "stored timestamp") === result);
  return result;
};
export const number =
  (minimum = 0, maximum = Number.MAX_VALUE): Decoder<number> =>
  (value) => {
    invariant(typeof value === "number" && Number.isFinite(value));
    invariant(value >= minimum && value <= maximum);
    return value;
  };
export const integer =
  (minimum = 0): Decoder<number> =>
  (value) => {
    const result = number(minimum, Number.MAX_SAFE_INTEGER)(value);
    invariant(Number.isSafeInteger(result));
    return result;
  };
export const boolean: Decoder<boolean> = (value) => {
  invariant(typeof value === "boolean");
  return value;
};
export const enumeration =
  <const T extends readonly string[]>(...values: T): Decoder<T[number]> =>
  (value) => {
    invariant(typeof value === "string");
    const result = values.find((item) => item === value);
    invariant(result !== undefined);
    return result;
  };
export const optional =
  <T>(decode: Decoder<T>): Decoder<T | undefined> =>
  (value) =>
    value === undefined ? undefined : decode(value);
export const nullable =
  <T>(decode: Decoder<T>): Decoder<T | null> =>
  (value) =>
    value === null ? null : decode(value);
export const array =
  <T>(decode: Decoder<T>, maximum = 1_000): Decoder<readonly T[]> =>
  (value) => {
    invariant(Array.isArray(value) && value.length <= maximum);
    return Object.freeze(value.map((entry: unknown) => decode(entry)));
  };

type Shape = Readonly<Record<string, Decoder<unknown>>>;
type Decoded<S extends Shape> = {
  readonly [K in keyof S as undefined extends ReturnType<S[K]> ? never : K]: ReturnType<S[K]>;
} & {
  readonly [K in keyof S as undefined extends ReturnType<S[K]> ? K : never]?: Exclude<
    ReturnType<S[K]>,
    undefined
  >;
};

/** Every property is decoded before the one structural assertion assembles the typed object. */
export function object<const S extends Shape>(shape: S): Decoder<Decoded<S>> {
  return (value) => {
    invariant(value !== null && typeof value === "object" && !Array.isArray(value));
    invariant(Object.keys(value).every((key) => Object.hasOwn(shape, key)));
    const entries = Object.entries(shape).flatMap(([key, decode]) => {
      const property: unknown = Reflect.get(value, key);
      const decoded = decode(property);
      return decoded === undefined ? [] : [[key, decoded]];
    });
    return Object.freeze(Object.fromEntries(entries)) as Decoded<S>;
  };
}

export const record =
  <T>(decode: Decoder<T>): Decoder<Readonly<Record<string, T>>> =>
  (value) => {
    invariant(value !== null && typeof value === "object" && !Array.isArray(value));
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]: [string, unknown]) => [key, decode(item)]),
      ),
    );
  };

export const triggerValue: Decoder<string | number | boolean | readonly string[]> = (value) => {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    invariant(Number.isFinite(value));
    return value;
  }
  return array((entry) => {
    invariant(typeof entry === "string");
    return entry;
  }, 10_000)(value);
};

/** Use JSON values only; SQL rows never become typed records by casting JSON.parse. */
export function parse<T>(value: unknown, decode: Decoder<T>): T {
  invariant(typeof value === "string");
  const parsed: unknown = JSON.parse(value);
  return decode(parsed);
}

export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown): unknown => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  });
}
