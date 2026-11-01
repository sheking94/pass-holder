import { normalizeServerUrls } from "../server-urls.ts";
import { h, setStatus } from "./dom.ts";

const URL_EXAMPLE = "https://passholder.local:8443";
const SECOND_URL_EXAMPLE = "https://100.x.y.z:8443";
const NO_PERMISSION = "Bez zgody na dostęp do serwera wtyczka nie może się z nim łączyć";

function originPattern(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

/** Two address inputs: the main one and an optional second one (e.g. Tailscale). The vault picks whichever answers. */
export function serverUrlFields(current: readonly string[] = []) {
  const main = h("input", { type: "url", placeholder: URL_EXAMPLE, required: true, value: current[0] ?? "" });
  const second = h("input", { type: "url", placeholder: SECOND_URL_EXAMPLE, value: current[1] ?? "" });
  return {
    main,
    fields: [
      h("label", {}, "Adres serwera"),
      main,
      h("label", {}, "Drugi adres serwera (opcjonalnie, np. Tailscale)"),
      second,
    ],
    /** The typed addresses and the host permission patterns they need, or an error message. */
    read(): { urls: string[]; origins: string[] } | string {
      const urls = normalizeServerUrls([main.value, second.value]);
      if (urls.length === 0) return `Podaj pełny adres, np. ${URL_EXAMPLE}`;
      try {
        return { urls, origins: [...new Set(urls.map(originPattern))] };
      } catch {
        return `Podaj pełne adresy, np. ${URL_EXAMPLE}`;
      }
    },
  };
}

/**
 * Asks Chrome for access to the server addresses, then runs onGranted. Must be called directly in the
 * submit handler, before any await (the prompt needs the user gesture). It runs in a tab (see page-mode.ts),
 * so the page survives the prompt and the callback runs.
 */
export function requestHostPermission(origins: string[], status: HTMLElement, onGranted: () => void) {
  chrome.permissions.request({ origins }, (granted) => {
    if (!granted) return setStatus(status, NO_PERMISSION, true);
    onGranted();
  });
}
