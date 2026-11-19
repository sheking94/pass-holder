# Pytanie o zapis loginu w Chrome (V3, krok C1) – plan wdrożenia

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Po wysłaniu formularza logowania wtyczka pokazuje na stronie panel „Zapisać login w PassHolder?” / „Zaktualizować hasło w PassHolder?” i zapisuje login albo nowe hasło.

**Architecture:** Czysta logika (`saveUrl`, `decideSave`, `newLogin`) w `core/src/save/` ze wspólnymi wektorami w `core/test-vectors/save/` (krok C2 przeniesie ją do Kotlina). Skrypt `save-watch.js` (rejestrowany dynamicznie po włączeniu, tylko gdy jest uprawnienie `https://*/*`) czyta login i hasło przy wysłaniu formularza i wysyła je do service workera. Service worker (`SaveCandidates`) trzyma kandydata per karta w `chrome.storage.session`, decyduje i zapisuje; panel to strona wtyczki `save-prompt.html` w `<iframe>` w zamkniętym Shadow DOM, bez dostępu do hasła.

**Tech Stack:** TypeScript, esbuild, vitest, happy-dom, Chrome MV3 (`scripting.registerContentScripts`, `permissions`, `storage.session`, `alarms`, `action.openPopup`).

**Spec:** `docs/superpowers/specs/2026-11-11-pytanie-o-zapis-design.md` (sekcje 3, 4, 6, 7, 8). Wykonawcy czytają spec i plan.

**Odstępstwa od specu (świadome):**
- 4.1 „Stan przełącznika w `storage.local`”: stanem jest samo uprawnienie `https://*/*` (prosi o nie tylko ta funkcja). Powód: okienko zamyka się, gdy Chrome pokazuje pytanie o uprawnienie, więc flaga zapisana przed pytaniem rozjechałaby się z uprawnieniem. Tło rejestruje i wyrejestrowuje skrypt w `permissions.onAdded` / `onRemoved`, `runtime.onStartup` i `onInstalled`.
- 4.3 p. 4: kandydat nie przechowuje `decision`; tło liczy decyzję przy każdym `save-info` i `save-answer` (sejf mógł się zmienić w ciągu 2 minut).
- 4.4 „Zapisano przez 2 s”: chowaniem panelu zawsze steruje tło (`save-hide` do ramki głównej): od razu po „Nie teraz”/„Nigdy”, po 2 s po zapisie, także gdy zapis przyszedł z okienka.

## Global Constraints

- Manifest: `optional_host_permissions` = `["https://*/*", "http://*/*"]`; bez nowych stałych `permissions` ani `content_scripts`. `web_accessible_resources`: `[{ "resources": ["save-prompt.html"], "matches": ["https://*/*", "http://*/*"], "use_dynamic_url": true }]`.
- Rejestracja skryptu: `{ id: "save-watch", js: ["save-watch.js"], matches: ["https://*/*", "http://*/*"], allFrames: true, runAt: "document_idle", persistAcrossSessions: true }`.
- Kandydat żyje 2 minuty (`SAVE_TTL_MS = 120_000`), jeden na kartę; hasło nigdy nie trafia do `chrome.storage.local`, do panelu ani do wiadomości od tła do strony.
- Adres zapisu zawsze z `sender.url`, nigdy z treści wiadomości; ramki o innym origin niż strona główna są pomijane (w skrypcie i w tle).
- `save-info` i `save-answer` przyjmowane tylko od stron wtyczki: `sender.id === chrome.runtime.id` i `new URL(sender.url).protocol === "chrome-extension:"`. `save-candidate` i `save-pending` tylko od skryptu: ten sam `sender.id`, `sender.tab.id` jest, `sender.url` ma schemat `http:`/`https:`.
- Teksty dokładnie jak w specu: „Zapis”, „Zapis haseł”, „Pytaj o zapis haseł”, „Nigdy dla tych stron”, „Usuń”, „Zapisać login w PassHolder?”, „Zaktualizować hasło w PassHolder?”, „Zapisz”, „Aktualizuj”, „Nie teraz”, „Nigdy dla tej strony”, „Odblokuj i zapisz”, „Zapisano”.
- Kod w `core/src/save/` nie importuje nic z przeglądarki; `save-watch.js` importuje tylko `@passholder/core/autofill` (bez kryptografii w skrypcie strony).
- esbuild `target: "chrome127"`.

## Review Focus

1. **Logowanie w ramce z innym origin** (np. okienko SSO w `<iframe>` obcej domeny) → skrypt w tej ramce nic nie wysyła; tło odrzuca `save-candidate`, gdy origin `sender.url` ≠ origin `sender.tab.url`. Testy w zadaniach 3 i 4.
2. **Złe hasło z przeładowaniem**: po wysłaniu wraca ta sama strona z tym samym formularzem i pustym hasłem → panel się nie pokazuje, kandydat zostaje. Test w zadaniu 4.
3. **Strona czyści pola we własnym handlerze `submit`** (React) → skrypt czyta wartości w fazie przechwytywania (`capture: true`), zanim zadziała strona. Test w zadaniu 3.
4. **Sejf zablokowany przy wysłaniu, a po odblokowaniu ten login z tym hasłem już jest** (np. przyszedł z synchronizacji) → `save-info` zwraca `undefined`, kandydat usunięty, okienko pokazuje listę. Test w zadaniu 4.
5. **Wyłączenie przy adresie telefonu `http://…`** → usuwane jest tylko `https://*/*`; synchronizacja z telefonem dalej działa. Test w zadaniu 5.

---

### Task 1: Adres do zapisu (`saveUrl`)

**Files:**
- Create: `core/src/save/url.ts`, `core/src/save/index.ts`, `core/test-vectors/save/url.json`
- Modify: `core/src/index.ts` (`export * as save from "./save/index.ts";`), `core/package.json` (`exports["./save"] = "./src/save/index.ts"`)
- Test: `core/test/save/url.test.ts`

**Interfaces:**
- Produces: `function saveUrl(pageUrl: string): string | null` (spec 3.1); `function saveName(url: string): string` – host z wyniku `saveUrl` bez schematu i portu (`http://localhost:3000` → `localhost`).
- Format `url.json`: `{ "cases": [ { "page": string, "expected": string | null, "name": string | null, "why": string } ] }`.

- [ ] **Step 1: Wektory** (strona → wynik → nazwa): `https://github.com/login?x=1#a` → `github.com` → `github.com`; `https://WWW.GitHub.com./` → `github.com`; `https://www.github.com:443` → `github.com`; `https://a.example:8443/x` → `a.example:8443` → `a.example`; `http://intranet.local/login` → `http://intranet.local`; `http://intranet.local:80` → `http://intranet.local`; `http://localhost:3000/` → `http://localhost:3000` → `localhost`; `https://localhost` → `localhost`; `http://192.168.1.10:8080/a` → `http://192.168.1.10:8080` → `192.168.1.10`; `http://[::1]:8080` → `http://[::1]:8080` → `[::1]`; `https://accounts.google.com` → `accounts.google.com`; `https://www.` → `null`; `ftp://x.pl` → `null`; `chrome://settings` → `null`; `file:///c:/a.html` → `null`; `nie adres` → `null`.
- [ ] **Step 2: Test** `url.test.ts`: każdy przypadek `saveUrl(c.page) === c.expected`; dla `expected !== null`: `saveName(c.expected) === c.name` i `autofill.matchUrl(c.page, c.expected) === "exact"` (spec 3.1 „wynik zawsze pasuje”).
- [ ] **Step 3:** `cd core && npx vitest run test/save/url.test.ts` → FAIL (brak modułu).
- [ ] **Step 4: Zaimplementuj** na `URL` (bez dopisywania `https://`: wejście to pełny adres strony). Pusty host po zdjęciu `www.` → `null`.
- [ ] **Step 5:** PASS; `npx tsc --noEmit` w `core/`.
- [ ] **Step 6: Commit** `feat(core): address to save a login under`.

### Task 2: Decyzja i nowy wpis (`decideSave`, `newLogin`)

**Files:**
- Create: `core/src/save/decide.ts`, `core/test-vectors/save/decide.json`
- Modify: `core/src/save/index.ts`
- Test: `core/test/save/decide.test.ts`

**Interfaces:**
- Consumes: `emptyLogin`, `EntryContentV3` z `core/src/p2p/entry.ts`; `saveName` (Task 1).
- Produces:
  - `interface SavedLogin { id: string; username: string; password: string }`
  - `type SaveDecision = { kind: "none" } | { kind: "create" } | { kind: "update"; id: string }`
  - `function decideSave(username: string, password: string, logins: readonly SavedLogin[]): SaveDecision` (spec 3.2; `logins` w kolejności z `matchLogins`).
  - `function newLogin(url: string, username: string, password: string): EntryContentV3 & { type: "login" }` – `name = saveName(url)`, `urls = [url]`, reszta jak `emptyLogin`.
  - `function withPassword(entry: EntryContentV3 & { type: "login" }, password: string): EntryContentV3 & { type: "login" }` – kopia ze zmienionym tylko `fields.password`.
- Format `decide.json`: `{ "cases": [ { "username": string, "password": string, "logins": SavedLogin[], "expected": SaveDecision, "why": string } ] }`.

- [ ] **Step 1: Wektory:** ten sam login i hasło → `none`; ten sam login, inne hasło → `update` (id); dwa wpisy z tym loginem i innym hasłem → `update` pierwszego; jeden z innym hasłem, drugi z tym samym → `none`; brak wpisu z tym loginem → `create`; pusta lista → `create`; `" Jan@X.pl "` vs `jan@x.pl` → ten sam login; pusty login vs wpis z pustym loginem i innym hasłem → `update`; pusty login vs wpis `jan` → `create`; puste hasło → `none`.
- [ ] **Step 2: Test** wektorów + `newLogin("http://localhost:3000", "a", "b")` → `name: "localhost"`, `urls: ["http://localhost:3000"]`, `totp: ""`, `androidApps: []`; `withPassword` nie zmienia `note`, `urls`, `custom`.
- [ ] **Step 3:** FAIL. **Step 4:** zaimplementuj. **Step 5:** PASS + `tsc`.
- [ ] **Step 6: Commit** `feat(core): decide whether to save or update a login`.

### Task 3: Skrypt obserwujący (`save-watch.js`)

**Files:**
- Create: `extension/src/save/read-form.ts` (odczyt formularza), `extension/src/save/watch.ts` (zdarzenia, wiadomości, ramka panelu), `extension/src/save/messages.ts` (typy wiadomości), `extension/src/save-watch.ts` (punkt wejścia: `startSaveWatch(document)`)
- Modify: `extension/src/autofill/fill-page.ts` (eksportuj `isVisible`), `extension/build.mjs` (`src/save-watch.ts` w drugim wywołaniu `build`, `format: "iife"`)
- Test: `extension/test/save/read-form.test.ts`, `extension/test/save/watch.test.ts` (`// @vitest-environment happy-dom`)

**Interfaces:**
- Consumes: `describeField`, `isVisible` z `fill-page.ts`; `autofill.classifyField`.
- Produces:
  - `messages.ts`:
    - `type SaveCandidateMessage = { target: "background"; type: "save-candidate"; username: string; password: string; formSignature: string }`
    - `type SavePendingMessage = { target: "background"; type: "save-pending"; emptyLoginForms: string[] }`, odpowiedź `{ candidateId?: string }`
    - `type ToWatchMessage = { target: "save-watch"; type: "save-show"; candidateId: string } | { target: "save-watch"; type: "save-hide" }`
    - `type SaveInfoMessage = { target: "background"; type: "save-info"; candidateId?: string; tabId?: number }`, odpowiedź `SavePromptInfo | undefined`
    - `interface SavePromptInfo { id: string; host: string; username: string; decision: "create" | "update" | null; locked: boolean }` (`null` tylko przy `locked: true`)
    - `type SaveAnswerMessage = { target: "background"; type: "save-answer"; candidateId: string; answer: "save" | "later" | "never" }`, odpowiedź `{ ok: true } | { ok: false; error: string }`
  - `read-form.ts`:
    - `interface ReadLogin { username: string; password: string; formSignature: string }`
    - `function loginScope(el: Element): ParentNode | undefined` – `form` elementu, inaczej najbliższy przodek (do `body`) z widocznym `input[type=password]`.
    - `function readLogin(scope: ParentNode): ReadLogin | undefined` – spec 4.2 „Pola”; `undefined` przy pustym haśle.
    - `function formSignature(scope: ParentNode): string` – posortowane, unikalne `name || id` pól `input/select/textarea` (bez `type` `hidden|submit|button|reset|image`), złączone `,`.
    - `function emptyLoginForms(doc: Document): string[]` – `formSignature` każdego zakresu z widocznym, pustym polem hasła.
  - `watch.ts`: `function startSaveWatch(doc: Document, runtime: WatchRuntime): void`, gdzie `interface WatchRuntime { send(m: SaveCandidateMessage | SavePendingMessage): Promise<unknown>; onMessage(h: (m: ToWatchMessage) => void): void; panelUrl(candidateId: string): string }` (w produkcji `chrome.runtime.sendMessage`, `onMessage`, `getURL("save-prompt.html") + "?id=" + id`). Ramka o innym origin niż `top` → funkcja nic nie rejestruje. `save-pending` i ramkę panelu obsługuje tylko ramka główna (`window.top === window`); ramki podrzędne o tym samym origin tylko wysyłają `save-candidate`.

- [ ] **Step 1: Testy `read-form`:** formularz `username`+`password` → oba; `email` przed hasłem bez `username` → login z e-maila; rejestracja (`autocomplete="new-password"` ×2) → hasło z pierwszego; zmiana hasła (current, new, confirm) → nowe; puste hasło → `undefined`; pola bez `<form>` w `<div>` z przyciskiem → `loginScope(przycisk)` zwraca ten `div`; `formSignature` nie zależy od kolejności pól; `emptyLoginForms` pomija formularz z wypełnionym hasłem.
- [ ] **Step 2: Testy `watch`** (atrapa `WatchRuntime` zbiera wysłane wiadomości): `submit` wysyła `save-candidate`; Enter w polu hasła wysyła; klik `<button>` w `div` bez formularza wysyła; klik przycisku w innym formularzu nie wysyła; Review Focus 3: handler strony na `submit` czyści pola → wiadomość ma wartości sprzed czyszczenia; na starcie wysyłany jest `save-pending` z `emptyLoginForms`, a odpowiedź `{candidateId}` wstawia ramkę; `save-show` wstawia jedną ramkę (`iframe` w hoście z `attachShadow({mode:"closed"})`, `src` = `panelUrl(id)`, drugi `save-show` jej nie dubluje), `save-hide` ją usuwa; Review Focus 1: `window.top.location.origin` rzuca → brak nasłuchów i brak `save-pending`.
- [ ] **Step 3:** `cd extension && npx vitest run test/save` → FAIL.
- [ ] **Step 4: Zaimplementuj.** Nasłuchy na `doc` z `capture: true`: `submit`, `keydown` (`Enter` na `input[type=password]`), `click` (`button`, `input[type=submit]`, `[role=button]`, przez `closest`). Host panelu: `div` z `position: fixed; top: 16px; right: 16px; z-index: 2147483647`, `iframe` 360×180 bez ramki.
- [ ] **Step 5:** PASS; `npm run build` tworzy `dist/save-watch.js`; `npm run typecheck`.
- [ ] **Step 6: Commit** `feat(extension): watch login forms for the save prompt`.

### Task 4: Kandydaci w tle (`SaveCandidates`)

**Files:**
- Create: `extension/src/save/candidates.ts`
- Modify: `extension/src/background.ts` (nasłuchy wiadomości, `alarms.onAlarm`, `tabs.onRemoved`)
- Test: `extension/test/save/candidates.test.ts`

**Interfaces:**
- Consumes: typy z `messages.ts` (Task 3); `save.saveUrl`, `save.saveName`, `save.decideSave`, `save.newLogin`, `save.withPassword` (Task 1–2); `autofill.matchLogins`; `VaultStore` (`resume`, `listEntries("login")`, `getEntry`, `putEntry`).
- Produces:
  - `const SAVE_TTL_MS = 120_000`, `const SAVED_HIDE_MS = 2000`, `const SAVE_ALARM_PREFIX = "save-expire:"`, klucze `STORAGE_KEYS.saveCandidates = "saveCandidates"` (session), `STORAGE_KEYS.saveNever = "saveNever"` (local, `string[]` nazw z `saveName`) dopisane w `storage.ts`.
  - `interface Sender { id?: string; url?: string; tab?: { id?: number; url?: string } }`
  - `interface SaveDeps { store(): VaultStore; session: KeyValueStore; local: KeyValueStore; selfId: string; sendToTab(tabId: number, m: ToWatchMessage): Promise<void>; alarms: { create(name: string, info: { when: number }): Promise<void>; clear(name: string): Promise<boolean> }; now(): number; newId(): string; later(ms: number, fn: () => void): void }`
  - `class SaveCandidates { constructor(deps: SaveDeps); onCandidate(m: SaveCandidateMessage, s: Sender): Promise<void>; onPending(m: SavePendingMessage, s: Sender): Promise<{ candidateId?: string }>; info(m: SaveInfoMessage, s: Sender): Promise<SavePromptInfo | undefined>; answer(m: SaveAnswerMessage, s: Sender): Promise<{ ok: true } | { ok: false; error: string }>; onAlarm(name: string): Promise<void>; onTabRemoved(tabId: number): Promise<void> }`
  - `async function neverList(local: KeyValueStore): Promise<string[]>`, `async function removeFromNever(local: KeyValueStore, host: string): Promise<void>` (dla Task 5).
  - Kandydat w sesji: `{ id, tabId, url, username, password, at, formSignature }`, gdzie `url` = `saveUrl(sender.url)`, `formSignature` = `origin(sender.url) + "|" + m.formSignature`.

- [ ] **Step 1: Testy** z `memoryStore` i odblokowanym `VaultStore` (wzór z `test/autofill/fill-tab.test.ts`), atrapą `sendToTab`/`alarms`, `later` wołanym ręcznie:
  - `stores a candidate and shows the panel` → sesja ma kandydata bez zapisu w `local`, `save-show` do karty, alarm `save-expire:<tabId>` na `now + SAVE_TTL_MS`;
  - `takes the address from sender.url, not the message`; `ignores messages without a tab or from another extension`;
  - Review Focus 1: `ignores a frame from another origin than the tab`;
  - `skips hosts on the never list`; `skips when the same login and password exist` (`none`);
  - `newer candidate replaces the older in the same tab`, a kandydat innej karty zostaje;
  - `pending shows the panel within two minutes` / `not after two minutes`;
  - Review Focus 2: `pending hides the panel when the same form came back empty` (kandydat zostaje);
  - `info has no password`, `decision` `create`/`update`; zablokowany sejf → `{locked: true, decision: null}`;
  - Review Focus 4: `info drops the candidate when after unlocking the login already exists`;
  - `answer save creates a login` (`newLogin`, `pendingCount() === 1`) / `updates only the password`, `save-hide` po `SAVED_HIDE_MS`;
  - `answer later` / `answer never` (dopisuje nazwę do `saveNever`) → kandydat usunięty, `save-hide` od razu;
  - `answer save when locked` → `{ ok: false, error: LOCKED }` (stała z `fill-tab.ts`);
  - `info and answer only from extension pages` (sender `https:` → `undefined` / błąd);
  - `alarm and closed tab remove the candidate`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Zaimplementuj** `candidates.ts`; w `background.ts` jeden nasłuch dla `type` `save-candidate|save-pending|save-info|save-answer` (`return true` i `sendResponse` dla odpowiedzi), `deps` produkcyjne: `chrome.tabs.sendMessage(tabId, m, { frameId: 0 })` z pominięciem błędu „no receiver”, `later = setTimeout`, `newId = crypto.randomUUID`.
- [ ] **Step 4:** PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(extension): keep save candidates in the service worker`.

### Task 5: Włączanie i widok „Zapis haseł”

**Files:**
- Create: `extension/src/save/registration.ts`, `extension/src/views/save-settings.ts`
- Modify: `extension/static/manifest.json` (Global Constraints), `extension/src/background.ts` (`syncSaveWatch` w `runtime.onStartup`, `onInstalled`, `permissions.onAdded`, `onRemoved`), `extension/src/views/list.ts` (przycisk „Zapis” po „PIN”, `title: "Pytanie o zapis haseł"`)
- Test: `extension/test/save/registration.test.ts`, `extension/test/ui/save-settings.test.ts`

**Interfaces:**
- Consumes: `neverList`, `removeFromNever` (Task 4); `VaultStore.getAccount()` (`phoneUrls`).
- Produces:
  - `const SAVE_ORIGINS = ["https://*/*", "http://*/*"] as const`, `const SAVE_SCRIPT_ID = "save-watch"`
  - `interface SaveWatchApi { contains(origins: string[]): Promise<boolean>; remove(origins: string[]): Promise<boolean>; registered(): Promise<boolean>; register(): Promise<void>; unregister(): Promise<void> }`, `function chromeSaveWatchApi(): SaveWatchApi`
  - `async function syncSaveWatch(api: SaveWatchApi): Promise<void>` – uprawnienie `https://*/*` jest i skrypt niezarejestrowany → `register`; brak i zarejestrowany → `unregister`.
  - `async function disableSavePrompt(api: SaveWatchApi, phoneUrls: readonly string[]): Promise<void>` – `remove(["https://*/*"])` i `remove(["http://*/*"])` tylko gdy żaden adres nie zaczyna się od `http:`.
  - `async function saveSettingsView(): Promise<void>` – przełącznik (`<input type=checkbox>` z etykietą „Pytaj o zapis haseł”, stan = `contains(["https://*/*"])`), lista „Nigdy dla tych stron” (host + „Usuń”, pusta → „Brak”), „Wróć”. Włączenie: `chrome.permissions.request({ origins: [...SAVE_ORIGINS] })` od razu w handlerze (bez `await` przed), w callbacku ponowne narysowanie; odmowa → przełącznik wyłączony.

- [ ] **Step 1: Testy `registration`:** rejestracja przy uprawnieniu; wyrejestrowanie po odebraniu (użytkownik w `chrome://extensions`); brak podwójnej rejestracji; Review Focus 5: `disableSavePrompt` z adresem `http://192.168.1.5:8787` usuwa tylko `https://*/*`, z samymi `https` – oba.
- [ ] **Step 2: Testy widoku** (`setupPopup`, rozszerz `fake-chrome.ts` o `permissions.request/remove` z wynikiem z opcji): przycisk „Zapis” otwiera widok; zgoda → przełącznik włączony; odmowa → wyłączony; wyłączenie woła `remove`; „Usuń” zdejmuje host z listy.
- [ ] **Step 3:** FAIL. **Step 4:** zaimplementuj. **Step 5:** PASS; `npm run build` (manifest w `dist/` ma `web_accessible_resources`).
- [ ] **Step 6: Commit** `feat(extension): turn the save prompt on and off`.

### Task 6: Panel na stronie i pytanie w okienku

**Files:**
- Create: `extension/static/save-prompt.html`, `extension/src/save-prompt.ts` (punkt wejścia), `extension/src/save/prompt-view.ts` (wspólny widok pytania), `extension/src/views/save-question.ts`
- Modify: `extension/build.mjs` (`src/save-prompt.ts` w pierwszym wywołaniu, `esm`), `extension/static/popup.css` (style panelu, jeśli potrzebne), `extension/src/views/locked.ts` (`showUnlocked`: najpierw `save-info` dla `activeTab()`, jest → `saveQuestionView`, inaczej jak dziś), `extension/test/screens/harness.ts` (stany panelu)
- Test: `extension/test/save/prompt-view.test.ts`, `extension/test/ui/save-question.test.ts`

**Interfaces:**
- Consumes: `SavePromptInfo`, `SaveInfoMessage`, `SaveAnswerMessage` (Task 3); `activeTab()` z `ui/active-tab.ts`; `listView`.
- Produces:
  - `function promptView(info: SavePromptInfo, actions: { answer(a: "save" | "later" | "never"): Promise<{ ok: boolean; error?: string }>; unlock(): void; done(message: string): void }): HTMLElement` – tytuł „Zapisać login w PassHolder?” (create i locked) / „Zaktualizować hasło w PassHolder?”, host, login (pusty → „(bez loginu)”), przyciski „Zapisz”/„Aktualizuj” albo „Odblokuj i zapisz” (locked), „Nie teraz”, „Nigdy dla tej strony”, krzyżyk (`aria-label="Zamknij"`) = „Nie teraz”; po zapisie tekst „Zapisano”; błąd → linia stanu.
  - `save-prompt.ts`: id z `location.search` (`?id=`), `save-info {candidateId}`; brak → pusta strona; `unlock = () => chrome.action.openPopup()`.
  - `function saveQuestionView(info: SavePromptInfo): void` – `promptView` w okienku; `done` → `listView("Zapisano login.")`, „Nie teraz”/„Nigdy” → `listView()`.

- [ ] **Step 1: Testy `promptView`:** tytuły dla create/update/locked; brak hasła w DOM (`textContent` nie zawiera hasła z atrapy); „Zapisz” woła `answer("save")` i pokazuje „Zapisano”; „Nigdy dla tej strony” → `answer("never")`; krzyżyk → `answer("later")`; locked → „Odblokuj i zapisz” woła `unlock`; błąd → komunikat.
- [ ] **Step 2: Testy okienka:** po odblokowaniu hasłem, gdy tło zwraca info dla aktywnej karty → pytanie zamiast listy; „Zapisz” → lista z „Zapisano login.”; bez info → lista jak dziś.
- [ ] **Step 3:** FAIL. **Step 4:** zaimplementuj. **Step 5:** PASS; `npm test`, `npm run typecheck`, `npm run build`.
- [ ] **Step 6: Zrzuty** `node extension/scripts/screenshots.mjs /mnt/project-files/wtyczka-v3` – nowe `14-panel-zapisz.png`, `15-panel-aktualizuj.png`, `16-panel-zablokowany.png`, `17-ustawienia-zapisu.png`.
- [ ] **Step 7: Commit** `feat(extension): save prompt panel and popup question`.

### Task 7: Dokumentacja

**Files:**
- Modify: `docs/FUNKCJE.md` (rozdział „Pytanie o zapis”: włączenie, kiedy pyta, „Nigdy”, zablokowany sejf, ograniczenia: otwarte karty działają po przeładowaniu, logowanie w obcej ramce, złe hasło bez przeładowania pokazuje panel), `docs/ARCHITEKTURA.md` (moduł `core/src/save/`, `save-watch.js`, `SaveCandidates`, `save-prompt.html`, przepływ strona → tło → panel, bezpieczeństwo ze specu 6), `docs/TESTY.md` (T20 wg specu 7), `docs/INSTALACJA.md` (włączenie przyciskiem „Zapis”, uprawnienie do wszystkich stron).

- [ ] **Step 1:** opisz zgodnie z kodem (nazwy z zadań 1–6), krótko.
- [ ] **Step 2:** `cd core && npx vitest run && npx tsc --noEmit && cd ../extension && npm test && npm run typecheck && npm run build` – wszystko PASS.
- [ ] **Step 3: Commit** `docs: save prompt in Chrome`.
