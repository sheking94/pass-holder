# Wtyczka Chrome: przycisk „Otwórz w karcie”

Dokument opisuje zmianę z gałęzi `claude/project-thread-borcs6`.

## Problem

Okienko wtyczki (popup) Chrome zamyka, gdy tylko traci fokus: po kliknięciu na stronie, w innym oknie
albo gdy Chrome pokazuje własne okno. Razem z okienkiem znika cała strona wtyczki, więc wszystko, co było
wpisane w formularzu (np. nowy wpis w trakcie dodawania), przepada. Nie da się tego wyłączyć w popupie,
tak działa Chrome.

## Rozwiązanie

W popupie, nad zawartością, jest mały przycisk **Otwórz w karcie ↗**. Otwiera on tę samą stronę wtyczki
(`popup.html?tab`) w zwykłej karcie. Karta nie zamyka się po kliknięciu gdzie indziej, więc można
przełączać się między stroną a PassHolderem i kopiować dane bez utraty tego, co wpisane.

- Przycisk jest na ekranach: zablokowany sejf, lista wpisów, dodawanie/edycja wpisu.
  Na ekranie łączenia z serwerem go nie ma, bo tam jest już **Otwórz ustawienia połączenia** (to też karta).
- W karcie przycisk się nie pokazuje.
- Jeśli karta PassHolder jest już otwarta, przycisk przełącza na nią (i jej okno) zamiast otwierać kolejną.
- Po kliknięciu popup się zamyka.
- Odblokowany sejf zostaje odblokowany w karcie: klucze są w `chrome.storage.session`, wspólnym dla
  popupu i karty, a `start()` woła `store.resume()` tak samo jak w popupie.

Ograniczenie: to, co już wpisałeś w popupie przed kliknięciem przycisku, nie jest przenoszone do karty.
Przycisk trzeba kliknąć przed rozpoczęciem pisania.

## Kod

Stan po PR #16 (podział `popup.ts` na widoki). Przy PR #9 te same rzeczy były w `popup.ts` i
`open-in-tab.ts` pod innymi nazwami (`IN_TAB`, `isTabPage`, `openSetupTab` …), patrz „Stare nazwy” w
[ARCHITEKTURA.md](ARCHITEKTURA.md#stare-nazwy).

### `extension/src/page-mode.ts`

- `PageMode = "popup" | "tab" | "setup" | "addresses" | "transfer"`: która to strona. `?setup` to karta
  łączenia z serwerem (PR #8), `?tab` to karta z przycisku, `?addresses` i `?transfer` to karty adresów
  (PR #12) i CSV (PR #10).
- `pageMode(location.search)`: odczytuje tryb z adresu.
- `isInTab(mode)`: każda karta (wszystko poza popupem).
- `isMainTab(mode)`: karta z całą wtyczką, czyli `tab` albo `setup`. Tylko na nią przełącza przycisk.
- `modeQuery(mode)`: np. `"?tab"`.

### `extension/src/open-in-tab.ts`

- `TabApi`: trzy operacje na kartach, wydzielone, żeby dało się je podmienić w testach:
  `openTabs()` (otwarte karty z PassHolderem), `focus(tabId, windowId)`, `create(url)`.
- `chromeTabApi()`: implementacja na `chrome.*`.
  - `openTabs()` używa `chrome.runtime.getContexts({ contextTypes: ["TAB"] })`. To API zwraca strony
    samej wtyczki otwarte w kartach (z `tabId`, `windowId`, `documentUrl`) bez uprawnienia `tabs`,
    więc `manifest.json` się nie zmienia. Wymaga Chrome 116+, manifest i tak wymaga 120.
  - `focus()` to `chrome.tabs.update(tabId, { active: true })` i `chrome.windows.update(windowId, { focused: true })`.
  - `create()` to `chrome.tabs.create({ url })`.
- `openInTab(api, pageUrl)`: szuka karty, której adres zaczyna się od `pageUrl` (`…/popup.html`) i której
  tryb spełnia `isMainTab`. Jest: przełącza na nią. Nie ma: otwiera `popup.html?tab`.

### `extension/src/ui/page.ts`

- `MODE = pageMode(location.search)` i `IN_TAB = isInTab(MODE)`. W każdej karcie `body` dostaje klasę `tab`
  (`popup.ts`), a łączenie z serwerem (po „Odłącz tę przeglądarkę”) odbywa się w niej bez przenoszenia do
  kolejnej karty.
- `openInTabButton()`: zwraca pasek z przyciskiem albo `undefined` w każdej karcie; `show()` pomija `undefined`.
  Kliknięcie: `openInTab(chromeTabApi(), chrome.runtime.getURL("popup.html"))`, potem `window.close()`.
- `showInTab(mode, view)`: w karcie pokazuje widok od razu, w popupie otwiera kartę w danym trybie i zamyka
  popup. Używają jej `showConnect` (`"setup"`), `openAddresses` (`"addresses"`) i `openTransfer` (`"transfer"`).

### Widoki (`extension/src/views/`)

- `locked.ts`, `list.ts`, `edit.ts`: `openInTabButton()` jako pierwszy element w `show(...)`.
- Współpraca z przyciskami z PR #10 i #12 w karcie:
  - **CSV** (`openTransfer`) pokazuje import/eksport w tej samej karcie, bo w karcie okno wyboru pliku
    działa.
  - **Adresy serwera** (`openAddresses`) też pokazuje formularz w tej samej karcie (okno zgody Chrome
    nie zamyka karty). Pod formularzem jest wtedy przycisk **Wróć do listy**. Z popupu adresy dalej
    otwierają się w osobnej karcie `?addresses`, bez tego przycisku.

### `extension/static/popup.css`

- `.topbar`: pasek wyrównany do prawej nad nagłówkiem.
- `button.small`: mniejszy, wyszarzony przycisk, żeby nie konkurował z przyciskami głównymi.

## Testy

`extension/test/open-in-tab.test.ts` (z udawanym `TabApi`):

- `pageMode` rozpoznaje każdy tryb, a pusty adres i inne parametry to `popup`.
- Karta CSV albo adresów nie jest kartą główną: przycisk otwiera wtedy nową kartę `?tab`.
- Bez otwartej karty: tworzy `popup.html?tab`.
- Z otwartą kartą `?tab` albo `?setup`: przełącza na nią, nie tworzy nowej.
- Inne strony wtyczki (np. `offscreen.html`) są ignorowane.

Sprawdzone też ręcznie w Chromium (Playwright) na zbudowanym `dist/` z podstawionym obiektem `chrome`:
przycisk widać w popupie, nie widać w karcie, kliknięcie woła `tabs.create(…popup.html?tab)` i zamyka popup,
a przy otwartej karcie woła `tabs.update` + `windows.update`. Nie udało się załadować wtyczki do Chromium
w środowisku testowym, więc samego `chrome.runtime.getContexts` w prawdziwym Chrome nie sprawdziłem.
Do sprawdzenia u Ciebie: przebuduj wtyczkę (`npm run build -w extension`), przeładuj ją w
`chrome://extensions` i kliknij przycisk dwa razy (drugi raz powinien przełączyć na istniejącą kartę).
