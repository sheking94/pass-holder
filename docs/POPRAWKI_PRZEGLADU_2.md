# Poprawki z przeglądu czystości kodu nr 2

Data: 2026-11-01 · Podstawa: `main@cdef88a` · Przegląd: `docs/PRZEGLAD_CZYSTOSCI_KODU_2.md` (PR #15)

Ten dokument opisuje, co zmieniło się w kodzie po przeglądzie: wszystkie 20 punktów (grupy A–D).
Zasada: refaktor bez zmiany zachowania. Jedyna świadoma zmiana zachowania to naprawa pkt 9
(karta CSV bez konta) i jej skutek uboczny opisany w sekcji B.

## Co wiem na pewno, a co zakładam

**Sprawdzone:**

- Testy przed zmianami (na `cdef88a`): wtyczka 41/41, Android `:core:test` 53 (1 pominięty) i `:app:testDebugUnitTest` 17, wszystkie zielone.
- Testy po zmianach: wtyczka 45/45 (4 nowe), `tsc` bez błędów, `npm run build` działa; Android 54 + 17 zielonych, a `RealServerTest` z `PASSHOLDER_SERVER_TEST=1` (telefon i wtyczka na prawdziwym serwerze) też przechodzi.
- Wtyczka w prawdziwym Chromium (Playwright, bez okna, serwer na `127.0.0.1:8787`): ten sam skrypt
  z 27 krokami puściłem na starej i nowej wersji. Wyniki są identyczne poza krokami pkt 9, które na starej
  wersji nie przechodzą, a na nowej przechodzą (szczegóły w sekcji „Testy”).

**Nie sprawdzone:**

- Nowej wersji Androida nie uruchamiałem na prawdziwym telefonie, tylko w Robolectric (jak poprzednie kroki).
  Okno odcisku palca w testach jest atrapą (`FakeFingerprintPrompt`).
- Okna zgody Chrome na dostęp do serwera nie da się kliknąć w trybie bez okna: w teście wtyczka miała
  na stałe `host_permissions` dla `127.0.0.1` (tylko kopia testowa).

## Wtyczka Chrome

### Nowy układ plików (pkt 1)

`popup.ts` miał 695 linii; teraz ma 19 i tylko uruchamia właściwy widok.

| Plik | Co robi |
|---|---|
| `src/popup.ts` | `start()`: wybiera pierwszy widok (połączenie, adresy, lista/CSV, blokada) |
| `src/page-mode.ts` | tryb strony: `popup`, `tab`, `setup`, `addresses`, `transfer` (pkt 3), bez DOM, z testami |
| `src/ui/dom.ts` | pomocniki DOM: `h`, `show`, `statusLine`, `setStatus`, `busy`, `form`, `passwordField`, `pinInput`, `confirmButton` |
| `src/ui/page.ts` | `MODE`, `IN_TAB`, `showInTab(mode, view)` (pkt 4), przycisk „Otwórz w karcie” |
| `src/ui/server-url-fields.ts` | dwa pola adresu serwera i `requestHostPermission` (okno zgody Chrome) |
| `src/ui/state.ts` | jeden `VaultStore` strony, wspólny dla widoków |
| `src/views/connect.ts` | „Połącz z serwerem” (Mam już sejf / Nowy sejf) |
| `src/views/addresses.ts` | adresy serwera |
| `src/views/locked.ts` | ekran PIN-u i hasła głównego, `showUnlocked()` (lista albo CSV) |
| `src/views/list.ts` | lista wpisów, kopiowanie loginu i hasła |
| `src/views/edit.ts` | edycja wpisu i generator |
| `src/views/pin-settings.ts` | `pinEnabledView` i `pinSetupView` (pkt 5) |
| `src/views/transfer.ts` | `exportSection`, `importSection` (pkt 5) |
| `src/storage.ts` | `STORAGE_KEYS`, `KeyValueStore`, `chromeStore`, `memoryStore` (wydzielone z `vault-store.ts`) |
| `src/pin-store.ts` | `PinStore`: gdzie leży PinLock i jak liczyć próby (pkt 12) |

Widoki importują się nawzajem (lista → edycja → lista). To cykl importów, ale bezpieczny: moduły
eksportują tylko funkcje, które wołają się dopiero po kliknięciu, a esbuild skleja wszystko w jeden `popup.js`.

`vault-store.ts` dalej eksportuje `STORAGE_KEYS`, `memoryStore`, `chromeStore` i typ `PinStatus`, więc testy
i inne pliki nie musiały zmieniać importów.

### B. Tryby karty (pkt 3, 4, 9)

**Było:** `IN_TAB` (karta `?tab`, `?setup` albo `?addresses`), osobno `TRANSFER_TAB` (`?transfer`), gołe
stringi `"addresses"` i `"transfer"` w sześciu miejscach i trzy prawie identyczne funkcje
`openSetupTab`, `openAddressesTab`, `openTransferTab`.

**Jest:** jeden typ i kilka małych funkcji w `page-mode.ts`:

```ts
type PageMode = "popup" | "tab" | "setup" | "addresses" | "transfer";
pageMode(location.search)  // który to tryb
isInTab(mode)              // każda karta, także CSV
isMainTab(mode)            // karta z całą wtyczką: "tab" albo "setup"
```

i jedna funkcja w `ui/page.ts`:

```ts
showInTab("transfer", transferView)  // w karcie: pokaż tutaj; w popupie: otwórz kartę ?transfer i zamknij popup
```

**Pkt 9 (naprawiony błąd):** karta CSV nie liczyła się jako karta, więc po odłączeniu przeglądarki
i odświeżeniu karty `?transfer` wtyczka otwierała kolejną kartę z formularzem i zamykała bieżącą.
Teraz formularz połączenia pokazuje się w tej samej karcie. Potwierdzone w Playwright: stara wersja
w tym kroku nie pokazuje formularza, nowa pokazuje i nie otwiera nowej karty.

**Skutek uboczny (świadomy):** w karcie CSV po „Wróć do listy” przycisk **Adresy serwera** pokazuje teraz
formularz w tej samej karcie, tak jak w karcie „Otwórz w karcie”. Wcześniej otwierał osobną kartę
`?addresses` i zamykał kartę CSV. Okno zgody Chrome nie zamyka karty, więc formularz działa w obu miejscach.

**Bez zmian:** „Otwórz w karcie” dalej przełącza tylko na kartę `?tab` albo `?setup`, a nie na kartę
CSV czy adresów (pokazują one jeden formularz). Dopisałem na to test.

### A. Drobne poprawki we wtyczce (pkt 8, 10, 11, 13, 20)

- **Pkt 8, `api.ts`:** `request(method, path, { body, token, timeoutMs })` zamiast pięciu parametrów
  pozycyjnych. Wywołanie statusu to teraz `{ timeoutMs }` zamiast `undefined, undefined, timeoutMs`.
- **Pkt 10, komunikaty:** `INVALID_PIN` jest w `pin-lock.ts` (jedna kopia zamiast czterech),
  `NOT_CONNECTED` w `vault-store.ts` (zamiast trzech), komunikat o braku zgody Chrome w
  `ui/server-url-fields.ts` (zamiast dwóch).
  Kształt PIN-u jest dalej sprawdzany w dwóch miejscach jednej ścieżki i to celowe: `PinStore.unlock`
  sprawdza go **przed** liczeniem próby (test „does not count input that is not 4-6 digits” tego wymaga),
  a `openPinLock` broni się sam, bo jest funkcją publiczną. To samo w `VaultStore.enablePin`: kształt PIN-u
  jest sprawdzany przed „czy sejf jest odblokowany”, bo test oczekuje komunikatu o złym PIN-ie.
- **Pkt 11, zależność od CSV:** typ `EntryFields` (nazwa, login, hasło) i porównanie `sameEntry` są teraz
  w `vault-store.ts`. `csv-transfer.ts` importuje z niego tylko typy. Typ `ImportedEntry` zniknął.
- **Pkt 13, jeden adres:** `createVault` i `connectExisting` przyjmują tylko listę adresów. Testy
  (i `android/core/src/test/resources/interop.ts`) podają `[url]`.
- **Pkt 20, eksport CSV:** zamiast `switch` w `map` jest mapa `{ name, username, password, type }` i
  `NORDPASS_COLUMNS.map(c => values[c] ?? "")`.

### C. PinStore i widoki (pkt 5, 12)

- **Pkt 12:** `PinStore(local, session)` ma `status`, `enable`, `disable`, `unlock` i `resetAttempts`.
  `VaultStore` tworzy go w konstruktorze i tylko deleguje, np.:

  ```ts
  async unlockWithPin(pin) {
    if (!(await this.getAccount())) throw new Error(NOT_CONNECTED);
    const keys = await this.pin.unlock(pin);       // liczenie prób, kasowanie po 5 błędach
    await this.startSession(keys.vaultKey, keys.authKey, await this.loadVault(keys.vaultKey));
  }
  ```

  Przegląd proponował przekazywać `PinStore` w konstruktorze `VaultStore`. Nie zrobiłem tego, bo
  `PinStore` potrzebuje tych samych dwóch magazynów co `VaultStore`, a dodatkowy parametr zmieniłby
  wszystkie `new VaultStore(...)` w testach bez zysku. `vault-store.ts` ma teraz 368 linii zamiast 446.
- **Pkt 5:** `pinSettingsView` wybiera `pinEnabledView(status)` albo `pinSetupView()`. `transferView`
  składa `exportSection` i `importSection`; tekst po imporcie liczy czysta funkcja
  `importSummary(parsed, result)` w `csv-transfer.ts`, z dwoma nowymi testami.
- Przycisk „Na pewno? Kliknij ponownie” był napisany dwa razy (Odłącz, Usuń); teraz to `confirmButton`.

## Android

### D. Blokada i odcisk palca (pkt 2, 6, 7, 14, 17, 18)

`AppViewModel.kt` ma 313 linii zamiast 400.

Jeden test (`LockDelayLateTimerTest`) złapał błąd w mojej pierwszej wersji: `LockController` zapamiętywał `LeaveLock` przy tworzeniu, a ten należy do procesu (`PassHolderApp`) i może zostać podmieniony. Teraz kontroler czyta go przy każdym użyciu, jak wcześniej ViewModel. Logika blokady i odcisku jest w dwóch nowych klasach.

**`LockController.kt` (pkt 2):** odpowiada na dwa pytania: kiedy sejf się blokuje i kiedy ekran blokady
sam otwiera okno odcisku. Metody: `onLeftApp`, `onReturn`, `checkIdle` (15 minut), `onLockedByUser`
(„Zablokuj”), `takeFingerprintOffer`, `onOperationFinished`, `onCleared`. ViewModel przekazuje mu
lambdy (`isBusy`, `currentScreen`, `showLocked`), więc kontroler nie zna `UiState`.

Przegląd proponował jeden `enum`/`sealed` stan zamiast trzech flag. Tu się nie zgadzam: to są dwa
niezależne fakty („blokada czeka na koniec operacji” i „następny ekran blokady otworzy okno odcisku”)
plus licznik wyjść z aplikacji dla `LaunchedEffect`. Każda kombinacja jest możliwa, więc jeden enum
miałby cztery stany o sztucznych nazwach. Zostawiłem dwa pola z opisem i licznik, ale wszystkie są w jednej
klasie i zmieniają się tylko w jej metodach, więc żeby zrozumieć okno odcisku, wystarczy przeczytać ten plik.

**`BiometricController.kt` (pkt 6):** `enabled` (StateFlow), `cipherToEnable`, `enable`, `cipherToUnlock`,
`unlock`, `disable`. Komunikaty błędów są przygotowane tu, ViewModel tylko je pokazuje.
`ByteArray.useAndWipe { }` zeruje klucze także przy wyjątku (zastępuje dwa `try … finally { keys.fill(0) }`).

**Okno odcisku w ekranie (pkt 7):** ViewModel nie przyjmuje już `FragmentActivity`. Okno pokazuje
`ui/FingerprintDialog.kt`, a ViewModel ma dwie pary metod bez klas UI:

```kotlin
fingerprint.show("Odblokuj PassHolder", vm::cipherToUnlockBiometric, vm::onBiometricUnlockAuthorized)
fingerprint.show("Włącz odblokowanie odciskiem palca", vm::cipherToEnableBiometric, vm::onBiometricEnableAuthorized)
```

`cipherTo…` zwraca szyfr albo `null` (trwa operacja albo błąd już jest na pasku stanu), `on…Authorized`
dostaje szyfr odblokowany palcem i robi resztę w tle.

**Pkt 14:** `ServerPicker.firstThatAnswers(urls, onAllFailed) { url -> … }` to wspólna pętla „próbuj adresy
po kolei”. Używają jej `ServerPicker.pick` (przy błędach woli błąd przypiętego certyfikatu) i parowanie
w `inspectServer` (pokazuje błąd ostatniego adresu, jak wcześniej `firstCertificate`). Nowy test w `ServerPickerTest`.

**Pkt 17, nazwy:** `lockOnLeave()` → `onLeftApp()` (para z `onReturn()`), `fingerprintRequests` →
`timesLeftApp`, `fingerprintOnLockedScreen` → `offerFingerprint`, `lockWhenDone` → `lockWaitsForOperation`.

**Pkt 18:** `Screen.showsVault` (true dla listy, adresów i edycji). Używają go `LockController` (ekran
z wpisami po blokadzie w tle) i auto-blokada (wcześniej `screen == Connect || screen == Locked`).

### A. Drobne poprawki w Androidzie (pkt 10, 13, 15, 16, 19)

- **Pkt 10:** `VaultStore.requireAccount()` zamiast czterech `account() ?: throw IllegalStateException("Brak konta")`.
- **Pkt 13:** usunięte przeciążenia `createVault(serverUrl: String, …)` i `connectExisting(serverUrl: String, …)`;
  testy podają `listOf(url)`.
- **Pkt 15:** `Account` nie ma już pola `serverUrl`. Stary format czyta prywatna klasa `StoredAccount`
  z `toAccount()`, jak `StoredAccount`/`upgradeAccount` we wtyczce. Test odczytu konta z wersji 1.0 przechodzi.
- **Pkt 16, `BiometricUnlock.cipherToUnlock`:** nie rzuca i nie łapie własnego wyjątku w jednym `try`:
  ```kotlin
  val cipher = try { keys.decryptCipher(iv) } catch (e: KeyPermanentlyInvalidatedException) { null }
  return cipher ?: run { disable(); throw BiometricKeyLostException() }
  ```
- **Pkt 19:** `BiometricKeyLostException.MESSAGE` jako stała; ViewModel nie używa już `e.message!!`.

## Testy

| Co | Przed | Po |
|---|---|---|
| Wtyczka `npm test` | 41 | 45 (nowe: `pageMode`, karta CSV/adresów w `openInTab`, 2× `importSummary`) |
| Wtyczka `tsc --noEmit`, `npm run build` | OK | OK |
| Android `:core:test` | 53 (1 pominięty: `RealServerTest`) | 54 (nowy: `firstThatAnswers`); `RealServerTest` osobno z `PASSHOLDER_SERVER_TEST=1`: OK |
| Android `:app:testDebugUnitTest` (Robolectric) | 17 | 17 |
| Playwright, 27 kroków | 24 OK | 26 OK |

Kroki Playwright, które nie przeszły:

- „PIN: zły kształt” – na **obu** wersjach. To nie błąd: pole PIN ma `pattern="[0-9]{4,6}"`, więc Chrome
  sam blokuje wysłanie formularza z PIN-em „12” i pokazuje swój dymek, zanim kod wtyczki zobaczy wartość.
- „Odłącz w karcie: formularz od razu” i „pkt 9: ?transfer bez konta pokazuje formularz” – tylko na
  **starej** wersji. To właśnie błąd z pkt 9.

## Jak sprawdzić u siebie

```sh
git pull
npm test -w extension && npm run build -w extension
cd android && ./gradlew :core:test :app:testDebugUnitTest
```

W `chrome://extensions` odśwież PassHolder. Warto kliknąć ręcznie: Otwórz w karcie → CSV → Wróć do listy →
Adresy serwera (formularz w tej samej karcie) i odblokowanie PIN-em. Na telefonie: włączenie odcisku na liście,
Zablokuj → Odblokuj odciskiem palca, wyjście z aplikacji i powrót.

## Stare dokumenty

Opisy kroków (`WTYCZKA_ZAKLADANIE_SEJFU.md`, `WTYCZKA_OTWIERANIE_W_KARCIE.md`, `WTYCZKA_PIN.md`,
`WIELE_ADRESOW_SERWERA.md`, `ANDROID_ODCISK_PALCA.md`) zostawiłem jako zapis tego, jak kod wyglądał po danym
kroku; na górze każdego jest odsyłacz tutaj. Stare nazwy → nowe:

| Było | Jest |
|---|---|
| `IN_TAB`, `TRANSFER_TAB`, `isTabPage`, `TAB_PARAM`, `SETUP_PARAM` | `pageMode`, `isInTab`, `isMainTab`, `modeQuery` (`page-mode.ts`) |
| `openSetupTab`, `openAddressesTab`, `openTransferTab` | `showInTab("setup" \| "addresses" \| "transfer", widok)` |
| `VaultStore.findPinLock`, `resetPinAttempts` | `PinStore.find` (prywatna), `PinStore.resetAttempts` |
| `ImportedEntry` (`csv-transfer.ts`) | `EntryFields` (`vault-store.ts`) |
| `AppViewModel.lockOnLeave` | `AppViewModel.onLeftApp` → `LockController.onLeftApp` |
| `AppViewModel.fingerprintRequests` | `AppViewModel.timesLeftApp` |
| `AppViewModel.enableBiometric(activity)` | `cipherToEnableBiometric` + `onBiometricEnableAuthorized` |
| `AppViewModel.unlockWithBiometric(activity)` | `cipherToUnlockBiometric` + `onBiometricUnlockAuthorized` |
| `AppViewModel.firstCertificate` | `ServerPicker.firstThatAnswers` |
