# Przegląd czystości kodu nr 2 (usprawnienia v1.0, PR #9–#14)

Data: 2026-11-01 · Stan: `main@cdef88a` · Narzędzie: skill *clean-code-reviewer* (zasady Clean Code R. C. Martina)

Zakres: kod produkcyjny dodany lub zmieniony od `c92cc3c` (merge PR #8) do `cdef88a` (merge PR #14):

- **Wtyczka Chrome**: `open-in-tab.ts` (PR #9), `csv-transfer.ts` (PR #10), `pin-lock.ts` (PR #11), `server-urls.ts` (PR #12), zmiany w `popup.ts`, `vault-store.ts`, `api.ts`.
- **Android**: `ServerPicker.kt`, zmiany w `VaultStore.kt`, `ServerClient.kt` (PR #12), `BiometricUnlock.kt` (PR #13), `LeaveLock.kt` (PR #14), zmiany w `AppViewModel.kt`, `MainActivity.kt`, `PassHolderApp.kt` i ekranach.

Pominięte: testy, konfiguracja Gradle, CSS, dokumentacja. Serwer i `core/` nie zmieniły się od poprzedniego przeglądu.

Poprzedni przegląd: `docs/PRZEGLAD_CZYSTOSCI_KODU.md` (2026-10-31). Jego grupy 3–4 (podział `popup.ts`, `buildApp`, `ConnectScreen`/`EditScreen`) nadal są otwarte; ten przegląd mówi, ile się od tamtej pory pogłębiły.

## Podsumowanie

Pliki: 17 | Critical: 2 | High: 6 | Medium: 8 | Low: 4

**Co wiem na pewno** (sprawdzone w kodzie): wszystkie numery linii, rozmiary plików i duplikaty poniżej.
**Co jest oceną**: progi (np. „funkcja > 20 linii”) to reguły Clean Code, nie błędy. W projekcie do nauki część z nich świadomie można zostawić. Żadna z uwag nie jest błędem bezpieczeństwa ani zepsutą funkcją; jedna (pkt 9) to niespójność, która może dać dziwne zachowanie w rzadkim przypadku.

Najważniejszy wniosek: nowe moduły (`csv-transfer.ts`, `pin-lock.ts`, `server-urls.ts`, `ServerPicker.kt`, `LeaveLock.kt`, `BiometricUnlock.kt`) są małe, dobrze nazwane i testowane. Problem leży w dwóch miejscach, do których każda funkcja dopisała „jeszcze trochę”: **`popup.ts` (695 linii)** i **`AppViewModel.kt` (400 linii)**. Oba urosły o ok. 50–80% w jeden dzień.

---

## Naruszenia

### Critical

**1. [Critical] [Structure/SRP] `extension/src/popup.ts` — plik-bóg (695 linii, +340 od PR #8)**
> ```ts
> function connectView(...)        // :179
> async function addressesView()   // :241
> function pinLockedView(...)      // :292
> async function pinSettingsView() // :448
> async function editView(...)     // :514
> function transferView()          // :627
> ```
Problem: jeden plik zawiera pomocniki DOM (`h`, `show`, `busy`), routing kart (`IN_TAB`, `TRANSFER_TAB`, `PARAMS`), uprawnienia Chrome i siedem widoków. Każda nowa funkcja (karta, CSV, PIN, adresy) dopisała tu swój widok i swoje warunki. Poprzedni przegląd już to zgłaszał (grupa 3); od tamtej pory plik urósł prawie dwukrotnie.
Fix: rozbić na `ui/dom.ts` (h, show, statusLine, busy, form, passwordField), `ui/page-mode.ts` (pkt 3) i po pliku na widok: `views/connect.ts`, `views/addresses.ts`, `views/locked.ts`, `views/pin-settings.ts`, `views/list.ts`, `views/edit.ts`, `views/transfer.ts`. `popup.ts` zostaje tylko z `start()`.

**2. [Critical] [Structure/SRP] `android/.../app/AppViewModel.kt:57` — ViewModel robi pięć rzeczy (400 linii, +223)**
> ```kotlin
> private var fingerprintOnLockedScreen = true          // :73
> private val _fingerprintRequests = MutableStateFlow(0)
> private val _lockDelay = MutableStateFlow(...)
> private var lockWhenDone = false                      // :84
> ```
Problem: parowanie z serwerem, adresy, cykl życia blokady (wyjście z aplikacji, 60 s, auto-lock, „zablokuj po zakończeniu operacji”), odcisk palca i wpisy siedzą w jednej klasie. Stan blokady to trzy luźne flagi, które zmieniają się w siedmiu metodach (`lockOnLeave`, `onReturn`, `lockNow`, `checkAutoLock`, `lock`, `launchVaultOperation`, `onCleared`). Żeby zrozumieć, kiedy pojawi się okno odcisku, trzeba prześledzić wszystkie.
Fix: wydzielić
- `LockController` (lockOnLeave, onReturn, lockNow, showLockedIfLocked, lockWhenDone, fingerprintOnLockedScreen) z jednym `enum`/`sealed` stanem zamiast trzech flag,
- `BiometricController` (enable/disable/unlockWithBiometric, biometricEnabled),
- ViewModel zostawia tylko zbieranie `UiState` i delegowanie.

### High

**3. [High] [Smells/Primitive obsession] `extension/src/popup.ts:144-145, 610` — tryb strony jako rozsiane stringi i boole**
> ```ts
> const IN_TAB = isTabPage(location.search) || PARAMS.has("addresses");
> const TRANSFER_TAB = PARAMS.has("transfer");
> ...
> if (IN_TAB || TRANSFER_TAB) document.body.classList.add("tab");
> ```
Problem: `"tab"` i `"setup"` są stałymi w `open-in-tab.ts`, ale `"addresses"` i `"transfer"` to gołe stringi w `popup.ts` (6 miejsc). `IN_TAB` obejmuje kartę adresów, a nie obejmuje karty CSV, więc w kilku miejscach trzeba pamiętać o `IN_TAB || TRANSFER_TAB`. `TRANSFER_TAB` jest zadeklarowane 450 linii pod pierwszym użyciem.
Fix: jeden typ i jedna funkcja:
```ts
type PageMode = "popup" | "tab" | "setup" | "addresses" | "transfer";
export function pageMode(search: string): PageMode
export const isInTab = (mode: PageMode) => mode !== "popup";
export const pageUrl = (mode: Exclude<PageMode, "popup">) => chrome.runtime.getURL(`popup.html?${mode}`);
```

**4. [High] [DRY] `extension/src/popup.ts:148, 233, 612` — trzy kopie „otwórz w karcie albo pokaż tutaj”**
> ```ts
> async function openAddressesTab() {
>   if (IN_TAB) return addressesView();
>   await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?addresses") });
>   window.close();
> }
> ```
Problem: `openSetupTab`, `openAddressesTab`, `openTransferTab` (i podobne `showConnect`) różnią się tylko parametrem i widokiem.
Fix: `async function showInTab(mode: PageMode, view: () => void)`, które w karcie wywołuje `view()`, a w popupie otwiera kartę i zamyka popup.

**5. [High] [Functions] `extension/src/popup.ts:627` `transferView` (≈60 linii) i `:448` `pinSettingsView` (≈60 linii, dwa tryby)**
Problem: `transferView` buduje dwa formularze i w handlerze importu składa komunikat z czterech części (`lines = [...]`). `pinSettingsView` to w praktyce dwa różne ekrany rozdzielone `if (current) { ...; return; }`.
Fix: `pinSettingsView` → `pinEnabledView(status)` + `pinSetupView()`. W `transferView` wydzielić `exportSection(status)`, `importSection(status)` i czystą funkcję `importSummary(parsed, result): string` (do przetestowania bez DOM).

**6. [High] [DRY] `android/.../app/AppViewModel.kt:259, 289` — `enableBiometric` i `unlockWithBiometric` to ta sama procedura**
> ```kotlin
> val cipher = try { biometric.cipherToEnable() } catch (e: Exception) { return fail(...) }
> app.fingerprintPrompt.authenticate(activity, "...", cipher,
>     onSuccess = { authorized -> launchVaultOperation("...") {
>         val keys = ...
>         try { ... } finally { keys.fill(0) }
>         ...
>     } },
>     onError = { message -> message?.let(::fail) },
> )
> ```
Problem: przygotuj szyfr → pokaż okno → w operacji użyj kluczy → wyzeruj. Dwie kopie po ~30 linii i 4 poziomy zagnieżdżenia (funkcja → lambda → lambda → try).
Fix: `private fun withFingerprint(activity, title, prepare: () -> Cipher, busyText, onAuthorized: (Cipher) -> Unit)` oraz `inline fun <T> ByteArray.useAndWipe(block: (ByteArray) -> T): T`. Obie metody spadają do kilku linii.

**7. [High] [SOLID/DIP] `android/.../app/AppViewModel.kt:259, 289` — ViewModel przyjmuje `FragmentActivity`**
> ```kotlin
> fun enableBiometric(activity: FragmentActivity)
> ```
Problem: ViewModel żyje dłużej niż aktywność i nie powinien znać klas UI. Teraz aktywność trafia do niego tylko na chwilę (nie jest przechowywana), więc wycieku nie ma, ale warstwy są pomieszane i ViewModel trudniej testować (testy potrzebują Robolectric i fałszywego promptu).
Fix: ekran sam pokazuje okno (`FingerprintPrompt` przez `LocalActivity`), a ViewModel daje dwie metody bez Androida: `cipherToEnable()/onFingerprintEnabled(cipher)` i `cipherToUnlock()/onFingerprintUnlocked(cipher)`.

**8. [High] [Functions/params] `extension/src/api.ts:29` — 5 parametrów pozycyjnych, z czego 3 opcjonalne**
> ```ts
> private async request<T>(method: string, path: string, body?: unknown, token?: string, timeoutMs?: number)
> ...
> return this.request(..., "GET", "/api/v1/status", undefined, undefined, timeoutMs);
> ```
Problem: wywołanie `undefined, undefined, timeoutMs` nie mówi, co jest czym; kolejny parametr pogorszy to dalej.
Fix: `request<T>(method, path, options: { body?: unknown; token?: string; timeoutMs?: number } = {})`.

### Medium

**9. [Medium] [Smells] Niespójność trybów karty: karta CSV bez konta**
`popup.ts:168` `showConnect()` sprawdza tylko `IN_TAB`, a karta `?transfer` nie jest w `IN_TAB`. Gdy ktoś otworzy kartę CSV na przeglądarce bez konta (np. po „Odłącz” w innej karcie i odświeżeniu), `start()` otworzy kolejną kartę z formularzem i zamknie bieżącą. Nie sprawdzałem tego ręcznie w Chrome; wynika to z odczytu kodu. Znika samo po pkt 3.

**10. [Medium] [DRY] Powtórzone komunikaty błędów**
- `"PIN musi mieć od 4 do 6 cyfr"`: `pin-lock.ts:43, 52`, `vault-store.ts:47`, `popup.ts:480` (4 kopie). Do tego PIN jest sprawdzany dwa razy w jednej ścieżce (`VaultStore.unlockWithPin` i `openPinLock`).
- `"Ta przeglądarka nie jest połączona z serwerem"`: `vault-store.ts:163, 257, 274`.
- `"Bez zgody na dostęp do serwera…"`: `popup.ts:197, 252`.
- `"Brak konta"`: `VaultStore.kt:103, 170, 200, 261`.
Fix: stałe (`INVALID_PIN` eksportowane z `pin-lock.ts`, `NOT_CONNECTED`), a w Kotlinie `private fun requireAccount(): Account`.

**11. [Medium] [Coupling] `extension/src/vault-store.ts:26` — magazyn sejfu zależy od modułu CSV**
> ```ts
> import { sameEntry, type ImportedEntry } from "./csv-transfer.ts";
> ```
Problem: `VaultStore.importEntries` nie ma nic wspólnego z CSV, a importuje z niego typ i porównanie. Gdyby doszedł import z innego formatu, zależność idzie w złą stronę.
Fix: `sameEntry` i typ `EntryFields = Pick<EntryData, "name"|"username"|"password">` przenieść do `vault-store.ts` (albo do `@passholder/core`); `csv-transfer.ts` importuje je stamtąd.

**12. [Medium] [SRP] `extension/src/vault-store.ts` — logika PIN-u w `VaultStore` (446 linii, +174)**
`unlockWithPin`, `enablePin`, `disablePin`, `pinStatus`, `findPinLock`, `resetPinAttempts` (≈90 linii) to osobna odpowiedzialność: gdzie trzymać PinLock i jak liczyć próby. `unlockWithPin` (≈25 linii) robi pięć kroków.
Fix: klasa `PinStore(local, session)` z tymi metodami; `VaultStore` dostaje ją w konstruktorze i woła `pin.unlock(pin) → UnlockKeys`, a sam tylko `startSession`.

**13. [Medium] [YAGNI] API tylko dla testów: `string | string[]` (TS) i przeciążenia jednego adresu (Kotlin)**
> ```ts
> async createVault(serverUrls: string | readonly string[], ...)   // vault-store.ts
> ```
> ```kotlin
> fun createVault(serverUrl: String, ...) = createVault(listOf(serverUrl), ...)   // VaultStore.kt:121, 147
> ```
Problem: kod produkcyjny (`popup.ts:199`, `AppViewModel.kt:209`) zawsze podaje listę; wariant z jednym adresem istnieje tylko po to, żeby stare testy się nie zmieniły.
Fix: zostawić tylko listę, w testach `[url]` / `listOf(url)`.

**14. [Medium] [DRY] `android/.../app/AppViewModel.kt:191` `firstCertificate` powtarza pętlę `ServerPicker.pick`**
Obie funkcje „próbują po kolei adresy, zapamiętują błąd, rzucają na końcu”. Fix: generyczne `ServerPicker.firstThatAnswers(urls) { url -> ... }` używane w obu miejscach.

**15. [Medium] [Structure] `android/.../core/VaultStore.kt:56` — stary format w modelu domenowym**
> ```kotlin
> /** Version 1.0 kept a single address here. Only read, ... */
> val serverUrl: String? = null,
> ```
Problem: każde `Account` w kodzie ma pole, którego nikt nie powinien używać. Wtyczka rozwiązała to lepiej (`StoredAccount` + `upgradeAccount` w `vault-store.ts`).
Fix: `@Serializable private data class StoredAccount(...)` + `toAccount()`; `Account` bez `serverUrl`.

**16. [Medium] [Error handling] `android/.../app/BiometricUnlock.kt:55` — wyjątek rzucany i łapany w tym samym `try`**
> ```kotlin
> return try {
>     keys.decryptCipher(...) ?: throw BiometricKeyLostException()
> } catch (e: KeyPermanentlyInvalidatedException) { disable(); throw BiometricKeyLostException() }
>   catch (e: BiometricKeyLostException) { disable(); throw e }
> ```
Problem: sterowanie przepływem przez wyjątek, który sam rzucasz i od razu łapiesz; trudno to przeczytać.
Fix:
```kotlin
val cipher = try { keys.decryptCipher(iv) } catch (e: KeyPermanentlyInvalidatedException) { null }
return cipher ?: run { disable(); throw BiometricKeyLostException() }
```

### Low

**17. [Low] [Naming] `AppViewModel.lockOnLeave()`** nie zawsze blokuje (z opóźnieniem planuje blokadę i zwiększa licznik okna odcisku). Lepiej `onLeftApp()` w parze z istniejącym `onReturn()`. Podobnie `fingerprintRequests` to licznik powrotów, nie żądań.

**18. [Low] [Smells] `AppViewModel.kt:142` `showLockedIfLocked`** wylicza ekrany z sejfem (`List || Addresses || is Edit`). Przy kolejnym ekranie łatwo zapomnieć. Fix: `val Screen.showsVault: Boolean` w `sealed interface Screen`.

**19. [Low] [Error handling] `AppViewModel.kt:295` `fail(e.message!!)`** — `!!` na wiadomości wyjątku. Komunikat jest stały, więc nie wybuchnie, ale `BiometricKeyLostException.MESSAGE` jako stała usuwa wątpliwość.

**20. [Low] [Readability] `csv-transfer.ts:111` `exportNordPassCsv`** — `switch` wewnątrz `map` po wszystkich kolumnach. Czytelniej: `const values: Partial<Record<Column, string>> = { name, username, password, type: LOGIN_TYPE }; NORDPASS_COLUMNS.map(c => values[c] ?? "")`.

---

## Dobre praktyki

- **Małe, czyste moduły z wstrzykiwanymi zależnościami**: `TabApi` w `open-in-tab.ts`, `UnlockKeyProtector` i `FingerprintPrompt` w `BiometricUnlock.kt`, `now`/`handler` w `LeaveLock.kt`. Dzięki temu karta, odcisk i opóźniona blokada mają testy bez prawdziwego Chrome/Keystore.
- **Funkcje czyste tam, gdzie to możliwe**: `parseCsv`, `toCsv`, `parseNordPassCsv`, `normalizeServerUrls`, `orderForTrying`, `ServerPicker.normalize/order` — bez I/O, łatwe do testów.
- **Spójność dwóch klientów**: `server-urls.ts` i `ServerPicker.kt` mają te same nazwy pojęć, ten sam timeout i ten sam komunikat; komentarz wskazuje odpowiednik.
- **Komentarze mówią „dlaczego”, nie „co”**: np. liczenie próby PIN-u przed sprawdzeniem (`vault-store.ts:280`), `elapsedRealtime` w `LeaveLock`, Keystore unieważniany po dodaniu odcisku.
- **Własne typy błędów** (`WrongPinError`, `BiometricKeyLostException`, `PinMismatchException`) zamiast kodów błędów; zerowanie kluczy w `finally`.
- **Migracja danych** z v1.0 (`serverUrl` → `serverUrls`) bez ręcznych kroków u użytkownika.

## Proponowana kolejność poprawek

| Grupa | Punkty | Ryzyko | Uwagi |
|---|---|---|---|
| A. Szybkie i bezpieczne | 8, 10, 11, 13, 15, 16, 19, 20 | niskie | mechaniczne, testy pokryją |
| B. Tryby karty we wtyczce | 3, 4, 9 | niskie | naprawia też pkt 9 |
| C. Rozbicie popup.ts | 1, 5, 12 | średnie | duży diff, zachowanie bez zmian |
| D. Rozbicie AppViewModel | 2, 6, 7, 14, 17, 18 | średnie | dotyka blokady i odcisku; potrzebne testy Robolectric |

Moje zdanie: A + B dają najwięcej czytelności przy najmniejszym ryzyku. C i D są warte zrobienia, zanim dojdzie kolejna funkcja do wtyczki lub Androida, bo każda następna dopisze się do tych dwóch plików.
