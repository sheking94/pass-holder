/**
 * Keys in chrome.storage. account, vault and generator are in local storage; sessionKeys and pendingPairing
 * in session storage. pinLock is in session storage, or in local storage if the user wants the PIN to survive
 * a browser restart. The v1 keys of the Raspberry Pi version ("account", "vault") are not read: that data
 * moves to the phone through a file export.
 */
export const STORAGE_KEYS = {
  account: "accountV2",
  vault: "vaultV2",
  pendingPairing: "pendingPairing",
  sessionKeys: "keys",
  generator: "generator",
  pinLock: "pinLock",
  /** session: save candidates by tab id; local: hosts the user never wants to be asked about. */
  saveCandidates: "saveCandidates",
  saveNever: "saveNever",
  /** session: tab id → the window that shows its save question (prompt-window.ts). */
  savePromptWindows: "savePromptWindows",
  /** local: ids of attachments whose download did not match their descriptor; sync skips them. */
  corruptFiles: "corruptFiles",
} as const;

/** Key-value storage; chrome.storage.local and chrome.storage.session in the extension, a Map in tests. */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export function chromeStore(area: chrome.storage.StorageArea): KeyValueStore {
  return {
    async get<T>(key: string) {
      return (await area.get(key))[key] as T | undefined;
    },
    set: (key, value) => area.set({ [key]: value }),
    remove: (key) => area.remove(key),
  };
}

export function memoryStore(): KeyValueStore {
  const data = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return structuredClone(data.get(key)) as T | undefined;
    },
    async set(key, value) {
      data.set(key, structuredClone(value));
    },
    async remove(key) {
      data.delete(key);
    },
  };
}
