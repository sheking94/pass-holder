import { describe, expect, it } from "vitest";
import { p2p, PassHolderError } from "@passholder/core";
import {
  errorMessage,
  PHONE_FORGOT_BROWSER,
  PHONE_MALFORMED,
  toUserError,
} from "../src/error-messages.ts";

describe("errorMessage", () => {
  it("gives the Polish text of a core code, with its detail", () => {
    expect(errorMessage(new PassHolderError("PHONE_UPDATE_REQUIRED"))).toBe(
      "Zaktualizuj aplikację na telefonie",
    );
    expect(errorMessage(new PassHolderError("HOST_MALFORMED"))).toBe(PHONE_MALFORMED);
    expect(errorMessage(new PassHolderError("NOISE_FAILED", "Noise: decryption failed"))).toBe(
      PHONE_MALFORMED,
    );
    expect(errorMessage(p2p.entryTooLargeToSync("Bank"))).toBe(
      "Wpis „Bank” jest za duży (ponad 64 KiB) i nie może zostać zsynchronizowany. Skróć go.",
    );
    expect(
      errorMessage(new PassHolderError("IMPORT_CSV_UNCLOSED_QUOTE", "x", { detail: "3" })),
    ).toBe("Plik CSV jest uszkodzony: niezamknięty cudzysłów (wiersz 3)");
    expect(errorMessage(new PassHolderError("FILE_SYNC_EPOCH_MISMATCH"))).toBe(
      "Zsynchronizuj ponownie",
    );
  });

  it("names the host's status and text, and a forgotten browser", () => {
    expect(errorMessage(new p2p.P2pHostError(500, "internal error"))).toBe(
      "Telefon odpowiedział błędem 500 (internal error).",
    );
    expect(errorMessage(new p2p.P2pHostError(403, "device not paired"))).toBe(PHONE_FORGOT_BROWSER);
  });

  it("shows the extension's own errors and other values as they are", () => {
    expect(errorMessage(new Error("Złe hasło główne"))).toBe("Złe hasło główne");
    expect(errorMessage("tekst")).toBe("tekst");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});

describe("toUserError", () => {
  it("replaces a core error by one with the user's text, keeping it as the cause", () => {
    const core = new PassHolderError("ENTRY_TOO_LARGE", "Entry too large");
    const user = toUserError(core) as Error;
    expect(user).not.toBeInstanceOf(PassHolderError);
    expect(user.message).toBe("Wpis jest za duży");
    expect(user.cause).toBe(core);
  });

  it("keeps anything else", () => {
    const own = new Error("Sejf jest zablokowany");
    expect(toUserError(own)).toBe(own);
    expect(toUserError("x")).toBe("x");
  });
});
