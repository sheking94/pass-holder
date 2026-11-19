# Eksport i import ZIP z plikami (krok 5) – plan wykonania

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wtyczka i telefon eksportują sejf razem z plikami do archiwum PassHolder ZIP i importują takie archiwum (wpisy + pliki), a archiwum z jednego urządzenia działa na drugim.

**Architecture:** Rdzeń TS dostaje własny, mały czytnik i zapis ZIP (`core/src/transfer/zip.ts`, deflate przez wbudowane `CompressionStream`/`DecompressionStream`, bez nowych zależności) oraz format archiwum (`passholder-zip.ts`: indeks `passholder.json` z opisami plików `{name, mime, size, path}` + pliki w `files/`). Kotlin używa `java.util.zip` i portu parsera indeksu. Import: najpierw indeks i duplikaty, potem tylko potrzebne pliki są szyfrowane i zapisywane do magazynu plików (`storeEncryptedFile` / `addFile`), na końcu `importContents` z nowymi opisami; nieużyte i przy błędzie – usuwane. Pliki dostają nowe `id` i klucze i synchronizują się jak dodane ręcznie.

**Tech Stack:** TypeScript (vitest, happy-dom, fake-indexeddb), Kotlin (`java.util.zip`, JUnit 5, Robolectric + Roborazzi), Compose.

**Spec:** `docs/superpowers/specs/2026-11-12-pliki-w-sejfie-design.md`, punkt 8 i 9 krok 5. Kod bazowy: PR #42–#45 (`core/src/files/`, `extension/src/vault-store.ts`, `K/p2p/PhoneVaultStore.kt`).

Skróty: `A/` = `android/app/src/main/kotlin/io/github/sheking94/passholder/app/`, `AT/` = `android/app/src/test/kotlin/io/github/sheking94/passholder/app/`, `K/` = `android/core/src/main/kotlin/io/github/sheking94/passholder/core/`, `KT/` = `android/core/src/test/kotlin/io/github/sheking94/passholder/core/`.

## Global Constraints

- Archiwum: pierwszy wpis ZIP to `passholder.json`, potem pliki `files/<n>-<nazwa>` (`n` od 1 w kolejności eksportu, w nazwie `<>:"|?*` → `_`; prawdziwa nazwa tylko w indeksie). Ścieżka z archiwum **nigdy** nie trafia do systemu plików – służy tylko do wyszukania wpisu w ZIP.
- Indeks: `{"format":"passholder","version":3,"entries":[…]}` jak eksport JSON; wpis z plikami ma `attachments: [{name, mime, size, path}]` (dokładnie te klucze, w tej kolejności); bez `id`, `key`, `sha256`, `chunks`.
- Limity: archiwum ≤ **268 435 456 B (256 MiB)**; `passholder.json` ≤ 10 MiB po rozpakowaniu; plik ≤ `MAX_FILE_SIZE` (10 485 760) po rozpakowaniu (licznik w trakcie inflate, nie nagłówek); ≤ 40 plików na wpis (`MAX_ATTACHMENTS_PARSED`); ≤ 5000 pozycji w ZIP.
- Odrzucane archiwa (komunikat „Archiwum ZIP jest uszkodzone albo nieobsługiwane”): ZIP64, szyfrowane (bit 0), metoda inna niż 0/8, wiele dysków, powtórzone nazwy, zły CRC-32.
- Rozpoznanie ZIP po treści: pierwsze 4 bajty `50 4B 03 04`.
- Teksty UI (dokładnie, oba urządzenia):
  - opcja eksportu „PassHolder ZIP (wpisy i pliki)”,
  - dopisek przy sejfie z plikami: „<skippedFilesPhrase(N)> w formatach JSON i CSV. Wybierz PassHolder ZIP, żeby je zabrać.”,
  - ostrzeżenie dla ZIP (zamiast zwykłego, gdy wybrany ZIP): „Uwaga: archiwum nie jest zaszyfrowane. Zawiera hasła jawnym tekstem i odszyfrowane pliki. Każdy, kto je zobaczy (inny program, kopia zapasowa, folder w chmurze), pozna je wszystkie. Usuń je zaraz po użyciu.”,
  - po eksporcie: „Wyeksportowano <entriesNoun> i <filesNoun>.” + przy pominiętych „Pominięto <filesNoun>, które czekają na synchronizację albo są uszkodzone.” + „Usuń archiwum, gdy nie będzie już potrzebne.”,
  - podsumowanie importu: dotychczasowe zdania + „Dodano <filesNoun>.” (gdy > 0) + „Pominięto <filesNoun>: <lista ≤5> …” (gdy są), ostatnie zdanie „Usuń plik z dysku, zawiera hasła jawnym tekstem.” bez zmian,
  - powody pominięcia pliku (`at` = „wpis N, <nazwa>”): „brak w archiwum”, „inny rozmiar niż w opisie”, „za duży”, „uszkodzony”,
  - za duże archiwum: „Plik jest za duży (limit 256 MiB)”,
  - `filesNoun(n)` = „1 plik / 2 pliki / 5 plików”.
- Treść jawna plików tylko w pamięci, na czas jednego pliku (szyfrowanie / zapis do ZIP); tablice zerowane po użyciu w Kotlinie. Bez kopii archiwum w `cacheDir`.
- Komentarze i nazwy po angielsku, teksty UI i dokumentacja po polsku. Testy UI Android: jeden `@Test` na klasę.

## Decyzje planu (do akceptacji)

- **Z1 – własny ZIP w TS, bez biblioteki.** ~250 linii: CRC-32, zapis (deflate, a gdy nie zmniejsza – stored), odczyt z katalogu centralnego (obsługuje deskryptory danych z `java.util.zip`). Deflate robi przeglądarka (`CompressionStream("deflate-raw")`, Chrome 103+, Node 22 w testach). Za: zero zależności, pełna kontrola limitów (zip-bomb), nauka formatu. Alternatywa: `fflate` (~8 KB, sprawdzona) – mniej kodu, ale nowa zależność. Kotlin: `java.util.zip` (w JDK).
- **Z2 – JSON zostaje, ZIP dochodzi jako czwarta opcja** (druga na liście, domyślnie nadal JSON). Eksport JSON/CSV dalej bez plików, z nowym dopiskiem. Alternatywa: ZIP zamiast PassHolder JSON.
- **Z3 – duplikaty jak dziś:** wpis o tej samej treści (bez załączników, `contentKey`) jest pomijany razem ze swoimi plikami. Ponowny import tego samego archiwum nic nie dubluje. Skutek: jeśli w sejfie jest ten sam wpis bez plików, pliki z archiwum nie zostaną do niego dołączone. Alternatywa: dołączać brakujące pliki do istniejącego wpisu (więcej kodu, nowy przypadek konfliktu).
- **Z4 – problem z jednym plikiem nie blokuje importu:** wpis trafia do sejfu bez tego pliku, plik na liście pominiętych. Problem z całym archiwum (uszkodzony ZIP, brak `passholder.json`, brak miejsca, blokada sejfu) → nic nie zostaje zaimportowane, dodane pliki są usuwane.
- **Z5 – eksport nie czeka na pliki:** plik niekompletny (czeka na synchronizację) albo uszkodzony jest pomijany, wpis wychodzi bez niego, komunikat podaje liczbę.
- **Z6 – telefon czyta archiwum strumieniowo** (`ZipInputStream`, jeden plik naraz w pamięci, bez kopii na dysk), więc wymaga, by `passholder.json` był pierwszy – tak zapisują oba urządzenia. Archiwum przepakowane ręcznie z innym porządkiem → „Archiwum nie jest eksportem PassHolder”. Wtyczka czyta całe archiwum do pamięci (≤ 256 MiB) i kolejność jej nie obchodzi.
- **Z7 – `passholder.json` wyjęty z ZIP i zaimportowany sam** daje wpisy bez plików (opisy w formacie archiwum są pomijane, nie psują wpisu); w podsumowaniu „Pominięto N plików: … importuj całe archiwum ZIP”.
- **Z8 – limit archiwum 256 MiB** na obu urządzeniach (spec: „wyżej niż 10 MiB, wartość w planie”). Zwykły JSON/CSV zostaje przy 10 MiB.
- **Z9 – jeden PR, pięć zadań** (rdzeń TS, rdzeń Kotlin, wtyczka, Android, dokumentacja). Spec nie dzieli kroku 5; podział na dwa PR (wtyczka / Android) możliwy, jeśli wolisz mniejsze przeglądy.

## Review Focus

1. Archiwum z telefonu (`java.util.zip`, deflate z deskryptorem danych) importowane we wtyczce. Test w zadaniu 2 (fixture z Kotlina czytany przez TS) i opcjonalny test interop.
2. Zip-bomb: plik deklaruje 1 KB, po rozpakowaniu ma 11 MB → odrzucony bez rozpakowania całości. Test w zadaniu 1 i 2.
3. Ten sam wpis w archiwum dwa razy / import tego samego archiwum drugi raz → żadnych nowych wpisów ani osieroconych plików w magazynie. Testy w zadaniu 3 i 4.
4. Sejf blokuje się w trakcie długiego importu (szyfrowanie wielu plików) → nic nie zostaje, magazyn plików pusty. Testy w zadaniu 3 i 4.
5. Nazwa pliku z `:`/`?` (Windows) i polskimi znakami → ścieżka w ZIP bezpieczna, nazwa po imporcie identyczna jak przed eksportem. Test w zadaniu 1 (round-trip) i 2.

---

### Task 1: Rdzeń TS – ZIP i format archiwum

**Files:**
- Create: `core/src/transfer/zip.ts`, `core/src/transfer/passholder-zip.ts`
- Modify: `core/src/transfer/index.ts` (eksport), `core/src/transfer/passholder-json.ts` (Z7), `core/scripts/transfer-vectors.ts` (fixture)
- Create: `core/test-vectors/transfer/archive.passholder.zip`, `core/test-vectors/transfer/archive.expected.json`
- Test: `core/test/transfer/zip.test.ts`, `core/test/transfer/passholder-zip.test.ts`, `core/test/transfer/passholder-json.test.ts`

**Interfaces:**
- Produces (`zip.ts`):
  - `crc32(bytes: Uint8Array): number`
  - `class ZipWriter { constructor(date?: Date); add(path: string, bytes: Uint8Array): Promise<void>; finish(): Uint8Array[] }` – części do `new Blob(parts)`; UTF-8 z flagą bit 11.
  - `interface ZipEntry { path: string; method: 0 | 8; compressedSize: number; size: number; crc: number; offset: number }`
  - `readZipIndex(bytes: Uint8Array): ZipEntry[]` (katalog centralny; limity i odrzucenia z Global Constraints)
  - `readZipEntry(bytes: Uint8Array, e: ZipEntry, maxSize: number): Promise<Uint8Array>` – przekroczenie `maxSize` w trakcie → `ZIP_ENTRY_TOO_LARGE`; zły CRC → `ZIP_INVALID`.
  - stałe `ZIP_INVALID = "Archiwum ZIP jest uszkodzone albo nieobsługiwane"`, `ZIP_ENTRY_TOO_LARGE = "Entry too large"`, `isZip(bytes: Uint8Array): boolean`.
- Produces (`passholder-zip.ts`):
  - `MAX_ZIP_BYTES = 268435456`, `ARCHIVE_INDEX = "passholder.json"`, `NOT_ARCHIVE = "Archiwum nie jest eksportem PassHolder"`
  - `interface ArchivedFile { name: string; mime: string; size: number; path: string }`
  - `interface ArchiveEntry { content: EntryContentV3 /* bez attachments */; files: ArchivedFile[] }`
  - `interface ParsedArchive { entries: ArchiveEntry[]; skipped: ImportSkip[] }`
  - `archivePath(n: number, name: string): string`
  - `exportPassHolderZip(entries: readonly EntryContentV3[], readFile: (a: Attachment) => Promise<Uint8Array | undefined>, date?: Date): Promise<{ parts: Uint8Array[]; files: number; missing: number }>`
  - `parseArchiveIndex(text: string): ParsedArchive` (te same reguły co `parsePassHolderJson`, wpis z błędnym opisem pliku → „zły format wpisu”)
  - `openPassHolderZip(bytes: Uint8Array): Promise<{ parsed: ParsedArchive; readFile(f: ArchivedFile): Promise<Uint8Array> }>` – `readFile` rzuca `Error` z powodem po polsku z Global Constraints („brak w archiwum” / „inny rozmiar niż w opisie” / „za duży” / „uszkodzony”).
  - Odmiana „plik/pliki/plików” zostaje w UI (`extension/src/plural.ts`, `A/ImportSummary.kt`), nie w rdzeniu.
- Z7: `ParsedImport` dostaje opcjonalne pole `files?: ImportSkip[]`; `parsePassHolderJson` wpisuje tam pominięte opisy z powodem „importuj całe archiwum ZIP”, a UI pokazuje je jak `fileSkips`.

- [ ] **Step 1: Testy `zip.test.ts`:** `crc32("123456789") == 0xCBF43926`; round-trip `ZipWriter` → `readZipIndex`/`readZipEntry` dla pustego pliku tekstowego, 300 KB losowych bajtów (stored, bo deflate nie zmniejsza) i 300 KB zer (method 8); nazwa „Zażółć ?.txt” wraca bez zmian; ręcznie złożone bajty: ZIP64 (`0xFFFFFFFF` rozmiar), bit szyfrowania, metoda 12, powtórzona nazwa, zły CRC → `ZIP_INVALID`; wpis z nagłówkiem `size = 1000` i treścią 11 MB zer → `ZIP_ENTRY_TOO_LARGE` przy `maxSize = MAX_FILE_SIZE`; `isZip` dla `PK\3\4` i dla `{`.
- [ ] **Step 2: Testy `passholder-zip.test.ts`:** eksport 2 wpisów (jeden z 2 plikami, w tym „a:b?.jpg”) → pierwszy wpis ZIP to `passholder.json`, ścieżki `files/1-a_b_.jpg`, `files/2-…`; indeks bez `key/sha256/id/chunks`; `readFile` zwracające `undefined` dla jednego pliku → `missing == 1`, wpis bez tego opisu; `openPassHolderZip` na wyniku eksportu → te same treści i bajty plików; brak `passholder.json` → `NOT_ARCHIVE`; opis z nieznanym kluczem / 41 plików → wpis pominięty „zły format wpisu”; `readFile` dla ścieżki nieobecnej → „brak w archiwum”, rozmiar różny → „inny rozmiar niż w opisie”. `passholder-json.test.ts`: indeks z archiwum importowany jako JSON → wpisy bez plików, `files` z powodem „importuj całe archiwum ZIP”.
- [ ] **Step 3:** `cd core && npx vitest run test/transfer` → FAIL.
- [ ] **Step 4:** Implementacja `zip.ts` (zapis: nagłówek lokalny z rozmiarami, bez deskryptora; odczyt tylko przez katalog centralny + nagłówek lokalny dla długości nazwy/extra), `passholder-zip.ts`, zmiana w `passholder-json.ts`. Fixture: `transfer-vectors.ts` zapisuje `archive.passholder.zip` (stała data, 2 wpisy, 2 pliki) i `archive.expected.json` (treści + `sha256` plików).
- [ ] **Step 5:** `npx vitest run` i `npm run typecheck` w `core` → bez błędów.
- [ ] **Step 6:** Commit `feat(core): PassHolder ZIP archive with files`.

### Task 2: Rdzeń Kotlin – archiwum i import do sejfu telefonu

**Files:**
- Create: `K/transfer/PassHolderZip.kt`
- Modify: `K/transfer/PassHolderJson.kt` (Z7), `K/transfer/Common.kt` (pole `files` w `ParsedImport`), `K/p2p/PhoneVaultStore.kt`
- Test: `KT/transfer/PassHolderZipTest.kt`, `KT/p2p/PhoneVaultStoreArchiveTest.kt`, opcjonalnie `KT/transfer/ZipInteropTest.kt` + `android/core/src/test/resources/zip-interop.ts` (wzór `PhoneInteropTest`, zmienna `PASSHOLDER_INTEROP_TEST=1`)
- Create: `core/test-vectors/transfer/archive-kotlin.passholder.zip` (zapisany przez test Kotlina, `-Dpassholder.writeFixtures=true`), test TS czytający go w `core/test/transfer/passholder-zip.test.ts`

**Interfaces:**
- Consumes: format i komunikaty z zadania 1 (te same stałe po polsku).
- Produces:
  - `object PassHolderZip { const val MAX_ZIP_BYTES = 268435456L; fun archivePath(n: Int, name: String): String; fun parseIndex(text: String): ParsedArchive; fun export(entries: List<EntryContentV3>, out: OutputStream, readFile: (Attachment) -> ByteArray?): ExportedArchive }`
  - `data class ArchivedFile(val name: String, val mime: String, val size: Int, val path: String)`, `data class ArchiveEntry(val content: EntryContentV3, val files: List<ArchivedFile>)`, `data class ParsedArchive(val entries: List<ArchiveEntry>, val skipped: List<ImportSkip>)`, `data class ExportedArchive(val files: Int, val missing: Int)`
  - `class ArchiveReader(input: InputStream) : Closeable { fun readIndex(): ParsedArchive; fun forEachFile(wanted: Set<String>, action: (path: String, bytes: ByteArray) -> Unit) }` – strumieniowo; pierwszy wpis inny niż `passholder.json` → `NOT_ARCHIVE`; licznik bajtów archiwum (> `MAX_ZIP_BYTES` → „Plik jest za duży (limit 256 MiB)”), licznik rozpakowanych bajtów na wpis.
  - `data class ArchiveImportResult(val entries: ImportResult, val filesAdded: Int, val fileSkips: List<ImportSkip>)`
  - `PhoneVaultStore.importArchive(input: InputStream): Pair<ParsedArchive, ArchiveImportResult>` – kolejność: indeks → duplikaty (`contentKey` vs `allContents()` i wcześniejsze z archiwum) → `forEachFile` tylko dla plików wpisów nie-duplikatów, każdy przez `addFile` (rozmiar ≠ opis → pominięty) → `importContents` z opisami → `discardFiles(wszystkie dodane)` (usuwa tylko nieużyte). Wyjątek w trakcie → `discardFiles(dodane)` i wyjątek dalej.

- [ ] **Step 1: Testy `PassHolderZipTest`:** czyta `archive.passholder.zip` z zadania 1 → treści i `sha256` jak `archive.expected.json`; `export` → `ArchiveReader` round-trip (nazwa „Zażółć ?.txt”); indeks nie pierwszy → `NOT_ARCHIVE`; wpis zadeklarowany 1000 B, 11 MB zer → plik pominięty „za duży”; archiwum > limit (strumień z licznikiem, limit podmieniony parametrem `internal`) → komunikat limitu; `parseIndex` = te same przypadki co TS (nieznany klucz, 41 plików). Z7 w `PassHolderJsonTest`.
- [ ] **Step 2: Testy `PhoneVaultStoreArchiveTest`:** import do pustego sejfu → wpisy z nowymi `id` plików, `readFile` zwraca te same bajty; drugi import tego samego → 0 dodanych, liczba plików w magazynie bez zmian; brak pliku w archiwum → wpis jest, `fileSkips` „brak w archiwum”; `addFile` rzuca (brak miejsca – podmieniony magazyn albo sejf zablokowany w `action`) → wyjątek, `allContents()` bez zmian, magazyn plików bez nowych id.
- [ ] **Step 3:** `cd android && ./gradlew :core:test --tests '*PassHolderZip*' --tests '*Archive*' --tests '*PassHolderJson*'` → FAIL.
- [ ] **Step 4:** Implementacja. `export` przez `ZipOutputStream` (DEFLATED, indeks pierwszy), bajty pliku zerowane po zapisie. Test zapisujący fixture `archive-kotlin.passholder.zip` (tylko z flagą) + uruchomienie go raz i commit pliku; test TS: `openPassHolderZip` na tym pliku → oczekiwane treści.
- [ ] **Step 5:** `./gradlew :core:test` i `cd core && npx vitest run` → bez błędów. Opcjonalnie `PASSHOLDER_INTEROP_TEST=1 ./gradlew :core:test --tests '*ZipInterop*'`.
- [ ] **Step 6:** Commit `feat(android-core): PassHolder ZIP export and streaming import`.

### Task 3: Wtyczka – eksport i import ZIP

**Files:**
- Modify: `extension/src/vault-store.ts`, `extension/src/views/transfer.ts`, `extension/src/import-summary.ts`, `extension/src/plural.ts`
- Test: `extension/test/vault-store-files.test.ts` (lub nowy `vault-store-archive.test.ts`), `extension/test/import.test.ts`, `extension/test/screens/` (ekran eksportu)

**Interfaces:**
- Consumes: `transfer.exportPassHolderZip`, `transfer.openPassHolderZip`, `transfer.isZip`, `transfer.MAX_ZIP_BYTES`, `files.encryptFile`, `files.storeEncryptedFile`, `files.usedAttachments`.
- Produces:
  - `VaultStore.exportArchive(): Promise<{ parts: Uint8Array[]; entries: number; files: number; missing: number }>` – `readFile` = `readFile(a)` gdy `fileStatus(a) === "ready"`, błąd → `undefined`.
  - `VaultStore.importArchive(bytes: Uint8Array): Promise<{ parsed: transfer.ParsedArchive; result: ImportResult; filesAdded: number; fileSkips: transfer.ImportSkip[] }>` – kolejność jak w zadaniu 2; po zapisaniu plików `requireKeys()` (blokada → wyjątek); błąd → usunięcie dodanych plików, sejf bez zmian; na końcu usunięcie dodanych plików nieużywanych przez żaden żywy wpis.
  - `filesNoun(n: number): string` w `plural.ts`; `importSummary(parsed, result, format, files?: { added: number; skipped: ImportSkip[] })`.

- [ ] **Step 1: Testy:** `importArchive` (archiwum z `exportPassHolderZip`): wpisy dodane, `readFile` nowego opisu = te same bajty, `id` inne niż w źródle; drugi import → `added 0`, `fileStore.ids()` bez zmian; blokada w trakcie (`lock()` w `readFile` podmienionego magazynu lub po `storeEncryptedFile`) → wyjątek, `allContents()` i `fileStore.ids()` jak przed; `exportArchive` z plikiem „czeka” → `missing 1`. Ekran: opcja „PassHolder ZIP (wpisy i pliki)”, przy wybranym ZIP ostrzeżenie archiwum, dopisek dla sejfu z plikami, wybór pliku `.zip` w imporcie trafia do `importArchive` (po `isZip`), plik > 256 MiB (`File` o `size` podmienionym) → komunikat limitu bez czytania. `importSummary` z plikami – dokładne zdania z Global Constraints.
- [ ] **Step 2:** `cd extension && npx vitest run test/import.test.ts test/vault-store-files.test.ts test/screens` → FAIL.
- [ ] **Step 3:** Implementacja. Import czyta `await chosen.arrayBuffer()`, `isZip` → archiwum, w przeciwnym razie `TextDecoder` + dotychczasowe `parseImportFile`. `accept` w polu pliku: `.json,.csv,.zip,application/json,text/csv,application/zip`. Eksport: `downloadFile(\`passholder-${day}.zip\`, new Blob(parts), "application/zip")`.
- [ ] **Step 4:** `npx vitest run`, `npm run typecheck`, `npm run build` w `extension` → bez błędów. Zrzuty ekranu eksportu (ZIP wybrany) i podsumowania importu do `/mnt/project-files/wtyczka-v3/18-…`, `19-…`.
- [ ] **Step 5:** Commit `feat(extension): export and import PassHolder ZIP with files`.

### Task 4: Android – eksport i import ZIP

**Files:**
- Modify: `A/ui/TransferScreen.kt`, `A/AppViewModel.kt`, `A/TransferFiles.kt`, `A/ImportSummary.kt`
- Test: `AT/TransferFilesTest.kt`, `AT/TransferScreenTest.kt` (+ nowa klasa na ZIP, jeden `@Test` na klasę), `AT/ImportSummaryTest.kt`

**Interfaces:**
- Consumes: `PassHolderZip.export`, `PhoneVaultStore.importArchive`, `isFileComplete`, `readFile`.
- Produces:
  - `TransferFiles.isZip(open: () -> InputStream?): Boolean` (4 bajty), `TransferFiles.defaultFileName` → `passholder-RRRR-MM-DD.zip` dla ZIP, `TransferFiles.READ_FAILED/WRITE_FAILED` bez zmian.
  - `AppViewModel.exportArchiveTo(uri: Uri?)`, `importFrom(uri)` rozgałęzia: ZIP → `store.importArchive(resolver.openInputStream(uri))`, inaczej dotychczasowa ścieżka tekstowa.
  - Wybór eksportu: osobny stan ekranu (`ExportChoice` z `zip = true`), bo `TransferFormat` się nie zmienia; launcher `CreateDocument("application/zip")`; typy importu + `"application/zip"`.
  - `filesNoun(n: Int)`, `importSummary(..., files: ArchiveFiles? = null)` – port zmian z zadania 3.

- [ ] **Step 1: Testy:** `isZip` (PK / `{` / pusty strumień); nazwa domyślna `.zip`; `importSummary` z plikami – te same zdania co TS; ekran: opcja ZIP, ostrzeżenie archiwum po wybraniu, dopisek z plikami (zrzut Roborazzi `51-eksport-zip.png`); ViewModel (Robolectric): `importFrom` na archiwum z zadania 2 → status z „Dodano 2 pliki.”; `exportArchiveTo` → archiwum czytelne przez `ArchiveReader`, status „Wyeksportowano … i …”.
- [ ] **Step 2:** `cd android && ./gradlew :app:testDebugUnitTest --tests '*Transfer*' --tests '*ImportSummary*'` → FAIL.
- [ ] **Step 3:** Implementacja; IO poza wątkiem głównym (`launchVaultOperation`), okno 60 s przy wyborze/zapisie jak dotąd. Zapis eksportu trybem `"wt"`, błąd → `WRITE_FAILED`.
- [ ] **Step 4:** `./gradlew :app:testDebugUnitTest` i `./gradlew :app:assembleDebug` → bez błędów. Zrzut do `/mnt/project-files/android-v3/51-eksport-zip.png`.
- [ ] **Step 5:** Commit `feat(android): export and import PassHolder ZIP with files`.

### Task 5: Dokumentacja

**Files:**
- Modify: `docs/FUNKCJE.md` (import/eksport: ZIP), `docs/ARCHITEKTURA.md` (moduł `transfer/zip`, przepływ importu archiwum), `docs/SPEC.md` (format PassHolder ZIP, limity), `docs/TESTY.md` (test ręczny **T23**), spec `docs/superpowers/specs/2026-11-12-pliki-w-sejfie-design.md` punkt 8 (status: zrobione, odnośnik do planu)

- [ ] **Step 1:** Opis kodu z tego kroku (po polsku, zwięźle): format, limity, kolejność importu, co się dzieje przy błędach (Z3–Z7).
- [ ] **Step 2:** T23: (1) wtyczka: wpis ze zdjęciem 5 MB → eksport ZIP → rozpakuj i sprawdź `passholder.json` + `files/`; (2) telefon: nowy sejf lub inny wpis → import tego ZIP → „Pobierz” daje to samo zdjęcie; (3) odwrotnie: eksport ZIP z telefonu → import we wtyczce; (4) drugi import tego samego ZIP → „Pominięto … już są w sejfie”; (5) usuń archiwa.
- [ ] **Step 3:** Commit `docs: PassHolder ZIP export and import, manual test T23`.
