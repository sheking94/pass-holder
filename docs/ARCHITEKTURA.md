# Architektura PassHolder

Mapa kodu po PR #18 (listopad 2026): które pliki za co odpowiadają i jak części systemu ze sobą rozmawiają.
Format danych, kryptografię i API opisuje [SPEC.md](SPEC.md); tu jest tylko „gdzie to jest w kodzie”.

## Całość

```
 Chrome (wtyczka, TypeScript)            Android (Kotlin)
 extension/  ──używa──► core/            android/app ──używa──► android/core
        │                 ▲                                         │
        │ HTTPS, JSON     │ ten sam kod                             │ HTTPS + przypięty certyfikat
        ▼                 │                                         ▼
 ┌──────────────────────────────── Raspberry Pi ────────────────────────────────┐
 │ server/ (Node.js, Fastify, SQLite)  – widzi tylko szyfrogramy i numery rewizji │
 └──────────────────────────────────────────────────────────────────────────────┘
```

- `core/` to implementacja referencyjna: szyfrowanie, generator, logika synchronizacji po obu stronach.
  Używają go serwer i wtyczka. `android/core` to ten sam algorytm przepisany na Kotlina; zgodność pilnują
  wektory testowe `core/test-vectors/v1.json` i test na prawdziwym serwerze (`RealServerTest`).
- Klienci działają offline: sejf jest zaszyfrowany na urządzeniu, serwer to tylko punkt wymiany.

Telefon jako host P2P (w trakcie, plan 3 z 4): aplikacja Android ma własny sejf i serwer HTTP na porcie 8787
(`android/core/.../core/p2p/`: `SyncHttpServer`, `PhoneRouter`, `PairingHost`, `PhoneVaultStore`), a wtyczka ma
synchronizować się z nim bezpośrednio, bez Pi. Raspberry Pi i kod v1 są w trakcie wycofywania (plan 4); opis
telefonu w [P2P_TELEFON.md](P2P_TELEFON.md), projekt całości w [SYNCHRONIZACJA_P2P.md](SYNCHRONIZACJA_P2P.md). Tabele
poniżej opisują jeszcze stan z v1.

## `core/` (TypeScript, wspólny)

| Plik | Co robi |
|---|---|
| `src/encoding.ts` | UTF-8 z normalizacją NFC, Base64, hex |
| `src/kdf.ts` | Argon2id, HKDF (`encKey`, `authKey`), `authHash`, granice parametrów `MIN_KDF` / `MAX_KDF` |
| `src/cipher.ts` | AES-256-GCM w formacie `0x01 ‖ nonce ‖ szyfrogram ‖ tag` |
| `src/vault.ts` | zawijanie klucza sejfu, szyfrowanie wpisów i nagrobków, sprawdzanie ich kształtu |
| `src/sync.ts` | synchronizacja po stronie klienta: wysyłka `dirty`, konflikty, „ostatni zapis wygrywa” |
| `src/protocol.ts` | typy żądań `/sync` i `processSync`, czyli logika serwera niezależna od bazy |
| `src/generator.ts` | generator haseł (CSPRNG z odrzucaniem, Fisher-Yates) |
| `scripts/gen-vectors.ts` | generuje `test-vectors/v1.json` (`npm run gen-vectors -w core`) |

## `server/` (Raspberry Pi)

| Plik | Co robi |
|---|---|
| `src/main.ts` | start procesu: konfiguracja, baza, losowanie tokenu zakładania sejfu, nasłuch HTTPS |
| `src/config.ts` | zmienne `PASSHOLDER_*` (przykład: `deploy/passholder.env.example`) |
| `src/app.ts` | `buildApp`: trasy `/status`, `/setup`, `/prelogin`, `/session`, `/sync`, sesje w pamięci, limity logowania |
| `src/db.ts` | SQLite (wbudowany moduł `node:sqlite`): meta sejfu i rekordy, implementuje `SyncStore` z `core` |

`deploy/`: `make-certs.sh` (CA z `nameConstraints` i certyfikat serwera, uruchamiany na Ubuntu),
`passholder.service` (systemd), `passholder.env.example`, `vpn.sh` (Tailscale on/off).

## `extension/` (Chrome, Manifest V3)

Budowanie: `extension/build.mjs` (esbuild) skleja trzy punkty wejścia do `extension/dist/`:
`popup.ts` (strona `popup.html`), `background.ts` (service worker), `offscreen.ts` (czyszczenie schowka).

`popup.html` działa w dwóch miejscach: w okienku przy ikonie i w zwykłej karcie. Okienko zamyka się, gdy
traci fokus (okno zgody Chrome, wybór pliku), dlatego część widoków pokazuje się tylko w karcie. Tryb strony
odczytuje `page-mode.ts` z adresu: `popup`, `tab`, `setup`, `addresses`, `transfer`.

| Plik | Co robi |
|---|---|
| `src/popup.ts` | `start()`: wybiera pierwszy widok i włącza automatyczną blokadę strony |
| `src/vault-store.ts` | `VaultStore`: konto, lokalny sejf, odblokowanie, synchronizacja, import, adresy; serce wtyczki |
| `src/storage.ts` | klucze `chrome.storage` (`STORAGE_KEYS`), `chromeStore`, `memoryStore` do testów |
| `src/api.ts` | `ServerClient`: zapytania HTTP do serwera |
| `src/server-urls.ts` | wybór działającego adresu serwera (`pickServer`) |
| `src/auto-lock.ts` | blokada po 15 minutach: `watchIdle` na stronie i alarm w service workerze |
| `src/pin-lock.ts`, `src/pin-store.ts` | PIN: kryptografia (`createPinLock`, `openPinLock`) i przechowywanie z licznikiem prób (`PinStore`) |
| `src/csv-transfer.ts` | CSV w układzie NordPass: parser, eksport, podsumowanie importu |
| `src/clipboard.ts`, `src/background.ts`, `src/offscreen.ts` | czyszczenie schowka po minucie (alarm + dokument offscreen) |
| `src/page-mode.ts`, `src/open-in-tab.ts` | tryby strony, przycisk „Otwórz w karcie” |
| `src/ui/dom.ts` | pomocniki DOM: `h`, `show`, `form`, `passwordField`, `pinInput`, `confirmButton`, `busy` |
| `src/ui/page.ts` | `MODE`, `IN_TAB`, `showInTab(tryb, widok)`, `openInTabButton` |
| `src/ui/server-url-fields.ts` | dwa pola adresu serwera i prośba o zgodę Chrome (`requestHostPermission`) |
| `src/ui/state.ts` | jeden `VaultStore` strony, wspólny dla widoków |
| `src/views/*.ts` | ekrany: `connect`, `locked`, `list`, `edit`, `addresses`, `pin-settings`, `transfer` |

## `android/`

Dwa moduły Gradle: `core` (czysta JVM, testy bez emulatora) i `app` (Jetpack Compose).

| Plik (`android/core/.../core/`) | Co robi |
|---|---|
| `Encoding.kt`, `Kdf.kt`, `Cipher.kt`, `Vault.kt`, `Generator.kt` | odpowiedniki plików z `core/src/` |
| `Sync.kt`, `Protocol.kt` | synchronizacja po stronie klienta, typy protokołu |
| `ServerClient.kt` | klient HTTP (OkHttp) |
| `CertificatePin.kt` | przypięcie odcisku SHA-256 certyfikatu serwera |
| `ServerPicker.kt` | wybór działającego adresu (`pick`, `firstThatAnswers`) |
| `VaultStore.kt` | konto, lokalny sejf w plikach, odblokowanie (hasłem albo kluczami z odcisku), sync |

| Plik (`android/app/.../app/`) | Co robi |
|---|---|
| `PassHolderApp.kt` | obiekt procesu: jeden `VaultStore`, `LeaveLock`, ustawienia, odcisk |
| `MainActivity.kt` | `onStart` / `onStop` → powrót i wyjście z aplikacji, aktywność użytkownika, blokada zrzutów ekranu |
| `AppViewModel.kt` | stan ekranów (`UiState`) i operacje na sejfie w tle (`launchVaultOperation`) |
| `LockController.kt` | kiedy sejf się blokuje (wyjście z aplikacji, 15 minut, „Zablokuj”) i kiedy samo otwiera się okno odcisku |
| `LeaveLock.kt` | minutnik blokady 60 s po wyjściu z aplikacji |
| `BiometricController.kt`, `BiometricUnlock.kt` | odcisk palca: klucz w Android Keystore, zapisane klucze sejfu |
| `SecureClipboard.kt` | kopiowanie i czyszczenie schowka po minucie (WorkManager) |
| `ui/*.kt` | ekrany Compose: `ConnectScreen`, `LockedScreen`, `ListScreen`, `EditScreen`, `AddressesScreen`, `FingerprintDialog`, `PassHolderUi` (wybór ekranu) |

## Przepływ synchronizacji (oba klienty)

```
[Synchronizuj]
  → VaultStore.sync()
      wybierz adres (pickServer / ServerPicker.pick)
      token ważny? nie → POST /session (authKey) → token
      POST /sync { sinceRevision, changes = wpisy dirty }
         401? → zaloguj ponownie raz i powtórz (restart Pi kasuje sesje)
      odszyfruj i sprawdź wszystkie rekordy z odpowiedzi, zanim cokolwiek zmienisz
      rozstrzygnij konflikty po modifiedAt, zapisz sejf, lastSyncRevision = currentRevision
      lokalny wpis wygrał? → kolejna runda (maks. 3)
```

## Dokumentacja

| Dokument | Treść |
|---|---|
| [INSTALACJA.md](INSTALACJA.md) | instalacja krok po kroku: Pi, Chrome, Android, aktualizacje, kopie |
| [DEZINSTALACJA.md](DEZINSTALACJA.md) | całkowite usunięcie serwera z Raspberry Pi i sprzątanie na Ubuntu i telefonie |
| [SPEC.md](SPEC.md) | kryptografia, format danych, protokół, API |
| [TESTY.md](TESTY.md) | co testujemy i jak uruchomić testy |
| [WTYCZKA_ZAKLADANIE_SEJFU.md](WTYCZKA_ZAKLADANIE_SEJFU.md) | formularz połączenia w karcie (PR #8) |
| [WTYCZKA_OTWIERANIE_W_KARCIE.md](WTYCZKA_OTWIERANIE_W_KARCIE.md) | przycisk „Otwórz w karcie” (PR #9) |
| [WTYCZKA_IMPORT_EKSPORT_CSV.md](WTYCZKA_IMPORT_EKSPORT_CSV.md) | import i eksport CSV (PR #10) |
| [WTYCZKA_PIN.md](WTYCZKA_PIN.md) | PIN we wtyczce (PR #11) |
| [WIELE_ADRESOW_SERWERA.md](WIELE_ADRESOW_SERWERA.md) | kilka adresów serwera (PR #12) |
| [P2P_TELEFON.md](P2P_TELEFON.md) | telefon jako host synchronizacji P2P (plan 3a) |
| [ANDROID_ODCISK_PALCA.md](ANDROID_ODCISK_PALCA.md) | odcisk palca i blokada po wyjściu z aplikacji (PR #13, #14) |
| [PRZEGLAD_CZYSTOSCI_KODU.md](PRZEGLAD_CZYSTOSCI_KODU.md) | przegląd czystości kodu nr 1 (część punktów otwarta) |
| [PRZEGLAD_BEZPIECZENSTWA.md](PRZEGLAD_BEZPIECZENSTWA.md), [POPRAWKI_BEZPIECZENSTWA.md](POPRAWKI_BEZPIECZENSTWA.md) | przegląd bezpieczeństwa i poprawki S1–S4, N3 (punkty N1, N2, N4–N7, I1–I5 otwarte) |
| [ZMIANY_DOKUMENTACJI_2026-11-02.md](ZMIANY_DOKUMENTACJI_2026-11-02.md) | co zmieniła aktualizacja dokumentacji i czyszczenie |

## Stare nazwy

Przy PR #16 (poprawki z przeglądu czystości kodu nr 2) część plików i funkcji zmieniła nazwy. W historii
gita i w starszych PR-ach spotkasz jeszcze te z lewej kolumny.

| Było | Jest |
|---|---|
| widoki w `extension/src/popup.ts` (695 linii) | `extension/src/views/*.ts` i `extension/src/ui/*.ts` |
| `IN_TAB`, `TRANSFER_TAB`, `isTabPage`, `TAB_PARAM`, `SETUP_PARAM` | `pageMode`, `isInTab`, `isMainTab`, `modeQuery` (`page-mode.ts`); `IN_TAB` w `ui/page.ts` |
| `openSetupTab`, `openAddressesTab`, `openTransferTab` | `showInTab("setup" \| "addresses" \| "transfer", widok)` |
| `VaultStore.findPinLock`, `resetPinAttempts` | `PinStore.find` (prywatna), `PinStore.resetAttempts` |
| `ImportedEntry` (`csv-transfer.ts`) | `EntryFields` (`vault-store.ts`) |
| `AppViewModel.lockOnLeave` | `AppViewModel.onLeftApp` → `LockController.onLeftApp` |
| `AppViewModel.fingerprintRequests` | `timesLeftApp` |
| `fingerprintOnLockedScreen`, `lockWhenDone` | `LockController.offerFingerprint`, `lockWaitsForOperation` |
| `AppViewModel.enableBiometric(activity)` | `cipherToEnableBiometric` + `onBiometricEnableAuthorized` |
| `AppViewModel.unlockWithBiometric(activity)` | `cipherToUnlockBiometric` + `onBiometricUnlockAuthorized` |
| `AppViewModel.firstCertificate` | `ServerPicker.firstThatAnswers` |
| `Account.serverUrl` (wersja 1.0) | `serverUrls` + `lastServerUrl`; stary zapis czyta `StoredAccount` |
