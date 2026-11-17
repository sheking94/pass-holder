// Small helpers for strict parsing of JSON values: the core refuses anything it does not expect, so every parser
// checks the shape the same way. The Kotlin twin is android/core/.../StrictJson.kt.

export type JsonObject = Record<string, unknown>;

/** True for a JSON object: not null and not an array. */
export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a JSON object whose own keys are exactly `keys`, in any order. */
export function hasExactKeys(value: unknown, keys: readonly string[]): value is JsonObject {
  if (!isRecord(value)) return false;
  return Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

/** `value` when it is a string; otherwise throws the error that `error` makes. */
export function requireString(value: unknown, error: () => Error): string {
  if (typeof value !== "string") throw error();
  return value;
}
