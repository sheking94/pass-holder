# Pliki w sejfie – wtyczka Chrome (krok 3) – plan wykonania

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** We wtyczce można dodać, pobrać i usunąć załącznik przy każdym typie wpisu; pliki leżą zaszyfrowane w IndexedDB i synchronizują się z telefonem przez `/p2p/v2/file` po synchronizacji wpisów.

**Architecture:** Nowy `extension/src/files/idb-file-store.ts` implementuje `LocalFileStore` z rdzenia (`@passholder/core/files`). `VaultStore` dostaje magazyn plików: zapis wpisu z nowymi plikami, fazę plików w `sync()` (rdzeniowe `syncFiles` + `pruneLocalFiles`), odczyt pliku do pobrania. Ekran: sekcja „Załączniki” w formularzu (`views/forms/attachments.ts`), spinacz na liście, postęp i komunikaty synchronizacji, uwaga o plikach przy eksporcie.

**Tech Stack:** TypeScript, Chrome MV3, IndexedDB, vitest + happy-dom; nowa zależność dev `fake-indexeddb` (tylko testy).

**Spec:** `docs/superpowers/specs/2026-11-12-pliki-w-sejfie-design.md` (punkty 4.2, 5, 6.2, 6.4, 7, 8, 9 krok 3, 10). Rdzeń: `core/src/files/` (plan kroku 1 `docs/superpowers/plans/2026-11-12-pliki-rdzen-ts.md`, decyzje D1–D9).

Skróty: `E/` = `extension/src/`, `ET/` = `extension/test/`.

## Global Constraints

- Limity z rdzenia, nie przepisywać liczb: `MAX_FILE_SIZE` (10 485 760), `MAX_ATTACHMENTS_PER_ENTRY` (20), `canAddAttachment`.
- Teksty (dokładnie): „Plik jest za duży (limit 10 MB)”, „Najwyżej 20 plików we wpisie”, „Plik jest pusty”, „Nieprawidłowa nazwa pliku”, „czeka na synchronizację”, „Plik jest uszkodzony”, ostrzeżenie „Pobierasz plik, który zostanie odszyfrowany i będzie dostępny na tym urządzeniu.” z przyciskami „Pobierz” / „Anuluj”, postęp „Pliki: 3 z 12”, „Nie wszystkie pliki zsynchronizowane”.
- Rozmiar na ekranie: `formatSize(b)` – poniżej 1 MiB „N KB” (`max(1, round(b/1024))`), wyżej „4,6 MB” (1 miejsce po przecinku, przecinek dziesiętny, podstawa 1024).
- Plik odszyfrowany tylko po „Pobierz” w oknie ostrzeżenia; nigdzie nie zapisujemy treści jawnej (ani w IndexedDB, ani w `chrome.storage`).
- Bez `window.confirm/alert` (blokuje rozszerzenie) – okna jako elementy DOM.
- Komentarze i nazwy po angielsku, teksty UI i dokumentacja po polsku.

## Decyzje planu (do akceptacji)

- **W1 – plik szyfrowany od razu, zapisywany przy „Zapisz”:** „+ Dodaj plik” szyfruje plik (`encryptFile`) i trzyma `EncryptedFile` w pamięci formularza. Do IndexedDB trafia dopiero w `putEntry` (przed zapisem wpisu). Rozwiązuje uwagę (a) z kroku 1: sprzątanie nie skasuje pliku, którego wpisu jeszcze nie zapisano. „Anuluj” = nic nie zostaje.
- **W2 – sprzątanie:** `pruneLocalFiles` po udanej fazie plików oraz po każdym `putEntry`/`delete` (sejf jest wtedy spójny). Usunięty załącznik znika lokalnie od razu, na telefonie po jego sprzątaniu (24 h, spec 6.4).
- **W3 – faza plików w `sync()`:** `sync()` po wpisach uruchamia `syncFiles` w `try/catch`; błąd nie cofa wpisów, tylko trafia do wyniku. `SyncResult` dostaje `files: FilesOutcome`. `pairFinish`/`repair` (pierwsza synchronizacja) też dostają fazę plików, bez zmian w ich kodzie.
- **W4 – uszkodzone pliki pamiętane:** id pliku, który po pobraniu nie zgadza się z opisem, trafia do `chrome.storage.local` (`STORAGE_KEYS.corruptFiles`) i jest pomijany w kolejnych synchronizacjach (uwaga (b) z kroku 1; pliki są niezmienne, więc ponowna próba nic nie da). Rdzeń: `syncFiles` dostaje opcjonalne `skip`. Id znika z listy, gdy żaden wpis go nie używa.
- **W5 – `contentKey` bez załączników** (wyrównanie z Kotlinem, K6): wpis różniący się tylko plikami = duplikat przy imporcie.
- **W6 – „+ Dodaj plik” w popupie** otwiera ten sam formularz w karcie (nowy tryb strony `edit`: `?edit&type=<typ>&id=<id>`), bo popup zamyka się przy wyborze pliku. Niezapisane zmiany z popupu przepadają, więc najpierw okno ostrzeżenia w DOM (decyzja właściciela 2026-11-13): „Formularz otworzy się w karcie. Niezapisane zmiany z tego okna przepadną – najpierw zapisz wpis, jeśli coś zmieniłeś.” z przyciskami „Otwórz w karcie” / „Anuluj”. W karcie wybór pliku działa normalnie.
- **W7 – rozłączenie** (`disconnect`) usuwa też wszystkie pliki z IndexedDB (to lokalna kopia sejfu).
- **W8 – magazyn w testach:** `VaultStore` przyjmuje `LocalFileStore` (domyślnie `MemoryLocalFileStore`); IndexedDB testowany osobno przez `fake-indexeddb`. Fałszywy telefon w testach dostaje `MemoryFileStore` w `P2pHost`.

## Review Focus

1. Zamknięcie karty/popupu w połowie fazy plików → następna synchronizacja wznawia od brakujących kawałków (IndexedDB zapisuje kawałek po kawałku). Test w zadaniu 3 (przerwany transport po 1 kawałku, druga synchronizacja kończy).
2. Edycja loginu przez pytanie o zapis (`upsert` → `loginContent`) gubi `attachments` → załączniki zostają. Test w zadaniu 3.
3. Stary telefon (404 na `/p2p/v2/file`) → wpisy zsynchronizowane, komunikat „Nie wszystkie pliki zsynchronizowane: Zaktualizuj aplikację na telefonie”. Test w zadaniu 3.
4. Sejf zablokował się (15 min) w czasie wyboru pliku → „Zapisz” daje „Sejf jest zablokowany”, nic nie trafia do IndexedDB. Test w zadaniu 3 (`putEntry` po wygaśnięciu).
5. Ten sam plik wybrany dwa razy → dwa niezależne załączniki (różne id), oba pobieralne. Test w zadaniu 4.

---

### Task 1: Rdzeń – `contentKey` bez plików i `skip` w `syncFiles`

**Files:**
- Modify: `core/src/transfer/common.ts` (`contentKey`), `core/src/files/client.ts` (`syncFiles`)
- Test: `core/test/transfer/common.test.ts`, `core/test/files/client.test.ts`

**Interfaces:**
- Produces: `contentKey(c)` ignoruje `attachments`. `syncFiles(vault, files, send, onProgress?, skip?: ReadonlySet<string>)` – id ze `skip` nie są kandydatami (nie liczą się też do `pending`).

- [ ] **Step 1: Testy:** `contentKey ignores attachments` – `contentKey({...note("A"), attachments:[a]}) === contentKey(note("A"))`; `syncFiles skips ids in skip` – plik kompletny na telefonie, brak lokalnie, `skip = {id}` → wynik `{uploaded:0, downloaded:0, pending:0, corrupted:[]}`, transport nie wywołany.
- [ ] **Step 2:** `cd core && npx vitest run test/transfer/common.test.ts test/files/client.test.ts` → FAIL.
- [ ] **Step 3:** W `contentKey` usuń `attachments` z kopii przed `trimmed`; w `syncFiles` pomiń `a.id` ze `skip` przy budowie `candidates`.
- [ ] **Step 4:** `cd core && npx vitest run && npx tsc --noEmit` → PASS (wektory transfer bez zmian).
- [ ] **Step 5:** Commit `feat(core): import ignores attachments; syncFiles skip list`.

### Task 2: Magazyn plików w IndexedDB

**Files:**
- Create: `E/files/idb-file-store.ts`
- Modify: `extension/package.json` (dev: `fake-indexeddb`), `extension/static/manifest.json` (`"unlimitedStorage"` w `permissions`)
- Test: `ET/idb-file-store.test.ts`

**Interfaces:**
- Produces: `class IdbFileStore implements files.LocalFileStore` z `constructor(factory: IDBFactory = indexedDB, dbName = "passholder-files")`; dodatkowo `clear(): Promise<void>`. Baza wersja 1: magazyn `files` (klucz `id`, wartość `LocalFileState` bez `have`) i `chunks` (klucz `[id, index]`, wartość `blob`). `have` liczone z kluczy `chunks` (zakres `[id,0]..[id,40]`). `putChunk` z inną liczbą kawałków kasuje stare kawałki w tej samej transakcji (semantyka jak `MemoryLocalFileStore`).

- [ ] **Step 1: Test** – ten sam zestaw przypadków co `MemoryLocalFileStore` w `core/test/files/client.test.ts` uruchomiony na `new IdbFileStore(new IDBFactory())` z `fake-indexeddb`: `putChunk`/`state.have` rosnąco, zmiana `chunks` zaczyna od nowa, `markComplete`/`markIncomplete`/`markUploaded`, `delete` usuwa kawałki, `ids()`, `clear()`; plus „dane przeżywają nową instancję na tej samej bazie” i `syncFiles` end-to-end (rdzeniowy `P2pHost`+`MemoryFileStore`) na `IdbFileStore`.
- [ ] **Step 2:** `cd extension && NO_PROXY=localhost npm i -D fake-indexeddb --cafile=/root/.ccr/ca-bundle.crt`, `npx vitest run test/idb-file-store.test.ts` → FAIL.
- [ ] **Step 3:** Implementacja (jedna transakcja na metodę; `Promise` wokół `IDBRequest`).
- [ ] **Step 4:** `npx vitest run test/idb-file-store.test.ts && npx tsc --noEmit` → PASS.
- [ ] **Step 5:** Commit `feat(extension): IndexedDB store for file chunks`.

### Task 3: `VaultStore` – zapis, synchronizacja, pobieranie plików

**Files:**
- Modify: `E/vault-store.ts`, `E/storage.ts` (`corruptFiles: "corruptFiles"`), `E/ui/state.ts` (przekazuje `new IdbFileStore()`), `E/phone-client.ts` (nic, jeśli `phoneErrorInPolish` wystarcza), `ET/fake-phone.ts` (`readonly files = new files.MemoryFileStore()`, przekazane do `P2pHost`)
- Test: `ET/vault-store-files.test.ts`

**Interfaces:**
- Consumes: `IdbFileStore` (zadanie 2), `syncFiles(..., skip)` (zadanie 1), z rdzenia `storeEncryptedFile`, `pruneLocalFiles`, `noiseFileTransport`, `decryptFile`, `usedAttachments`.
- Produces (konstruktor): 6. parametr `files: files.LocalFileStore = new files.MemoryLocalFileStore()`.
- Produces:
  - `putEntry(id, content, newFiles: readonly files.EncryptedFile[] = [])` – najpierw `requireVault()`, potem zapis plików, potem wpis; gdy zapis wpisu się nie uda, nowe pliki są kasowane. Po zapisie `pruneLocalFiles`.
  - `fileStatus(a: Attachment): Promise<"ready" | "waiting" | "corrupted">` – `ready` = lokalnie `complete`; `corrupted` = id w `corruptFiles`; inaczej `waiting`. Dopisek „czeka na synchronizację” także dla `ready`, gdy `uploadedEpoch !== vault.epoch` → druga metoda `fileUploaded(a): Promise<boolean>`.
  - `readFile(a: Attachment): Promise<Uint8Array>` – wymaga odblokowania; `decryptFile` z kawałków; `File is corrupted` → `Error("Plik jest uszkodzony")`.
  - `sync(onFileProgress?: (done, total) => void): Promise<SyncResult>`; `SyncResult.files: FilesOutcome` gdzie `type FilesOutcome = files.FileSyncResult & { error?: string }`. Faza: transport `noiseFileTransport` z tym samym adresem i kluczem co sync; `skip` = `corruptFiles`; nowe uszkodzone id dopisywane; po sukcesie `pruneLocalFiles` i odchudzenie `corruptFiles` do używanych id; błąd → `error` = komunikat z `phoneErrorInPolish`, `FILE_SYNC_EPOCH_MISMATCH` → „Zsynchronizuj ponownie”.
  - `disconnect()` czyści magazyn plików (`ids()`+`delete`).
  - `loginContent` przenosi `base.attachments`.

- [ ] **Step 1: Testy** (dwie wtyczki + `FakePhone` z `ET/fake-phone.ts`, plik 600 000 B → 3 kawałki):
  - `file added in browser A downloads in browser B` – A: `encryptFile` → `putEntry(id, content, [ef])` → `sync()`; `result.files.uploaded === 1`; B: `sync()` → `downloaded === 1`, `readFile` = te same bajty; `onFileProgress` dostał `(1,1)`.
  - `interrupted file phase resumes` – transport plików pada po 1. `put` (fałszywy telefon zwraca błąd raz) → `files.error` ustawione, wpisy zsynchronizowane; druga `sync()` → `uploaded === 1`, wysłane tylko brakujące kawałki.
  - `removing an attachment prunes it locally` – `putEntry` bez załącznika → `fileStatus` nie `ready`, `files.ids()` puste.
  - `old phone without file path` – `FakePhone` bez `files` → `files.error === "Zaktualizuj aplikację na telefonie"`, wpisy na telefonie.
  - `corrupted download is remembered` – telefon ma kawałki innego pliku pod tym id → `corrupted: [name]`, `fileStatus === "corrupted"`, kolejna `sync()` nie wysyła `get`.
  - `upsert keeps attachments` (Review Focus 2); `putEntry after auto-lock stores no file` (RF 4); `disconnect clears files`.
- [ ] **Step 2:** `cd extension && npx vitest run test/vault-store-files.test.ts` → FAIL.
- [ ] **Step 3:** Implementacja wg Interfaces.
- [ ] **Step 4:** `npx vitest run && npx tsc --noEmit` → PASS (stare testy `sync()` przechodzą: brak załączników = faza bez żądań).
- [ ] **Step 5:** Commit `feat(extension): vault store syncs and stores attachments`.

### Task 4: Ekrany – sekcja „Załączniki”, pobieranie, lista, postęp

**Files:**
- Create: `E/views/forms/attachments.ts`, `E/files/format-size.ts`
- Modify: `E/views/edit.ts`, `E/views/list.ts`, `E/page-mode.ts` (+ tryb `edit`), `E/popup.ts` (start w trybie `edit` → `editView(type, id)` po odblokowaniu), `E/views/locked.ts` jeśli `showUnlocked` decyduje o widoku startowym, `extension/static/popup.css`
- Test: `ET/ui/attachments.test.ts`, `ET/format-size.test.ts`, `ET/open-in-tab.test.ts` (tryb `edit`)

**Interfaces:**
- Consumes: `store.putEntry(..., newFiles)`, `fileStatus`, `fileUploaded`, `readFile`, `sync(onFileProgress)` (zadanie 3).
- Produces: `formatSize(bytes: number): string`; `attachmentsEditor(initial: Attachment[], status: HTMLElement, openInTab: () => void): Promise<{ node: HTMLElement; read(): { attachments: Attachment[]; added: EncryptedFile[] } }>`; `editQuery(type, id?): string` w `page-mode.ts`.
- Zachowanie:
  - Wiersz: nazwa, `formatSize`, dopisek („czeka na synchronizację” / „Plik jest uszkodzony” / „nowy – zapisz wpis”), „Pobierz” (nieaktywne, gdy nie `ready`), „Usuń” (usuwa z listy formularza; zapis przy „Zapisz”).
  - „+ Dodaj plik”: w karcie `<input type=file>` (pojedynczy), w popupie pokazuje ostrzeżenie z W6, a „Otwórz w karcie” otwiera kartę `editQuery`. Kolejność sprawdzeń: liczba (`canAddAttachment`), pusty, za duży, nazwa (`isAttachmentName`), potem `encryptFile(bytes, {name, mime: file.type})`.
  - „Pobierz” → okno w DOM z tekstem ostrzeżenia i „Pobierz”/„Anuluj”; po „Pobierz” `readFile` → Blob (`mime || "application/octet-stream"`) + `<a download=name>`, URL zwalniany po 60 s (jak `downloadText` w `transfer.ts`).
  - Lista: przy wpisie z plikami `📎 N` w nazwie wiersza.
  - Synchronizuj: status „Pliki: d z t” w trakcie; po końcu dopiski: ` Pliki: wysłano X, pobrano Y.` (gdy X+Y>0), ` Nie wszystkie pliki zsynchronizowane (N czeka).` (pending>0), ` Nie wszystkie pliki zsynchronizowane: <error>.`, ` Uszkodzone pliki: a, b.`; z `error` albo uszkodzonymi status jako błąd.

- [ ] **Step 1: Testy:** `formatSize(483211) === "472 KB"`, `formatSize(500) === "1 KB"`, `formatSize(4823449) === "4,6 MB"`; ekran (happy-dom, `setupPopup` z `ET/ui/fake-chrome.ts`, tryb karty): dodanie pliku przez `input.files` → wiersz „nowy – zapisz wpis” → „Zapisz” → wpis ma 1 załącznik; 21. plik → „Najwyżej 20 plików we wpisie”; plik 10 485 761 B → „Plik jest za duży (limit 10 MB)”; ten sam plik dwa razy → 2 załączniki o różnych id (RF 5); „Usuń” + „Zapisz” → 0; „Pobierz” pokazuje ostrzeżenie, „Anuluj” nic nie pobiera, „Pobierz” tworzy `<a download="dowod.jpg">`; w popupie „+ Dodaj plik” pokazuje ostrzeżenie W6, „Anuluj” nic nie otwiera, „Otwórz w karcie” woła `chrome.tabs.create` z `?edit&type=document&id=…`; lista pokazuje `📎 1`; status synchronizacji z dopiskami.
- [ ] **Step 2:** `cd extension && npx vitest run test/ui/attachments.test.ts test/format-size.test.ts test/open-in-tab.test.ts` → FAIL.
- [ ] **Step 3:** Implementacja; sekcja w `editView` między notatką a polami własnymi, `save` przekazuje `read().attachments` w treści i `read().added` do `putEntry`.
- [ ] **Step 4:** `npx vitest run && npx tsc --noEmit && npm run build` → PASS.
- [ ] **Step 5:** Commit `feat(extension): attachments section, download and sync progress`.

### Task 5: Eksport bez plików, dokumentacja

**Files:**
- Modify: `E/views/transfer.ts`, `E/plural.ts` (`filesNoun(n)`: 1 plik, 2–4 pliki, 5+ plików), `docs/SPEC.md`, `docs/SYNCHRONIZACJA.md`, `docs/FUNKCJE.md`, `docs/ARCHITEKTURA.md`, `docs/TESTY.md`
- Test: `ET/ui/transfer-view.test.ts`, `ET/plural.test.ts`

- [ ] **Step 1: Testy:** przy sejfie z 2 załącznikami ekran eksportu pokazuje „2 pliki nie zostaną wyeksportowane (eksport z plikami będzie w kolejnej wersji).” (`transfer.countAttachments(store.allContents())`), bez załączników brak tego zdania; `filesNoun(1|3|5)`.
- [ ] **Step 2:** `npx vitest run test/ui/transfer-view.test.ts test/plural.test.ts` → FAIL.
- [ ] **Step 3:** Implementacja.
- [ ] **Step 4:** Dokumentacja (po polsku, zwięźle): SYNCHRONIZACJA – faza plików we wtyczce (kolejność, wznawianie, uszkodzone, sprzątanie); FUNKCJE – załączniki we wtyczce (dodawanie w karcie, pobieranie z ostrzeżeniem, limity); ARCHITEKTURA – IndexedDB `passholder-files`, `unlimitedStorage`; SPEC – `contentKey` bez załączników; TESTY – T22 część wtyczkowa (dodaj 5 MB → sync → druga przeglądarka/telefon po kroku 4; usuń → znika), testy automatyczne kroku 3.
- [ ] **Step 5:** `npm test` w `core/` i `extension/`, `npx tsc --noEmit` w obu → PASS. Commit `feat(extension): export notes skipped files; docs: attachments in the extension`.
