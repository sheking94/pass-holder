import { chromeStore, VaultStore } from "../vault-store.ts";

/** The one VaultStore of this page, shared by all views. */
export const local = chromeStore(chrome.storage.local);
export const store = new VaultStore(local, chromeStore(chrome.storage.session));
