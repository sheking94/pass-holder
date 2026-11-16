/** Copying to the clipboard from the views; secrets are cleared from it after a minute. */
import { CLEAR_AFTER_MINUTES, sha256Hex, type ClipboardMessage } from "../clipboard.ts";
import { setStatus } from "./status.ts";

/** Copies text that is not secret (the clipboard is left alone): "Skopiowano <what>.". */
export async function copyText(text: string, what: string, status: HTMLElement): Promise<void> {
  await navigator.clipboard.writeText(text);
  setStatus(status, `Skopiowano ${what}.`);
}

/** Copies a secret and asks the service worker to clear the clipboard after CLEAR_AFTER_MINUTES. */
export async function copySecret(text: string, what: string, status: HTMLElement): Promise<void> {
  await navigator.clipboard.writeText(text);
  const message: ClipboardMessage = {
    target: "background",
    type: "password-copied",
    hash: await sha256Hex(text),
  };
  await chrome.runtime.sendMessage(message);
  setStatus(
    status,
    `Skopiowano ${what}. Schowek zostanie wyczyszczony za ${CLEAR_AFTER_MINUTES} min.`,
  );
}
