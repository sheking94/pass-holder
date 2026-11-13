# Pliki w sejfie – ekrany Androida (krok 4) – plan wykonania

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Na telefonie można dodać, pobrać i usunąć załącznik przy każdym typie wpisu, z tym samym zachowaniem co wtyczka (PR #44): plik należy do wpisu dopiero po „Zapisz”, „Anuluj” nic nie zostawia, przed pobraniem ostrzeżenie.

**Architecture:** Rdzeń z PR #43 (`PhoneVaultStore.addFile/isFileComplete/readFile/pruneFiles`) dostaje jedną metodę `discardFiles`. W aplikacji: `AttachmentFiles` (odczyt wybranego dokumentu z limitami, zapis pliku, kontrakt `CreateDocument` z typem z opisu), `formatSize`, sekcja `AttachmentsEditor` w `EditScreen`, funkcje w `AppViewModel` (dodanie, pobranie, odrzucenie niezapisanych plików), spinacz na liście, uwaga przy eksporcie.

**Tech Stack:** Kotlin, Jetpack Compose (Material 3), Activity Result API (`OpenDocument`, `CreateDocument`), Robolectric + Roborazzi.

**Spec:** `docs/superpowers/specs/2026-11-12-pliki-w-sejfie-design.md` (punkty 4.1, 5, 6.3, 6.4, 7, 8, 9 krok 4, 10). Rdzeń Kotlin: plan `docs/superpowers/plans/2026-11-13-pliki-rdzen-kotlin.md` (K1–K8). Wzór zachowania: `extension/src/views/forms/attachments.ts`.

Skróty: `A/` = `android/app/src/main/kotlin/io/github/sheking94/passholder/app/`, `AT/` = `android/app/src/test/kotlin/io/github/sheking94/passholder/app/`, `K/` = `android/core/src/main/kotlin/io/github/sheking94/passholder/core/`, `KT/` = `android/core/src/test/kotlin/io/github/sheking94/passholder/core/`.

## Global Constraints

- Limity z rdzenia, nie przepisywać liczb: `Attachments.MAX_FILE_SIZE` (10 485 760), `Attachments.canAdd(count)` (20), `Attachments.isName`.
- Teksty jak we wtyczce (dokładnie): „Załączniki”, „+ Dodaj plik”, „Pobierz”, „Usuń”, „Najwyżej 20 plików we wpisie”, „Plik jest pusty”, „Plik jest za duży (limit 10 MB)”, „Nieprawidłowa nazwa pliku”, „czeka na synchronizację”, „nowy – zapisz wpis”, „Plik jest uszkodzony”, „Szyfruję plik…”, „Odszyfrowuję plik…”, ostrzeżenie „Pobierasz plik, który zostanie odszyfrowany i będzie dostępny na tym urządzeniu.” z przyciskami „Pobierz” / „Anuluj”.
- Rozmiar: `formatSize(b)` – poniżej 1 MiB „N KB” (`max(1, round(b/1024))`), wyżej „4,6 MB” (1 miejsce po przecinku, przecinek, podstawa 1024). Te same przykłady co TS: 483211 → „472 KB”, 500 → „1 KB”, 4823449 → „4,6 MB”.
- Treść jawna pliku tylko w pamięci, tylko na czas szyfrowania (dodanie) albo zapisu (pobranie); tablice bajtów zerowane po użyciu. Nic jawnego w `filesDir`, w stanie zapisywanym (`rememberSaveable`) ani w `Intent`.
- Bez uprawnień do pamięci: tylko `OpenDocument` / `CreateDocument`.
- Każda operacja na dysku i szyfrowanie poza wątkiem głównym (`launchVaultOperation` / `Dispatchers.IO`).
- Testy UI: jeden `@Test` na klasę (Compose przecieka między testami), zrzuty w `android/app/screenshots/`.
- Komentarze i nazwy po angielsku, teksty UI i dokumentacja po polsku.

## Decyzje planu (do akceptacji)

- **A1 – plik od razu na dysk, zaszyfrowany; „Anuluj” go kasuje.** Wtyczka trzyma nowy plik w pamięci do „Zapisz” (W1). Na telefonie 20 plików po 10 MB to ok. 550 MB tekstu Base64 w pamięci, więc „+ Dodaj plik” woła `addFile` (zaszyfrowane kawałki na dysku, jak plik od wtyczki). ViewModel pamięta id plików dodanych w tym formularzu. „Anuluj”, Wstecz i „Usuń wpis” kasują je od razu (`discardFiles`); „Zapisz” kasuje te, które usunięto z formularza przed zapisem. Gdy proces zginie albo sejf zablokuje się w trakcie edycji, plik usuwa zwykłe sprzątanie po 24 h (spec 6.4). Dla użytkownika efekt ten sam co we wtyczce: bez „Zapisz” plik nie należy do sejfu.
- **A2 – `discardFiles(ids)` w rdzeniu** (`PhoneVaultStore`): usuwa pliki o podanych id, **pomijając id używane przez żywy wpis** (zabezpieczenie: nie skasuje pliku, który zdążył trafić do wpisu, np. przez synchronizację). Przy nieczytelnym wpisie nie usuwa nic (jak `pruneFiles`, K3). Zwraca liczbę usuniętych.
- **A3 – stany pliku na telefonie:** telefon jest hostem i niczego nie pobiera, więc są tylko trzy: gotowy (komplet kawałków na telefonie), „czeka na synchronizację” (wtyczka jeszcze nie wysłała, „Pobierz” nieaktywne), „nowy – zapisz wpis”. Stan sprawdzany poza wątkiem głównym przy otwarciu formularza. Uszkodzenie wychodzi dopiero przy „Pobierz”: `IllegalArgumentException("File is corrupted")` → „Plik jest uszkodzony”; `IOException` przy odczycie z dysku → „Nie udało się odczytać pliku z sejfu.” (rozstrzyga odłożony punkt z kroku 2).
- **A4 – zapis pliku:** systemowe `CreateDocument` ma stały typ, więc własny kontrakt `CreateDocumentOf` (wejście: nazwa i typ; puste `mime` → `application/octet-stream`). Zapis trybem `"wt"`, potem zerowanie bajtów. Komunikat po zapisie: „Zapisano plik <nazwa>.” Błąd zapisu: „Nie udało się zapisać pliku. Jeśli plik powstał, usuń go.”
- **A5 – odczyt wybranego pliku:** nazwa z `OpenableColumns.DISPLAY_NAME` (brak → „plik”), typ z `ContentResolver.getType` (brak → „”), rozmiar z `OpenableColumns.SIZE`, gdy znany (za duży → odmowa bez czytania); czytanie najwyżej 10 MB + 1 bajt. Kolejność sprawdzeń jak we wtyczce: liczba, pusty, za duży, nazwa. Brak miejsca: komunikat rdzenia „Za mało miejsca na telefonie”.
- **A6 – okno 60 s bez blokady** przy wyborze i przy zapisie pliku (`beginFilePick`/`endFilePick`, jak import). Sejf zablokowany w czasie wyboru → plik nie jest czytany.
- **A7 – lista i eksport:** przy nazwie wpisu z plikami „ 📎 N”; na ekranie eksportu, gdy sejf ma pliki, dopisek „N plików nie zostanie wyeksportowanych (eksport z plikami będzie w kolejnej wersji).” (`countAttachments` z K7, odmiana jak `skippedFilesPhrase` w TS).
- **A8 – bez zmian w synchronizacji:** host `/p2p/v2/file` jest gotowy (PR #43); krok 4 to tylko ekrany. ZIP – krok 5, osobny wątek.

## Review Focus

1. Użytkownik dodaje plik i wychodzi przez Wstecz (nie „Anuluj”) → pliku nie ma na dysku. Test w zadaniu 3.
2. Sejf blokuje się (15 min) w czasie systemowego wyboru pliku → po powrocie nic nie trafia na dysk ani do wpisu. Test w zadaniu 3 (`attachFile` przy zablokowanym sejfie).
3. Edycja loginu przez pytanie o zapis (`withPassword`) i edycja w formularzu innych pól zachowują `attachments`. Test w zadaniu 3.
4. Plik z wtyczki niekompletny na telefonie → „czeka na synchronizację”, „Pobierz” nieaktywne; po kompletnym → aktywne. Test w zadaniu 3.
5. Ten sam plik wybrany dwa razy → dwa załączniki o różnych id (jak RF 5 we wtyczce). Test w zadaniu 3.

---

### Task 1: Rdzeń – `discardFiles`

**Files:**
- Modify: `K/p2p/PhoneVaultStore.kt` (sekcja „Files”)
- Test: `KT/p2p/PhoneVaultStoreTest.kt`

**Interfaces:**
- Produces: `fun discardFiles(ids: Collection<String>): Int` w `PhoneVaultStore` – wymaga odblokowanego sejfu (`requireSession()`), synchronizacja jak w `pruneFiles` (lista wpisów pod `this`, usuwanie pod magazynem, `store.closed` → 0).

- [ ] **Step 1: Testy:** (a) `addFile` ×2, `discardFiles([a.id])` → 1, `isFileComplete(a) == false`, `isFileComplete(b) == true`; (b) plik użyty przez wpis (`upsertContent` z `attachments = [a]`) → `discardFiles([a.id]) == 0`, plik zostaje; (c) nieznane id → 0, bez wyjątku; (d) nieczytelny rekord w sejfie → 0 (wzór jak test sprzątania z K3); (e) zablokowany sejf → wyjątek jak w `addFile`.
- [ ] **Step 2:** `cd android && ./gradlew :core:test --tests '*PhoneVaultStoreTest*'` → FAIL (brak metody).
- [ ] **Step 3:** Implementacja w `PhoneVaultStore.kt`, KDoc po angielsku (decyzja A2).
- [ ] **Step 4:** Ten sam test → PASS; potem `./gradlew :core:test` → bez błędów.
- [ ] **Step 5:** Commit `feat(android-core): discardFiles for files added and not saved`.

### Task 2: Pliki z systemu – odczyt, zapis, rozmiar

**Files:**
- Create: `A/AttachmentFiles.kt`, `A/FileSize.kt`
- Modify: `A/ImportSummary.kt` (`skippedFilesPhrase`)
- Test: `AT/AttachmentFilesTest.kt`, `AT/FileSizeTest.kt`

**Interfaces:**
- Produces:
  - `data class PickedFile(val name: String, val mime: String, val bytes: ByteArray)`
  - `object AttachmentFiles` ze stałymi tekstów (`TOO_MANY`, `EMPTY`, `TOO_LARGE`, `BAD_NAME`, `WAITING`, `NEW`, `CORRUPTED`, `READ_FAILED` = „Nie udało się odczytać pliku.”, `VAULT_READ_FAILED` = „Nie udało się odczytać pliku z sejfu.”, `WRITE_FAILED`, `DOWNLOAD_WARNING`) oraz:
    - `fun read(resolver: ContentResolver, uri: Uri): PickedFile` – nazwa/rozmiar przez `query(OpenableColumns)`, typ przez `getType`; deleguje do
    - `internal fun read(name: String?, mime: String?, size: Long?, open: () -> InputStream?): PickedFile` – sprawdza `size` (> MAX → `TOO_LARGE`, == 0 → `EMPTY`), czyta najwyżej `MAX_FILE_SIZE + 1`, potem pusty / za duży / `Attachments.isName` (`BAD_NAME`); błędy dostawcy (`IOException`, `SecurityException`, `null`) → `IOException(READ_FAILED)`; komunikaty limitów jako `IllegalArgumentException`.
    - `fun write(resolver: ContentResolver, uri: Uri, bytes: ByteArray)` / `internal fun write(bytes, open: () -> OutputStream?)` – tryb `"wt"`, błędy → `IOException(WRITE_FAILED)`.
  - `class CreateDocumentOf : ActivityResultContract<CreateDocumentOf.Input, Uri?>` z `data class Input(val name: String, val mime: String)`; intencja `ACTION_CREATE_DOCUMENT`, `CATEGORY_OPENABLE`, `EXTRA_TITLE = name`, typ `mime.ifEmpty { "application/octet-stream" }`.
  - `fun formatSize(bytes: Long): String` (`A/FileSize.kt`).
  - `fun skippedFilesPhrase(n: Int): String` – „1 plik nie zostanie wyeksportowany”, „2 pliki nie zostaną wyeksportowane”, „5 plików nie zostanie wyeksportowanych” (przez istniejące `plural`).

- [ ] **Step 1: Testy (JVM/Robolectric, bez ekranu):** `formatSize(483211) == "472 KB"`, `formatSize(500) == "1 KB"`, `formatSize(4823449) == "4,6 MB"`, `formatSize(1048576) == "1,0 MB"`; `read` z rozmiarem 10 485 761 nie otwiera strumienia (licznik wywołań `open` = 0) i rzuca `TOO_LARGE`; strumień 10 485 761 B bez znanego rozmiaru → `TOO_LARGE`; 0 B → `EMPTY`; nazwa `null` → „plik”; nazwa z `\u0001` → `BAD_NAME`; `mime == null` → `""`; `open` rzuca `SecurityException` → `IOException(READ_FAILED)`; `write` pisze bajty, `null` strumień → `IOException(WRITE_FAILED)`; `CreateDocumentOf().createIntent(ctx, Input("a.jpg", ""))` ma typ `application/octet-stream` i `EXTRA_TITLE == "a.jpg"`; `skippedFilesPhrase(1/2/5/12/22)`.
- [ ] **Step 2:** `./gradlew :app:testDebugUnitTest --tests '*AttachmentFilesTest*' --tests '*FileSizeTest*' -ProbolectricRepoUrl=https://maven-central.storage-download.googleapis.com/maven2` → FAIL.
- [ ] **Step 3:** Implementacja (wzór: `TransferFiles.kt`).
- [ ] **Step 4:** Te same testy → PASS.
- [ ] **Step 5:** Commit `feat(android): reading and saving attachment files, file sizes`.

### Task 3: Sekcja „Załączniki” w formularzu

**Files:**
- Create: `A/ui/forms/AttachmentsEditor.kt`
- Modify: `A/AppViewModel.kt`, `A/ui/EditScreen.kt`
- Test: `AT/AttachmentsScreenTest.kt` (kilka klas, po jednym `@Test`), `AT/AttachmentsViewModelTest.kt` (jeśli wygodniej bez ekranu)

**Interfaces:**
- Consumes: `PhoneVaultStore.addFile/isFileComplete/readFile/discardFiles` (zadanie 1), `AttachmentFiles`, `CreateDocumentOf`, `formatSize` (zadanie 2).
- Produces (w `AppViewModel`):
  - `fun attachFile(uri: Uri?, count: Int, onAdded: (Attachment) -> Unit)` – `endFilePick()`; `uri == null` albo sejf zablokowany → nic; `!Attachments.canAdd(count)` → `fail(TOO_MANY)` bez czytania; w `launchVaultOperation("Szyfruję plik…")`: `AttachmentFiles.read` → `store.addFile(bytes, name, mime)` → zerowanie bajtów → id do `addedFiles` → `onAdded(a)` na wątku głównym; status czyszczony.
  - `suspend fun fileReady(attachments: List<Attachment>): Set<String>` – id kompletnych plików (`isFileComplete`, na `Dispatchers.IO`; błąd → plik traktowany jak niegotowy).
  - `fun downloadFile(a: Attachment, uri: Uri?)` – `endFilePick()`; `uri == null` albo zablokowany → nic; w `launchVaultOperation("Odszyfrowuję plik…")`: `readFile` → `AttachmentFiles.write` → zerowanie → status „Zapisano plik <nazwa>.”; mapowanie błędów jak A3.
  - `private val addedFiles: MutableSet<String>`; `backToList()` i `delete(id)` wołają `discardFiles(addedFiles)` (poza wątkiem głównym, błąd tylko w logu) i czyszczą zbiór; `save(...)` po udanym `upsertContent` odrzuca `addedFiles - tidy.attachments.ids`; `newEntry`/`openEntry` zaczynają od pustego zbioru (odrzucając stary).
  - `@Composable fun AttachmentsEditor(attachments: List<Attachment>, onChange: (List<Attachment>) -> Unit, vm: AppViewModel, busy: Boolean)` – `OutlinedCard`/sekcja z tytułem „Załączniki”; wiersz: nazwa (1 linia, wielokropek), „<formatSize> · <dopisek>”, „Pobierz” (nieaktywne, gdy plik nie jest gotowy albo jest nowy), „Usuń” (tylko z listy formularza); „+ Dodaj plik” → `vm.beginFilePick()` + `OpenDocument(arrayOf("*/*"))`, `ActivityNotFoundException` jak w `TransferScreen`. „Pobierz” → `AlertDialog` z `DOWNLOAD_WARNING`, „Pobierz” uruchamia `CreateDocumentOf` (z `beginFilePick`), „Anuluj” zamyka. Dopiski: nowy → „nowy – zapisz wpis”, niegotowy → „czeka na synchronizację”. Stan gotowości: `LaunchedEffect(attachments) { ready = vm.fileReady(attachments) }`.
- `EditScreen`: `AttachmentsEditor` po `CustomFieldsEditor`, `onChange = { edit(content.copy(attachments = it)) }`; „Anuluj” zostaje `vm::backToList` (odrzuca nowe pliki).

- [ ] **Step 1: Testy:**
  - Dodanie: plik 3 B przez `vm.attachFile(Uri.fromFile(...), 0) { … }` w formularzu nowego dokumentu → wiersz z nazwą, „1 KB · nowy – zapisz wpis”, „Pobierz” nieaktywne → „Zapisz” → wpis ma 1 załącznik, `isFileComplete == true`; zrzut `43-zalaczniki.png` (przed zapisem, 2 pliki).
  - „Anuluj” po dodaniu → wpisu nie ma, `isFileComplete(a) == false`. To samo przez Wstecz (RF 1).
  - Dodanie, „Usuń” w wierszu, „Zapisz” → wpis bez plików, plik usunięty z dysku.
  - Ten sam plik dwa razy → 2 załączniki, różne id (RF 5).
  - 21. plik (wpis z 20 załącznikami z `addFile`) → „Najwyżej 20 plików we wpisie”; plik 10 485 761 B → „Plik jest za duży (limit 10 MB)”; plik pusty → „Plik jest pusty”.
  - Sejf zablokowany przed `attachFile` → brak wiersza, brak plików na dysku (RF 2).
  - Pobieranie: zapisany wpis z plikiem → „Pobierz” → okno z ostrzeżeniem (zrzut `44-pobierz-ostrzezenie.png`); „Anuluj” → nic; `vm.downloadFile(a, Uri.fromFile(out))` → `out` ma te same bajty, status „Zapisano plik dowod.jpg.”.
  - Plik niekompletny (wpis z załącznikiem, którego kawałków nie ma na telefonie) → „czeka na synchronizację”, „Pobierz” nieaktywne (RF 4); `downloadFile` na uszkodzonym (kawałek nadpisany na dysku innym blobem przez `DiskFileStore` testowy albo podmiana pliku) → „Plik jest uszkodzony”.
  - Zachowanie załączników: zmiana nazwy wpisu z plikiem w formularzu → załącznik zostaje; `saveReviewed` z nowym hasłem dla loginu z plikiem → załącznik zostaje (RF 3).
- [ ] **Step 2:** Uruchom nowe klasy (`--tests '*Attachments*'`) → FAIL.
- [ ] **Step 3:** Implementacja ViewModelu, `AttachmentsEditor`, `EditScreen`.
- [ ] **Step 4:** Nowe klasy → PASS; potem `--tests '*Edit*'` (formularze nie popsute) → PASS.
- [ ] **Step 5:** Commit `feat(android): attachments section, download warning`.

### Task 4: Lista, eksport, dokumentacja

**Files:**
- Modify: `A/ui/ListScreen.kt`, `A/ui/TransferScreen.kt`, `docs/FUNKCJE.md`, `docs/ARCHITEKTURA.md`, `docs/TESTY.md`, `docs/SYNCHRONIZACJA.md` (tylko jeśli opis telefonu mówi „bez ekranów”)
- Test: `AT/ListTabsScreenTest.kt` albo nowa klasa, `AT/TransferScreenTest.kt` albo nowa klasa

**Interfaces:**
- Consumes: `skippedFilesPhrase` (zadanie 2), `countAttachments` (`K/transfer/Common.kt`).

- [ ] **Step 1: Testy:** lista z wpisem z 2 załącznikami pokazuje „ 📎 2” przy nazwie (węzeł z tekstem zawierającym „📎 2”), wpis bez plików – bez spinacza; ekran eksportu przy 1 pliku pokazuje „1 plik nie zostanie wyeksportowany (eksport z plikami będzie w kolejnej wersji).”, bez plików – brak dopisku.
- [ ] **Step 2:** Te testy → FAIL.
- [ ] **Step 3:** Implementacja: spinacz jako część tekstu nazwy (`"${name} 📎 $n"` tylko przy `n > 0`, jak we wtyczce); dopisek w `TransferScreen` nad ostrzeżeniem, `bodySmall`.
- [ ] **Step 4:** Te testy → PASS; potem całe `./gradlew :core:test :app:testDebugUnitTest -ProbolectricRepoUrl=…` raz → bez błędów (zapisz liczby testów).
- [ ] **Step 5: Dokumentacja (krótko, po polsku):** FUNKCJE – w punkcie „Załączniki” część telefonu (A1, A3, A4, A6, spinacz, eksport); ARCHITEKTURA – wiersze `AttachmentFiles.kt`, `FileSize.kt`, `ui/forms/AttachmentsEditor.kt`, `discardFiles`; TESTY – nowe klasy testów i liczby, zrzuty 43–44, T22 przepisany na całość (wtyczka + telefon: dodaj zdjęcie ok. 5 MB na telefonie → zapisz → sync → pobierz we wtyczce; odwrotnie: plik z wtyczki → sync → na telefonie „Pobierz” aktywne, ostrzeżenie, zapis przez systemowe okno, porównanie sumy; „Anuluj” po dodaniu nie zostawia pliku; usuń → znika na obu; eksport z dopiskiem). Zrzuty skopiować do `/mnt/project-files/android-v3/`.
- [ ] **Step 6:** Commit `feat(android): attachment count on the list and export note; docs: attachments on Android`.
