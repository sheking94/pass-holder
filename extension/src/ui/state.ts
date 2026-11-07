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
);
