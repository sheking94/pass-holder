# Pytanie o zapis loginu na Androidzie (V3 krok C2) – plan wykonania

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Usługa autouzupełniania PassHolder pyta systemowym oknem „Zapisać w PassHolder?” po wysłaniu formularza logowania i zapisuje nowy login albo nowe hasło istniejącego.

**Architecture:** Czysta logika w `android/core/.../core/save/` (port `core/src/save/` z TS, te same wektory). Usługa dokleja `SaveInfo` do odpowiedzi dla grupy login, a identyfikatory pól i opis aplikacji chowa w `clientState`. `onSaveRequest` czyta wartości, liczy decyzję i zapisuje; przy zablokowanym sejfie trzyma kandydata w pamięci i otwiera `AutofillSaveActivity`.

**Tech Stack:** Kotlin 2.2, Android `android.service.autofill` (minSdk 26, compileSdk 36), Compose, JUnit + Robolectric (`@Config(sdk = [35])`).

**Spec:** `docs/superpowers/specs/2026-11-11-pytanie-o-zapis-design.md` (sekcje 3, 5, 6, 7, 8). Wzór: plan C1 `docs/superpowers/plans/2026-11-11-pytanie-o-zapis-chrome.md`.

## Global Constraints

- Tylko loginy: nowy wpis albo zmiana samego `password` (spec 3.3). Zmiana czeka na synchronizację jak każda inna.
- `SaveInfo(SAVE_DATA_TYPE_PASSWORD or SAVE_DATA_TYPE_USERNAME)`, wymagane: pole hasła, opcjonalne: pole loginu, flaga `FLAG_SAVE_ON_ALL_VIEWS_INVISIBLE` (spec 5.1).
- Bez `SaveInfo`: przełącznik „Pytaj o zapis haseł” wyłączony, brak sejfu, sama aplikacja PassHolder.
- Domena tylko od `TRUSTED_BROWSERS`; inna aplikacja (też z WebView) zapisuje się pod swoim pakietem (spec 6).
- Kandydat przy zablokowanym sejfie: tylko w pamięci procesu, 2 minuty (`app.clock`), nigdy w intencji ani na dysku.
- Teksty: „Zapisano w PassHolder”, „Zaktualizowano hasło w PassHolder”, „Nie udało się zapisać w PassHolder”, przełącznik „Pytaj o zapis haseł” (domyślnie włączony, `SharedPreferences` `settings`, klucz `askToSave`).
- Blokada po odblokowaniu z okna zapisu jak w B2: D1 (60 s albo od razu wg „Blokuj po 60 s”), R2 (ponownie blokuje tylko sejf, który był zablokowany).
- Komentarze i nazwy w kodzie po angielsku, teksty UI i dokumentacja po polsku (jak dotąd).

## Decyzje planu (do akceptacji)

- **P1 – Android 8.0–8.1 (API 26–27):** `SaveCallback.onSuccess(IntentSender)` istnieje od API 28. Na starszych przy zablokowanym sejfie: `onFailure("Odblokuj PassHolder i spróbuj ponownie")`, bez kandydata.
- **P2 – pola w `clientState`:** czytnik struktury pomija pola niewidoczne, a przy zapisie formularz bywa już ukryty. Dlatego odpowiedź zapamiętuje w `clientState` `AutofillId` pola hasła i loginu oraz pakiet, `webDomain`, `webScheme` z chwili wypełniania. `onSaveRequest` szuka wartości po tych id we wszystkich `fillContexts` (od ostatniego).
- **P3 – które pole hasła:** pierwsze `NEW_PASSWORD`, a gdy go brak – pierwsze `PASSWORD` (zmiana hasła: zapisuje nowe). Login: pierwsze `USERNAME`, inaczej ostatnie `EMAIL` przed polem hasła.
- **P4 – adres w Kotlinie:** `saveUrl(page)` przyjmuje adres jak w TS (te same wektory); usługa podaje `"${webScheme ?: "https"}://$webDomain"`.
- **P5 – po odblokowaniu decyzja `none`:** okno zapisu zamyka się bez komunikatu (jak w Chrome).

## Review Focus

1. Formularz już ukryty przy zapisie (`FLAG_SAVE_ON_ALL_VIEWS_INVISIBLE`) → wartości i tak odczytane (P2). Test w zadaniu 3.
2. Ten sam login, inna wielkość liter / spacje → aktualizacja, nie duplikat. Wektory `decide.json` w zadaniu 1, test usługi w zadaniu 3.
3. Obca aplikacja zgłaszająca `webDomain` → zapis pod pakietem, nie pod domeną. Testy w zadaniach 1 i 3.
4. Kandydat starszy niż 2 minuty przy odblokowaniu → nic nie zapisane. Test w zadaniu 4.
5. Brak pasujących wpisów (dziś `null`) → odpowiedź z samym `SaveInfo`, nie `null`. Test w zadaniu 2.

---

### Task 1: Logika zapisu w Kotlinie (`core/save`)

**Files:**
- Create: `android/core/src/main/kotlin/io/github/sheking94/passholder/core/save/SaveUrl.kt`, `Decide.kt`, `SaveFields.kt`
- Modify: `android/core/src/main/kotlin/io/github/sheking94/passholder/core/autofill/Match.kt` (tylko jeśli warto użyć `parse` – zmiana na `internal`)
- Test: `android/core/src/test/kotlin/io/github/sheking94/passholder/core/save/SaveVectorsTest.kt`, `SaveFieldsTest.kt`, `SaveTargetTest.kt`

**Interfaces:**
- Produces:
  - `fun saveUrl(pageUrl: String): String?`, `fun saveName(url: String): String`
  - `data class SavedLogin(val id: String, val username: String, val password: String)`
  - `sealed interface SaveDecision { data object None; data object Create; data class Update(val id: String) }`
  - `fun decideSave(username: String, password: String, logins: List<SavedLogin>): SaveDecision`
  - `sealed interface SaveTarget { data class Web(val url: String); data class App(val packageName: String) }`
  - `fun saveTargetFor(request: AppRequest): SaveTarget?` – przeglądarka z `TRUSTED_BROWSERS` z niepustym `webDomain` → `Web(saveUrl(...) ?: return null)`; inaczej `App(packageName)`, pusty pakiet → `null`
  - `fun newLogin(target: SaveTarget, appLabel: String, username: String, password: String): EntryContentV3` – `Web`: nazwa `saveName(url)`, `urls = [url]`; `App`: nazwa `appLabel`, `androidApps = [pakiet]`; reszta pusta
  - `fun withPassword(content: EntryContentV3, password: String): EntryContentV3` (zmienia tylko `LoginFields.password`)
  - `data class SaveFields<Id>(val password: Id, val username: Id?)`, `fun <Id> saveFields(nodes: List<AutofillNode<Id>>): SaveFields<Id>?` (P3; `classifyField` z `core/autofill`; `null` bez pola hasła)

- [ ] **Step 1: Testy wektorów** – `SaveVectorsTest` czyta `core/test-vectors/save/url.json` i `decide.json` (jak `AutofillVectors.kt`, `passholder.repoRoot`). Dla `url.json`: `saveUrl(page) == expected`, `saveName(expected) == name`, a gdy `expected != null`, `matchUrl(page, expected) != null`. Dla `decide.json`: `decideSave(...)` równe `expected` (`none`/`create`/`update`+`id`).
- [ ] **Step 2: `SaveFieldsTest`** – `username`+`password` → oba; `email`+`password` → login = e-mail; `password`+`new-password`+`new-password` → hasło = pierwsze nowe; samo `username` → `null`; `email` po polu hasła nie jest loginem.
- [ ] **Step 3: `SaveTargetTest`** – Chrome + `www.GitHub.com`/`https` → `Web("github.com")`; Chrome + `http` + `intranet.local` → `Web("http://intranet.local")`; `com.example.app` z `webDomain = "bank.pl"` → `App("com.example.app")`; Chrome bez domeny → `App("com.android.chrome")`; `newLogin` i `withPassword` zachowują pozostałe pola.
- [ ] **Step 4: Uruchom – mają paść** `cd android && ./gradlew :core:test --tests '*core.save*'` → błędy kompilacji.
- [ ] **Step 5: Implementacja.** Uwaga: `https://www.` musi dać `null` (TS usuwa `www.` przed końcową kropką). Port domyślny pomijany, IPv6 w nawiasach.
- [ ] **Step 6: Uruchom – PASS**, potem całe `:core:test`.
- [ ] **Step 7: Commit** `feat(android-core): save logic (saveUrl, decideSave, saveFields, saveTarget)`

### Task 2: `SaveInfo` w odpowiedziach i przełącznik w Ustawieniach

**Files:**
- Modify: `android/app/.../app/PassHolderApp.kt` (`Settings.askToSave: Boolean`, domyślnie `true`)
- Modify: `android/app/.../app/autofill/PassHolderAutofillService.kt` (`respond`, `buildFillResponse`), `ResponseBuilder.kt`
- Create: `android/app/.../app/autofill/SaveState.kt` (klucze i odczyt `clientState`)
- Modify: `android/app/.../app/AppViewModel.kt` (`askToSave: StateFlow<Boolean>`, `setAskToSave(Boolean)`), `ui/SettingsScreen.kt`
- Test: `app/autofill/FillLogicTest.kt`, `ResponseBuilderTest.kt`, `app/SettingsScreenTests.kt`

**Interfaces:**
- Consumes: `saveFields` (zadanie 1).
- Produces:
  - `class SaveSpec(val fields: SaveFields<AutofillId>, val app: AppRequest)`
  - `fun saveSpecFor(app: PassHolderApp, request: ParsedRequest): SaveSpec?` – `null` gdy `!settings.askToSave`, brak planu LOGIN albo brak pola hasła
  - `ResponseBuilder.datasets(context, specs, inline, save: SaveSpec?): FillResponse?` – `null` tylko gdy brak zbiorów i brak `save`
  - `ResponseBuilder.locked(context, ids, auth, inline, save: SaveSpec?)`
  - `fun SaveSpec.toClientState(): Bundle` i `fun Bundle.saveSpecIds(): SavedIds?` gdzie `data class SavedIds(val password: AutofillId, val username: AutofillId?, val app: AppRequest)` (klucze `save.password`, `save.username`, `save.package`, `save.webDomain`, `save.webScheme`)
- `buildFillResponse` (używane też przez `AutofillUnlockActivity`) dodaje `SaveInfo` po odblokowaniu.

- [ ] **Step 1: Testy** (`FillLogicTest`; `SaveInfo` odczytywany refleksją: `response.javaClass.getMethod("getSaveInfo").invoke(response)`, bo getter jest `@hide`):
  - `unlocked with matches carries save info`, `no matching entry gives save info only` (odpowiedź nie-`null`, bez zbiorów),
  - `locked vault carries save info`, `save prompt off gives no save info` (z dopasowaniem: zbiory bez `SaveInfo`; bez dopasowania: `null`),
  - `own app and no vault still get nothing`, `client state keeps field ids and app`.
- [ ] **Step 2: Test Ustawień** – `SettingsScreenTests`: wiersz „Pytaj o zapis haseł” pod „Autouzupełnianie”, domyślnie włączony, klik zmienia `settings.askToSave`; zrzut Roborazzi `62-ustawienia-zapis.png` (kopia do `/mnt/project-files/android-v3/`). Pod nazwą opis: włączony „Po zalogowaniu PassHolder zapyta, czy zapisać hasło.”, wyłączony „PassHolder nie pyta o zapis.”
- [ ] **Step 3: Uruchom – mają paść.**
- [ ] **Step 4: Implementacja.** `SaveInfo.Builder(SAVE_DATA_TYPE_PASSWORD or SAVE_DATA_TYPE_USERNAME, arrayOf(password)).setOptionalIds(...)` (tylko gdy jest login) `.setFlags(SaveInfo.FLAG_SAVE_ON_ALL_VIEWS_INVISIBLE)`; `FillResponse.Builder.setSaveInfo(...)` i `setClientState(...)`.
- [ ] **Step 5: Uruchom testy autofill i Ustawień – PASS.**
- [ ] **Step 6: Commit** `feat(android): SaveInfo in fill responses, "Pytaj o zapis haseł" switch`

### Task 3: `onSaveRequest` przy odblokowanym sejfie

**Files:**
- Create: `android/app/.../app/autofill/SaveLogin.kt`
- Modify: `PassHolderAutofillService.kt` (`onSaveRequest`)
- Test: `app/autofill/SaveLoginTest.kt`

**Interfaces:**
- Consumes: zadanie 1 (`saveTargetFor`, `decideSave`, `newLogin`, `withPassword`, `matchApp`), zadanie 2 (`SavedIds`).
- Produces:
  - `data class SaveData(val app: AppRequest, val username: String, val password: String)`
  - `enum class SaveOutcome { SAVED, UPDATED, NOTHING, LOCKED }`
  - `fun saveLogin(app: PassHolderApp, data: SaveData, appLabel: (String) -> String): SaveOutcome` – sejf zablokowany (także po terminie `leaveLock.expired()`, który blokuje) → `LOCKED`, nic nie zmienia; inaczej decyzja na loginach z `matchApp` i `upsertContent` (nowy id `UUID.randomUUID()`)
  - `fun readSaveData(request: SaveRequest): SaveData?` – `clientState` + wartości po `AutofillId` ze wszystkich `fillContexts` (od ostatniego), `autofillValue.textValue`; Android-only, bez testu jednostkowego
  - `fun saveToast(outcome: SaveOutcome): String?` – teksty z Global Constraints, `null` dla `NOTHING`/`LOCKED`
- `onSaveRequest`: w wątku jak `onFillRequest`; `NOTHING`/`SAVED`/`UPDATED` → `Toast` na głównym wątku (gdy jest tekst) i `callback.onSuccess()`; wyjątek → `callback.onFailure("Nie udało się zapisać w PassHolder")`; `LOCKED` → zadanie 4. Etykieta aplikacji: `packageManager.getApplicationLabel(getApplicationInfo(pkg, 0))`, błąd → nazwa pakietu.

- [ ] **Step 1: Testy** `SaveLoginTest` (Robolectric, sejf jak w `FillLogicTest`):
  - `new login in browser saved under the domain` (Chrome, `www.github.com` → wpis „github.com”, `urls = ["github.com"]`, `SAVED`),
  - `new login in an app saved under the package` (`com.example.bank`, etykieta „Bank” → `androidApps = ["com.example.bank"]`),
  - `app posing as a site saved under its package` (`webDomain = "github.com"` z obcego pakietu nie zmienia wpisu GitHub),
  - `changed password updates the matching entry` (`" JKowalski "` → `UPDATED`, ten sam id, reszta pól bez zmian),
  - `same password changes nothing` (`NOTHING`, liczba wpisów bez zmian),
  - `locked vault saves nothing` (`LOCKED`).
- [ ] **Step 2: Uruchom – mają paść.** **Step 3: Implementacja.** **Step 4: PASS.**
- [ ] **Step 5: Commit** `feat(android): save submitted logins from the autofill service`

### Task 4: Zapis przy zablokowanym sejfie (`AutofillSaveActivity`)

**Files:**
- Create: `android/app/.../app/autofill/PendingSave.kt`, `AutofillSaveActivity.kt`
- Modify: `AutofillUnlockActivity.kt` (wspólna część odblokowania wydzielona do `abstract class AutofillAuthActivity : FragmentActivity` i hakiem `protected abstract fun afterUnlock(): Intent?` – wołany w `Dispatchers.IO` po odblokowaniu, zwraca dane wyniku `RESULT_OK`; baza robi D1/R2, anulowanie i `finish()`, a `protected open fun onCancelled()` pozwala wyczyścić kandydata; zachowanie `AutofillUnlockActivity` bez zmian), `PassHolderApp.kt` (`val pendingSave = PendingSave { clock() }`), `PassHolderAutofillService.kt`, `AndroidManifest.xml` (`exported="false"`, motyw jak `AutofillUnlockActivity`)
- Test: `app/autofill/PendingSaveTest.kt`, `app/AutofillSaveTest.kt`, `app/autofill/ManifestTest.kt`, istniejące `AutofillUnlockTest.kt` (bez zmian, ma przejść)

**Interfaces:**
- Consumes: `saveLogin`, `saveToast`, `SaveData` (zadanie 3).
- Produces:
  - `class PendingSave(now: () -> Long)` z `fun put(data: SaveData)`, `fun take(): SaveData?` (zwraca i czyści; `null` po 2 min = `120_000` ms), `fun clear()`
  - `internal fun savePendingIntent(context): PendingIntent` (`FLAG_IMMUTABLE`, `requestCode = 1`, bez danych w intencji)
- Usługa przy `LOCKED`: API ≥ 28 → `pendingSave.put(data)`, `callback.onSuccess(savePendingIntent(this).intentSender)`; API < 28 → `onFailure("Odblokuj PassHolder i spróbuj ponownie")` (P1).
- `AutofillSaveActivity`: ekran `AutofillUnlockScreen`, odcisk palca jak w `AutofillUnlockActivity`; po odblokowaniu `take()` → `saveLogin` → `Toast` (`saveToast`), blokada D1/R2, `finish()`; anulowanie / Wstecz → `pendingSave.clear()` (i blokada, jeśli odblokowanie trwało). Brak kandydata przy starcie → `finish()`.

- [ ] **Step 1: Testy** – `PendingSaveTest`: `take` zwraca i czyści; po 120 001 ms `null`; `put` zastępuje starszy. `AutofillSaveTest` (Robolectric, jeden `@Test` na klasę – osobne klasy): hasło główne → wpis zapisany, sejf znowu zablokowany po 60 s albo od razu; „Anuluj” → kandydat usunięty, nic nie zapisane; kandydat przeterminowany → nic nie zapisane. `ManifestTest`: aktywność nieeksportowana.
- [ ] **Step 2: Uruchom – mają paść.** **Step 3: Implementacja.** **Step 4: PASS**, też `AutofillUnlockTest`.
- [ ] **Step 5: Commit** `feat(android): save after unlocking a locked vault`

### Task 5: Dokumentacja i pełne testy

**Files:**
- Modify: `docs/FUNKCJE.md` (rozdział „Pytanie o zapis” – część Android), `docs/ARCHITEKTURA.md` (moduł `core/save` w Kotlinie, pliki `app/autofill/`), `docs/TESTY.md` (liczby, pliki testów, T21), `docs/INSTALACJA.md` (przełącznik w Ustawieniach)

- [ ] **Step 1:** T21 w `TESTY.md`: logowanie w aplikacji (nowy login), Chrome z „inną usługą autouzupełniania” (nowy + zmiana hasła), zablokowany sejf (odcisk palca / hasło), przełącznik wyłączony → brak okna.
- [ ] **Step 2:** Pełne `./gradlew :core:test :app:testDebugUnitTest -ProbolectricRepoUrl=...`; liczby do `TESTY.md`.
- [ ] **Step 3: Commit** `docs: save prompt on Android (FUNKCJE, ARCHITEKTURA, TESTY T21, INSTALACJA)`
