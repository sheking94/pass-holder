# Pliki w sejfie – rdzeń TS (krok 1) – plan wykonania

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rdzeń TS umie opisać załącznik we wpisie v3, zaszyfrować plik w kawałki, obsłużyć `POST /p2p/v2/file` w hoście referencyjnym, zsynchronizować pliki po stronie klienta i połączyć listy załączników przy konflikcie; wektory dla Kotlina.

**Architecture:** Nowy moduł `core/src/files/` (format opisu, kawałki, host, klient), eksportowany jako `@passholder/core/files` i `files` z `index.ts`. `entry.ts` dostaje opcjonalne `attachments`; `host.ts` dostaje opcjonalny `files: FileStore` i drugą ścieżkę sesji; `transport.ts` wydziela wspólne „handshake + jedno żądanie”; `sync.ts` łączy załączniki w `applyResponse`. Magazyn plików klienta to interfejs (`LocalFileStore`), który w kroku 3 zrealizuje IndexedDB.

**Tech Stack:** TypeScript (ESM, `.ts` importy), WebCrypto (AES-GCM, SHA-256), vitest, tsx.

**Spec:** `docs/superpowers/specs/2026-11-12-pliki-w-sejfie-design.md` (punkty 4, 5, 6, 8, 10).

## Global Constraints

- `MAX_FILE_SIZE = 10485760`, `FILE_CHUNK_SIZE = 262144`, `MAX_FILE_CHUNKS = 40`, `MAX_FILE_BLOB_LENGTH = 4·ceil((29 + 262144)/3) = 349564`.
- `MAX_ATTACHMENTS_PER_ENTRY = 20` (dodawanie), `MAX_ATTACHMENTS_PARSED = 40` (parser, łączenie).
- AAD kawałka: `passholder/v3/file/<id>/<i>/<n>`; format blobu jak SPEC punkt 3 (`seal`).
- Opis: klucze dokładnie `id, name, mime, size, chunks, sha256, key` w tej kolejności; `attachments` między `custom` a `hlc`, tylko gdy lista niepusta. Wpis bez plików = te same bajty co dziś (`v3.json` bez zmian).
- Błąd opisu = `Invalid entry payload` (ten sam tekst co dziś).
- Ścieżka `/p2p/v2/file`, operacje `status` (≤ 500 id), `put`, `get`; inna epoka → `{epoch}`; 400/404/409/507 jak spec 6.1.
- Sprzątanie: pliki nieużywane i starsze niż `ORPHAN_FILE_AGE_MS = 86400000` (24 h).
- Bez nowych zależności. Komentarze i nazwy po angielsku, dokumentacja po polsku.

## Decyzje planu (do akceptacji)

- **D1 – UUID:** `id` tylko małymi literami, UUID v4: `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` (to daje `crypto.randomUUID()`). Ten sam wzorzec w opisie i w hoście.
- **D2 – nazwa i typ:** długość liczona w jednostkach UTF-16 (`String.length` w TS i Kotlinie). Zakazane w `name`: `/`, `\`, U+0000–U+001F, U+007F–U+009F. `mime`: 0..127 znaków, bez znaków sterujących. `key`: kanoniczny Base64 32 B. `chunks` musi równać się `ceil(size / CHUNK)`.
- **D3 – pusta lista:** parser odrzuca `"attachments": []` (zapis tylko niepustej). Żeby wtyczka nie zapisała pustej listy (jej sejf to `JSON.stringify` danych), `upsertEntryV2` i łączenie usuwają pusty klucz.
- **D4 – 404:** brak kawałka przy `get` to 404 z tekstem `chunk not found`. Stary telefon odpowiada na `/p2p/v2/file` 404 `not found`; klient rozróżnia po tekście i rzuca `PHONE_UPDATE_REQUIRED`.
- **D5 – `uploaded` jako epoka:** klient trzyma `uploadedEpoch` zamiast flagi. Plik jest wysłany, gdy `uploadedEpoch === vault.epoch`, więc zmiana epoki (adoptEpoch) sama „odznacza” pliki bez nowego zaczepu w `sync.ts`.
- **D6 – limit przy łączeniu:** gdy połączona lista ma > 40 opisów albo wpis przekroczyłby `MAX_ENTRY_BLOB_LENGTH`, zostaje sama lista zwycięzcy (bez łączenia).
- **D7 – `upsertEntryV2`:** przyjmuje do 40 załączników (parser); limit 20 sprawdza UI przez `canAddAttachment(count)`. Dzięki temu wpis po łączeniu (np. 25) da się dalej edytować.
- **D8 – eksport:** `exportPassHolderJson` pomija `attachments` (inaczej plik wyeksportowałby klucze, a import by go odrzucił). `countAttachments(entries)` daje liczbę do komunikatu „N plików nie zostanie wyeksportowanych” (UI w krokach 3–4).
- **D9 – status:** odpowiedź `{files: [{id, chunks, have, complete}]}`; nieznane `id` → `chunks: 0, have: [], complete: false`.

## Review Focus

1. Wpis z `attachments: []` w sejfie wtyczki → po odczycie sejf się nie wczytuje. Test w zadaniu 1 (`upsertEntryV2` usuwa pusty klucz) i w zadaniu 5 (łączenie dwóch pustych).
2. Edycja wpisu z załącznikami → załączniki zostają (spread w `upsertEntryV2` nie gubi klucza). Test w zadaniu 1.
3. Przerwana wysyłka (błąd transportu po 2 z 3 kawałków) → następne wywołanie wysyła tylko brakujący kawałek. Test w zadaniu 4.
4. Telefon ma plik niekompletny (inna wtyczka w trakcie) → klient nie pobiera, plik zostaje „czeka”. Test w zadaniu 4.
5. Konflikt, w którym zwycięża nagrobek → wpis usunięty, bez łączenia. Test w zadaniu 5.

---

### Task 1: Opis załącznika we wpisie

**Files:**
- Create: `core/src/files/attachment.ts`, `core/src/files/index.ts`
- Modify: `core/src/p2p/entry.ts`, `core/src/p2p/sync.ts` (`upsertEntryV2`), `core/src/transfer/passholder-json.ts`, `core/src/index.ts`, `core/package.json` (`exports["./files"]`)
- Test: `core/test/files/attachment.test.ts`

**Interfaces:**
- Produces (`files/attachment.ts`):
  - stałe z Global Constraints (`MAX_FILE_SIZE`, `FILE_CHUNK_SIZE`, `MAX_FILE_CHUNKS`, `MAX_FILE_BLOB_LENGTH`, `MAX_ATTACHMENTS_PER_ENTRY`, `MAX_ATTACHMENTS_PARSED`), `UUID_V4: RegExp`
  - `interface Attachment { id: string; name: string; mime: string; size: number; chunks: number; sha256: string; key: string }`
  - `chunkCount(size: number): number`
  - `attachmentJson(a: Attachment): Attachment` (kopia w kanonicznej kolejności kluczy)
  - `parseAttachments(value: unknown): Attachment[]` (rzuca `Invalid entry payload`)
  - `canAddAttachment(count: number): boolean` (`count < 20`)
  - `isAttachmentName(name: string): boolean`
- Produces (`entry.ts`): `EntryContentV3` ma `attachments?: Attachment[]`; `serializeEntryData` i `parseEntryData` je obsługują. `parseEntryContent` bez zmian (eksport ma 5 kluczy).
- Produces (`transfer`): `countAttachments(entries: readonly EntryContentV3[]): number`.

- [ ] **Step 1: Testy (failing)** w `attachment.test.ts`:
  - `serializeEntryData` wpisu z 1 załącznikiem daje `…"custom":[…],"attachments":[{"id":…,"name":…,"mime":…,"size":…,"chunks":…,"sha256":…,"key":…}],"hlc":…` (porównanie całego tekstu), a `parseEntryData(JSON.parse(text))` zwraca te same dane.
  - Wpis bez `attachments` i z `attachments: undefined` serializuje się identycznie jak dziś (bez klucza).
  - `parseEntryData` rzuca `Invalid entry payload` dla: `attachments: []`; nieznanego klucza w opisie; braku `key`; `size` 0, 10485761, 1.5; `chunks` ≠ `ceil(size/262144)` (np. size 262145, chunks 1); `name` "", 256 znaków, `"a/b"`, `"a\\b"`, `"a\u0000"`, `"a\u0085"`; `mime` 128 znaków; `sha256` 63 znaki i wielkie litery; `key` 31 B i niekanoniczny Base64; `id` wielkimi literami i UUID v1; powtórzone `id`; 41 opisów. 40 opisów przechodzi.
  - `upsertEntryV2` z `attachments: []` zapisuje dane bez klucza `attachments` (`"attachments" in data === false`); z 1 załącznikiem – zostaje; 41 → `Invalid entry payload`.
  - `exportPassHolderJson` wpisu z załącznikiem nie zawiera `"attachments"`, a `parsePassHolderJson` go przyjmuje; `countAttachments` dwóch wpisów (2 i 0 plików) = 2.
  - `canAddAttachment(19) === true`, `canAddAttachment(20) === false`.
- [ ] **Step 2:** `npx vitest run test/files/attachment.test.ts` → FAIL (brak modułu).
- [ ] **Step 3: Implementacja.** `parseEntryData`: rekord v3 ma 7 kluczy albo 8 z `attachments` (sprawdzić `Object.keys` jak w `record`). `upsertEntryV2`: przed sprawdzeniem rozmiaru znormalizować treść (pusta lista → bez klucza; > 40 albo zły opis → `parseAttachments` rzuca). Eksport: `sortForExport` na kopiach bez `attachments`.
- [ ] **Step 4:** test zadania PASS; `npm test -w core` i `npm run typecheck -w core` PASS (stare wektory `v3.json` bez zmian).
- [ ] **Step 5: Commit** `feat(core): attachment descriptors in v3 entries`.

### Task 2: Szyfrowanie pliku w kawałki

**Files:**
- Create: `core/src/files/chunks.ts`
- Test: `core/test/files/chunks.test.ts`

**Interfaces:**
- Consumes: `Attachment`, `chunkCount`, stałe (zadanie 1); `seal`, `open` z `cipher.ts`.
- Produces:
  - `fileChunkAad(id: string, index: number, chunks: number): string`
  - `interface EncryptedFile { attachment: Attachment; blobs: string[] }`
  - `encryptFile(bytes: Uint8Array, meta: { name: string; mime: string }, fixed?: { id: string; key: Uint8Array; nonces: Uint8Array[] }): Promise<EncryptedFile>` – `fixed` tylko dla wektorów; normalnie losowe `id` (`crypto.randomUUID()`), klucz i nonce. Rzuca `FILE_TOO_LARGE = "File too large"` dla > 10 MB i `EMPTY_FILE = "Empty file"` dla 0 B; zła nazwa → `INVALID_FILE_NAME = "Invalid file name"`.
  - `decryptChunk(a: Attachment, index: number, blob: string): Promise<Uint8Array>`
  - `decryptFile(a: Attachment, blobs: readonly string[]): Promise<Uint8Array>` – sprawdza liczbę blobów, rozmiar i SHA-256; każda niezgodność albo błąd AES → `FILE_CORRUPTED = "File is corrupted"`.
  - `sha256Hex(bytes: Uint8Array): Promise<string>`

- [ ] **Step 1: Testy (failing):** plik 262144·2 + 5 B → 3 bloby, `chunks: 3`, ostatni kawałek 5 B; `decryptFile` zwraca te same bajty. Plik dokładnie 262144 B → 1 kawałek. `fileChunkAad("…", 1, 3) === "passholder/v3/file/…/1/3"`. `decryptFile` rzuca `File is corrupted` przy: zamienionej kolejności blobów, uciętej liście, blobie z innego pliku (inne `id` w AAD), zmienionym `sha256` w opisie, zmienionym `size`. `encryptFile` rzuca dla 0 B, 10485761 B i nazwy `"a/b"`. Z `fixed` dwa wywołania dają identyczne bloby.
- [ ] **Step 2:** `npx vitest run test/files/chunks.test.ts` → FAIL.
- [ ] **Step 3:** Implementacja; SHA-256 przez `crypto.subtle.digest`. Rozmiar sprawdzany przed złożeniem (suma długości kawałków).
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(core): chunked file encryption`.

### Task 3: Host referencyjny `/p2p/v2/file`

**Files:**
- Create: `core/src/files/host-files.ts`
- Modify: `core/src/p2p/host.ts` (opcja `files?: FileStore`, ścieżka pliku), `core/src/p2p/transport.ts` (stała `P2P_FILE_PATH = "/p2p/v2/file"`)
- Test: `core/test/files/host-files.test.ts`

**Interfaces:**
- Consumes: `UUID_V4`, `MAX_FILE_CHUNKS`, `MAX_FILE_BLOB_LENGTH` (zadanie 1).
- Produces:
  - `interface FileStore { chunks(id): number | undefined; have(id): number[]; get(id, index): string | undefined; put(id, index, chunks, blob, now: number): void; canStore(bytes: number): boolean; createdAt(id): number | undefined; ids(): string[]; delete(id): void; clear(): void }`
  - `class MemoryFileStore implements FileStore` (`constructor(capacityBytes = Infinity)`)
  - typy `P2pFileRequest = {op:"status"; epoch; ids} | {op:"put"; epoch; id; index; chunks; blob} | {op:"get"; epoch; id; index}`, `P2pFileStatus = { id; chunks; have: number[]; complete: boolean }`
  - `processP2pFile(store: FileStore, epoch: string, request: unknown, now: number): { status: number; body: unknown }` – ciało 200 idzie potem zaszyfrowane, błędy jawne jak w sync
  - `orphanFileIds(store: FileStore, used: ReadonlySet<string>, now: number): string[]` + `ORPHAN_FILE_AGE_MS = 86400000`
  - `P2pHost` z `files` obsługuje `P2P_FILE_PATH` (ta sama sesja Noise jednorazowa); bez `files` → 404 `not found`.

- [ ] **Step 1: Testy (failing)** przez `processP2pFile` i przez `P2pHost.handle` z prawdziwym handshake (wzór `test/p2p/transport.test.ts`):
  - `put` 0 z 2 → `{have: 1}`; `status` → `{files:[{id, chunks:2, have:[0], complete:false}]}`; po `put` 1 → `complete: true`; nieznane id → `chunks:0, have:[], complete:false`.
  - `put` tego samego kawałka z tym samym blobem → 200; z innym → 409 `chunk differs`; z innym `chunks` niż zapisane → 400 `chunk count mismatch`.
  - `get` istniejącego → `{chunks, blob}`; brakującego → 404 `chunk not found`.
  - Inna epoka (każda operacja) → 200 `{epoch}`, magazyn bez zmian.
  - 400 `malformed file request` dla: złego `op`, `id` nie-UUID, `index` −1 i = `chunks`, `chunks` 0 i 41, `blob` dłuższego niż 349564 znaków, `ids` > 500 albo nie-UUID.
  - `MemoryFileStore(capacity)` pełny → 507 `insufficient storage`, nic nie zapisane.
  - `orphanFileIds`: plik nieużywany 24 h + 1 ms → na liście; 24 h − 1 ms → nie; używany → nie.
  - Host bez `files` → `/p2p/v2/file` 404 `not found`; zła sesja → 401 jak sync.
- [ ] **Step 2:** `npx vitest run test/files/host-files.test.ts` → FAIL.
- [ ] **Step 3:** Implementacja. W `host.ts` wydzielić wspólną część `#sync` (sprawdzenie ciała, sesja, `stillPaired`, odszyfrowanie ramek) do metody, której przekazuje się funkcję przetwarzającą; status ≠ 200 z `processP2pFile` zwracać bez szyfrowania. Testy sync (`npm test -w core`) bez zmian.
- [ ] **Step 4:** PASS (całe `core`).
- [ ] **Step 5: Commit** `feat(core): reference /p2p/v2/file host`.

### Task 4: Klient synchronizacji plików

**Files:**
- Create: `core/src/files/client.ts`
- Modify: `core/src/p2p/transport.ts` (wspólne `noiseRequest`, nowe `noiseFileTransport`)
- Test: `core/test/files/client.test.ts`

**Interfaces:**
- Consumes: zadania 1–3; `LocalVaultV2`, `liveEntriesV2` (`sync.ts`).
- Produces:
  - `type P2pFileTransport = (request: P2pFileRequest) => Promise<unknown>` (zwraca odszyfrowaną odpowiedź 200; 404 `chunk not found` → `null` dla `get`)
  - `noiseFileTransport(o: same options as noiseTransport): P2pFileTransport` – 404 innej treści na `/p2p/v2/file` → `PHONE_UPDATE_REQUIRED`
  - `interface LocalFileState { id: string; chunks: number; have: number[]; complete: boolean; uploadedEpoch: string | null }`
  - `interface LocalFileStore { state(id): Promise<LocalFileState | undefined>; ids(): Promise<string[]>; getChunk(id, index): Promise<string | undefined>; putChunk(id, index, chunks, blob): Promise<void>; markComplete(id): Promise<void>; markUploaded(id, epoch): Promise<void>; delete(id): Promise<void> }`
  - `class MemoryLocalFileStore implements LocalFileStore` (testy, krok 3 ma IndexedDB)
  - `storeEncryptedFile(files: LocalFileStore, f: EncryptedFile): Promise<void>` (kompletny, `uploadedEpoch: null`)
  - `usedAttachments(vault: LocalVaultV2): Map<string, Attachment>` (żywe wpisy)
  - `interface FileSyncResult { uploaded: number; downloaded: number; pending: number; corrupted: string[] }` (`corrupted` = nazwy plików)
  - `syncFiles(vault: LocalVaultV2, files: LocalFileStore, send: P2pFileTransport, onProgress?: (done: number, total: number) => void): Promise<FileSyncResult>` – `FILE_SYNC_EPOCH_MISMATCH = "Epoch changed, sync again"` gdy telefon odpowie inną epoką
  - `pruneLocalFiles(vault: LocalVaultV2, files: LocalFileStore): Promise<number>` (usuwa nieużywane)

Przebieg `syncFiles` (spec 6.2): `status` dla używanych id (paczki po 500) → wysyłanie: kompletne lokalnie, `uploadedEpoch ≠ vault.epoch`, `put` kawałków spoza `have`, potem `markUploaded` → pobieranie: niekompletne lokalnie, a kompletne na telefonie: `get` brakujących, po ostatnim `decryptFile` (sprawdzenie), `markComplete`; przy `File is corrupted` usunąć lokalne kawałki i dopisać nazwę do `corrupted`. Telefon bez kompletnego pliku → `pending`. `total` = liczba plików do wysłania + pobrania; `onProgress` po każdym pliku.

- [ ] **Step 1: Testy (failing)** z prawdziwym `P2pHost` + `MemoryFileStore` + `noiseFileTransport` (jak w `transport.test.ts`):
  - Wtyczka A dodaje plik 3 kawałki → `syncFiles` → host ma `complete`; wynik `uploaded: 1`; drugie wywołanie nic nie wysyła (`uploaded: 0`, zero `put`).
  - Wtyczka B z tym samym sejfem → `downloaded: 1`, `decryptFile` z lokalnych kawałków = oryginał; `onProgress` wywołane `(1, 1)`.
  - Przerwanie: transport rzuca przy 3. `put` → `syncFiles` rzuca; następne wywołanie wysyła tylko kawałek 2 (licznik `put` = 1).
  - Przerwanie pobierania w połowie → następne pobiera tylko brakujące.
  - Telefon ma 1 z 2 kawałków → B: `pending: 1`, nic nie pobiera.
  - Opis z innym `sha256` niż treść → `corrupted: ["<nazwa>"]`, lokalne kawałki usunięte.
  - Zmiana `vault.epoch` (jak `adoptEpoch`) → plik wysłany ponownie.
  - Telefon odpowiada inną epoką → `Epoch changed, sync again`.
  - Host bez `files` → `Phone app needs an update`.
  - `pruneLocalFiles` usuwa plik, którego nie ma w żadnym żywym wpisie, zostawia używany.
- [ ] **Step 2:** `npx vitest run test/files/client.test.ts` → FAIL.
- [ ] **Step 3:** Implementacja; `noiseTransport` przepisać na `noiseRequest(o, path, request)` bez zmiany zachowania (testy sync bez zmian).
- [ ] **Step 4:** PASS (całe `core`).
- [ ] **Step 5: Commit** `feat(core): file sync client`.

### Task 5: Łączenie załączników przy konflikcie

**Files:**
- Create: `core/src/files/merge.ts`
- Modify: `core/src/p2p/sync.ts` (`applyResponse`)
- Test: `core/test/files/merge.test.ts`, przypadek w `core/test/p2p/sync.test.ts`

**Interfaces:**
- Produces: `mergeAttachments(winner: readonly Attachment[] | undefined, loser: readonly Attachment[] | undefined): Attachment[]` – zwycięzca, potem brakujące `id` przegranego w ich kolejności.
- W `applyResponse`, tylko gdy lokalny wpis jest `dirty` i **obie** wersje są żywe:
  - wygrywa zdalny: gdy `mergeAttachments(remote, local)` ≠ lista zdalna → wpis = zdalny z połączoną listą, nowy HLC (`clock.tick()` po `observe`), `dirty: true`, `revision` zdalny; `needsResync = true`.
  - wygrywa lokalny: lista = `mergeAttachments(local, remote)`; gdy się zmieniła → nowy HLC.
  - limit D6 (> 40 albo za duży blob) → bez łączenia; pusta lista → bez klucza (D3).

- [ ] **Step 1: Testy (failing):** `mergeAttachments([a,b],[b,c]) → [a,b,c]`; `(undefined,[c]) → [c]`; `([a],undefined) → [a]`. W `sync.test.ts` (host + dwa sejfy): A dodaje plik X do wpisu, potem B (nowszy HLC) dodaje Y do tego samego wpisu i synchronizuje pierwsze; po synchronizacji A i ponownej B obie strony mają `[Y, X]` (najpierw zwycięzca B). Nagrobek z wyższym HLC wygrywa nad edycją z plikiem → wpis usunięty. 21 + 20 różnych → zostaje lista zwycięzcy. Brak różnicy (te same id) → brak dodatkowej rundy.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementacja.
- [ ] **Step 4:** PASS (całe `core`).
- [ ] **Step 5: Commit** `feat(core): merge attachment lists on conflict`.

### Task 6: Wektory dla Kotlina i dokumentacja

**Files:**
- Create: `core/scripts/gen-vectors-files.ts`, `core/test-vectors/files/files.json`, `core/test/files/vectors.test.ts`
- Modify: `core/package.json` (`gen-vectors-files`), `docs/SPEC.md` (punkt 4 – opis załącznika, nowy punkt o kawałkach), `docs/SYNCHRONIZACJA.md` (5.x `/p2p/v2/file`, 4.3 łączenie, 9 ograniczenia), `docs/ARCHITEKTURA.md` (moduł `core/src/files/`), `docs/TESTY.md` (nowe pliki testów, liczby, T22 jako plan na krok 3–4)

Zawartość `files.json` (stały klucz, nonce i treść jak w `gen-vectors-v3.ts`):
- `limits`: wszystkie stałe z Global Constraints + `ORPHAN_FILE_AGE_MS`.
- `entries`: wpis z 2 załącznikami (`payload`, `blob`, `parsed`), wpis po łączeniu.
- `rejected`: każdy odrzucany opis z testu zadania 1 (`payload`, `error`).
- `files`: plik 5 B (pełne bloby) i plik 262144 + 1000 B o treści `byte[i] = (i * 31 + 7) & 0xff` (opis, `sha256` każdego blobu, pełny ostatni blob) – Kotlin generuje treść sam.
- `host`: sekwencja `{request, status, body}` dla `processP2pFile` od pustego magazynu (wszystkie przypadki z zadania 3, blob-y krótkie, `now` stały) + `orphan` (przypadki 24 h).
- `merge`: trzy przypadki `mergeAttachments`.

- [ ] **Step 1:** Test `vectors.test.ts` (failing – brak pliku): każdy wektor odtworzony z kodu (serializacja, `seal`, sha256 blobów, odpowiedzi hosta) daje dokładnie zapisane wartości.
- [ ] **Step 2:** `npm run gen-vectors-files -w core`; test PASS; drugie uruchomienie generatora nie zmienia pliku (`git diff --exit-code`).
- [ ] **Step 3:** Dokumentacja (krótko, po polsku, styl istniejących plików).
- [ ] **Step 4:** `npm test -w core`, `npm run typecheck -w core`, `npm test -w extension` (sprawdzenie, że nic nie pękło) PASS.
- [ ] **Step 5: Commit** `test(core): file vectors for Kotlin; docs: files core`.
