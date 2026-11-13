import * as files from "@passholder/core/files";
import { IdbFileStore } from "../files/idb-file-store.ts";
import { PhoneClient } from "../phone-client.ts";
import { chromeStore, VaultStore } from "../vault-store.ts";
import { hostPermissionGranted } from "./phone-url-fields.ts";

/** The one VaultStore of this page, shared by all views. */
export const local = chromeStore(chrome.storage.local);
export const store = new VaultStore(
  local,
  chromeStore(chrome.storage.session),
  (url) => new PhoneClient(url),
  Date.now,
  hostPermissionGranted,
  // happy-dom (UI tests) has no IndexedDB: those pages keep the files in memory.
  typeof indexedDB !== "undefined" ? new IdbFileStore() : new files.MemoryLocalFileStore(),
);
