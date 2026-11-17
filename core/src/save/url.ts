import { parseWebAddress } from "../web-address.ts";

/** Address to save a login under for a page (spec 3.1), or null when the page cannot be saved. */
export function saveUrl(pageUrl: string): string | null {
  const page = parseWebAddress(pageUrl, { assumeHttps: false });
  if (!page) return null;
  const withPort = page.port === "" ? page.host : `${page.host}:${page.port}`;
  return page.scheme === "https:" ? withPort : `http://${withPort}`;
}

/** Host of a `saveUrl` result without scheme and port. */
export function saveName(url: string): string {
  const rest = url.replace(/^https?:\/\//, "");
  const end = rest.startsWith("[") ? rest.indexOf("]") + 1 : rest.search(/:/);
  return end > 0 ? rest.slice(0, end) : rest;
}
