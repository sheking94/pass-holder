import { startSaveWatch } from "./save/watch.ts";
import type { ToWatchMessage } from "./save/messages.ts";

export { startSaveWatch };

startSaveWatch(document, {
  send: (m) => chrome.runtime.sendMessage(m),
  onMessage: (h) => {
    chrome.runtime.onMessage.addListener((m: unknown) => {
      if ((m as { target?: unknown } | null)?.target === "save-watch") h(m as ToWatchMessage);
    });
  },
  panelUrl: (id) => chrome.runtime.getURL("save-prompt.html") + "?id=" + encodeURIComponent(id),
});
