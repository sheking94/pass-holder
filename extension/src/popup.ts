/**
 * Entry point of popup.html, both in the toolbar popup and in the tabs (see page-mode.ts).
 * Every screen is a view in views/; ui/ has the DOM helpers, the page mode and the shared VaultStore.
 */
import { IN_TAB, MODE } from "./ui/page.ts";
import { store } from "./ui/state.ts";
import { addressesView } from "./views/addresses.ts";
import { showConnect } from "./views/connect.ts";
import { showLocked, showUnlocked } from "./views/locked.ts";

async function start() {
  if (IN_TAB) document.body.classList.add("tab");
  if (!(await store.getAccount())) return showConnect();
  if (MODE === "addresses") return addressesView();
  if (await store.resume()) return showUnlocked();
  await showLocked();
}

void start();
