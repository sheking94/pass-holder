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

### `extension/src/open-in-tab.ts` (nowy)

- `TAB_PARAM = "tab"`, `SETUP_PARAM = "setup"`: parametry adresu oznaczające stronę w karcie.
  `?setup` to karta łączenia z serwerem z PR #8, `?tab` to nowa karta z przycisku.
- `isTabPage(search)`: `true`, gdy w adresie jest `?tab` albo `?setup`.
- `TabApi`: trzy operacje na kartach, wydzielone, żeby dało się je podmienić w testach:
  `openTabs()` (otwarte karty z PassHolderem), `focus(tabId, windowId)`, `create(url)`.
- `chromeTabApi()`: implementacja na `chrome.*`.
  - `openTabs()` używa `chrome.runtime.getContexts({ contextTypes: ["TAB"] })`. To API zwraca strony
    samej wtyczki otwarte w kartach (z `tabId`, `windowId`, `documentUrl`) bez uprawnienia `tabs`,
    więc `manifest.json` się nie zmienia. Wymaga Chrome 116+, manifest i tak wymaga 120.
  - `focus()` to `chrome.tabs.update(tabId, { active: true })` i `chrome.windows.update(windowId, { focused: true })`.
  - `create()` to `chrome.tabs.create({ url })`.
- `openInTab(api, pageUrl)`: szuka karty, której adres zaczyna się od `pageUrl` (`…/popup.html`) i ma
  `?tab` lub `?setup`. Jest: przełącza na nią. Nie ma: otwiera `popup.html?tab`.

### `extension/src/popup.ts`

- `IN_TAB = isTabPage(location.search) || PARAMS.has("addresses")` (karta `?addresses` pochodzi z PR #12
  o wielu adresach serwera). Dzięki temu karta `?tab`
  zachowuje się jak karta `?setup`: `body` dostaje klasę `tab`, a łączenie z serwerem (po
  „Odłącz tę przeglądarkę”) odbywa się w niej bez przenoszenia do kolejnej karty.
- `openInTabButton()`: zwraca pasek z przyciskiem albo `undefined` w każdej karcie, także `?transfer`
  (import/eksport CSV z PR #10); `show()` pomija `undefined`.
  Kliknięcie: `openInTab(chromeTabApi(), chrome.runtime.getURL("popup.html"))`, potem `window.close()`.
- `lockedView`, `listView`, `editView`: `openInTabButton()` jako pierwszy element w `show(...)`.
- `openSetupTab` używa stałej `SETUP_PARAM`; zachowanie bez zmian (zawsze nowa karta).
- Współpraca z przyciskami z PR #10 i #12 w karcie `?tab`:
  - **CSV** (`openTransferTab`) pokazuje import/eksport w tej samej karcie, bo w karcie okno wyboru pliku
    działa (nie otwiera nowej karty).
  - **Adresy serwera** (`openAddressesTab`) otwiera osobną kartę jak wcześniej, ale `window.close()`
    woła tylko w popupie, żeby nie zamknąć Twojej karty PassHolder.

### `extension/static/popup.css`

- `.topbar`: pasek wyrównany do prawej nad nagłówkiem.
- `button.small`: mniejszy, wyszarzony przycisk, żeby nie konkurował z przyciskami głównymi.

## Testy

`extension/test/open-in-tab.test.ts` (z udawanym `TabApi`):

- `isTabPage` rozpoznaje `?tab` i `?setup`, a pusty adres i inne parametry nie.
- Bez otwartej karty: tworzy `popup.html?tab`.
- Z otwartą kartą `?tab` albo `?setup`: przełącza na nią, nie tworzy nowej.
- Inne strony wtyczki (np. `offscreen.html`) są ignorowane.

Sprawdzone też ręcznie w Chromium (Playwright) na zbudowanym `dist/` z podstawionym obiektem `chrome`:
przycisk widać w popupie, nie widać w karcie, kliknięcie woła `tabs.create(…popup.html?tab)` i zamyka popup,
a przy otwartej karcie woła `tabs.update` + `windows.update`. Nie udało się załadować wtyczki do Chromium
w środowisku testowym, więc samego `chrome.runtime.getContexts` w prawdziwym Chrome nie sprawdziłem.
Do sprawdzenia u Ciebie: przebuduj wtyczkę (`npm run build -w extension`), przeładuj ją w
`chrome://extensions` i kliknij przycisk dwa razy (drugi raz powinien przełączyć na istniejącą kartę).
