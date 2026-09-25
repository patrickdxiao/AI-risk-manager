import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { requireInteger } from "../../core/primitives.js";
import { canonical, invariant, parse, type Decoder } from "./validation.js";

/** SQL identifiers come only from adapter source; all record values use bound parameters. */
export class Records {
  constructor(
    readonly raw: DatabaseSync,
    private readonly assertActive: () => void,
  ) {}

  run(sql: string, ...parameters: SQLInputValue[]): number {
    this.assertActive();
    return Number(this.raw.prepare(sql).run(...parameters).changes);
  }
  count(sql: string, ...parameters: SQLInputValue[]): number {
    this.assertActive();
    const count = this.raw.prepare(sql).get(...parameters)?.["count"];
    invariant(typeof count === "number" && Number.isSafeInteger(count));
    return count;
  }
  one<T>(decode: Decoder<T>, sql: string, ...parameters: SQLInputValue[]): T | undefined {
    this.assertActive();
    const row = this.raw.prepare(sql).get(...parameters);
    return row === undefined ? undefined : parse(row["data"], decode);
  }
  all<T>(decode: Decoder<T>, sql: string, ...parameters: SQLInputValue[]): readonly T[] {
    this.assertActive();
    return Object.freeze(
      this.raw
        .prepare(sql)
        .all(...parameters)
        .map((row) => parse(row["data"], decode)),
    );
  }
  get<T>(table: string, id: string, decode: Decoder<T>): T | undefined {
    return this.one(decode, `SELECT data FROM ${table} WHERE id = ?`, id);
  }
  add<T>(table: string, id: string, value: T, decode: Decoder<T>): void {
    const normalized = decode(value);
    const saved = this.get(table, id, decode);
    if (saved !== undefined) {
      invariant(canonical(saved) === canonical(normalized), "Cannot replace an existing record");
      return;
    }
    this.run(`INSERT INTO ${table}(id, data) VALUES (?, ?)`, id, canonical(normalized));
  }
  update<T>(table: string, id: string, value: T, decode: Decoder<T>): void {
    invariant(
      this.run(`UPDATE ${table} SET data = ? WHERE id = ?`, canonical(decode(value)), id) === 1,
      "Cannot update a missing record",
    );
  }
}

/** Query limits never silently become SQLite's negative (unbounded) LIMIT. */
export function limit(value: number): number {
  requireInteger(value, "limit", 1);
  invariant(value <= 1_000, "Read limit exceeds 1000 records");
  return value;
}
