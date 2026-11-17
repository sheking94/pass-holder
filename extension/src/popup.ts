/**
 * Entry point of popup.html, both in the toolbar popup and in the tabs (see page-mode.ts).
 * Every screen is a view in views/; ui/ has the DOM helpers, the page mode and the shared VaultStore.
 */
import { watchIdle } from "./auto-lock.ts";
import { IN_TAB, MODE } from "./ui/page.ts";
import { store } from "./ui/state.ts";
import { addressesView } from "./views/addresses.ts";
import { showConnect } from "./views/connect.ts";
import { showLocked, showUnlocked } from "./views/locked.ts";
import { AUTO_LOCK_MS } from "./vault-store.ts";

async function start() {
  if (IN_TAB) document.body.classList.add("tab");
  if (!(await store.getAccount())) return showConnect();
  if (MODE === "addresses") return addressesView();
  // The open page locks itself after AUTO_LOCK_MS without a click or a key (S1 of the security review).
  watchIdle(
    store,
    {
      addEventListener: (type, listener, options) =>
        window.addEventListener(type, listener, options),
      setInterval: (h, ms) => window.setInterval(h, ms),
    },
    () =>
      void showLocked(
        `Sejf został zablokowany: ${AUTO_LOCK_MS / 60_000} minut bez działania albo blokada w innym oknie PassHoldera.`,
      ),
  );
  if (await store.resume()) return showUnlocked();
  await showLocked();
}

void start();
