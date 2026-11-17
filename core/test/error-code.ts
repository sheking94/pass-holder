import { expect } from "vitest";
import type { ErrorCode } from "../src/errors.ts";

/** Matches a thrown PassHolderError by its code: `toThrow(withCode("ZIP_INVALID"))`. */
export const withCode = (code: ErrorCode, detail?: string) =>
  expect.objectContaining(detail === undefined ? { code } : { code, detail });
