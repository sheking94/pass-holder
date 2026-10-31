/** Shared by the popup, the service worker and the offscreen document that clears the clipboard. */

import { toHex } from "@passholder/core";

export const CLEAR_CLIPBOARD_ALARM = "clear-clipboard";
export const CLEAR_AFTER_MINUTES = 1;

export type ClipboardMessage =
  | { target: "background"; type: "password-copied"; hash: string }
  | { target: "offscreen"; type: "clear-if-unchanged"; hash: string };

/**
 * Only a SHA-256 of the copied password is kept, so the service worker never holds the password itself.
 * The clipboard is cleared only if it still holds that password, so text you copied later is left alone.
 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}
