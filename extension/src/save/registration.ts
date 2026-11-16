/**
 * The save-watch content script is registered dynamically, and only while the user has granted the optional
 * https permission: that permission IS the "Pytaj o zapis haseł" switch (no separate flag to drift).
 * The service worker calls syncSaveWatch on every start and permission change.
 */
export const SAVE_ORIGINS = ["https://*/*", "http://*/*"] as const;
export const SAVE_SCRIPT_ID = "save-watch";

export interface SaveWatchApi {
  contains(origins: string[]): Promise<boolean>;
  remove(origins: string[]): Promise<boolean>;
  registered(): Promise<boolean>;
  register(): Promise<void>;
  unregister(): Promise<void>;
}

export function chromeSaveWatchApi(): SaveWatchApi {
  return {
    async contains(origins) {
      try {
        return await chrome.permissions.contains({ origins });
      } catch {
        return false;
      }
    },
    remove: (origins) => chrome.permissions.remove({ origins }),
    async registered() {
      const found = await chrome.scripting.getRegisteredContentScripts({ ids: [SAVE_SCRIPT_ID] });
      return found.length > 0;
    },
    register: () =>
      chrome.scripting.registerContentScripts([
        {
          id: SAVE_SCRIPT_ID,
          js: ["save-watch.js"],
          matches: [...SAVE_ORIGINS],
          allFrames: true,
          runAt: "document_idle",
          persistAcrossSessions: true,
        },
      ]),
    unregister: () => chrome.scripting.unregisterContentScripts({ ids: [SAVE_SCRIPT_ID] }),
  };
}

let syncing: Promise<unknown> = Promise.resolve();

/**
 * Makes the registration match the permission: granted and not registered → register; the reverse → unregister.
 * Calls run one after another (start and permission events can overlap), so none acts on a state another is changing.
 */
export function syncSaveWatch(api: SaveWatchApi): Promise<void> {
  const run = syncing.then(() => syncOnce(api));
  syncing = run.catch(() => undefined);
  return run;
}

async function syncOnce(api: SaveWatchApi): Promise<void> {
  const [allowed, registered] = await Promise.all([
    api.contains(["https://*/*"]),
    api.registered(),
  ]);
  if (allowed && !registered) await api.register();
  else if (!allowed && registered) await api.unregister();
}

// Takes the permission back; plain-http access stays while a phone address is http (the extension needs it to sync).
export async function disableSavePrompt(
  api: SaveWatchApi,
  phoneUrls: readonly string[],
): Promise<void> {
  await api.remove(["https://*/*"]);
  if (!phoneUrls.some((u) => u.startsWith("http:"))) await api.remove(["http://*/*"]);
}
