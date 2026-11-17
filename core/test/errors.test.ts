import { describe, expect, it } from "vitest";
import { hasErrorCode, PassHolderError } from "../src/errors.ts";
import { P2pHostError } from "../src/p2p/transport.ts";

describe("PassHolderError", () => {
  it("carries a code, an English message, a detail and a cause", () => {
    const cause = new Error("inner");
    const e = new PassHolderError("ENTRY_TOO_LARGE_TO_SYNC", "Entry too large to sync: A", {
      detail: "A",
      cause,
    });
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("ENTRY_TOO_LARGE_TO_SYNC");
    expect(e.message).toBe("Entry too large to sync: A");
    expect(e.detail).toBe("A");
    expect(e.cause).toBe(cause);
    expect(new PassHolderError("FILE_EMPTY").message).toBe("FILE_EMPTY");
  });

  it("hasErrorCode matches only a PassHolderError with one of the codes", () => {
    const e = new PassHolderError("ZIP_INVALID");
    expect(hasErrorCode(e, "ZIP_INVALID")).toBe(true);
    expect(hasErrorCode(e, "FILE_CORRUPTED", "ZIP_INVALID")).toBe(true);
    expect(hasErrorCode(e, "FILE_CORRUPTED")).toBe(false);
    // The text alone never counts.
    expect(hasErrorCode(new Error("ZIP_INVALID"), "ZIP_INVALID")).toBe(false);
    expect(hasErrorCode("ZIP_INVALID", "ZIP_INVALID")).toBe(false);
  });

  it("P2pHostError tells a forgotten device from other host errors", () => {
    const forgotten = new P2pHostError(403, "device not paired");
    expect(forgotten.code).toBe("DEVICE_NOT_PAIRED");
    expect(forgotten.message).toBe("P2P host returned 403: device not paired");
    expect(new P2pHostError(403, "forbidden host").code).toBe("HOST_ERROR");
    const other = new P2pHostError(500, "internal error");
    expect(other.code).toBe("HOST_ERROR");
    expect(other.status).toBe(500);
    expect(other.detail).toBe("internal error");
  });
});
