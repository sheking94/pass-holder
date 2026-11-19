# Autouzupełnianie na Androidzie (V3, krok B2) – plan wdrożenia

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Telefon podpowiada loginy, karty i kontakty z sejfu w polach innych aplikacji i przeglądarek (Autofill Framework), także przy zablokowanym sejfie (podpowiedź „Odblokuj PassHolder”).

**Architecture:** Czysta logika z B1 (`matchUrl`, `matchLogins`, `classifyField`, `planFor`, `fillValue`) przeniesiona 1:1 do Kotlina w `android/core/.../core/autofill/` i sprawdzana tymi samymi wektorami `core/test-vectors/autofill/`. W tym samym pakiecie `matchApp` (spec 3.2) i `planDatasets` (wybór grupy pól, podpowiedzi), generyczne po typie identyfikatora pola, więc testowane na JVM bez Androida. Moduł `app` ma tylko cienkie adaptery: `AssistStructure` → lista pól, lista podpowiedzi → `FillResponse`, usługę, ekran odblokowania i wiersz w Ustawieniach.

**Tech Stack:** Kotlin, Android Autofill Framework (minSdk 26), Compose, JUnit 5 (`:core`), Robolectric + Roborazzi (`:app`).

**Spec:** `docs/superpowers/specs/2026-11-09-autouzupelnianie-design.md` (sekcje 3, 5, 6, 7, 8). Plan B1: `docs/superpowers/plans/2026-11-09-autouzupelnianie-chrome.md`. Wykonawcy czytają spec i ten plan.

**Decyzje planu (zaakceptowane przez właściciela 2026-11-11; D4 zmienione na „tak”):**
- **D1 Blokada po odblokowaniu z autouzupełniania:** jak ustawienie „Blokuj dopiero po 60 s poza aplikacją”: włączone → `LeaveLock.schedule(60 s)`, wyłączone → blokada zaraz po zbudowaniu podpowiedzi. Bez tego sejf zostawałby otwarty bez limitu (15-minutowa blokada działa tylko przy otwartej aplikacji).
- **D2 Samo pole e-mail** (pierwszy krok logowania, np. Google) → podpowiedzi loginów, nie kontaktów. Kontakt wymaga co najmniej jednego pola kontaktu innego niż e-mail.
- **D3 Karta w przeglądarce** tylko przy `webScheme` = `https` albo braku `webScheme` (jak spec 6 dla Chrome; `localhost` wyjątek). W zwykłych aplikacjach karty zawsze.
- **D4 Podpowiedzi w pasku klawiatury** (inline suggestions, Android 11+ / API 30, np. Gboard) – decyzja właściciela 2026-11-11: robimy od razu, obok zwykłej listy pod polem (starsze Androidy i klawiatury bez obsługi dostają tylko listę).
- **D5 Wektory `matchApp`** w nowym pliku `core/test-vectors/autofill/app.json`, czytane tylko przez Kotlin (TS nie ma `matchApp`).

## Global Constraints

- Kotlin daje te same wyniki co TS na wszystkich przypadkach `match.json`, `fields.json`, `values.json` (bez zmian w tych plikach).
- Tokeny `autofillHints`/`autocomplete`: wygrywa **ostatni znany** token (jak `classifyField` w TS). Lista tokenów pola = tokeny atrybutu HTML `autocomplete` (z `htmlInfo`, podzielone po białych znakach), potem `autofillHints` widoku.
- Zaufane przeglądarki – dokładnie lista ze spec 3.2 (13 pakietów).
- Własny pakiet (`io.github.sheking94.passholder`) → brak odpowiedzi (`onSuccess(null)`).
- Najwyżej 10 podpowiedzi. Loginy w kolejności `matchLogins`; dla aplikacji (pakiet) – po nazwie. Karty i kontakty w kolejności `store.entries()`.
- Sortowanie po nazwie: `POLISH_COLLATOR` z `core/transfer/Common.kt` (zmień `private` na `internal`).
- `FillResponse` bez `SaveInfo`; brak `onSaveRequest` logiki (podprojekt C).
- Usługa nie trzyma wpisów ani kluczy w polach klasy; odszyfrowanie w czasie budowy odpowiedzi.
- Ekran odblokowania: `FLAG_SECURE`, `exported="false"`. Usługa: `android:permission="android.permission.BIND_AUTOFILL_SERVICE"`, `exported="true"`.
- Pasek klawiatury: biblioteka `androidx.autofill:autofill` `1.1.0` (`InlineSuggestionUi`); na API < 30 i bez `InlineSuggestionsRequest` nic się nie zmienia. Liczba podpowiedzi w pasku ≤ `min(10, request.maxSuggestionCount)`; spec stylu z `inlinePresentationSpecs` (indeks `i`, a dla dalszych ostatni spec), podpowiedź tylko gdy `UiVersions.getVersions(spec.style)` zawiera `UiVersions.INLINE_UI_VERSION_1`.
- Teksty UI po polsku: „Odblokuj PassHolder”, „Autouzupełnianie”, „Włączone”, „Wyłączone”, „Włącz”, „Hasło główne”, „Odblokuj”, „Odblokuj odciskiem palca”, „Anuluj”.

## Review Focus

1. **WebView w obcej aplikacji z `webDomain` banku** → tylko loginy przypisane do pakietu tej aplikacji, nie loginy banku. Wektor w `app.json` (Task 2).
2. **Wpis bez wartości dla żadnego pola** (login z pustym loginem przy formularzu tylko z polem loginu; karta ze złą ważnością przy polach tylko daty) → podpowiedź pominięta. `Dataset` bez wartości rzuca `IllegalStateException` i psuje całą odpowiedź. Test w Task 3.
3. **Formularz rejestracji** (tylko pola `newPassword` + e-mail/login) → brak podpowiedzi haseł; same pola `newPassword` → `null`. Test w Task 3.
4. **Odblokowanie z podpowiedzi, a potem otwarcie aplikacji** → aplikacja pokazuje listę, nie ekran blokady przy otwartym sejfie. Test w Task 6.
5. **Anulowanie ekranu odblokowania** (Wstecz) → `RESULT_CANCELED`, sejf zablokowany, nic nie wypełnione. Test w Task 6.

---

### Task 1: Rozpoznawanie pól i wartości w Kotlinie

**Files:**
- Create: `android/core/src/main/kotlin/io/github/sheking94/passholder/core/autofill/Keywords.kt`, `Fields.kt`, `Values.kt`
- Test: `android/core/src/test/kotlin/io/github/sheking94/passholder/core/autofill/FieldsVectorsTest.kt`, `ValuesVectorsTest.kt`, `AutofillVectors.kt` (czytanie wektorów jak `transfer/VectorSupport.kt`, katalog `core/test-vectors/autofill/`)

**Interfaces:**
- Produces:
  - `enum class FieldKind(val json: String)` – 19 wartości jak TS (`USERNAME("username")`, …, `BDAY("bday")`), `companion fun fromJson(s: String): FieldKind`.
  - `fun normalizeText(s: String): String` – `lowercase()` (Locale.ROOT), `Normalizer.Form.NFD`, usuń `\p{M}`, `ł`→`l`.
  - `val AUTOCOMPLETE_TOKENS: Map<String, FieldKind?>` (`null` = „skip”, jak `"skip"` w TS), `NEW_PASSWORD_PATTERN`, `SKIP_PATTERN`, `KEYWORDS: List<Pair<FieldKind, Regex>>` – przepisane z `core/src/autofill/keywords.ts` znak w znak (te same wzorce, ta sama kolejność); dopasowanie `Regex.containsMatchIn`.
  - `data class FieldOption(val value: String, val text: String)`
  - `data class FieldDescriptor(val autocomplete: List<String> = emptyList(), val type: String = "", val name: String = "", val id: String = "", val label: String = "", val placeholder: String = "", val maxLength: Int? = null, val options: List<FieldOption>? = null)`
  - `fun classifyField(field: FieldDescriptor): FieldKind?` – jak `fields.ts`.
  - `sealed interface FillPlan` z `Login(username, password)`, `Card(holder, number, expiry, cvc)`, `Contact(firstName, lastName, email, tel, street, postalCode, city, country, bday)`.
  - `fun planFor(content: EntryContentV3): FillPlan?` – jak `values.ts` (`bday` tylko poprawna data kalendarzowa).
  - `fun fillValue(plan: FillPlan, kind: FieldKind, field: FieldDescriptor, hasUsernameField: Boolean): String?` – jak `values.ts`.

- [ ] **Step 1: Testy wektorów** – `FieldsVectorsTest`: `@TestFactory` z każdego przypadku `fields.json` (`classifyField(...)?.json` == `expected`); `normalizeText("Łódź Ważność") == "lodz waznosc"`. `ValuesVectorsTest`: każdy przypadek `values.json` (`plan.kind` → klasa `FillPlan`) == `expected`; `planFor` dla notatki i dokumentu → `null`; kontakt bez telefonów → `tel == ""`; kontakt z `birthDate = "1990-02-30"` → `bday == ""`.
- [ ] **Step 2:** `cd android && ./gradlew :core:test --tests '*autofill*'` → FAIL (brak klas).
- [ ] **Step 3: Zaimplementuj** `Keywords.kt`, `Fields.kt`, `Values.kt`.
- [ ] **Step 4:** test → PASS (wszystkie 105 + 50 przypadków).
- [ ] **Step 5: Commit** `feat(android-core): classify autofill fields and values (port of core/src/autofill)`.

### Task 2: Dopasowanie adresu i aplikacji

**Files:**
- Create: `android/core/src/main/kotlin/io/github/sheking94/passholder/core/autofill/Match.kt`
- Modify: `android/core/src/main/kotlin/io/github/sheking94/passholder/core/transfer/Common.kt` (`POLISH_COLLATOR` → `internal`)
- Create: `core/test-vectors/autofill/app.json`
- Test: `android/core/src/test/kotlin/io/github/sheking94/passholder/core/autofill/MatchVectorsTest.kt`

**Interfaces:**
- Produces:
  - `enum class MatchKind { EXACT, SUBDOMAIN }`
  - `fun matchUrl(pageUrl: String, savedUrl: String): MatchKind?` – reguły spec 3.1 jak `match.ts`. Parser własny (nie `java.net.URI`, który odrzuca np. `_` w hoście): schemat do `://` (brak → `https`), tylko `http`/`https`; autorytet do pierwszego `/`, `?`, `#`; usuń `userinfo@`; host `[..]` (IPv6) albo do `:`; port tylko cyfry (inne → nieparsowalny); host małymi literami, `IDN.toASCII` (błąd → nieparsowalny), bez końcowej kropki i `www.`; port równy domyślnemu dla schematu traktuj jak pusty (jak WHATWG `URL`).
  - `fun <T> matchLogins(pageUrl: String, items: List<T>, candidate: (T) -> MatchCandidate): List<T>`; `data class MatchCandidate(val name: String, val urls: List<String>)`.
  - `val TRUSTED_BROWSERS: Set<String>` – 13 pakietów ze spec 3.2.
  - `data class AppRequest(val packageName: String, val webDomain: String?, val webScheme: String?)`
  - `fun <T> matchApp(request: AppRequest, items: List<T>, candidate: (T) -> AppCandidate): List<T>`; `data class AppCandidate(val name: String, val urls: List<String>, val androidApps: List<String>)`. Zaufana przeglądarka z `webDomain` → `matchLogins("${webScheme ?: "https"}://$webDomain", …)`; poza tym → wpisy z pakietem w `androidApps`, po nazwie (`POLISH_COLLATOR`).
- Format `app.json`: `{ "cases": [ { "request": {packageName, webDomain?, webScheme?}, "logins": [{name, urls, androidApps}], "expected": [name…], "why": string } ] }`.

- [ ] **Step 1: Wektory `app.json`** – minimum: aplikacja z pakietem na liście → ten login; pakiet spoza listy → `[]`; `com.android.chrome` + `webDomain=accounts.google.com` → login z `google.com`; Chrome bez `webDomain` → tylko po pakiecie (zwykle `[]`); `com.evil.app` + `webDomain=mbank.pl` i login `mbank.pl` → `[]` (Review Focus 1); ta sama obca aplikacja z loginem mającym jej pakiet → ten login; Firefox + `webScheme=http` i zapisany `https://x.pl` → `[]`; kilka loginów pakietu → kolejność po nazwie (`"Ąb"` przed `"B"`).
- [ ] **Step 2: Test** – każdy przypadek `match.json` (`matchUrl(...)` → `"exact"`/`"subdomain"`/`null`), każdy z `app.json`, oraz `matchLogins("https://mail.google.com", B=mail.google.com, A=google.com, C=x.pl)` → `["B","A"]`.
- [ ] **Step 3:** FAIL. **Step 4:** zaimplementuj. **Step 5:** PASS (`:core:test`).
- [ ] **Step 6: Commit** `feat(android-core): match logins to apps and browser domains`.

### Task 3: Podpowiedzi dla żądania (`planDatasets`)

**Files:**
- Create: `android/core/src/main/kotlin/io/github/sheking94/passholder/core/autofill/Planner.kt`
- Test: `android/core/src/test/kotlin/io/github/sheking94/passholder/core/autofill/PlannerTest.kt`

**Interfaces:**
- Consumes: Task 1, Task 2, `PhoneEntry` (`core/p2p/PhoneVault.kt`).
- Produces:
  - `data class AutofillNode<Id>(val id: Id, val field: FieldDescriptor, val isList: Boolean)` (`isList` = pole wyboru: wartość to indeks opcji).
  - `sealed interface NodeValue { data class Text(val value: String); data class ListIndex(val index: Int) }`
  - `enum class FillGroup { LOGIN, CARD, CONTACT }`
  - `data class DatasetSpec<Id>(val entryId: String, val title: String, val subtitle: String, val values: List<Pair<Id, NodeValue>>)`
  - `data class FillRequestPlan<Id>(val group: FillGroup, val nodes: List<Pair<AutofillNode<Id>, FieldKind>>)` – pola grupy z rodzajami.
  - `fun <Id> planRequest(nodes: List<AutofillNode<Id>>): FillRequestPlan<Id>?` – klasyfikuje pola (`classifyField`); grupa: `USERNAME`/`PASSWORD` → `LOGIN`; inaczej dowolne `CC_*` → `CARD`; inaczej rodzaj kontaktu inny niż `EMAIL` → `CONTACT`; inaczej `EMAIL` → `LOGIN` (D2); nic / same `NEW_PASSWORD` → `null`. W planie tylko pola należące do grupy.
  - `fun <Id> planDatasets(plan: FillRequestPlan<Id>, request: AppRequest, entries: List<PhoneEntry>): List<DatasetSpec<Id>>` – wpisy grupy (`LOGIN` przez `matchApp`; `CARD` pomija przeglądarkę z `webScheme` innym niż `https`, poza `localhost` – D3), dla każdego `planFor` + `fillValue` na każdym polu (`hasUsernameField` = jest pole `USERNAME`); pole listy → `ListIndex` indeksu opcji o tej wartości; wpis bez żadnej wartości pominięty; najwyżej 10. Tytuł = nazwa wpisu; podtytuł: login → login, karta → `"•••• " + 4 ostatnie cyfry` (brak cyfr → `""`), kontakt → imię i nazwisko.

- [ ] **Step 1: Testy** (`Id` = `String`, wpisy z `PhoneEntryFixtures` / budowane ręcznie):
  - `login form gets matching logins with username and password`;
  - `email only field is a login step` (D2) – login dostaje wartość w polu e-mail;
  - `registration form with only new passwords gives no plan` (Review Focus 3);
  - `entry without any value is skipped` (Review Focus 2: login z pustym loginem przy samym polu loginu; karta `expiry="7/2029"` przy samych polach daty);
  - `card fields get cards in list order, not in http browser` (D3);
  - `contact form fills names, address and first phone`;
  - `select field gets the option index`;
  - `at most ten datasets`;
  - `subtitle per type` (`"•••• 1111"`, `"Jan Kowalski"`).
- [ ] **Step 2:** FAIL. **Step 3:** zaimplementuj. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(android-core): plan autofill datasets for a request`.

### Task 4: Odczyt pól z `AssistStructure`

**Files:**
- Create: `android/app/src/main/kotlin/io/github/sheking94/passholder/app/autofill/ViewNodeReader.kt`
- Test: `android/app/src/test/kotlin/io/github/sheking94/passholder/app/autofill/NodeDescriptorTest.kt` (zwykły JUnit 4, bez Robolectric)

**Interfaces:**
- Consumes: `FieldDescriptor`, `AutofillNode`, `AppRequest`.
- Produces:
  - `data class NodeAttrs(val hints: List<String>, val htmlTag: String?, val htmlAttrs: Map<String, String>, val inputType: Int, val idEntry: String?, val hint: String?, val contentDescription: String?, val maxTextLength: Int, val options: List<String>?, val isList: Boolean)`
  - `fun describeNode(a: NodeAttrs): FieldDescriptor` – `autocomplete` = tokeny `htmlAttrs["autocomplete"]` + `hints`; `type`: tag `select` → `"select"`, `htmlAttrs["type"]`, a dla widoków natywnych z `inputType`: klasa tekstu z odmianą `PASSWORD`/`WEB_PASSWORD`/`VISIBLE_PASSWORD` albo klasa liczb z `NUMBER_VARIATION_PASSWORD` → `"password"`, `EMAIL_ADDRESS`/`WEB_EMAIL_ADDRESS` → `"email"`, `TYPE_CLASS_PHONE` → `"tel"`, inaczej `"text"`; `name` = `htmlAttrs["name"] ?: idEntry`; `id` = `htmlAttrs["id"] ?: idEntry`; `label` = `htmlAttrs["label"] ?: contentDescription`; `placeholder` = `htmlAttrs["placeholder"] ?: hint`; `maxLength` = `htmlAttrs["maxlength"]` albo `maxTextLength` gdy > 0; `options` = opcje jako `FieldOption(text, text)`.
  - `class ParsedRequest(val app: AppRequest, val nodes: List<AutofillNode<AutofillId>>)`
  - `fun readRequest(structure: AssistStructure): ParsedRequest` – ostatnie okno, rekurencja po dzieciach; tylko węzły z `autofillId`, `autofillType` `TEXT` lub `LIST`, `visibility == VISIBLE`, `isEnabled`; `webDomain`/`webScheme` (API 28+) z pierwszego węzła, który je ma; pakiet z `activityComponent.packageName`.

- [ ] **Step 1: Testy** `describeNode`: pole hasła natywne (`TYPE_CLASS_TEXT or TYPE_TEXT_VARIATION_PASSWORD`) → `type="password"`; PIN (`TYPE_CLASS_NUMBER or TYPE_NUMBER_VARIATION_PASSWORD`) → `"password"`; e-mail natywny → `"email"`; HTML `autocomplete="section-a cc-number"` + hints `["creditCardNumber"]` → tokeny w tej kolejności; `<select>` z opcjami → `type="select"`, opcje; `idEntry="login_field"` bez HTML → `name` i `id` = `"login_field"`; `classifyField(describeNode(...))` dla pola z `hint="Hasło"` i inputType hasła → `PASSWORD`.
- [ ] **Step 2:** FAIL. **Step 3:** zaimplementuj (`readRequest` bez testu jednostkowego – `ViewNode` nie da się zbudować w teście; sprawdza go T19). **Step 4:** PASS (`./gradlew :app:testDebugUnitTest --tests '*NodeDescriptorTest*'`).
- [ ] **Step 5: Commit** `feat(android): read autofill fields from the assist structure`.

### Task 5: Usługa i odpowiedź

**Files:**
- Create: `android/app/src/main/kotlin/io/github/sheking94/passholder/app/autofill/PassHolderAutofillService.kt`, `ResponseBuilder.kt`
- Create: `android/app/src/main/res/xml/autofill_service.xml` (`settingsActivity="io.github.sheking94.passholder.app.MainActivity"`), `android/app/src/main/res/layout/autofill_item.xml` (dwa `TextView`: `@+id/title`, `@+id/subtitle`)
- Modify: `android/gradle/libs.versions.toml`, `android/app/build.gradle.kts` (`androidx-autofill = { module = "androidx.autofill:autofill", version = "1.1.0" }`)
- Modify: `android/app/src/main/res/xml/autofill_service.xml` ma `android:supportsInlineSuggestions="true"`
- Modify: `android/app/src/main/AndroidManifest.xml` (usługa z `BIND_AUTOFILL_SERVICE`, `intent-filter` `android.service.autofill.AutofillService`, `meta-data` `android.autofill`)
- Test: `android/app/src/test/kotlin/io/github/sheking94/passholder/app/autofill/ResponseBuilderTest.kt` (Robolectric; `AutofillId` przez `ReflectionHelpers.callConstructor(AutofillId::class.java, ClassParameter.from(Int::class.javaPrimitiveType, n))`)

**Interfaces:**
- Consumes: Task 3, Task 4, `PassHolderApp.phoneStore`.
- Produces:
  - `object ResponseBuilder { fun datasets(context: Context, specs: List<DatasetSpec<AutofillId>>, inline: InlineSuggestionsRequest?): FillResponse?; fun locked(context: Context, ids: List<AutofillId>, auth: IntentSender, inline: InlineSuggestionsRequest?): FillResponse }` – `datasets` zwraca `null` dla pustej listy; `Dataset.Builder(presentation).setValue(id, AutofillValue.forText/forList)` (przestarzałe API, `@Suppress("DEPRECATION")`, działa od API 26); `locked` = `FillResponse.Builder().setAuthentication(ids, auth, presentation "Odblokuj PassHolder")`.
  - Pasek klawiatury (D4, API 30+, `inline != null`): `fun inlinePresentation(context: Context, inline: InlineSuggestionsRequest, index: Int, title: String, subtitle: String?): InlinePresentation?` – `InlineSuggestionUi.newContentBuilder(attribution).setTitle(title).setSubtitle(subtitle).setContentDescription(title).build().slice`, `InlinePresentation(slice, spec, false)`; `attribution` = `PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java), FLAG_IMMUTABLE)` (długie przytrzymanie podpowiedzi otwiera aplikację). Dataset dostaje ją przez `setInlinePresentation`, odpowiedź zablokowana przez `setAuthentication(ids, auth, presentation, inlinePresentation)`. Wartość `null` (stary Android, brak specu, styl bez `INLINE_UI_VERSION_1`) → tylko zwykła lista.
  - `fun buildFillResponse(app: PassHolderApp, request: ParsedRequest): FillResponse?` (w `PassHolderAutofillService.kt`, używana też przez Task 6) – `planRequest`, `store.entries()`, `planDatasets`, `ResponseBuilder.datasets`.
  - `ParsedRequest` dostaje pole `inline: InlineSuggestionsRequest?` (z `FillRequest.inlineSuggestionsRequest` na API 30+, poza tym `null`); w ekranie odblokowania (Task 6) – `AutofillManager.EXTRA_INLINE_SUGGESTIONS_REQUEST` z intentu.
  - `PassHolderAutofillService.onFillRequest`: pakiet = własny → `onSuccess(null)`; `planRequest == null` → `onSuccess(null)`; sejf bez sejfu (`!hasVault`) → `null`; zablokowany → `locked(...)` z `PendingIntent.getActivity(this, 0, Intent(this, AutofillUnlockActivity::class.java), FLAG_CANCEL_CURRENT or FLAG_MUTABLE).intentSender` (MUTABLE: system dokłada `EXTRA_ASSIST_STRUCTURE`); odblokowany → `buildFillResponse`. Wyjątek → log + `onSuccess(null)`. Praca poza wątkiem głównym (`thread`), odpowiedź jednym `callback`; `CancellationSignal` ustawia flagę.
  - `onSaveRequest` → `callback.onSuccess()` bez działania.

- [ ] **Step 1: Testy** `ResponseBuilderTest`: `datasets(emptyList())` → `null`; dwie specyfikacje → `FillResponse` nie `null` (Robolectric nie daje odczytu datasetów – sprawdzamy brak wyjątku i `null`/nie-`null`); `locked` z dwoma id → nie `null`; przy `@Config(sdk = [30])` z `InlineSuggestionsRequest.Builder(listOf(InlinePresentationSpec.Builder(Size(100,40), Size(400,80)).setStyle(UiVersions.newStylesBuilder().addStyle(InlineSuggestionUi.newStyleBuilder().build()).build()).build())).setMaxSuggestionCount(3).build()` – `inlinePresentation(...)` nie `null` dla indeksów 0–2, a `datasets` z 5 specyfikacjami nie rzuca (pasek dostaje 3); spec bez stylu → `inlinePresentation == null`. Plus `ManifestTest`: usługa w `PackageManager.queryIntentServices(Intent(AutofillService.SERVICE_INTERFACE))` z uprawnieniem `BIND_AUTOFILL_SERVICE`.
- [ ] **Step 2:** FAIL. **Step 3:** zaimplementuj. **Step 4:** PASS + `./gradlew :app:assembleDebug`.
- [ ] **Step 5: Commit** `feat(android): autofill service with suggestions and locked prompt`.

### Task 6: Odblokowanie z podpowiedzi

**Files:**
- Create: `android/app/src/main/kotlin/io/github/sheking94/passholder/app/autofill/AutofillUnlockActivity.kt`, `android/app/src/main/kotlin/io/github/sheking94/passholder/app/ui/AutofillUnlockScreen.kt`
- Modify: `AndroidManifest.xml` (aktywność `exported="false"`, `excludeFromRecents="true"`, `theme` aplikacji), `PassHolderApp.kt` (hak testowy `var autofillRequest: (Intent) -> ParsedRequest? = { it.assistStructure()?.let(::readRequest) }`), `AppViewModel.kt` (`onReturn`: ekran `Locked` + `store.isUnlocked` → lista, Review Focus 4)
- Test: `android/app/src/test/kotlin/io/github/sheking94/passholder/app/AutofillUnlockTest.kt`, `AutofillUnlockScreenTest.kt` (zrzut Roborazzi), `AppViewModel`/ekran: test powrotu (jedna klasa = jeden `@Test`, jak w repo)

**Interfaces:**
- Consumes: `buildFillResponse` (Task 5), `PhoneVaultStore.unlock`, `BiometricController`, `PassHolderApp.fingerprintPrompt`, `LeaveLock`.
- Produces:
  - `AutofillUnlockActivity : FragmentActivity` – `FLAG_SECURE`; ekran: tytuł „Odblokuj PassHolder”, pole „Hasło główne”, „Odblokuj”, „Odblokuj odciskiem palca” (gdy włączony; dialog otwiera się sam przy starcie), „Anuluj”. Odblokowanie na `Dispatchers.IO` (Argon2id); po sukcesie: `buildFillResponse(app, request)` → `setResult(RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, response))` (brak pasujących → `RESULT_OK` bez extra), potem D1: `if (app.settings.lockDelay) app.leaveLock.schedule(LeaveLock.DELAY_MS) else store.lock()`, `finish()`. Złe hasło → komunikat jak w `LockedScreen`, aktywność zostaje. Wstecz/Anuluj → `RESULT_CANCELED`. Brak `request` → `RESULT_CANCELED` od razu.
  - `@Composable fun AutofillUnlockScreen(busy: Boolean, status: Status?, fingerprint: Boolean, onUnlock: (String) -> Unit, onFingerprint: () -> Unit, onCancel: () -> Unit)`

- [ ] **Step 1: Testy:** `AutofillUnlockTest` – start z hakiem dającym `ParsedRequest` z jednym polem hasła i sejfem z loginem dla pakietu; złe hasło → komunikat, brak wyniku; dobre → `RESULT_OK`, extra `EXTRA_AUTHENTICATION_RESULT` nie `null`, przy `lockDelay=false` sejf zablokowany po zakończeniu (D1); Wstecz → `RESULT_CANCELED`, sejf zablokowany (Review Focus 5). Test powrotu: `MainActivity` na ekranie blokady, `store.unlock(...)` z zewnątrz, `onStart` → lista (Review Focus 4). `AutofillUnlockScreenTest` – zrzut do `app/screenshots/`.
- [ ] **Step 2:** FAIL. **Step 3:** zaimplementuj. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(android): unlock the vault from an autofill suggestion`.

### Task 7: Ustawienia i dokumentacja

**Files:**
- Modify: `android/app/src/main/kotlin/io/github/sheking94/passholder/app/ui/SettingsScreen.kt` (wiersz `AutofillSetting`), `PassHolderApp.kt` (`var autofillStatus: AutofillStatus = SystemAutofillStatus(this)`; `interface AutofillStatus { fun isEnabled(): Boolean }` – `AutofillManager.hasEnabledAutofillServices()`)
- Modify: `docs/FUNKCJE.md` (rozdział „Autouzupełnianie” – część Android), `docs/ARCHITEKTURA.md` (moduł `autofill` w Kotlinie, przepływ żądania, odblokowanie, D1–D4), `docs/TESTY.md` (T19 + liczby testów), `docs/INSTALACJA.md` (włączenie usługi + opcja Chrome „Autouzupełnianie przez inną usługę”)
- Test: `android/app/src/test/kotlin/io/github/sheking94/passholder/app/AutofillSettingTest.kt`

**Interfaces:**
- Consumes: `AutofillStatus`.
- Produces: wiersz „Autouzupełnianie” ze stanem „Włączone”/„Wyłączone”; przy wyłączonym przycisk „Włącz” → `Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE, Uri.parse("package:" + packageName))`; stan odświeżany przy powrocie na ekran (`LifecycleResumeEffect`).

- [ ] **Step 1: Test** `AutofillSettingTest`: atrapa `isEnabled=false` → „Wyłączone”, klik „Włącz” → `shadowOf(app).nextStartedActivity.action == ACTION_REQUEST_SET_AUTOFILL_SERVICE`; zrzut Roborazzi; atrapa `true` → „Włączone”, bez przycisku.
- [ ] **Step 2:** FAIL. **Step 3:** zaimplementuj. **Step 4:** PASS.
- [ ] **Step 5: Dokumentacja** – T19 w `TESTY.md` (kroki: włącz usługę; aplikacja z loginem przypisanym do pakietu; Chrome z „inną usługą” na stronie z zapisanym adresem; zablokowany sejf → „Odblokuj PassHolder” → podpowiedzi; formularz karty; formularz adresu; obca aplikacja nie dostaje loginu strony). Zrzuty z testów UI skopiuj do `/mnt/project-files/android-v3/` (`60-…` i dalej).
- [ ] **Step 6:** pełne `./gradlew :core:test :app:testDebugUnitTest` → PASS.
- [ ] **Step 7: Commit** `feat(android): autofill setting; docs: autofill on Android`.
