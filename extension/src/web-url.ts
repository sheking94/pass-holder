/** Parsing the addresses Chrome reports for tabs, frames and message senders. */

/** The URL, or undefined when raw is missing or not a URL. */
export function parseUrl(raw: string | undefined): URL | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/** The URL of a web page (http or https); undefined for anything else (chrome://, file:, extension pages…). */
export function webUrl(raw: string | undefined): URL | undefined {
  const url = parseUrl(raw);
  return url && (url.protocol === "http:" || url.protocol === "https:") ? url : undefined;
}

/**
 * Whether a message comes from a page of this extension (popup, tab, question window), not from its content
 * script running inside a web page (review V3-I4). Other extensions arrive at onMessageExternal; the sender URL
 * keeps out this extension's own content scripts.
 */
export function fromExtensionPage(
  sender: { id?: string; url?: string },
  extensionId: string,
): boolean {
  return (
    sender.id === extensionId && (sender.url ?? "").startsWith(`chrome-extension://${extensionId}/`)
  );
}
