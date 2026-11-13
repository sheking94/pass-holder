import { h } from "./dom.ts";

/** Saves data as a file in the browser's downloads (Blob + <a download>); the URL is revoked after a minute. */
export function downloadFile(fileName: string, data: BlobPart, mime: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const link = h("a", { href: url, download: fileName });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
