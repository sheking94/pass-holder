import { startSaveWatch } from "./save/watch.ts";

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
});
