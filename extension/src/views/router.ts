/**
 * The views of popup.html ask for each other by name here instead of importing each other (review CW13):
 * views/index.ts registers them all once, and a view calls e.g. views().list({ message: SAVED }).
 */
import type { p2p } from "@passholder/core";
import type { SavePromptInfo } from "../save/messages.ts";
import { h } from "../ui/dom.ts";

export interface ListOptions {
  /** The status line under the list. */
  message?: string;
  /** Shows message as an error. */
  error?: boolean;
  /** The tab to show; without it the tab chosen last (Loginy at first). */
  type?: p2p.EntryType;
}

export interface Views {
  list(options?: ListOptions): void;
  edit(type: p2p.EntryType, id?: string): Promise<void>;
  /** The PIN screen when the PIN is on, otherwise the master password screen. */
  locked(message?: string): Promise<void>;
  unlocked(message?: string): Promise<void>;
  connect(): Promise<void>;
  /** The phone's addresses, in a tab (may need a host permission prompt). */
  addresses(): Promise<void>;
  /** Import and export, in a tab (the file chooser would close the popup). */
  transfer(): Promise<void>;
  pinSettings(): Promise<void>;
  saveSettings(): Promise<void>;
  saveQuestion(info: SavePromptInfo): void;
}

let registered: Views | undefined;

export function registerViews(all: Views): void {
  registered = all;
}

/** All views; views/index.ts must have been imported first. */
export function views(): Views {
  if (!registered) throw new Error("views/index.ts was not loaded");
  return registered;
}

/** „Wróć” and the like: back to the list (the tab chosen last). */
export function backToListButton(label = "Wróć"): HTMLButtonElement {
  return h("button", { type: "button", onclick: () => views().list() }, label);
}
