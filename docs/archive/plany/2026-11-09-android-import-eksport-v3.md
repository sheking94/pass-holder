# Import i eksport na Androidzie (V3, krok 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aplikacja na Androida importuje i eksportuje wszystkie typy wpisów w formatach PassHolder JSON, Bitwarden JSON i NordPass CSV, z tym samym wynikiem co wtyczka.

**Architecture:** Port 1:1 parserów i eksporterów z `core/src/transfer/` (TS) do czystego Kotlina w `android/core`
(pakiet `io.github.sheking94.passholder.core.transfer`). Zgodność pilnują wspólne pliki z `core/test-vectors/transfer/`:
istniejące wektory importu i nowe wektory eksportu (bajt w bajt) oraz sortowania. Import zapisuje wszystkie rekordy
jednym dopisaniem do pliku (`SyncStore.putAll`), więc jest atomowy. W aplikacji nowy ekran „Import i eksport” w menu ⋮,
pliki przez Storage Access Framework (`OpenDocument`, `CreateDocument`).

**Tech Stack:** Kotlin, kotlinx.serialization.json (tylko `JsonElement`), JUnit 5, Compose, Robolectric + Roborazzi; TS + vitest (wektory).

**Spec:** `docs/superpowers/specs/2026-11-07-typy-wpisow-design.md` sekcja 6 (z „Decyzjami kroku 4”) + decyzje kroku 5 niżej.

## Global Constraints

- Decyzje kroku 5 (zaakceptowane 2026-11-09): (1) parsery w `android/core`, pakiet `transfer`, testy JUnit na plikach z `core/test-vectors/transfer/`; (2) ekran „Import i eksport” w menu ⋮ (po „Ustawienia”), import jednym przyciskiem z rozpoznaniem formatu, eksport z wyborem formatu, ostrzeżeniem i nazwą `passholder-RRRR-MM-DD.json` / `.csv`; (3) sortowanie `java.text.Collator.getInstance(Locale.forLanguageTag("pl"))`, różnice z przeglądarką dopasować do wektora sortowania i opisać; (4) plik importu ponad 10 MiB (10 485 760 bajtów) → błąd „Plik jest za duży (limit 10 MiB)”; (5) podsumowanie na ekranie, nowe wpisy czekają na synchronizację.
- Wszystkie reguły i teksty z TS bez zmian: powody pominięcia, `at` („wiersz N”, „wpis N”), komunikaty błędów, etykiety własnych pól, nagłówek NordPass, kolejność eksportu (nazwa, potem typ: login, contact, card, note, document). Źródłem prawdy jest kod TS w `core/src/transfer/` i jego testy w `core/test/transfer/`.
- Eksport bajt w bajt jak TS: JSON jak `JSON.stringify(v, null, 2) + "\n"` (2 spacje, `"klucz": wartość`, `[]`/`{}` dla pustych, znaki spoza ASCII bez ucieczki), CSV z `\r\n`.
- Import nie sprawdza formatu dat ani `expiry`. Wpis > 64 KiB po zaszyfrowaniu → „za duży” (`EntryTooLargeException`), reszta wchodzi.
- Format wpisu v3 i synchronizacja bez zmian. Teksty UI po polsku. Pliki przykładowe tylko z fałszywymi danymi.
- Bez nowych zależności Gradle (JSON tylko przez istniejące kotlinx.serialization.json).

## Decyzja do potwierdzenia przy przeglądzie planu

- **Blokada przy wyborze pliku.** Systemowy wybór pliku zatrzymuje aktywność (`onStop`), a to dziś blokuje sejf od razu
  (gdy „Blokuj dopiero po 60 s” jest wyłączone). Plan: na czas otwartego wyboru pliku z ekranu Import i eksport sejf
  czeka do 60 s (ten sam `LeaveLock`), także przy wyłączonym ustawieniu. Po powrocie po czasie: blokada i komunikat
  „Zablokowano: wybór pliku trwał ponad 60 s”, operacja przepada.

## Review Focus

- Plik ponad 10 MiB albo nie w UTF-8 (np. Windows-1250 z Excela) → błąd po polsku, sejf bez zmian (UTF-8 z `CodingErrorAction.REPORT`, błąd „Plik nie jest zapisany w UTF-8”) – test w Task 6.
- Ten sam plik zaimportowany dwa razy → za drugim razem 0 dodanych (test w Task 5).
- Błąd zapisu w połowie importu → w pliku rekordów i w pamięci nic z importu (test w Task 5, sklep rzucający w `putAll`).
- Użytkownik anuluje wybór pliku (wynik `null`) → bez komunikatu błędu, ekran bez zmian (test w Task 6).
- Nazwy z polskimi literami, wielkimi/małymi literami i cyframi → ta sama kolejność eksportu co we wtyczce (wektor sortowania, Task 1 i 2).

---

### Task 1: Wektory eksportu i sortowania (TS)

**Files:**
- Create: `core/scripts/transfer-vectors.ts` (generator; uruchamiany ręcznie, wynik commitowany)
- Create: `core/test-vectors/transfer/export.passholder.json`, `export.bitwarden.json`, `export.nordpass.csv` – eksport wpisów z `passholder.expected.json` + `bitwarden.expected.json` (połączonych) w każdym formacie
- Create: `core/test-vectors/transfer/sort.json` – `{"names":[…],"sorted":[…]}`
- Test: `core/test/transfer/vectors.test.ts`

**Interfaces:**
- Produces: pliki wektorów, których używają Task 2–6.

- [ ] **Step 1:** Test `vectors.test.ts`: dla każdego formatu `exportFile(f, entries)` === treść pliku `export.*` (entries = połączone `entries` z dwóch plików `.expected.json`); `[...names].sort((a,b)=>a.localeCompare(b,"pl"))` toEqual `sorted`. Uruchom: `cd core && npx vitest run test/transfer/vectors.test.ts` → FAIL (brak plików).
- [ ] **Step 2:** Generator pisze cztery pliki. Lista `names` w `sort.json` (dokładnie): `["żaba","Zebra","zebra","Źdźbło","Łódź","lody","Lody","ćma","Cma","cma","Ąbc","abc","Abc","Ślimak","sok","Ósemka","osa","Ńa","na","10 kotów","2 koty","Konto (stare)","Konto-nowe","konto_x"," spacja","Ęka","ewa"]`.
- [ ] **Step 3:** `node --experimental-strip-types core/scripts/transfer-vectors.ts`, potem test → PASS; `cd core && npx vitest run` cały pakiet zielony.
- [ ] **Step 4:** Commit `test(core): export and sort vectors for the Kotlin transfer port`.

### Task 2: Wspólne elementy Kotlin – model importu, CSV, JSON, sortowanie

**Files:**
- Modify: `android/core/src/main/kotlin/io/github/sheking94/passholder/core/p2p/EntryV3.kt` (`parseContent`, `contentJson`)
- Create: `android/core/src/main/kotlin/io/github/sheking94/passholder/core/transfer/Common.kt`, `Csv.kt`, `JsonText.kt`
- Test: `android/core/src/test/kotlin/io/github/sheking94/passholder/core/transfer/CommonTest.kt`, `CsvTest.kt`, `JsonTextTest.kt`, dopisek w `p2p/EntryV3Test.kt`

**Interfaces:**
- Produces:
  - `EntryV3.parseContent(value: JsonElement): EntryContentV3` – dokładnie klucze `type,name,note,fields,custom` (jak `p2p.parseEntryContent` w TS), błąd `"Invalid entry payload"`; `parse` korzysta z tych samych pomocników.
  - `EntryV3.contentJson(c: EntryContentV3): JsonObject` – klucze w kolejności `type,name,note,fields,custom` i pola w kolejności jak `serialize`.
  - `data class ImportSkip(val at: String, val reason: String)`, `data class ParsedImport(val entries: List<EntryContentV3>, val skipped: List<ImportSkip>)`
  - `val ENTRY_TYPE_ORDER = listOf("login","contact","card","note","document")`
  - `fun contentKey(c: EntryContentV3): String` – równoważny TS (przycięte teksty, posortowane klucze); wystarczy równość kluczy w Kotlinie, nie musi być identyczny tekstowo z TS.
  - `fun sortForExport(entries: List<EntryContentV3>): List<EntryContentV3>` – Collator `pl` (stały obiekt, `strength` domyślne), potem `ENTRY_TYPE_ORDER`.
  - `fun labelled(name: String, label: String): String`, `fun addressLine(a: PostalAddress): String`
  - `object Csv { data class Row(val line: Int, val fields: List<String>); fun parse(text: String): List<Row>; fun write(rows: List<List<String>>): String }` – port `core/src/transfer/csv.ts`, te same komunikaty.
  - `object JsonText { fun stringify(value: JsonElement): String }` – jak `JSON.stringify(v, null, 2)` (bez końcowego `\n`).

- [ ] **Step 1:** Testy (failing): przeniesione przypadki z `core/test/transfer/csv.test.ts` i `common.test.ts`; `SortVectorTest`: `sort.json` `names` posortowane `sortForExport` (wpisy-notatki o tych nazwach) dają `sorted`; `JsonTextTest`: `stringify` obiektu z zagnieżdżoną tablicą, pustymi `[]`/`{}`, `null`, liczbą, `true`, tekstem `"zażółć \"x\"\n\u0001"` == wynik z TS (wpisz oczekiwany tekst w teście); `EntryV3Test`: `parseContent(contentJson(c)) == c` dla wpisu każdego typu, nadmiarowy klucz `hlc` → wyjątek.
- [ ] **Step 2:** `cd android && ./gradlew :core:test --tests '*transfer*' --tests '*EntryV3Test*'` → FAIL.
- [ ] **Step 3:** Implementacja. Jeśli `SortVectorTest` nie przechodzi z domyślnym Collatorem, dopasuj (np. `RuleBasedCollator` z dodatkową regułą albo inna siła) do wektora i opisz różnicę w KDoc `sortForExport`; nie zmieniaj wektora.
- [ ] **Step 4:** Testy → PASS, cały `:core:test` zielony.
- [ ] **Step 5:** Commit `feat(android-core): transfer common, CSV, JSON text and content parser`.

### Task 3: PassHolder JSON i Bitwarden JSON (Kotlin)

**Files:**
- Create: `android/core/src/main/kotlin/io/github/sheking94/passholder/core/transfer/PassHolderJson.kt`, `BitwardenJson.kt`
- Test: `android/core/src/test/kotlin/io/github/sheking94/passholder/core/transfer/PassHolderJsonTest.kt`, `BitwardenJsonTest.kt`

**Interfaces:**
- Consumes: Task 2.
- Produces: `object PassHolderJson { fun isFormat(value: JsonElement): Boolean; fun parse(text: String): ParsedImport; fun export(entries: List<EntryContentV3>): String }`, `object BitwardenJson { fun isFormat(value: JsonElement): Boolean; fun parse(text: String): ParsedImport; fun export(entries: List<EntryContentV3>): String }` – porty `passholder-json.ts` i `bitwarden-json.ts`, te same komunikaty i etykiety.

- [ ] **Step 1:** Testy (failing): `parse(passholder.json)` == `passholder.expected.json`, `parse(bitwarden.json)` == `bitwarden.expected.json` (oczekiwany plik czytany przez `EntryV3.parseContent` dla wpisów i pola `skipped`); `export(…)` == `export.passholder.json` / `export.bitwarden.json`; obieg `parse(export(x)).entries == sortForExport(x)` dla PassHolder; plus wszystkie przypadki z `core/test/transfer/passholder-json.test.ts` i `bitwarden-json.test.ts` (zaszyfrowany eksport, PIN karty, dokument z „Rodzaj dokumentu”, ważność nie `MM/RR`).
- [ ] **Step 2:** `./gradlew :core:test --tests '*transfer*'` → FAIL.
- [ ] **Step 3:** Implementacja przez wierne przeniesienie logiki TS (te same nazwy funkcji pomocniczych, gdzie to możliwe). `null` w wyjściu Bitwarden jako `JsonNull`, kolejność kluczy jak w TS.
- [ ] **Step 4:** Testy → PASS.
- [ ] **Step 5:** Commit `feat(android-core): PassHolder and Bitwarden JSON import and export`.

### Task 4: NordPass CSV i rozpoznawanie formatu (Kotlin)

**Files:**
- Create: `android/core/src/main/kotlin/io/github/sheking94/passholder/core/transfer/NordPassCsv.kt`, `Transfer.kt`
- Test: `android/core/src/test/kotlin/io/github/sheking94/passholder/core/transfer/NordPassCsvTest.kt`, `TransferTest.kt`

**Interfaces:**
- Consumes: Task 2, 3.
- Produces: `object NordPassCsv { val COLUMNS: List<String>; fun parse(text: String): ParsedImport; fun export(entries: List<EntryContentV3>): String }`; `enum class TransferFormat { PASSHOLDER, BITWARDEN, NORDPASS }`; `data class ImportFile(val format: TransferFormat, val parsed: ParsedImport)`; `object Transfer { fun parseImportFile(text: String): ImportFile; fun exportFile(format: TransferFormat, entries: List<EntryContentV3>): String }` – porty `nordpass-csv.ts` i `detect.ts`. Błędy jako `IllegalArgumentException` z polskim komunikatem.

- [ ] **Step 1:** Testy (failing): `nordpass.csv`, `nordpass-typed.csv` == ich `.expected.json`; `export` == `export.nordpass.csv`; przypadki z `nordpass-csv.test.ts` i `detect.test.ts` (BOM, pusty plik, uszkodzony JSON, nierozpoznany, zaszyfrowany Bitwarden z hasłem, każdy format eksportu rozpoznany ponownie).
- [ ] **Step 2:** `./gradlew :core:test --tests '*transfer*'` → FAIL.
- [ ] **Step 3:** Implementacja.
- [ ] **Step 4:** Testy → PASS.
- [ ] **Step 5:** Commit `feat(android-core): NordPass CSV and import format detection`.

### Task 5: Atomowy import do sejfu telefonu

**Files:**
- Modify: `android/core/src/main/kotlin/io/github/sheking94/passholder/core/p2p/HostSync.kt` (`SyncStore.putAll`), `FileSyncStore.kt`, `PhoneVault.kt`, `PhoneVaultStore.kt` (`ResettableStore.putAll`)
- Test: `FileSyncStoreTest.kt`, `PhoneVaultTest.kt`, `PhoneVaultStoreTest.kt`

**Interfaces:**
- Produces:
  - `SyncStore.putAll(records: List<RemoteRecord>)` – domyślnie `records.forEach(::put)`; `FileSyncStore` dopisuje wszystkie linie jednym zapisem + `fsync`, a pamięć zmienia dopiero po udanym zapisie; `ResettableStore` sprawdza `closed`.
  - `data class ImportResult(val added: Int, val duplicates: Int, val tooLarge: Int)` (w `p2p`)
  - `PhoneVault.importContents(entries: List<EntryContentV3>, newId: () -> String = { UUID.randomUUID().toString() }): ImportResult` – duplikaty wg `contentKey` względem żywych wpisów i wcześniejszych z listy; każdy nowy szyfrowany z kolejnym `clock.tick()` i kolejną rewizją; `EntryTooLargeException` → `tooLarge`; na końcu jeden `putAll` (nic, gdy 0 dodanych). `duplicates = entries.size - added - tooLarge`.
  - `PhoneVaultStore.importContents(entries): ImportResult` i `PhoneVaultStore.allContents(): List<EntryContentV3>` (`@Synchronized`, `touch()`).

- [ ] **Step 1:** Testy (failing): import 3 wpisów → 3 rekordy, kolejne rewizje, `entries()` je pokazuje; drugi import tych samych → `ImportResult(0, 3, 0)`; dwa identyczne w liście (różne spacje na brzegach) → 1 dodany; wpis z notatką 70 000 znaków → `tooLarge = 1`, reszta dodana; sklep, którego `putAll` rzuca → wyjątek przechodzi, `listSince(0)` bez nowych rekordów, a kolejny zwykły `upsertContent` działa; `FileSyncStore.putAll` po ponownym otwarciu pliku daje te same rekordy; `ResettableStore` po resecie odrzuca `putAll`.
- [ ] **Step 2:** `./gradlew :core:test` → FAIL.
- [ ] **Step 3:** Implementacja.
- [ ] **Step 4:** `./gradlew :core:test` → PASS.
- [ ] **Step 5:** Commit `feat(android-core): atomic import into the phone vault`.

### Task 6: Ekran „Import i eksport” w aplikacji

**Files:**
- Create: `android/app/src/main/kotlin/io/github/sheking94/passholder/app/ui/TransferScreen.kt`, `android/app/src/main/kotlin/io/github/sheking94/passholder/app/ImportSummary.kt`
- Modify: `AppViewModel.kt` (`Screen.Transfer`, akcje), `ui/PassHolderUi.kt`, `ui/VaultTopBar.kt` (pozycja „Import i eksport” po „Ustawienia”), `LockController.kt` (okno wyboru pliku)
- Test: `android/app/src/test/kotlin/io/github/sheking94/passholder/app/TransferScreenTest.kt`, `ImportSummaryTest.kt`, dopisek w `LockController`/`ScreenTests` wg istniejącego wzorca (jeden `@Test` na klasę UI)

**Interfaces:**
- Consumes: Task 4, 5.
- Produces:
  - `fun importSummary(parsed: ParsedImport, result: ImportResult, format: TransferFormat): String` – port `extension/src/import-summary.ts` (z `plural`), z jedną zmianą tekstu: „Dodano N wpisów (zsynchronizuj, żeby trafiły do wtyczki).” zamiast „(lokalnie, … na telefon)”.
  - `AppViewModel`: `openTransfer()`, `beginFilePick()` (wywoływane tuż przed `launcher.launch`), `importFrom(uri: Uri?)`, `exportTo(format: TransferFormat, uri: Uri?)`; `uri == null` (anulowanie) → tylko koniec okna wyboru, bez komunikatu. Czytanie: najwyżej 10 MiB + 1 bajt, dekodowanie UTF-8 z `REPORT`; po imporcie `refresh()` i podsumowanie w statusie; po eksporcie status „Zapisano plik. Usuń go zaraz po użyciu, zawiera hasła jawnym tekstem.”
  - `LockController.expectFilePicker()` – następne `onLeftApp` planuje `LeaveLock` na 60 s mimo wyłączonego ustawienia; `onReturn` po czasie blokuje i pokazuje „Zablokowano: wybór pliku trwał ponad 60 s”.
- Ekran: tytuł „Import i eksport”, opis jak we wtyczce („Import rozpoznaje format sam: PassHolder JSON, Bitwarden JSON (bez szyfrowania) albo NordPass CSV.”), przycisk „Importuj plik” (`OpenDocument`, typy `application/json`, `text/*`, `text/comma-separated-values`, `application/octet-stream`); eksport: trzy opcje radiowe z etykietami jak we wtyczce + podpowiedź „Część pól trafi do notatki lub własnych pól.”, ostrzeżenie z wtyczki (tekst „Pobrane” zamienić na „folder w chmurze”), pole wyboru „Rozumiem, plik będzie zawierał hasła jawnym tekstem”, przycisk „Zapisz plik” (`CreateDocument`) nieaktywny bez zaznaczenia; „Wróć do listy”.

- [ ] **Step 1:** Testy (failing): `ImportSummaryTest` (1 / 3 / 5 wpisów, pominięcia > 5 z „; …”, „wiersz” dla NordPass); `TransferScreenTest` (Robolectric): menu ⋮ → „Import i eksport” otwiera ekran; „Zapisz plik” nieaktywny przed zaznaczeniem; zrzut Roborazzi `50-import-eksport.png`; test VM/kontrolera: `importFrom` z plikiem 10 MiB + 1 B → „Plik jest za duży (limit 10 MiB)”, z bajtami Windows-1250 → „Plik nie jest zapisany w UTF-8”, `null` → brak statusu; `expectFilePicker` + wyjście + powrót przed 60 s → sejf otwarty, po 60 s → zablokowany z komunikatem.
- [ ] **Step 2:** `cd android && ./gradlew :app:testDebugUnitTest -ProbolectricRepoUrl=https://maven-central.storage-download.googleapis.com/maven2` → FAIL.
- [ ] **Step 3:** Implementacja.
- [ ] **Step 4:** Testy → PASS; zrzut skopiowany do `/mnt/project-files/android-v3/50-import-eksport.png`.
- [ ] **Step 5:** Commit `feat(android): import and export screen`.

### Task 7: Dokumentacja

**Files:**
- Modify: `docs/FUNKCJE.md` (sekcja importu/eksportu: Android, limit 10 MiB, okno 60 s wyboru pliku, usunąć „brak importu na Androidzie (krok 5)”), `docs/ARCHITEKTURA.md` (pakiet `core.transfer`, `putAll`), `docs/TESTY.md` (liczby testów, wektory eksportu/sortowania, nowy test ręczny **T17**: eksport na telefonie w każdym formacie → import we wtyczce → te same wpisy; import pliku z wtyczki na telefonie → drugi import 0 dodanych), spec sekcja 6: „Decyzje kroku 5 (2026-11-09)” (5 decyzji + okno wyboru pliku + ewentualna różnica Collatora).

- [ ] **Step 1:** Wpisy w dokumentach, liczby testów z faktycznych przebiegów `:core:test`, `:app:testDebugUnitTest`, `core` vitest.
- [ ] **Step 2:** Commit `docs: import and export on Android`.
