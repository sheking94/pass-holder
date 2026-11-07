import { normalizePhoneUrls, PHONE_PORT } from "../server-urls.ts";
import { h, setStatus } from "./dom.ts";

const URL_EXAMPLE = `http://192.168.1.5:${PHONE_PORT}`;
const SECOND_URL_EXAMPLE = `http://100.64.0.7:${PHONE_PORT}`;
const NO_PERMISSION = "Bez zgody Chrome na dostęp do adresu telefonu wtyczka nie może się z nim łączyć.";

/** The host permission pattern for one normalized phone address, e.g. http://192.168.1.5:8787/*. */
export function originPattern(url: string): string {
  const parsed = new URL(url);
  return `http://${parsed.host}/*`;
}

/**
 * One input per phone address (the home network IP, the Tailscale IP…), plus "+ Dodaj adres".
 * The vault tries them all and remembers the one that answered.
 */
export function serverUrlFields(current: readonly string[] = []) {
  const box = h("div", { class: "url-list" });
  const add = (value = "") => {
    const first = box.childElementCount === 0;
    // Not `required`: read() names a missing address in the status line, in the same place as other errors.
    const input = h("input", { type: "text", inputmode: "url", class: "mono", placeholder: first ? URL_EXAMPLE : SECOND_URL_EXAMPLE, value, autocomplete: "off" });
    box.append(input);
    return input;
  };
  for (const url of current) add(url);
  // Always one empty field at the end, so a second address (e.g. Tailscale) can just be typed in.
  add();
  const main = box.querySelector("input")!;
  return {
    main,
    fields: [
      h("label", {}, "Adresy telefonu (z ekranu Synchronizacja w aplikacji)"),
      box,
      h("button", { type: "button", class: "small", onclick: () => add().focus() }, "+ Dodaj adres"),
    ],
    /** All typed addresses and the host permission patterns they need, or an error message. */
    read(): { urls: string[]; origins: string[] } | string {
      let urls: string[];
      try {
        urls = normalizePhoneUrls([...box.querySelectorAll("input")].map((i) => i.value));
      } catch (error) {
        return (error as Error).message;
      }
      if (urls.length === 0) return `Podaj adres telefonu, np. ${URL_EXAMPLE}`;
      return { urls, origins: [...new Set(urls.map(originPattern))] };
    },
  };
}

/**
 * Asks Chrome for access to the phone addresses, then runs onGranted. Must be called directly in the
 * submit handler, before any await (the prompt needs the user gesture). It runs in a tab (see page-mode.ts),
 * so the page survives the prompt and the callback runs.
 */
export function requestHostPermission(origins: string[], status: HTMLElement, onGranted: () => void) {
  chrome.permissions.request({ origins }, (granted) => {
    if (!granted) return setStatus(status, NO_PERMISSION, true);
    onGranted();
  });
}

/**
 * Like requestHostPermission, but goes on whether or not the user allows: for addresses the phone reported
 * besides the typed one. A sync skips the ones that are not allowed and says so.
 */
export function requestOptionalHostPermission(origins: string[], then: () => void) {
  if (origins.length === 0) return then();
  chrome.permissions.request({ origins }, () => {
    void chrome.runtime.lastError; // a refusal is fine here
    then();
  });
}

/** Whether Chrome lets the extension reach this phone address (the VaultStore's canReach). */
export async function hostPermissionGranted(url: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [originPattern(url)] });
  } catch {
    return false;
  }
}
