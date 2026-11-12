# Podgląd z edycją przed zapisem w Chrome – plan wykonania

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** panel pytania o zapis we wtyczce pozwala poprawić Nazwę, Login i Hasło przed zapisem (odpowiednik podglądu z Androida).

**Architecture:** tło (`SaveCandidates`) daje panelowi hasło kandydata i liczy decyzję dla wpisanych danych (`save-preview`); zapis przychodzi z `draft` i tło liczy decyzję ponownie. Widok `promptView` (wspólny dla panelu i okienka) dostaje pola do edycji.

**Tech Stack:** TypeScript, Chrome MV3, vitest + happy-dom, Playwright (zrzuty).

**Spec:** `docs/superpowers/specs/2026-11-11-pytanie-o-zapis-design.md`, sekcja 4.5 (oraz 4.3–4.4, 6).

## Global Constraints

- Teksty UI po polsku, dokładnie: „Nowy login”, „Zmiana hasła: <nazwa wpisu>”, „Ten login jest już zapisany”, „Strona: <host>”, „Nazwa”, „Login”, „Hasło”, „Zapisz”, „Nie teraz”, „Nigdy dla tej strony”, „Odblokuj i zapisz”, „Zapisano”, błąd zapisu `none`: „Ten login jest już zapisany w PassHolder”.
- Hasło nie trafia do skryptu na stronie (`ToWatchMessage`), do `chrome.storage.local` ani do logów. Inne hasła z sejfu nie trafiają do panelu.
- `save-info`, `save-preview`, `save-answer` przyjmowane tylko ze stron wtyczki (`fromExtensionPage`).
- Odczyty dla pytania nie przedłużają auto-blokady (`resume({touch:false})`); tylko zapis używa `touch:true` (jak dziś).
- Ramka panelu: `width: 360px; height: 340px`.
- Komendy: testy `cd extension && npx vitest run <plik>`, całość `npm test -w @passholder/extension`, typy `npm run typecheck -w @passholder/extension`. npm w chmurze: `NO_PROXY=localhost npm ci --cafile=/root/.ccr/ca-bundle.crt`.

## Review Focus

- Login zmieniony w podglądzie na inny niż w formularzu → decyzja i zapis dla nowego loginu (nie dla kandydata) – test w zadaniu 1.
- Puste hasło w podglądzie → nagłówek wg samego loginu, „Zapisz” nieaktywny, tło odrzuca zapis – testy w zadaniach 1 i 2.
- Nazwa pusta albo same spacje przy nowym wpisie → nazwa domyślna `saveName` – test w zadaniu 1.
- Szybkie pisanie: starsza odpowiedź `save-preview` przychodzi po nowszej → widok pokazuje wynik ostatniego zapytania – test w zadaniu 2.
- Sejf zablokowany między podglądem a zapisem → panel przechodzi na „Odblokuj i zapisz” (zachowanie jak dziś) – istniejący test `prompt-page` zostaje zielony.

---

### Task 1: Tło – hasło w `save-info`, `save-preview`, zapis z `draft`

**Files:**
- Modify: `extension/src/save/messages.ts`, `extension/src/save/candidates.ts`, `extension/src/background.ts` (routing `save-preview`)
- Test: `extension/test/save/candidates.test.ts`, `extension/test/save/read-form.test.ts`

**Interfaces (Produces):**
- `SavePromptInfo` dostaje `password: string` (pusty przy `locked: true`) i `entryName?: string` (nazwa wpisu przy `decision: "update"`).
- `type SaveDraft = { name: string; username: string; password: string }`.
- `type SavePreviewMessage = { target: "background"; type: "save-preview"; candidateId: string; username: string; password: string }`.
- `type SavePreviewResponse = { decision: "create" | "update" | "none"; entryName?: string } | undefined` (`undefined`: brak kandydata, sejf zablokowany albo obcy nadawca).
- `SaveAnswerMessage` dostaje `draft?: SaveDraft` (wymagany przy `answer: "save"`; bez niego tło zapisuje dane kandydata – zgodność z okienkiem do czasu zadania 2).
- `SaveCandidates.preview(m: SavePreviewMessage, s: Sender): Promise<SavePreviewResponse>`.

Reguły:
- `preview` przy pustym `password` zwraca decyzję wg samego loginu: `create`, gdy brak wpisu z tym loginem, inaczej `update` pierwszego (jak `intent` w `SaveReview.kt`). Bez `touch`.
- Zapis z `draft`: decyzja `decideSave(draft.username, draft.password, …)` liczona na nowo; `create` → `{ ...save.newLogin(c.url, draft.username, draft.password), name }`, gdzie `name = draft.name.trim() || save.saveName(c.url)`; `update` → `save.withPassword`; `none` → `{ ok: false, error: "Ten login jest już zapisany w PassHolder" }`, kandydat usunięty, panel schowany. Puste `draft.password` → `{ ok: false, error: "Podaj hasło" }`, kandydat zostaje.

- [ ] **Step 1: Testy (fail)** w `candidates.test.ts` – zamień „info has no password…” na:
  - `info gives the password and the entry name to extension pages`: `create` → `{…, password: "new", decision: "create"}` bez `entryName`; `update` → `{decision: "update", entryName: "Shop", password: "new"}`; locked → `password: ""`.
  - `preview decides from the typed login and password`: kandydat jan/new; `preview(jan,new)` → `{decision:"update", entryName:"Shop"}`; `preview(anna,x)` → `{decision:"create"}`; `preview(jan,old)` → `{decision:"none"}`; `preview(jan,"")` → `{decision:"update", entryName:"Shop"}`; `preview(anna,"")` → `{decision:"create"}`.
  - `preview only from extension pages and with a live candidate`: nadawca strony → `undefined`; nieznane id → `undefined`; sejf zablokowany → `undefined`.
  - `answer save uses the edited draft for a new login`: `draft {name:"  ", username:"anna", password:"p2"}` → nowy wpis `name: "shop.pl"`, `username: "anna"`, `password: "p2"`; z `name: "Mój sklep"` → `name: "Mój sklep"`.
  - `answer save with a draft for an existing login updates only its password` (draft jan/p2 → `s1` ma `p2`, nazwa „Shop”, dwa loginy).
  - `answer save of a draft already saved fails and hides the panel` (draft jan/old → `{ok:false, error:"Ten login jest już zapisany w PassHolder"}`, `stored()` puste, `save-hide`).
  - `answer save with an empty draft password keeps the candidate` → `{ok:false, error:"Podaj hasło"}`.
  - `hide and show messages carry no password`: po całym przepływie `JSON.stringify(s.sent)` nie zawiera `"new"`.
- [ ] **Step 2: Testy (fail)** w `read-form.test.ts`: `a contact form with a password is read` (imię, nazwisko, telefon, e-mail, hasło → login = e-mail, hasło) i `a form with only a new-password field is read` (`autocomplete="new-password"`, bez loginu → `username: ""`). Te dwa mają przejść od razu (zachowanie już jest) – sprawdź, że przechodzą.
- [ ] **Step 3:** `cd extension && npx vitest run test/save/candidates.test.ts test/save/read-form.test.ts` → nowe testy candidates FAIL.
- [ ] **Step 4:** Implementacja w `messages.ts`, `candidates.ts` (`preview` przez `serial`, wspólna funkcja zwracająca dopasowane loginy z nazwą), routing `case "save-preview"` w `background.ts` (`run(saveCandidates.preview(m, sender), undefined)`).
- [ ] **Step 5:** te same testy PASS; `npm run typecheck -w @passholder/extension` bez błędów (okienko i panel jeszcze bez `draft` – kompilują się).
- [ ] **Step 6: Commit** `feat(extension): save preview and edited draft in the background`.

### Task 2: Podgląd z edycją w panelu i okienku

**Files:**
- Modify: `extension/src/save/prompt-view.ts`, `extension/src/save/prompt-page.ts`, `extension/src/views/save-question.ts`, `extension/src/save/watch.ts` (wysokość ramki), `extension/static/popup.css`
- Test: `extension/test/save/prompt-view.test.ts`, `extension/test/save/prompt-page.test.ts`, `extension/test/save/watch.test.ts`

**Interfaces:**
- Consumes: z zadania 1 `SavePromptInfo.password/entryName`, `SaveDraft`, `SavePreviewMessage`, `SavePreviewResponse`.
- Produces: `PromptActions` = `{ answer(answer: PromptAnswer, draft?: SaveDraft): Promise<{ok: boolean; error?: string}>; preview(username: string, password: string): Promise<SavePreviewResponse>; unlock(): void; done(message: string): void }`. `PromptPageRuntime.send` przyjmuje też `SavePreviewMessage`.

Widok (sejf odblokowany): `h1` nagłówek („Nowy login” / „Zmiana hasła: <entryName>” / „Ten login jest już zapisany”), pole **Nazwa** (`input`, wartość `info.host`, widoczne tylko przy `create`), **Login** (wartość `info.username`), **Hasło** przez `secretField` (wartość `info.password`, ukryte, „Pokaż”), wiersz „Strona: <host>”, przyciski Zapisz / Nie teraz / Nigdy dla tej strony / ×. Na `input` Loginu lub Hasła → `actions.preview(...)`; wynik ostatniego wywołania (licznik) ustawia nagłówek, widoczność Nazwy i `disabled` Zapisz (`password === ""` albo `none`). „Zapisz” wysyła `answer("save", {name, username, password})`. Sejf zablokowany: widok jak dziś (tytuł „Zapisać login w PassHolder?”, host, login, „Odblokuj i zapisz”), bez pól i bez hasła.

- [ ] **Step 1: Testy (fail)** w `prompt-view.test.ts` (zaktualizuj istniejące tytuły):
  - `shows editable fields for a new login`: nagłówek „Nowy login”, pola Nazwa=`sklep.example.com`, Login=`jan`, Hasło=`s3cret` (`type=password`), tekst „Strona: sklep.example.com”.
  - `an update hides the name and names the entry`: `{decision:"update", entryName:"Sklep"}` → „Zmiana hasła: Sklep”, brak pola Nazwa.
  - `typing asks for a preview and updates the header`: zmiana Loginu → `preview` wywołane z (`nowy`, `s3cret`); odpowiedź `{decision:"none"}` → „Ten login jest już zapisany”, Zapisz `disabled`.
  - `an empty password disables Zapisz`.
  - `only the latest preview counts`: dwa wpisy, pierwsza odpowiedź przychodzi po drugiej → nagłówek z drugiej.
  - `Zapisz sends the edited draft`: zmiana Nazwy i Hasła → `answer("save", {name:"Mój", username:"jan", password:"inne"})`, potem „Zapisano”.
  - `locked shows no fields and no password`: brak `input`, tekst bez `s3cret`, „Odblokuj i zapisz”.
- [ ] **Step 2: Testy (fail)** w `prompt-page.test.ts`: `forwards previews and drafts to the background` (wysłane `save-preview` z `candidateId`, `save-answer` z `draft`). W `watch.test.ts`: ramka ma `height: 340px`.
- [ ] **Step 3:** `cd extension && npx vitest run test/save/prompt-view.test.ts test/save/prompt-page.test.ts test/save/watch.test.ts` → FAIL.
- [ ] **Step 4:** Implementacja; `save-question.ts` przekazuje `preview` i `draft` przez `chrome.runtime.sendMessage`; CSS: pola w panelu bez przewijania w 360 × 340.
- [ ] **Step 5:** testy PASS; pełne `npm test -w @passholder/extension` i `typecheck` bez błędów.
- [ ] **Step 6: Commit** `feat(extension): review and edit the login in the save panel`.

### Task 3: Zrzuty i dokumentacja

**Files:** Modify `extension/scripts/screenshots.mjs` (i jego strona testowa, jeśli `openPrompt` buduje `SavePromptInfo`), `docs/FUNKCJE.md` (Pytanie o zapis → Chrome: podgląd, zasięg kontakt/nowe hasło, bezpieczeństwo „hasło trafia do panelu”), `docs/ARCHITEKTURA.md` (`save-preview`, `draft`), `docs/TESTY.md` (T20: edycja w podglądzie, formularz kontaktowy, samo nowe hasło; liczby testów).

- [ ] **Step 1:** `openPrompt` podaje `password` i `entryName`; nowy zrzut `18-podglad-zapisu.png` (nowy login z polem Nazwa); 14–16 odświeżone. Uruchom skrypt, sprawdź brak `overflow` i problemów; skopiuj do `/mnt/project-files/wtyczka-v3/`.
- [ ] **Step 2:** Dokumentacja jak wyżej (zwięźle, po polsku).
- [ ] **Step 3:** Pełne `npm test` (cały monorepo) i `typecheck` PASS.
- [ ] **Step 4: Commit** `docs: save review in the Chrome panel`.
