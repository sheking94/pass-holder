# Pliki w sejfie – rdzeń Kotlin i host telefonu (krok 2) – plan wykonania

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rdzeń Kotlin (`android/core`) rozumie załączniki we wpisie v3, szyfruje i odszyfrowuje pliki w kawałkach, a telefon jako host obsługuje `POST /p2p/v2/file` z magazynem na dysku i sprzątaniem; wynik zgodny 1:1 z wektorami `core/test-vectors/files/files.json`.

**Architecture:** Nowy pakiet `io.github.sheking94.passholder.core.files` (opis załącznika, kawałki, host plików, magazyny) – port `core/src/files/` bez klienta (`client.ts` zostaje tylko w TS: telefon jest hostem). `EntryV3` dostaje opcjonalne `attachments`; `P2pHost` drugą ścieżkę sesji; `PhoneRouter` nową ścieżkę; `PhoneVaultStore` tworzy `DiskFileStore`, kasuje go przy zmianie epoki, sprząta i daje API dla ekranów z kroku 4. Aplikacja (`android/app`) bez zmian.

**Tech Stack:** Kotlin/JVM 17, kotlinx.serialization (JsonElement), javax.crypto (AES-GCM przez istniejące `Aead`), `MessageDigest` SHA-256, JUnit 5. Bez nowych zależności.

**Spec:** `docs/superpowers/specs/2026-11-12-pliki-w-sejfie-design.md` (punkty 4, 5, 6.1, 6.3, 6.4, 6.5, 9 krok 2, 10). Wzór: `core/src/files/*.ts` i plan kroku 1 `docs/superpowers/plans/2026-11-12-pliki-rdzen-ts.md` (decyzje D1–D9 obowiązują).

Skróty ścieżek: `K/` = `android/core/src/main/kotlin/io/github/sheking94/passholder/core/`, `T/` = `android/core/src/test/kotlin/io/github/sheking94/passholder/core/`.

## Global Constraints

- Stałe jak TS: `MAX_FILE_SIZE = 10485760`, `FILE_CHUNK_SIZE = 262144`, `MAX_FILE_CHUNKS = 40`, `MAX_FILE_BLOB_LENGTH = 349564`, `MAX_ATTACHMENTS_PER_ENTRY = 20`, `MAX_ATTACHMENTS_PARSED = 40`, `ORPHAN_FILE_AGE_MS = 86400000`, `MAX_STATUS_IDS = 500`. Test sprawdza je z `limits` w `files.json`.
- UUID: `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`. Nazwa 1..255 jednostek UTF-16 (`String.length`), bez `/`, `\`, U+0000–U+001F, U+007F–U+009F; mime 0..127, bez tych znaków sterujących; `sha256` 64 małe hex; `key` kanoniczny Base64 32 B; `chunks == ceil(size / 262144)`.
- Liczby JSON jak w JS: `1.0` (i `1e0`) to liczba całkowita 1; `1.5`, tekst, `null`, nieskończoność → błąd.
- AAD kawałka: `passholder/v3/file/<id>/<i>/<n>`; blob jak `Aead.seal`.
- Serializacja: `attachments` między `custom` a `hlc`, tylko gdy lista niepusta; klucze opisu `id, name, mime, size, chunks, sha256, key`. Wpis bez plików = bajty jak dziś (`P2pVectorsV3Test` bez zmian).
- Teksty błędów jak TS: `Invalid entry payload`, `File too large`, `Empty file`, `Invalid file name`, `File is corrupted`, `malformed file request`, `chunk count mismatch`, `chunk differs`, `chunk not found`, `insufficient storage`, `not found`.
- Kolejność w hoście: walidacja (400, także przy innej epoce) → epoka (200 `{epoch}`) → operacja; przy `put` 400 `chunk count mismatch` przed 409.
- Magazyn telefonu: `filesDir/p2p/files/<id>/`; 507 gdy po zapisie zostałoby < 50 MB wolnego (`MIN_FREE_BYTES = 52428800`).
- Komentarze i nazwy po angielsku, dokumentacja po polsku.

## Decyzje planu (do akceptacji)

- **K1 – bez klienta w Kotlinie:** `syncFiles`/`LocalFileStore` nie są portowane; telefon tylko odpowiada. Plik dodany na telefonie trafia od razu do jego magazynu jako kompletny (spec 6.3).
- **K2 – kompletność bez znacznika:** każdy kawałek zapisywany jako `<i>.tmp` → fsync → atomowy `rename` na `<i>`, więc istniejący plik `<i>` jest zawsze cały; „kompletny” = liczba kawałków == `chunks`. `meta.json` (`{chunks, createdAt}`) zapisywany atomowo przy pierwszym kawałku. Spec wspomina znacznik `complete` – zastępuję go tym (mniej stanów do pilnowania). Pozostałe `*.tmp` usuwane przy otwarciu magazynu.
- **K3 – sprzątanie na telefonie:** `PhoneVaultStore.pruneFiles()` po odblokowaniu (`start`) i po każdym zapisie/usunięciu wpisu. **Pomijane, gdy którykolwiek wpis jest nieczytelny** (`unreadableIds()` niepuste) – nie wiadomo, jakich plików używa, więc nic nie kasujemy. Błąd sprzątania nie psuje zapisu wpisu (tylko `onError`).
- **K4 – API dla kroku 4** w `PhoneVaultStore`: `addFile(bytes, name, mime): Attachment` (szyfruje i zapisuje kompletny plik; wpis zapisuje UI przy „Zapisz”, a 24 h chroni plik przed sprzątaniem), `isFileComplete(a): Boolean`, `readFile(a): ByteArray` (rzuca `File is corrupted`). Wszystkie wymagają odblokowanego sejfu.
- **K5 – zmiana epoki** (`createVault`, `startRestore`, `disconnect`): `resetRecords()` kasuje też `p2p/files/`. `finishRestore` nie zmienia epoki, więc pliki wysłane przez wtyczkę w trakcie odtwarzania zostają.
- **K6 – `contentKey` (duplikaty przy imporcie):** w Kotlinie liczony z `contentJson`, czyli bez załączników (wpis różniący się tylko plikami = duplikat). W TS `contentKey` obejmuje `attachments`. Zostawiam Kotlin jak jest i zapisuję do planu kroku 3, żeby wyrównać TS (import nigdy nie ma plików, więc nie ma wpływu na dane, tylko na wynik „duplikat”).
- **K7 – eksport:** `PassHolderJson` już pomija załączniki (`contentJson` ich nie zawiera) – test to potwierdza. `countAttachments(entries)` dodane teraz w `transfer/` dla ekranu eksportu w kroku 4.
- **K8 – łączenie:** `mergeAttachments` portowane i sprawdzane wektorami; telefon go nie używa (konflikty rozstrzyga wtyczka, spec 6.5).

## Review Focus

1. Telefon zabity w trakcie zapisu kawałka (zostaje `<i>.tmp` albo niepełny `meta.json`) → po restarcie magazyn się otwiera, kawałek liczy się jako brakujący, wtyczka go dośle. Test w zadaniu 4.
2. Sejf z wpisem nieczytelnym (np. uszkodzony rekord) → sprzątanie nie kasuje plików. Test w zadaniu 5.
3. Edycja loginu na telefonie (`upsert(Credentials)`) i zapis innego typu (`upsertContent`) → załączniki zostają. Test w zadaniu 1 (`PhoneVault`).
4. Dwie wtyczki wysyłają ten sam kawałek naraz (dwa wątki HTTP) → jeden zapis, oba 200. Test w zadaniu 4 (wątki na `DiskFileStore` przez `FileHost.process`).
5. „Nowy sejf”/rozłączenie po wysłaniu plików → stare pliki znikają z dysku, a stary host (żądanie w locie) nie odtwarza katalogu. Test w zadaniu 5.

---

### Task 1: Opis załącznika we wpisie v3

**Files:**
- Create: `K/files/Attachment.kt`
- Modify: `K/p2p/EntryV3.kt` (model, `serialize`, `parse`), `K/transfer/PassHolderJson.kt` albo `K/transfer/Common.kt` (`countAttachments`)
- Test: `T/files/AttachmentTest.kt`, `T/files/FilesVectorsTest.kt` (część `limits`, `entries`, `rejected`, `merge`), przypadek w `T/p2p/PhoneVaultTest.kt`

**Interfaces:**
- Produces (`files/Attachment.kt`, `object Attachments`): stałe z Global Constraints, `UUID_V4: Regex`, `chunkCount(size: Long): Int`, `isName(name: String): Boolean`, `isMime(mime: String): Boolean`, `canAdd(count: Int): Boolean` (`count < 20`), `parseList(value: JsonElement?): List<Attachment>` (rzuca `IllegalArgumentException("Invalid entry payload")`), `merge(winner: List<Attachment>, loser: List<Attachment>): List<Attachment>`, `json(a: Attachment): JsonObject` (kanoniczna kolejność).
- Produces: `data class Attachment(val id: String, val name: String, val mime: String, val size: Long, val chunks: Int, val sha256: String, val key: String)`.
- Produces (`EntryV3.kt`): `EntryContentV3(name, note, fields, custom, attachments: List<Attachment> = emptyList())` – domyślna wartość, więc `android/app` się kompiluje bez zmian. `parse` przyjmuje 7 albo 8 kluczy (8. to `attachments`); `parseContent`/`contentJson` bez zmian (eksport bez plików).
- Produces (`transfer`): `countAttachments(entries: List<EntryContentV3>): Int`.

- [ ] **Step 1: Testy (failing).** `FilesVectorsTest`: (a) każda stała = `limits`; (b) dla każdego `entries[]`: `EntryV3.parse(json(payload))` daje dane, których `serialize` = `canonicalPayload ?: payload`, `EntryV3.encryptJson(vaultKey, id, serialize(...), nonce) == blob`, `decrypt(blob)` daje to samo; wpis z `merge` – `Attachments.merge(winner, loser)` = jego lista; (c) każdy `rejected[].payload` → `parse` rzuca z komunikatem `error`; (d) `merge[]`: `merge(winner, loser) == expected`. `AttachmentTest`: `canAdd(19)`/`canAdd(20)`, `chunkCount(262144) == 1`, `chunkCount(262145) == 2`; wpis z `attachments = emptyList()` serializuje się identycznie jak bez klucza; `parse` liczby `1e0` jako 1, `1e400` → błąd; eksport `PassHolderJson` wpisu z załącznikiem nie zawiera `"attachments"`; `countAttachments` (2 + 0) = 2. `PhoneVaultTest`: wpis z 1 załącznikiem → `upsert(id, Credentials(...))` i `upsertContent(id, content.copy(name = "x"))` zachowują listę.
- [ ] **Step 2:** `cd android && ./gradlew :core:test --tests "*files*" --console=plain` → FAIL (brak klas).
- [ ] **Step 3: Implementacja.** Wspólny pomocnik do liczb: prymityw nie-tekstowy, `content.toDoubleOrNull()`, skończony, całkowity, w zakresie (inaczej błąd) – użyty też w zadaniu 3. Powtórzone `id`, lista pusta albo > 40 → błąd.
- [ ] **Step 4:** `./gradlew :core:test --console=plain` PASS (w tym `P2pVectorsV3Test`, `transfer/*`), `./gradlew :app:compileDebugKotlin` PASS.
- [ ] **Step 5: Commit** `feat(android-core): attachment descriptors in v3 entries`.

### Task 2: Szyfrowanie pliku w kawałki

**Files:**
- Create: `K/files/FileChunks.kt`
- Test: `T/files/FileChunksTest.kt`, `FilesVectorsTest` (część `files`)

**Interfaces:**
- Consumes: `Attachment`, `Attachments` (zadanie 1), `Aead.seal/open`, `Encoding`.
- Produces (`object FileChunks`): `aad(id: String, index: Int, chunks: Int): String`; `data class EncryptedFile(val attachment: Attachment, val blobs: List<String>)`; `encrypt(bytes: ByteArray, name: String, mime: String): EncryptedFile`; `internal fun encryptFixed(bytes, name, mime, id: String, key: ByteArray, nonces: List<ByteArray>): EncryptedFile` (tylko wektory); `decryptChunk(a: Attachment, index: Int, blob: String): ByteArray`; `decrypt(a: Attachment, blobs: List<String>): ByteArray`; `sha256Hex(bytes: ByteArray): String`; stałe tekstów błędów. Błędy jako `IllegalArgumentException(<tekst>)`; zły mime → `""` (jak TS).

- [ ] **Step 1: Testy (failing).** Wektory `files[]`: `encryptFixed` daje `attachment` równy wektorowi, `aads`, SHA-256 (hex) tekstu każdego blobu = `blobSha256`, ostatni blob = `lastBlob` (a dla pliku 5 B pełne `blobs`); treść z `contentRule` generowana `(i * 31 + 7) and 0xff`; `decrypt` zwraca treść. `FileChunksTest`: 2·262144 + 5 B → 3 bloby, round-trip; `decrypt` → `File is corrupted` przy zamienionej kolejności, uciętej liście, blobie z innym `id`, zmienionym `sha256`, zmienionym `size`; `encrypt` rzuca `Empty file` (0 B), `File too large` (10485761 B), `Invalid file name` (`"a/b"`); mime z `\n` → `""`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementacja; rozmiar sumowany przed złożeniem (jak TS), losowe `id` = `UUID.randomUUID().toString()` (małe litery, v4).
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(android-core): chunked file encryption`.

### Task 3: Host plików i magazyn w pamięci

**Files:**
- Create: `K/files/FileHost.kt` (`FileStore`, `MemoryFileStore`, `FileHost`)
- Test: `FilesVectorsTest` (części `host`, `storage`, `orphan`), `T/files/FileHostTest.kt`

**Interfaces:**
- Produces:
  - `interface FileStore { fun chunks(id: String): Int?; fun have(id: String): List<Int>; fun get(id: String, index: Int): String?; fun put(id: String, index: Int, chunks: Int, blob: String, now: Long); fun canStore(bytes: Long): Boolean; fun createdAt(id: String): Long?; fun ids(): List<String>; fun delete(id: String); fun clear() }` – niewątkobezpieczny, wołający trzyma `synchronized(store)` (jak `SyncStore`).
  - `class MemoryFileStore(capacity: Long = Long.MAX_VALUE) : FileStore` (pojemność = suma długości blobów).
  - `object FileHost { fun process(store: FileStore, epoch: String, request: JsonElement, now: Long): FileReply; fun orphanIds(store: FileStore, used: Set<String>, now: Long): List<String> }`, `data class FileReply(val status: Int, val body: JsonObject)`.
  - Kształt odpowiedzi jak TS: `{files:[{id, chunks, have, complete}]}`, `{have}`, `{chunks, blob}`, `{epoch}`, `{error}`.

- [ ] **Step 1: Testy (failing).** Wektory: `host.steps` po kolei na jednym `MemoryFileStore()` (`expand`: `ids` = `count` kopii `repeat`, `blob` = `repeat` × `count`), `storage.steps` na `MemoryFileStore(capacity)`; status i ciało (porównanie `JsonElement`) dokładnie jak w wektorze. `orphan`: dla każdego `cases[].now` posortowane `orphanIds` = `expected`. `FileHostTest`: synchronizacja wokół `process` – `process` sam bierze `synchronized(store)`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementacja (port `host-files.ts`, pomocnik liczb z zadania 1).
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(android-core): /p2p/v2/file request handling`.

### Task 4: Magazyn plików na dysku

**Files:**
- Create: `K/files/DiskFileStore.kt`
- Test: `T/files/DiskFileStoreTest.kt`

**Interfaces:**
- Consumes: `FileStore`, `FileHost` (zadanie 3).
- Produces: `class DiskFileStore(dir: File, freeSpace: () -> Long = { dir.usableSpace }, minFree: Long = MIN_FREE_BYTES) : FileStore`; `companion object { const val MIN_FREE_BYTES = 52_428_800L }`. Układ: `dir/<id>/meta.json` (`{"chunks":n,"createdAt":ms}`), `dir/<id>/<i>` (blob), zapis przez `.tmp` + fsync + `ATOMIC_MOVE` (K2). `canStore(bytes) = freeSpace() - bytes >= minFree`. Katalogi o nazwie spoza `UUID_V4` i bez czytelnego `meta.json` są pomijane przez `ids()` i usuwane przy otwarciu.

- [ ] **Step 1: Testy (failing).** Kroki `host.steps` z wektorów na `DiskFileStore` (`freeSpace = { Long.MAX_VALUE }`) dają te same odpowiedzi co w zadaniu 3 (wspólny pomocnik w `FilesVectorsTest`). Ponowne otwarcie tego samego katalogu: `chunks`, `have`, `get`, `createdAt` zachowane. Pozostawiony `3.tmp` i `meta.json.tmp` → po otwarciu brak `.tmp`, `have` bez 3. Katalog bez `meta.json` → usunięty, `ids()` go nie ma. `freeSpace = { 50 MB + 9 }`, `put` 10 znaków → 507 przez `FileHost.process`. `delete`/`clear` usuwają katalogi. Review Focus 4: 8 wątków robi `FileHost.process(put)` tego samego kawałka → wszystkie 200 `{have:1}`, jeden plik `0`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementacja.
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(android-core): disk file store for the phone host`.

### Task 5: Telefon jako host plików

**Files:**
- Modify: `K/p2p/P2pHost.kt` (opcja `files: FileStore? = null`, ścieżka `/p2p/v2/file`), `K/p2p/PhoneRouter.kt` (ścieżka w `SYNC_PATHS`), `K/p2p/PhoneVaultStore.kt` (magazyn, reset, sprzątanie, API K4), `android/core/src/testFixtures/.../TestP2pClient.kt` (metoda `file(request: String): HostReply` – handshake + jedno żądanie na `/p2p/v2/file`)
- Test: `T/p2p/P2pHostTest.kt`, `T/p2p/PhoneRouterTest.kt`, `T/p2p/PhoneVaultStoreTest.kt`

**Interfaces:**
- Consumes: zadania 1–4.
- Produces:
  - `P2pHost(..., files: FileStore? = null, ...)`: `/p2p/v2/file` przechodzi te same kroki co `sync` (ciało, sesja jednorazowa, `stillPaired`, odszyfrowanie ramek), potem `FileHost.process(files, epoch, request, now())`; status 200 → ciało zaszyfrowane w ramkach jak sync, inny status → jawne `{error}`; bez `files` → 404 `not found`. Wspólną część `sync` wydzielić do prywatnej metody (testy sync bez zmian). `onSynced` tylko po sync, nie po plikach.
  - `PhoneVaultStore`: `files = DiskFileStore(File(p2pDir, "files"))` tworzony w `openRecords` i przekazany hostowi; `resetRecords()` czyści go (K5); `fun pruneFiles(): Int`; `fun addFile(bytes: ByteArray, name: String, mime: String): Attachment`; `fun isFileComplete(a: Attachment): Boolean`; `fun readFile(a: Attachment): ByteArray`.

- [ ] **Step 1: Testy (failing).**
  - `P2pHostTest` (przez `TestP2pClient`): `put` + `status` + `get` po Noise; inna epoka → `{epoch}`; zły kawałek → jawne 409 `chunk differs`; host bez `files` → 404 `not found`; zła sesja → 401; usunięte urządzenie → 403; `onSynced` niewołane po żądaniu pliku.
  - `PhoneRouterTest`: `/p2p/v2/file` bez sejfu → 503 `vault not ready`; liczy się jako aktywność.
  - `PhoneVaultStoreTest`: `addFile` → `isFileComplete` true, `readFile` = treść, host `status` widzi `complete`; plik wysłany przez klienta testowego → `readFile` po zapisie wpisu z jego opisem; `pruneFiles`: nieużywany i starszy niż 24 h → usunięty, nieużywany młodszy → zostaje, używany → zostaje; sprzątanie wołane po `unlock` i po `upsertContent`/`delete` (sterowany `now`); nieczytelny rekord w sejfie → `pruneFiles() == 0`, nic nie usunięte (Review Focus 2); `createVault` po `disconnect` → katalog `p2p/files` pusty, a `put` przez starą instancję hosta po resecie nie tworzy plików (Review Focus 5); zablokowany sejf → `addFile`/`readFile` rzucają `Sejf jest zablokowany`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementacja. Stary host po resecie: magazyn plików owinięty jak `ResettableStore` (flaga `closed`, `put` rzuca → 500 i nic nie zapisane). Kolejność blokad bez zmian (sprzątanie: lista `entries()` pod blokadą obiektu, potem `synchronized(files)`).
- [ ] **Step 4:** `./gradlew :core:test :app:testDebugUnitTest --console=plain` PASS.
- [ ] **Step 5: Commit** `feat(android-core): phone hosts /p2p/v2/file`.

### Task 6: Test zgodności z klientem TS i dokumentacja

**Files:**
- Modify: `android/core/src/test/resources/p2p-interop.ts` i `T/p2p/P2pInteropTest.kt` (nowy przypadek), `docs/SPEC.md`, `docs/SYNCHRONIZACJA.md`, `docs/ARCHITEKTURA.md`, `docs/TESTY.md`

- [ ] **Step 1: Test (opcjonalny, `PASSHOLDER_INTEROP_TEST=1`).** Prawdziwy `syncFiles` z `core/src/files/client.ts` przeciw hostowi Kotlin z `MemoryFileStore`: wtyczka wysyła plik 3 kawałki → Kotlin `FileChunks.decrypt` z magazynu = oryginał; plik dodany po stronie Kotlina (`FileChunks.encrypt` + `put` wszystkich kawałków, opis we wpisie przez `PhoneVault.upsertContent`) → wtyczka po sync wpisów i `syncFiles` ma `downloaded: 1` i ten sam SHA-256.
- [ ] **Step 2:** `NO_PROXY=localhost npm ci --cafile=/root/.ccr/ca-bundle.crt` (raz), `PASSHOLDER_INTEROP_TEST=1 ./gradlew :core:test --tests "*Interop*" --console=plain` PASS.
- [ ] **Step 3: Dokumentacja (krótko, po polsku):** SPEC – „Kotlin: `core/files/`” przy opisie załącznika; SYNCHRONIZACJA – host telefonu `/p2p/v2/file`, magazyn na dysku (K2), 507 przy < 50 MB, sprzątanie (K3), reset przy zmianie epoki; ARCHITEKTURA – pakiet `files/` w `android/core`; TESTY – nowe pliki testów i liczby, wektory `files.json` sprawdzane w Kotlinie.
- [ ] **Step 4:** `./gradlew :core:test :app:testDebugUnitTest --console=plain` i `npm test -w core` PASS.
- [ ] **Step 5: Commit** `test(android-core): file sync interop; docs: files on the phone`.
