# V3 krok 3: ekrany typów wpisów na Androidzie – plan wykonania

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Cel:** aplikacja na telefonie pokazuje, dodaje, edytuje i usuwa wpisy wszystkich pięciu typów v3: dolny pasek z zakładkami (własne wyszukiwanie i „+”), formularz każdego typu z listami, notatką i własnymi polami, pola wrażliwe zakryte z „Pokaż” i „Kopiuj”, wybór aplikacji Androida z listy zainstalowanych.

**Podejście:** zachowanie jak we wtyczce z kroku 2 (`extension/src/entry-types.ts` to wzór logiki). Logika bez UI (opis wiersza, wyszukiwanie, sprzątanie, sprawdzanie) w nowym `app/.../app/entries/EntryTypes.kt`, testowana zwykłym JUnit4. `PhoneVault.entries()` zwraca wszystkie typy. Przyciski spod listy idą do górnego paska (tytuł, „Synchronizacja”, menu ⋮: Urządzenia, Ustawienia, Zablokuj); przełączniki odcisku i opóźnienia blokady na nowy ekran „Ustawienia”. Formularz: wspólna skorupa (nazwa, notatka, własne pola, Zapisz/Anuluj/Usuń) i sekcja pól typu w osobnym pliku. Lista aplikacji: aplikacje z ikoną w launcherze przez `<queries>`, bez uprawnień, plus ręczne wpisanie pakietu.

**Stos:** Kotlin, Jetpack Compose Material 3, Robolectric + Roborazzi (testy UI i zrzuty), JUnit4/JUnit5. Bez nowych zależności.

**Spec:** `docs/superpowers/specs/2026-11-07-typy-wpisow-design.md` (sekcja 5, sekcja 8 krok 3). Format wpisu i synchronizacja z kroku 1 bez zmian.

## Ograniczenia globalne

- Bez zmian formatu wpisu, protokołu, `EntryV3.kt` i wtyczki. W `core/` zmienia się tylko `PhoneVault`/`PhoneVaultStore`/`PhoneEntry` (zadanie 1).
- Zakładki w kolejności, Loginy startowa: `login` 🔑 „Loginy”, `contact` 👤 „Kontakty”, `card` 💳 „Karty”, `note` 📝 „Notatki”, `document` 🪪 „Dokumenty”. Material 3 `NavigationBar`, ikona = emoji w `Text`, podpis pod ikoną; pięć pozycji mieści się na 411 dp.
- Tytuły formularza: „Nowy login”/„Edytuj login”, „Nowy kontakt”/„Edytuj kontakt”, „Nowa karta”/„Edytuj kartę”, „Nowa notatka”/„Edytuj notatkę”, „Nowy dokument”/„Edytuj dokument”.
- Opis w wierszu: login → `username`; karta → `•••• ` + ostatnie 4 znaki numeru bez białych znaków (krótszy: cały; pusty: `""`); dokument → nazwa rodzaju; kontakt → pierwszy telefon (`value`); notatka → pierwsza niepusta linia `note`.
- Rodzaje dokumentu: `ID_CARD` „Dowód osobisty”, `PASSPORT` „Paszport”, `DRIVING_LICENSE` „Prawo jazdy”, `STUDENT_ID` „Legitymacja”, `OTHER` „Inny”. Domyślny dla nowego: `ID_CARD`.
- Wyszukiwanie: bez rozróżniania wielkości liter, podciąg `query.trim()` w `name + " " + opis`. Zmiana zakładki czyści frazę.
- Pola wrażliwe: hasło, TOTP, numer karty, CVC, PIN, własne pola `hidden = true`. Zakryte (`PasswordVisualTransformation`, `KeyboardType.Password`), przyciski „Pokaż/Ukryj” i „Kopiuj”. Kopia pola wrażliwego: `SecureClipboard.copyPassword` (oznaczenie sensitive + czyszczenie po `CLEAR_AFTER_MINUTES`), status „Skopiowano <etykieta małymi literami>. Schowek zostanie wyczyszczony za 1 min.”; kopia jawnego pola: `copyText`, status „Skopiowano <etykieta>.” Zaznaczenie „ukryte” zakrywa pole od razu.
- Formaty (sprawdza tylko formularz): daty `RRRR-MM-DD` (prawdziwa data, `java.time.LocalDate` z `ResolverStyle.STRICT`, wzorzec `uuuu-MM-dd`), ważność `MM/RR` (`^(0[1-9]|1[0-2])/\d{2}$`); puste dozwolone. Sprawdzane tylko pole różne od zapisanego.
- Komunikaty błędów (dokładnie): „Podaj nazwę”, „Podaj albo wygeneruj hasło”, „Data urodzenia: wpisz datę RRRR-MM-DD”, „Data wydania: wpisz datę RRRR-MM-DD”, „Data ważności: wpisz datę RRRR-MM-DD”, „Ważność: wpisz MM/RR”, „Aplikacje Androida: zła nazwa pakietu <x>” (wzorzec `^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$`, tylko nowe elementy), „Wpis jest za duży”, „Ten wpis ma inny typ”.
- Zapis: przycinana tylko nazwa; elementy list z samymi pustymi polami tekstowymi i puste własne pola (etykieta i wartość `""`) pomijane. Typu wpisu nie da się zmienić.
- Kliknięcie wiersza otwiera formularz; wiersz loginu zachowuje przyciski „Login” i „Hasło”. Po zapisie, anulowaniu i usunięciu lista wraca na zakładkę typu wpisu. Komunikaty `SAVED`/`DELETED` bez zmian.
- Stan formularza w `remember`, nie `rememberSaveable` (sekrety poza saved instance state), jak dziś.
- Teksty UI po polsku, kod i komentarze po angielsku.
- Komendy (z `android/`): `./gradlew :core:test` i `./gradlew :app:testDebugUnitTest -ProbolectricRepoUrl=https://maven-central.storage-download.googleapis.com/maven2`. Pojedyncza klasa: `--tests '*NazwaKlasy*'`. Jedna metoda `@Test` na klasę testów UI (Compose przecieka między testami). Przygotowanie kontenera (SDK, mirror Maven): notatki projektu `passholder-android-build`.

## Na co uważać przy przeglądzie

1. Wpis z innym zapisem daty (`01.02.1990`) lub ważności (`2/2030`) z wtyczki/importu: otwarcie i „Zapisz” bez zmiany pola przechodzi. Testy: zadanie 2 krok 1, zadanie 6 krok 1.
2. Edycja loginu zachowuje pola, których nie zmieniano (`totp`, `urls`, `androidApps`, `custom`), a zapis pod id żywego wpisu innego typu jest odrzucony. Testy: zadanie 1 krok 1, zadanie 5 krok 1.
3. Ukryte własne pole: zakryte przy otwarciu, „Pokaż” odkrywa, kopia idzie przez `copyPassword`; przełączenie „ukryte” zakrywa od razu. Test: zadanie 5 krok 1.
4. Pusty element listy dodany „+ Dodaj” i niewypełniony nie trafia do wpisu. Testy: zadanie 2 krok 1, zadanie 6 krok 1.
5. Blokada (ręczna, automatyczna, po wyjściu) w trakcie formularza lub ekranu Ustawienia kończy na ekranie blokady, a po odblokowaniu lista jest na zakładce Loginy, bez danych formularza. Test: zadanie 3 krok 1.

---

### Zadanie 1: `PhoneVault` zwraca wszystkie typy i pilnuje typu przy zapisie

**Pliki:**
- Modyfikuj: `android/core/src/main/kotlin/io/github/sheking94/passholder/core/p2p/PhoneVault.kt`, `PhoneVaultStore.kt` (tylko komentarze/sygnatury `entries`, `upsertContent`)
- Utwórz: `android/core/src/testFixtures/kotlin/io/github/sheking94/passholder/core/p2p/PhoneEntryFixtures.kt`
- Test: `android/core/src/test/kotlin/io/github/sheking94/passholder/core/p2p/PhoneVaultTest.kt`, `PhoneVaultStoreTest.kt` (oraz importy w testach używających `.credentials`: `P2pInteropTest`, `PhoneInteropTest`, `app/.../SyncScreenTests.kt`)

**Interfejsy:**
- Produkuje:
  ```kotlin
  data class PhoneEntry(val id: String, val revision: Long, val data: EntryDataV3) {
      val content: EntryContentV3 get() = data.content
      val hlc: Hlc get() = data.hlc
  }
  class EntryTypeMismatchException : IllegalArgumentException("Entry has another type")
  fun PhoneVault.entries(): List<PhoneEntry>            // wszystkie żywe, czytelne wpisy, sortowane po name (jak dziś)
  fun PhoneVault.upsertContent(id: String, content: EntryContentV3) // rzuca EntryTypeMismatchException, gdy pod id żyje wpis innego typu
  fun PhoneVault.upsert(id: String, credentials: Credentials)       // zostaje (testy, interop); przy innym typie też EntryTypeMismatchException
  // testFixtures:
  val PhoneEntry.credentials: Credentials // tylko login; inny typ → IllegalStateException
  ```
- `PhoneEntry.credentials` znika z kodu produkcyjnego; testy dostają rozszerzenie z testFixtures (dodać import).

- [ ] **Krok 1: Testy** w `PhoneVaultTest`: `entries returns every type sorted by name` (login „B”, karta „A”, notatka „C” → `["A","B","C"]`, typy `card, login, note`); `upsertContent refuses an id holding another type` (karta pod `e1`, potem login pod `e1` → `EntryTypeMismatchException`, w sklepie dalej karta, rewizja bez zmian); `upsertContent over a tombstone may change the type`; `upsert of a login keeps totp, urls, androidApps, note and custom` (istniejący test zostaje, dopisać `custom`). Zastąp dzisiejszy test, że inne typy są pomijane.
- [ ] **Krok 2:** `./gradlew :core:test --tests '*PhoneVault*'` → FAIL (kompilacja).
- [ ] **Krok 3:** Implementacja + rozszerzenie w testFixtures + importy w testach.
- [ ] **Krok 4:** `./gradlew :core:test` → PASS; `./gradlew :app:compileDebugUnitTestKotlin` się kompiluje (aplikacja przejściowo może użyć `(entry.content.fields as? LoginFields)`; ekran listy zmienia się w zadaniu 4).
- [ ] **Krok 5:** Commit `feat(android-core): phone vault lists every entry type`.

### Zadanie 2: Logika typów bez UI

**Pliki:**
- Utwórz: `android/app/src/main/kotlin/io/github/sheking94/passholder/app/entries/EntryTypes.kt`
- Test: `android/app/src/test/kotlin/io/github/sheking94/passholder/app/entries/EntryTypesTest.kt` (zwykły JUnit4, bez Robolectric)

**Interfejsy:**
- Produkuje:
  ```kotlin
  enum class EntryType(val icon: String, val tab: String, val newTitle: String, val editTitle: String) {
      LOGIN, CONTACT, CARD, NOTE, DOCUMENT; // wartości z Ograniczeń globalnych, w tej kolejności
      companion object { fun of(fields: EntryFieldsV3): EntryType }
  }
  val DOCUMENT_KIND_LABELS: Map<DocumentKind, String>
  fun emptyContent(type: EntryType): EntryContentV3
  fun entrySummary(content: EntryContentV3): String
  fun matchesQuery(content: EntryContentV3, query: String): Boolean
  fun tidyContent(content: EntryContentV3): EntryContentV3
  fun validateContent(content: EntryContentV3, original: EntryContentV3?): String? // pierwszy błąd albo null
  ```
- Port 1:1 z `extension/src/entry-types.ts` (te same reguły i komunikaty). `validateContent` nie sprawdza rozmiaru (to robi `EntryV3` przy zapisie).

- [ ] **Krok 1: Testy** (wartości jak w testach wtyczki `extension/test/entry-types.test.ts`, jeśli są; inaczej): opis karty `"4111 1111 1111 1234"` → `"•••• 1234"`, `"12"` → `"•••• 12"`, `""` → `""`; notatka `"\n  \nPierwsza\nDruga"` → `"Pierwsza"`; dokument `PASSPORT` → „Paszport”; kontakt bez telefonów → `""`; `matchesQuery` karty po `"1234"`, kontaktu po telefonie, bez rozróżniania wielkości liter; `tidyContent` usuwa `LabeledValue("", "")`, pusty adres, `""` w `urls`/`androidApps`, `CustomField("", "", true)`, przycina nazwę, nie przycina hasła `" a "`; `validateContent`: pusta nazwa → „Podaj nazwę”, login bez hasła → „Podaj albo wygeneruj hasło”, `"1990-02-30"` → „Data urodzenia: wpisz datę RRRR-MM-DD”, `"01.02.1990"` z takim samym oryginałem → `null` (punkt 1), `"13/27"` → „Ważność: wpisz MM/RR”, `"2/2030"` niezmieniony → `null`, nowa aplikacja `"zla nazwa"` → „Aplikacje Androida: zła nazwa pakietu zla nazwa”, `"pl.mbank"` → `null`, data wydania/ważności dokumentu z właściwymi komunikatami.
- [ ] **Krok 2:** `./gradlew :app:testDebugUnitTest --tests '*EntryTypesTest*' …` → FAIL.
- [ ] **Krok 3:** Implementacja.
- [ ] **Krok 4:** ten sam test → PASS.
- [ ] **Krok 5:** Commit `feat(android): entry type logic`.

### Zadanie 3: ViewModel dla wszystkich typów, górny pasek i ekran Ustawienia

**Pliki:**
- Modyfikuj: `android/app/src/main/kotlin/io/github/sheking94/passholder/app/AppViewModel.kt`, `ui/PassHolderUi.kt`, `ui/ListScreen.kt` (tylko przeniesienie przycisków i przełączników)
- Utwórz: `android/app/src/main/kotlin/io/github/sheking94/passholder/app/ui/SettingsScreen.kt`, `ui/VaultTopBar.kt`
- Test: `android/app/src/test/kotlin/io/github/sheking94/passholder/app/SettingsScreenTests.kt`; poprawić odwołania do przycisków w `ScreenTests.kt`, `BiometricScreenTests.kt`, `SyncScreenTests.kt` (pomocnik w `ScreenTestBase`: `menu(item: String)` otwiera ⋮ i klika pozycję)

**Interfejsy:**
- Produkuje:
  ```kotlin
  sealed interface Screen { … data class Edit(val id: String?, val type: EntryType) ; data object Settings }  // Settings: showsVault = true
  data class UiState(…, val tab: EntryType = EntryType.LOGIN)
  fun AppViewModel.selectTab(type: EntryType)
  fun AppViewModel.newEntry(type: EntryType)                 // Screen.Edit(null, type)
  fun AppViewModel.openEntry(id: String)                     // jak dziś, typ z odczytanego wpisu
  fun AppViewModel.save(id: String?, content: EntryContentV3, original: EntryContentV3?) // tidy → validate → store.upsertContent; błędy jak w Ograniczeniach; lista na zakładce typu
  fun AppViewModel.backToList()                              // zakładka = typ edytowanego wpisu (albo bieżąca)
  fun AppViewModel.openSettings()
  fun AppViewModel.copy(label: String, value: String, sensitive: Boolean)
  @Composable fun VaultTopBar(state: UiState, vm: AppViewModel) // tytuł „PassHolder”, przycisk „Synchronizacja”, ⋮ z „Urządzenia”, „Ustawienia”, „Zablokuj”
  @Composable fun SettingsScreen(state: UiState, vm: AppViewModel) // FingerprintSetting + LockDelaySetting przeniesione z ListScreen, przycisk „Wróć” + BackHandler
  ```
- `copyLogin`/`copyPassword` zastąpione przez `copy` (wiersz loginu: `copy("login", …, false)`, `copy("hasło", …, true)`; dzisiejsze komunikaty „Skopiowano login.” i „Skopiowano hasło. Schowek…” zostają). Usuń dzisiejsze `save(id, Credentials)`; formularz loginu przechodzi na `save(id, content, original)` w zadaniu 5, do tego czasu `EditScreen` buduje `EntryContentV3` z trzech pól (zachowując resztę oryginału).
- `EntryTypeMismatchException` → „Ten wpis ma inny typ”; `EntryTooLargeException` → „Wpis jest za duży”.

- [ ] **Krok 1: Testy** `SettingsScreenTests` (jedna metoda): z listy ⋮ → „Ustawienia” → przełącznik „Blokuj dopiero po 60 s poza aplikacją” zmienia ustawienie → „Wróć” na listę; potem formularz nowego wpisu otwarty i `vm.lock()` → ekran blokady → odblokowanie → lista na zakładce Loginy, bez statusu i danych formularza (punkt 5); zrzut `30-ustawienia`. Istniejące testy przechodzą po zmianie kliknięć na `menu("Urządzenia")`, `menu("Zablokuj")`, ekran Ustawienia dla odcisku.
- [ ] **Krok 2:** uruchom `SettingsScreenTests` → FAIL.
- [ ] **Krok 3:** Implementacja.
- [ ] **Krok 4:** pełne `:app:testDebugUnitTest` → PASS.
- [ ] **Krok 5:** Commit `feat(android): settings screen and top bar menu`.

### Zadanie 4: Lista z dolnym paskiem zakładek

**Pliki:**
- Modyfikuj: `android/app/src/main/kotlin/io/github/sheking94/passholder/app/ui/ListScreen.kt`
- Test: `android/app/src/test/kotlin/io/github/sheking94/passholder/app/ListTabsScreenTest.kt`; pomocnik w `ScreenTestBase`: `putEntry(content: EntryContentV3): String` (zapis przez `app.phoneStore.upsertContent` + `vm` odświeżenie listy, np. ponowne odblokowanie albo publiczne `vm.reloadEntries()`)

**Interfejsy:**
- Konsumuje: `EntryType`, `entrySummary`, `matchesQuery` (zadanie 2), `selectTab`, `newEntry`, `openEntry`, `copy`, `VaultTopBar` (zadanie 3).
- Produkuje: `fun AppViewModel.reloadEntries()` (publiczny `refresh` w `viewModelScope`), jeśli pomocnik testu go potrzebuje.
- Układ: `Scaffold(topBar = VaultTopBar, bottomBar = NavigationBar)`; treść: pole „Szukaj…” + „+ Dodaj”, ostrzeżenie o nieczytelnych wpisach, lista (wiersz: ikona typu, nazwa, opis; login z „Login”/„Hasło”), `StatusLine`. Pusta zakładka: „Brak wpisów. Dodaj pierwszy.”, brak trafień: „Nic nie pasuje.” Fraza wyszukiwania w `rememberSaveable(tab)`.

- [ ] **Krok 1: Test** (jedna metoda): sejf z loginem, kartą `"4111111111111234"`, kontaktem z telefonem `"600 100 200"`, notatką, dokumentem; Loginy pokazują tylko login; Karty → wiersz „•••• 1234”; szukaj „1234” zostawia kartę; przejście na Kontakty czyści frazę (punkt 5 przeglądu wtyczki), szukaj „600” znajduje kontakt; „+ Dodaj” na Kartach otwiera „Nowa karta”, „Anuluj” wraca na Karty; zrzuty `31-zakladka-loginy`, `32-zakladka-karty`, `33-zakladka-kontakty`, `34-zakladka-notatki`, `35-zakladka-dokumenty`.
- [ ] **Krok 2:** → FAIL.
- [ ] **Krok 3:** Implementacja (formularze innych typów mogą do zadania 5 pokazywać samą skorupę).
- [ ] **Krok 4:** pełne `:app:testDebugUnitTest` → PASS (zaktualizuj zrzuty 03, 05).
- [ ] **Krok 5:** Commit `feat(android): bottom navigation tabs per entry type`.

### Zadanie 5: Formularz – skorupa, pola wrażliwe, listy, własne pola, login, notatka

**Pliki:**
- Modyfikuj: `android/app/src/main/kotlin/io/github/sheking94/passholder/app/ui/EditScreen.kt` (skorupa), `ui/Common.kt` (`SecretField`)
- Utwórz: `ui/forms/LoginForm.kt`, `ui/forms/GeneratorCard.kt` (wydzielony z `EditScreen`), `ui/forms/ListEditor.kt`, `ui/forms/CustomFieldsEditor.kt`
- Test: `android/app/src/test/kotlin/io/github/sheking94/passholder/app/EditLoginScreenTest.kt`, `EditNoteScreenTest.kt`

**Interfejsy:**
- Konsumuje: `save(id, content, original)`, `copy`, `delete`, `backToList` (zadanie 3), `emptyContent`, `EntryType` (zadanie 2).
- Produkuje:
  ```kotlin
  @Composable fun SecretField(value: String, onValueChange: (String) -> Unit, label: String, onCopy: () -> Unit,
      monospace: Boolean = false, keyboardType: KeyboardType = KeyboardType.Password,
      revealed: Boolean? = null, onRevealedChange: ((Boolean) -> Unit)? = null)   // „Pokaż/Ukryj” + „Kopiuj”
  @Composable fun <T> ListEditor(title: String, items: List<T>, onChange: (List<T>) -> Unit, addLabel: String,
      empty: () -> T, item: @Composable (T, (T) -> Unit) -> Unit)                 // „+ Dodaj …” i „Usuń” przy elemencie
  @Composable fun CustomFieldsEditor(items: List<CustomField>, onChange: (List<CustomField>) -> Unit, vm: AppViewModel)
  @Composable fun LoginForm(fields: LoginFields, onChange: (LoginFields) -> Unit, vm: AppViewModel)
  ```
- Skorupa: tytuł z `EntryType`, „Nazwa”, sekcja typu, „Notatka” (wielowierszowe; dla `NOTE` etykieta „Treść”, bez osobnej notatki), „Własne pola” (etykieta, wartość, przełącznik „ukryte”; ukryte → `SecretField`, jawne → `PlainField` + „Kopiuj”), „+ Dodaj pole”, Zapisz/Anuluj/Usuń (dialog jak dziś). Stan: `var content by remember(id) { mutableStateOf(existing ?: emptyContent(type)) }`.
- Login: Login (+ „Kopiuj”), Hasło (`SecretField` + generator jak dziś), TOTP (`SecretField`), „Adresy stron” (`KeyboardType.Uri`, „+ Dodaj adres”), „Aplikacje Androida” (w tym zadaniu ręczne pole, placeholder `np. pl.mbank`, „+ Dodaj aplikację”; wybór z listy w zadaniu 7).

- [ ] **Krok 1: Testy** `EditLoginScreenTest`: nowy login z adresem, aplikacją `pl.mbank`, TOTP i ukrytym własnym polem → zapis → `phoneStore.entry(id).content` równa się oczekiwanej treści (pełny obiekt); edycja loginu z `androidApps = ["pl.bank"]`, `urls`, `custom` (dodanego przez `putEntry`) – zmiana hasła zachowuje resztę (punkt 2); ukryte własne pole otwiera się zakryte (`SemanticsProperties.Password`), „Pokaż” odkrywa, „Kopiuj” daje status „…wyczyszczony za 1 min.” i zadanie w WorkManagerze, wyłączenie „ukryte” → jawne, włączenie → od razu zakryte (punkt 3); brak hasła → „Podaj albo wygeneruj hasło”; „Generuj” wstawia hasło; zrzuty `36-formularz-login`, `37-pole-ukryte-pokazane`. `EditNoteScreenTest`: notatka zapisuje treść w `note` i `NoteFields`; „Usuń” → potwierdzenie → wpis usunięty, lista na Notatkach; zrzut `38-formularz-notatka`.
- [ ] **Krok 2:** → FAIL.
- [ ] **Krok 3:** Implementacja.
- [ ] **Krok 4:** pełne `:app:testDebugUnitTest` → PASS (zaktualizuj `addEntry` w `ScreenTestBase`: „Nazwa” zamiast „Nazwa serwisu”, tytuł „Edytuj login”; zrzut 04).
- [ ] **Krok 5:** Commit `feat(android): entry form shell, login and note forms`.

### Zadanie 6: Formularze kontaktu, karty i dokumentu

**Pliki:**
- Utwórz: `android/app/src/main/kotlin/io/github/sheking94/passholder/app/ui/forms/ContactForm.kt`, `CardForm.kt`, `DocumentForm.kt`
- Modyfikuj: `ui/EditScreen.kt` (wybór sekcji)
- Test: `android/app/src/test/kotlin/io/github/sheking94/passholder/app/EditContactScreenTest.kt`, `EditCardScreenTest.kt`, `EditDocumentScreenTest.kt`

**Interfejsy:**
- Konsumuje: `SecretField`, `ListEditor`, skorupa (zadanie 5).
- Produkuje: `ContactForm(fields: ContactFields, onChange: (ContactFields) -> Unit, vm)`, `CardForm(fields: CardFields, onChange, vm)`, `DocumentForm(fields: DocumentFields, onChange, vm)`.
- Kontakt: Imię, Nazwisko, Data urodzenia (placeholder `RRRR-MM-DD`), Telefony (etykieta + numer, `KeyboardType.Phone`, „+ Dodaj telefon”), E-maile (`KeyboardType.Email`, „+ Dodaj e-mail”), Adresy (etykieta, ulica, kod pocztowy, miasto, kraj, „+ Dodaj adres”).
- Karta: Posiadacz, Numer (`SecretField`, `KeyboardType.Number`, monospace), Ważność (placeholder `MM/RR`), CVC i PIN (`SecretField`, `KeyboardType.NumberPassword`).
- Dokument: Rodzaj (`ExposedDropdownMenuBox` z `DOCUMENT_KIND_LABELS`), Numer, Imię i nazwisko, Data wydania, Data ważności, Wystawca.

- [ ] **Krok 1: Testy** (jedna metoda na klasę): kontakt – wypełnij, dodaj drugi telefon i zostaw pusty → zapis daje `phones` z jednym elementem (punkt 4); wpis z `birthDate = "01.02.1990"` (przez `putEntry`) zapisuje się bez zmiany pola, a `1990-02-30` → błąd (punkt 1); zrzut `39-formularz-kontakt`. Karta – numer, CVC, PIN zakryte; „Kopiuj” przy CVC → status z czyszczeniem; `13/27` → „Ważność: wpisz MM/RR”; zapis pełnej karty = oczekiwana treść; zrzut `40-formularz-karta`. Dokument – zmiana rodzaju na „Paszport” zapisuje `DocumentKind.PASSPORT`, zła data ważności → komunikat; zrzut `41-formularz-dokument`.
- [ ] **Krok 2:** → FAIL.
- [ ] **Krok 3:** Implementacja.
- [ ] **Krok 4:** pełne `:app:testDebugUnitTest` → PASS.
- [ ] **Krok 5:** Commit `feat(android): contact, card and document forms`.

### Zadanie 7: Wybór aplikacji Androida z listy zainstalowanych

**Pliki:**
- Utwórz: `android/app/src/main/kotlin/io/github/sheking94/passholder/app/InstalledApps.kt`, `ui/forms/AppPickerDialog.kt`
- Modyfikuj: `android/app/src/main/AndroidManifest.xml` (`<queries><intent><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent></queries>`), `PassHolderApp.kt` (`var installedApps: InstalledApps = SystemInstalledApps(this)`), `ui/forms/LoginForm.kt`
- Test: `android/app/src/test/kotlin/io/github/sheking94/passholder/app/AppPickerScreenTest.kt`, `InstalledAppsTest.kt` (Robolectric, `ShadowPackageManager`)

**Interfejsy:**
- Produkuje:
  ```kotlin
  data class InstalledApp(val label: String, val packageName: String)
  fun interface InstalledApps { fun list(): List<InstalledApp> }
  class SystemInstalledApps(context: Context) : InstalledApps // queryIntentActivities(MAIN+LAUNCHER), bez własnego pakietu, distinct po pakiecie, sort po label (ignoreCase)
  @Composable fun AppPickerDialog(apps: List<InstalledApp>, onPick: (String) -> Unit, onDismiss: () -> Unit)
  ```
- Lista w formularzu: każdy element pokazuje nazwę aplikacji (z `installedApps`, jeśli zainstalowana) i nazwę pakietu, z „Usuń”. Przyciski „+ Wybierz aplikację” (dialog: pole „Szukaj…” po nazwie i pakiecie, lista; ładowanie listy poza wątkiem głównym) i „+ Wpisz pakiet” (dzisiejsze ręczne pole z zadania 5). Wybrany pakiet już na liście nie jest dodawany drugi raz.
- Bez `QUERY_ALL_PACKAGES`.

- [ ] **Krok 1: Testy** `InstalledAppsTest`: dwie aktywności launchera (`Bank`/`pl.bank`, `alfa`/`com.alfa`) i własny pakiet → `[alfa, Bank]`, bez własnego. `AppPickerScreenTest` (fałszywe `installedApps`): „+ Wybierz aplikację” → szukaj „mb” → „mBank” → element „mBank · pl.mbank” na liście → zapis → `androidApps == ["pl.mbank"]`; ponowny wybór tej samej aplikacji nie dubluje; zrzut `42-wybor-aplikacji`.
- [ ] **Krok 2:** → FAIL.
- [ ] **Krok 3:** Implementacja.
- [ ] **Krok 4:** pełne `:app:testDebugUnitTest` i `:core:test` → PASS.
- [ ] **Krok 5:** Commit `feat(android): pick Android apps from the installed list`.

### Zadanie 8: Dokumentacja i zrzuty

**Pliki:**
- Modyfikuj: `docs/FUNKCJE.md` (sekcja „Typy wpisów” obejmuje telefon: zakładki, górny pasek i Ustawienia, formularze, wybór aplikacji; usuń „do kroku 3”), `docs/TESTY.md` (nowe klasy testów, lista zrzutów, test ręczny T15: każdy typ na telefonie + synchronizacja z wtyczką w obie strony, wybór aplikacji na prawdziwym telefonie), `docs/ARCHITEKTURA.md` (pliki `entries/`, `ui/forms/`, `InstalledApps`, `<queries>`), `docs/INSTALACJA.md` tylko jeśli opisuje przyciski spod listy, `docs/SPEC.md`/`docs/SYNCHRONIZACJA.md` tylko jeśli coś tam mówi, że telefon pokazuje tylko loginy; odstępstwa od specu (jeśli były) dopisać w specu jako „Odstępstwo (krok 3)”.
- Skopiuj nowe zrzuty do `/mnt/project-files/android-v3/`.

- [ ] **Krok 1:** `grep -rn "tylko loginy\|do kroku 3\|Zablokuj\|Urządzenia" docs/` i popraw opisy.
- [ ] **Krok 2:** pełne `:core:test`, `:app:testDebugUnitTest` → PASS; `git status` bez przypadkowych plików.
- [ ] **Krok 3:** Commit `docs: v3 android screens`.
