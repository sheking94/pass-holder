# Autouzupełnianie w Chrome (V3, krok B1) – plan wdrożenia

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wtyczka wpisuje login i hasło, dane karty i dane kontaktu w formularz na bieżącej karcie: przyciskiem „Wypełnij” w okienku albo skrótem Ctrl+Shift+L.

**Architecture:** Czysta logika (dopasowanie adresu, rozpoznawanie pól, wartości do wpisania) w `core/src/autofill/` ze wspólnymi wektorami w `core/test-vectors/autofill/` (krok B2 przeniesie ją do Kotlina). Service worker odszyfrowuje jeden wpis (`VaultStore.resume()`), sprawdza adres karty i wstrzykuje do strony zbudowany osobno skrypt `autofill-content.js` (`chrome.scripting`, uprawnienie `activeTab`), a potem woła w nim `fillPage(plan)`. Okienko wysyła do service workera tylko `{entryId, tabId}`.

**Tech Stack:** TypeScript, esbuild, vitest, happy-dom, Chrome MV3 (`activeTab`, `scripting`, `commands`).

**Spec:** `docs/superpowers/specs/2026-11-09-autouzupelnianie-design.md` (sekcje 3, 4, 6, 7, 8). Wykonawcy czytają spec i plan.

**Odstępstwa od specu (świadome):**
- Spec 4.3 p. 3–4: `fillPage` miał być samodzielną funkcją w `func`. Funkcja w `func` nie może mieć importów, a potrzebuje `classifyField` i słownika, więc najpierw wstrzykiwany jest zbudowany plik `autofill-content.js` (`files`), a potem wołane jest `passholderFill(plan)` (`func` + `args`). Oba działają w izolowanym świecie wtyczki: skrypty strony nie widzą `passholderFill` ani planu.
- Spec 4.3 p. 1: wiadomość ma też `tabId` (okienko zna kartę, z której zostało otwarte; service worker nie musi zgadywać).
- Spec 3.3 p. 3 podaje `e-?mail` jako słowo dla `username`. Plan: `e-?mail` → `email` (potrzebne dla kontaktów); login i tak trafia w pole `email`, gdy formularz nie ma pola `username` (3.4).

## Global Constraints

- Uprawnienia dochodzą tylko dwa: `activeTab`, `scripting`. Bez `host_permissions`, bez `content_scripts` w manifeście.
- `minimum_chrome_version` = `"127"`; esbuild `target: "chrome127"`.
- Skrót: komenda `fill-login`, `suggested_key` `{ "default": "Ctrl+Shift+L", "mac": "Command+Shift+L" }`, opis „Wypełnij login na tej stronie”.
- Do strony trafiają tylko pola potrzebne do wypełnienia (`FillPlan`), nigdy klucze ani inne wpisy.
- Karta: tylko `https:` (wyjątek: host `localhost`). Login: ponowne `matchLogins` w service workerze.
- Ramki: wypełniana tylko ramka o tym samym `origin` co strona główna.
- Pola ukryte, `disabled`, `readonly`, `type=hidden` nie są wypełniane; pusta wartość nie nadpisuje pola.
- Teksty w UI po polsku, dokładnie jak w spec: „Pasujące do tej strony”, „Wypełnij”, „Nie znaleziono pól logowania”, „Nie znaleziono pól karty (mogą być w ramce operatora płatności), skopiuj dane ręcznie”, „Nie znaleziono pól adresu”.
- Sortowanie po nazwie: `Intl.Collator("pl")`.
- Kod w `core/src/autofill/` nie importuje nic z przeglądarki (działa w Node i w stronie).

## Review Focus

1. **Strona zmieniła adres** między otwarciem okienka a kliknięciem „Wypełnij” (np. przekierowanie na obcą domenę) → login nie jest wpisywany, komunikat „Ta strona nie pasuje do loginu”. Test w zadaniu 5.
2. **Pole loginu `name="email"` z `autocomplete="off"`** → rozpoznane jako `email`, dostaje login (brak pola `username`). Test w zadaniu 4.
3. **Formularz rejestracji bez `autocomplete`** z dwoma polami hasła („Hasło”, „Powtórz hasło”) → hasła nie są wpisywane (formularz z więcej niż jednym widocznym polem hasła nie jest logowaniem). Test w zadaniu 4.
4. **Pola sterowane przez React** (setter `value` nadpisany na elemencie) → wartość ustawiana setterem z `HTMLInputElement.prototype`, zdarzenia `input` i `change` z `bubbles: true`. Test w zadaniu 4.
5. **Sejf zablokował się** (auto-blokada lub PIN po restarcie) przy otwartym okienku → „Wypełnij” daje „Sejf jest zablokowany. Odblokuj go i spróbuj ponownie”, nic nie jest wstrzykiwane. Test w zadaniu 5.

---

### Task 1: Dopasowanie loginu do strony (`matchLogins`)

**Files:**
- Create: `core/src/autofill/match.ts`, `core/src/autofill/index.ts`
- Modify: `core/src/index.ts` (dodaj `export * as autofill from "./autofill/index.ts";`)
- Create: `core/test-vectors/autofill/match.json`
- Test: `core/test/autofill/match.test.ts`

**Interfaces:**
- Produces:
  - `interface MatchCandidate { name: string; urls: readonly string[] }`
  - `type MatchKind = "exact" | "subdomain"`
  - `function matchLogins<T>(pageUrl: string, items: readonly T[], candidate: (item: T) => MatchCandidate): T[]` (wywołanie dla wpisów: `matchLogins(url, store.listEntries("login"), (e) => ({ name: e.data.name, urls: e.data.type === "login" ? e.data.fields.urls : [] }))`) – wynik posortowany: najpierw `exact`, potem `subdomain`, w grupie `Intl.Collator("pl").compare` po `name`.
  - `function matchUrl(pageUrl: string, savedUrl: string): MatchKind | undefined` – reguły 1–6 ze spec 3.1.
- Format `match.json`: `{ "cases": [ { "page": string, "saved": string, "expected": "exact" | "subdomain" | null, "why": string } ] }`.

- [ ] **Step 1: Napisz wektory `match.json`** – co najmniej te przypadki (strona → zapisany → wynik):
  `https://google.com/x` → `google.com` → `exact`; `https://www.google.com` → `https://google.com` → `exact`;
  `https://google.com` → `https://www.google.com/login` → `exact`; `https://accounts.google.com` → `google.com` → `subdomain`;
  `https://evilgoogle.com` → `google.com` → `null`; `https://google.com.evil.pl` → `google.com` → `null`;
  `http://google.com` → `https://google.com` → `null`; `https://google.com` → `http://google.com` → `exact`;
  `https://GOOGLE.com./` → `google.com` → `exact`; `https://a.example:8443` → `https://a.example:8443` → `exact`;
  `https://a.example:8443` → `https://a.example` → `null`; `https://a.example` → `https://a.example:443` → `exact`;
  `http://192.168.1.10:8080` → `http://192.168.1.10:8080` → `exact`; `http://1.192.168.1.10` → `192.168.1.10` → `null`;
  `http://localhost:3000` → `http://localhost:3000` → `exact`; `chrome://settings` → `settings` → `null`;
  `https://a.example` → `nie adres ::` → `null`; `file:///c:/x.html` → `file:///c:/x.html` → `null`.
- [ ] **Step 2: Napisz test** `match.test.ts`: dla każdego przypadku `expect(matchUrl(c.page, c.saved) ?? null).toBe(c.expected)`; osobny test `matchLogins("https://mail.google.com", [{name:"B",urls:["mail.google.com"]},{name:"A",urls:["google.com"]},{name:"C",urls:["x.pl"]}], (x) => x)` → nazwy `["B","A"]`; `matchLogins` z wpisem o kilku adresach bierze najlepszy (`exact` > `subdomain`); strona `chrome://` → `[]`.
- [ ] **Step 3:** `cd core && npx vitest run test/autofill/match.test.ts` → FAIL (brak modułu).
- [ ] **Step 4: Zaimplementuj** `match.ts` na `URL`: adres bez `://` poprzedź `https://`; port pusty = domyślny; IP (IPv4 regex, IPv6 w `[]`) i `localhost` tylko równość; tylko schematy `http:`/`https:`.
- [ ] **Step 5:** test → PASS; `npx tsc --noEmit` w `core/` bez błędów.
- [ ] **Step 6: Commit** `feat(core): match logins to a page address`.

### Task 2: Rozpoznawanie pól (`classifyField`)

**Files:**
- Create: `core/src/autofill/fields.ts`, `core/src/autofill/keywords.ts`
- Modify: `core/src/autofill/index.ts`
- Create: `core/test-vectors/autofill/fields.json`
- Test: `core/test/autofill/fields.test.ts`

**Interfaces:**
- Produces:
  - `type FieldKind = "username" | "password" | "newPassword" | "ccName" | "ccNumber" | "ccExp" | "ccExpMonth" | "ccExpYear" | "ccCsc" | "givenName" | "familyName" | "fullName" | "email" | "tel" | "street" | "postalCode" | "city" | "country" | "bday"`
  - `interface FieldDescriptor { autocomplete: string[]; type: string; name: string; id: string; label: string; placeholder: string; maxLength?: number; options?: { value: string; text: string }[] }` (wszystkie teksty jak w DOM; `autocomplete` to tokeny atrybutu lub `autofillHints` z Androida; `type` dla `<select>` = `"select"`).
  - `function classifyField(field: FieldDescriptor): FieldKind | null`
  - `const AUTOCOMPLETE_TOKENS: Readonly<Record<string, FieldKind>>` i `const KEYWORDS: readonly { kind: FieldKind; pattern: RegExp }[]` w `keywords.ts` (kolejność ma znaczenie: pierwszy trafiony wygrywa).
  - `function normalizeText(s: string): string` – małe litery, NFD bez znaków łączących, `ł`→`l`.
- Format `fields.json`: `{ "cases": [ { "field": FieldDescriptor, "expected": FieldKind | null } ] }` – brakujące pola deskryptora w wektorze = `""` / `[]`.

- [ ] **Step 1: Wektory `fields.json`** – minimum 40 przypadków: każdy token z listy spec 3.3 (oba warianty `country`/`country-name`, `address-line1`, `street-address`, `address-level2`, `current-password`→`password`, `new-password`→`newPassword`, tokeny z sekcją, np. `section-a shipping postal-code` → `postalCode`), stałe Androida (`emailAddress`, `password`, `username`, `creditCardNumber`, `creditCardSecurityCode`, `creditCardExpirationDate`, `creditCardExpirationMonth`, `creditCardExpirationYear`, `postalCode`, `phone`, `personGivenName`, `personFamilyName`, `personName`, `postalAddress`→`street`), `autocomplete="off"` z `name="email"` → `email`, `type=password` bez innych danych → `password`, `type=tel` → `tel`, słowa PL: `numer karty`, `Data ważności`, `kod CVV`, `Imię`, `Nazwisko`, `Kod pocztowy`, `Miejscowość`, `Ulica`, `Login`, `Nazwa użytkownika`, `Powtórz hasło`→`newPassword`, słowa EN: `card_number`, `cardholder`, `exp_month`, `exp_year`, `zip`, `first_name`, `last_name`, `phone`; pole bez sensu (`name="q"`, `placeholder="Szukaj"`) → `null`; `type=hidden` → `null`; `type=search` → `null`.
- [ ] **Step 2: Test** `fields.test.ts`: każdy przypadek z wektorów; plus `normalizeText("Łódź Ważność")` → `"lodz waznosc"`.
- [ ] **Step 3:** FAIL.
- [ ] **Step 4: Zaimplementuj** reguły 1→2→3 ze spec 3.3. Słowa szukane w `normalizeText(name + " " + id + " " + label + " " + placeholder)`; reguły dla `newPassword` (`powtorz|potwierdz|confirm|repeat|new.?pass|nowe.?haslo`) sprawdzane tylko dla pól typu `password` i przed regułą `password`. Pola `type` `hidden|search|submit|button|checkbox|radio|file` → `null` od razu.
- [ ] **Step 5:** PASS + `tsc`.
- [ ] **Step 6: Commit** `feat(core): classify form fields for autofill`.

### Task 3: Wartości do wpisania (`FillPlan`, `fillValue`)

**Files:**
- Create: `core/src/autofill/values.ts`
- Modify: `core/src/autofill/index.ts`
- Create: `core/test-vectors/autofill/values.json`
- Test: `core/test/autofill/values.test.ts`

**Interfaces:**
- Consumes: `FieldKind`, `FieldDescriptor` (Task 2); `EntryContentV3` z `core/src/p2p/entry.ts`.
- Produces:
  - `type FillPlan = { kind: "login"; username: string; password: string } | { kind: "card"; holder: string; number: string; expiry: string; cvc: string } | { kind: "contact"; firstName: string; lastName: string; email: string; tel: string; street: string; postalCode: string; city: string; country: string; bday: string }`
  - `function planFor(entry: EntryContentV3): FillPlan | undefined` – login/karta/kontakt (kontakt: pierwszy telefon, e-mail, adres; brak → `""`); inne typy → `undefined`.
  - `function fillValue(plan: FillPlan, kind: FieldKind, field: FieldDescriptor, form: { hasUsernameField: boolean }): string | undefined` – `undefined` = nie dotykaj pola (także gdy wartość pusta albo `kind` nie należy do typu planu).
- Format `values.json`: `{ "cases": [ { "plan": FillPlan, "kind": FieldKind, "field": FieldDescriptor, "hasUsernameField": boolean, "expected": string | null } ] }`.

- [ ] **Step 1: Wektory** – reguły spec 3.4: `email` dostaje login tylko gdy `hasUsernameField=false`; `ccNumber` `"4111 1111 1111 1111"` → `"4111111111111111"`; `ccExp` z `expiry="07/29"`: domyślnie `"07/29"`, `maxLength=7` → `"07/2029"`, `placeholder="MM/YYYY"` → `"07/2029"`; `ccExpMonth` → `"07"`, a `<select>` z opcjami `1..12` bez zera → `"7"`; `ccExpYear`: `maxLength=2` → `"29"`, `maxLength=4` lub brak → `"2029"`, `<select>` z opcjami `2026..2035` → `"2029"`, z opcjami `26..35` → `"29"`; zły `expiry` (`"7/2029"`, `""`) → pola daty `null`; `<select>` kraj z opcją tekstu `Polska` i `country="polska"` → wartość tej opcji, bez pasującej opcji → `null`; `fullName` → `"Jan Kowalski"`; `bday` → `"1990-05-01"`; `ccCsc` przy planie loginu → `null`; `newPassword` → zawsze `null`.
- [ ] **Step 2: Test** wektorów + `planFor` dla każdego typu (notatka i dokument → `undefined`, kontakt bez telefonów → `tel: ""`).
- [ ] **Step 3:** FAIL. **Step 4:** zaimplementuj. **Step 5:** PASS + `tsc`.
- [ ] **Step 6: Commit** `feat(core): values to fill per field`.

### Task 4: Skrypt na stronie (`fillPage`)

**Files:**
- Create: `extension/src/autofill/fill-page.ts` (logika DOM, eksportuje `fillPage`), `extension/src/autofill-content.ts` (punkt wejścia: `globalThis.passholderFill = fillPage`)
- Modify: `extension/build.mjs` (drugie wywołanie `build` dla `src/autofill-content.ts`, `format: "iife"`, wynik `dist/autofill-content.js`; oba wywołania `target: "chrome127"`)
- Test: `extension/test/autofill/fill-page.test.ts` (`// @vitest-environment happy-dom`)

**Interfaces:**
- Consumes: `autofill.classifyField`, `autofill.fillValue`, `autofill.FillPlan` z `@passholder/core`.
- Produces:
  - `function describeField(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): FieldDescriptor` – etykieta z `<label for>`, otaczającego `<label>`, `aria-label` albo `aria-labelledby`.
  - `function fillPage(plan: FillPlan, doc?: Document): { filled: number }` – `doc` domyślnie `document`.
  - W ramce o innym `origin` niż `window.top` (dostęp do `top.location.origin` rzuca albo różni się) → `{ filled: 0 }` bez dotykania pól.
  - `declare global { var passholderFill: typeof fillPage | undefined }`.

- [ ] **Step 1: Testy** (każdy buduje HTML w `document.body.innerHTML`, woła `fillPage`, sprawdza `value` i liczbę):
  - `fills a simple login form` – `username` + `password`, `filled: 2`;
  - `fills username only in a two-step login` – sam `<input name="login">` → `filled: 1`;
  - `email field gets the login when there is no username field` (Review Focus 2: `name="email" autocomplete="off"`);
  - `skips passwords in a registration form` (Review Focus 3: dwa pola hasła bez `autocomplete` → hasła puste);
  - `skips new-password fields`;
  - `uses the first form with a visible password field` – dwa formularze (wyszukiwarka u góry, logowanie niżej);
  - `skips hidden, disabled and readonly fields` (`style="display:none"`, `hidden`, `disabled`, `readonly`, `type=hidden`);
  - `sets value through the prototype setter and fires input and change` (Review Focus 4: nadpisz `value` na elemencie przez `Object.defineProperty`, sprawdź że setter z prototypu ustawił wartość, a nasłuch `input`/`change` na `document` dostał oba zdarzenia);
  - `fills a card with one expiry field` i `fills a card with month and year selects`;
  - `fills an address form` (imię, nazwisko, e-mail, telefon, ulica, kod, miasto, kraj `<select>`);
  - `does not overwrite with empty values` – kontakt bez telefonu, pole `tel` z `"123"` zostaje `"123"`;
  - `returns 0 in a frame from another origin` – podmień `window.top` na obiekt, którego `location.origin` rzuca.
- [ ] **Step 2:** `cd extension && npx vitest run test/autofill/fill-page.test.ts` → FAIL.
- [ ] **Step 3: Zaimplementuj.** Widoczność: `el.offsetParent !== null || el.getClientRects().length > 0` nie działa w happy-dom – użyj `getComputedStyle(el).display !== "none" && visibility !== "hidden"` dla elementu i przodków oraz atrybutu `hidden`. Login: wybierz pierwszy `<form>` (albo `document`, gdy pól nie ma w formularzu) z dokładnie jednym widocznym polem `password`; brak takiego → pierwsze widoczne pole `username`/`email` na stronie dostaje sam login. Karta i kontakt: wszystkie widoczne pola dokumentu.
- [ ] **Step 4:** PASS; `npm run build` w `extension/` tworzy `dist/autofill-content.js` (sprawdź `ls dist`).
- [ ] **Step 5: Commit** `feat(extension): fill forms in the page`.

### Task 5: Wypełnianie z service workera i skrót

**Files:**
- Create: `extension/src/autofill/fill-tab.ts`
- Modify: `extension/src/background.ts` (nasłuch wiadomości `fill` i `chrome.commands.onCommand`), `extension/static/manifest.json` (uprawnienia, `commands`, `minimum_chrome_version`)
- Test: `extension/test/autofill/fill-tab.test.ts`

**Interfaces:**
- Consumes: `fillPage` / `globalThis.passholderFill` (Task 4), `autofill.matchLogins`, `autofill.planFor`, `VaultStore` (`resume()`, `getEntry(id)`, `listEntries("login")`).
- Produces:
  - `interface TabApi { get(tabId: number): Promise<{ id?: number; url?: string }>; inject(tabId: number, plan: FillPlan): Promise<number> }` – `inject` w produkcji: `chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["autofill-content.js"] })`, potem `executeScript({ target: { tabId, allFrames: true }, func: (p) => globalThis.passholderFill?.(p).filled ?? 0, args: [plan] })`, suma `result` ze wszystkich ramek (`InjectionResult[]`, brak `result` = 0). Chrome sam pomija ramki bez dostępu; gdy wywołanie rzuci (brak dostępu do strony głównej), `inject` rzuca, a `fillTab` zwraca `UNSUPPORTED_PAGE`.
  - `function chromeTabApi(): TabApi`
  - `type FillMessage = { target: "background"; type: "fill"; entryId: string; tabId: number }`; odpowiedź `FillResult = { ok: true } | { ok: false; error: string }`.
  - `async function fillTab(store: VaultStore, tabs: TabApi, tabId: number, entryId: string): Promise<FillResult>`
  - `async function onFillCommand(store: VaultStore, tabs: TabApi, tab: { id?: number; url?: string } | undefined, openPopup: () => Promise<void>): Promise<void>`
  - Stałe komunikatów (eksportowane): `LOCKED = "Sejf jest zablokowany. Odblokuj go i spróbuj ponownie"`, `NOT_MATCHING = "Ta strona nie pasuje do loginu"`, `CARD_NEEDS_HTTPS = "Kartę wypełniam tylko na stronach https"`, `UNSUPPORTED_PAGE = "Na tej stronie nie można wypełniać"`, `NO_FIELDS = { login: "Nie znaleziono pól logowania", card: "Nie znaleziono pól karty (mogą być w ramce operatora płatności), skopiuj dane ręcznie", contact: "Nie znaleziono pól adresu" }`.

- [ ] **Step 1: Testy** z `memoryStore` i odblokowanym `VaultStore` (wzór z `test/ui/fake-chrome.ts`) oraz atrapą `TabApi` zapisującą wywołania `inject`:
  - `fills a matching login` → `{ok:true}`, `inject` dostał `{kind:"login",username,password}`;
  - `refuses a login when the tab moved to another site` (Review Focus 1) → `NOT_MATCHING`, brak `inject`;
  - `refuses a card on http` / `allows a card on http://localhost`;
  - `refuses chrome:// pages` → `UNSUPPORTED_PAGE`;
  - `reports locked vault` (Review Focus 5: usuń klucze z sesji) → `LOCKED`, brak `inject`;
  - `reports no fields` (atrapa zwraca 0) → właściwy tekst z `NO_FIELDS` dla każdego typu;
  - `command fills the only matching login` / `command opens the popup for zero or several matches` / `command opens the popup when locked`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Zaimplementuj** `fill-tab.ts`. `fillTab`: `store.resume()` (false → `LOCKED`), wpis (`getEntry`), `planFor`, adres karty (`tabs.get`), reguły z Global Constraints, `inject`. W `background.ts`: `chrome.runtime.onMessage` dla `type: "fill"` odpowiada przez `sendResponse` (zwróć `true` z nasłuchu); `chrome.commands.onCommand.addListener((command, tab) => command === "fill-login" && onFillCommand(...))` z `openPopup = () => chrome.action.openPopup()`. Service worker tworzy `new VaultStore(chromeStore(chrome.storage.local), chromeStore(chrome.storage.session))` przy każdym zdarzeniu.
- [ ] **Step 4: Manifest** – Global Constraints (uprawnienia, `commands`, wersja 127).
- [ ] **Step 5:** PASS; `npm test`, `npm run typecheck`, `npm run build` w `extension/` bez błędów.
- [ ] **Step 6: Commit** `feat(extension): fill the active tab from the service worker and shortcut`.

### Task 6: Okienko – „Pasujące do tej strony” i „Wypełnij”

**Files:**
- Modify: `extension/src/views/list.ts`, `extension/static/popup.css`
- Create: `extension/src/ui/active-tab.ts`
- Modify: `extension/test/ui/fake-chrome.ts` (atrapa `chrome.tabs.query`, `chrome.runtime.sendMessage` dla `fill`, `window.close`)
- Test: `extension/test/ui/autofill-view.test.ts`
- Modify: `extension/scripts/screenshots.mjs` (zrzuty `12-pasujace.png`, `13-karta-wypelnij.png`)

**Interfaces:**
- Consumes: `FillMessage`, `FillResult` (Task 5), `autofill.matchLogins` (Task 1), `pageMode`/`isInTab` z `page-mode.ts`.
- Produces:
  - `async function activeTab(): Promise<{ id: number; url: string } | undefined>` – `chrome.tabs.query({ active: true, currentWindow: true })`; `undefined` w trybie karty (`isInTab(pageMode(location.search))`) i gdy brak `id`/`url`.
  - `async function requestFill(tabId: number, entryId: string): Promise<FillResult>`

- [ ] **Step 1: Testy** (happy-dom, `fake-chrome.ts`):
  - `shows matching logins above the list` – aktywna karta `https://mail.google.com`, loginy „Poczta” (`google.com`) i „Bank” (`bank.pl`) → sekcja z nagłówkiem „Pasujące do tej strony” zawiera tylko „Poczta” z przyciskiem „Wypełnij”; pełna lista dalej ma oba;
  - `hides the section when nothing matches`;
  - `cards and contacts get a fill button in every row`; notatki i dokumenty – bez przycisku;
  - `no fill buttons in tab mode` (`location.search = "?tab"`);
  - `fill sends entry and tab id, closes the popup on success`;
  - `fill shows the error and keeps the popup open` (odpowiedź `{ok:false,error:NO_FIELDS.card}` → tekst w linii statusu).
- [ ] **Step 2:** FAIL. **Step 3:** zaimplementuj (sekcja renderowana tylko w zakładce Loginy, bez wyszukiwania w niej). **Step 4:** PASS + `npm test` + `npm run typecheck`.
- [ ] **Step 5: Zrzuty** `node extension/scripts/screenshots.mjs /mnt/project-files/wtyczka-v3` – nowe pliki istnieją.
- [ ] **Step 6: Commit** `feat(extension): fill buttons in the popup`.

### Task 7: Dokumentacja

**Files:**
- Modify: `docs/FUNKCJE.md` (rozdział „Autouzupełnianie” – Chrome: jak działa, skrót, ograniczenia, bezpieczeństwo), `docs/ARCHITEKTURA.md` (moduł `core/src/autofill/`, `autofill-content.js`, przepływ okienko → service worker → strona, diagram tekstowy), `docs/TESTY.md` (T18 wg spec 7: login, skrót przy jednym i dwóch loginach, karta https, adres, strona http z kartą), `docs/INSTALACJA.md` (zmiana skrótu w `chrome://extensions/shortcuts`, wymagany Chrome ≥ 127).

- [ ] **Step 1:** opisz zgodnie z kodem (nazwy plików i funkcji jak w zadaniach 1–6), krótko.
- [ ] **Step 2:** `cd core && npx vitest run && cd ../extension && npm test && npm run typecheck` – wszystko PASS.
- [ ] **Step 3: Commit** `docs: autofill in Chrome`.
