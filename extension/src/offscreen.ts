import { sha256Hex, type ClipboardMessage } from "./clipboard.ts";

// Offscreen documents never have focus, so navigator.clipboard is unavailable here; the older
// execCommand API still works in them.

function readClipboard(): string {
  const area = document.createElement("textarea");
  document.body.append(area);
  area.focus();
  document.execCommand("paste");
  const text = area.value;
  area.remove();
  return text;
}

function writeEmptyClipboard() {
  const onCopy = (event: ClipboardEvent) => {
    event.clipboardData?.setData("text/plain", "");
    event.preventDefault();
  };
  document.addEventListener("copy", onCopy);
  document.execCommand("copy");
  document.removeEventListener("copy", onCopy);
}

chrome.runtime.onMessage.addListener((message: ClipboardMessage, _sender, sendResponse) => {
  if (message.target !== "offscreen" || message.type !== "clear-if-unchanged") return;
  void (async () => {
    if ((await sha256Hex(readClipboard())) === message.hash) writeEmptyClipboard();
    sendResponse(true);
  })();
  return true; // keeps the channel open until sendResponse
});
