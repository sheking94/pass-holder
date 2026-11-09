/**
 * Which page this is: the toolbar popup or one of the tabs, read from the query string of popup.html.
 *
 * Chrome closes the popup as soon as it loses focus: a host permission prompt, a file chooser, a click on
 * the web page. Whatever needs one of those runs in a normal tab, which stays open:
 *  - "tab":       the whole extension, opened by the "Otwórz w karcie" button,
 *  - "setup":     pairing with the phone (the host permission prompt),
 *  - "addresses": the phone address form and pairing with another phone (host permission prompts),
 *  - "transfer":  import and export of all formats (the file chooser).
 */
export type PageMode = "popup" | "tab" | "setup" | "addresses" | "transfer";
export type TabMode = Exclude<PageMode, "popup">;

/** Checked in this order if, for some reason, the URL has more than one. */
const TAB_MODES: readonly TabMode[] = ["setup", "addresses", "transfer", "tab"];

export function pageMode(search: string): PageMode {
  const params = new URLSearchParams(search);
  return TAB_MODES.find((mode) => params.has(mode)) ?? "popup";
}

/** Any tab: a permission prompt or a file chooser cannot close it, so every view can be shown right here. */
export function isInTab(mode: PageMode): boolean {
  return mode !== "popup";
}

/** The tabs that show the whole extension; "Otwórz w karcie" switches to one of them instead of opening another. */
export function isMainTab(mode: PageMode): boolean {
  return mode === "tab" || mode === "setup";
}

/** The query string that opens popup.html in this mode, e.g. "?transfer". */
export function modeQuery(mode: TabMode): string {
  return `?${mode}`;
}
