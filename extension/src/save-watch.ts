import { startSaveWatch } from "./save/watch.ts";
import type { ToWatchMessage } from "./save/messages.ts";

export { startSaveWatch };

startSaveWatch(document, {
  send: (m) => {
    // After the extension is reloaded, old pages keep this script and sendMessage throws at once
    // ("Extension context invalidated"): turn that into a rejection the watcher already ignores.
    try {
      return chrome.runtime.sendMessage(m);
    } catch (error) {
      return Promise.reject(error);
    }
  },
  onMessage: (h) => {
    chrome.runtime.onMessage.addListener((m: unknown) => {
      if ((m as { target?: unknown } | null)?.target === "save-watch") h(m as ToWatchMessage);
    });
  },
  panelUrl: (id) => chrome.runtime.getURL("save-prompt.html") + "?id=" + encodeURIComponent(id),
});
