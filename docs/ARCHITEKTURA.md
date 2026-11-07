# Architektura PassHolder

Mapa kodu: które pliki za co odpowiadają i jak części systemu ze sobą rozmawiają. Kryptografię i format
danych opisuje [SPEC.md](SPEC.md), protokół [SYNCHRONIZACJA.md](SYNCHRONIZACJA.md), funkcje urządzeń
[FUNKCJE.md](FUNKCJE.md); tu jest tylko „gdzie to jest w kodzie”.

## Całość

```
 Chrome: wtyczka (TypeScript)                     Android: aplikacja (Kotlin)
 extension/ ──używa──► core/                      android/app ──używa──► android/core
 pełna zaszyfrowana kopia sejfu                   sejf (kotwica), tryb „Synchronizacja”
        │                                                      ▲
        │  POST http://<IPv4 telefonu>:8787/p2p/v1/...          │ SyncHttpServer (tylko w trybie
        │  parowanie: CPace z 8-cyfrowym kodem                  │ Synchronizacja)
        │  synchronizacja: Noise KK, w środku zaszyfrowane wpisy│
        └───────────────────── LAN albo Tailscale ─────────────┘
```

- `core/` to implementacja referencyjna w TypeScripcie: szyfrowanie, generator, parowanie, Noise,
  synchronizacja po stronie wtyczki i referencyjny host (`P2pHost`). `android/core` to strona telefonu w
  Kotlinie (te same algorytmy); zgodność pilnują wektory w `core/test-vectors/` i testy współpracy
  (`P2pInteropTest`, `PhoneInteropTest`).
- Telefon jest **hostem**: trzyma rekordy z numerami `revision` i przyjmuje zmiany wtyczek. Jest też
  klientem własnego sejfu (zmiany z telefonu idą prosto do tej samej bazy).
- Wtyczka działa offline na swojej kopii i synchronizuje się tylko z telefonem.

## `core/` (TypeScript, wspólny)

| Plik | Co robi |
|---|---|
| `src/encoding.ts` | UTF-8 z normalizacją NFC, Base64, hex, `randomBytes` |
| `src/kdf.ts` | Argon2id, HKDF (`encKey`; `authKey` liczony, ale nieużywany, bo podział klucza to część formatu), granice `MIN_KDF` / `MAX_KDF` |
| `src/cipher.ts` | AES-256-GCM w formacie `0x01 ‖ nonce ‖ szyfrogram ‖ tag` (`seal`, `open`) |
| `src/vault.ts` | klucz sejfu: `newVaultKey`, `wrapVaultKey`, `unwrapVaultKey` |
| `src/protocol.ts` | `RemoteRecord`, `SyncStore`, `processSync`, `MemorySyncStore`: logika hosta (numery `revision`, `baseRevision`) |
| `src/generator.ts` | generator haseł (CSPRNG z odrzucaniem, Fisher-Yates) |
| `src/p2p/hlc.ts` | hybrydowy zegar logiczny (HLC) do rozstrzygania konfliktów |
| `src/p2p/entry.ts` | treść wpisu v2 i nagrobka, AAD `passholder/v2/entry/<id>` |
| `src/p2p/sync.ts` | sejf wtyczki (`LocalVaultV2`) i `syncVaultV2` |
| `src/p2p/host-sync.ts` | strona hosta: `validateP2pSyncRequest`, `processP2pSync` (na `processSync`), epoka, stronicowanie |
| `src/p2p/cpace.ts`, `pairing.ts`, `pair-client.ts` | parowanie: CPace, kod 8 cyfr, zapieczętowane tożsamości, klient HTTP parowania wtyczki |
| `src/p2p/noise.ts`, `frames.ts`, `transport.ts` | Noise KK, ramki, `noiseTransport` i `callP2pHost` |
| `src/p2p/host.ts` | `P2pHost`: referencyjny host (uzgadnianie, sesje, sync) |
| `scripts/gen-vectors.ts`, `gen-vectors-v2.ts` | `test-vectors/v1.json` (KDF, klucz sejfu) i `v2.json` (P2P) |

## `extension/` (Chrome, Manifest V3)

Budowanie: `extension/build.mjs` (esbuild) kopiuje `static/` i skleja trzy punkty wejścia do `extension/dist/`:
`popup.ts` (strona `popup.html`), `background.ts` (service worker), `offscreen.ts` (czyszczenie schowka).

`popup.html` działa w okienku przy ikonie i w zwykłej karcie. Okienko zamyka się, gdy traci fokus (okno zgody
Chrome, wybór pliku), dlatego parowanie, adresy i CSV pokazują się w karcie. Tryb strony odczytuje
`page-mode.ts` z adresu: `popup`, `tab`, `setup`, `addresses`, `transfer`.

| Plik | Co robi |
|---|---|
| `src/popup.ts` | `start()`: wybiera pierwszy widok i włącza automatyczną blokadę strony |
| `src/vault-store.ts` | `VaultStore`: konto, lokalny sejf, parowanie (`pairStart`, `pairFinish`, `repair`), `sync`, adresy, PIN, CSV; serce wtyczki |
| `src/storage.ts` | klucze `chrome.storage` (`STORAGE_KEYS`), `chromeStore`, `memoryStore` do testów |
| `src/phone-client.ts` | `PhoneClient`: JSON `POST` do telefonu z limitem 30 s, polskie komunikaty błędów |
| `src/phone-urls.ts` | adresy telefonu: `normalizePhoneUrl` (tylko IPv4), `learnedPhoneUrls`, `pickPhone` (wybór działającego adresu, ping 4 s) |
| `src/auto-lock.ts` | blokada po 15 minutach: `watchIdle` na stronie i alarm w service workerze |
| `src/pin-lock.ts`, `src/pin-store.ts` | PIN: kryptografia (`createPinLock`, `openPinLock`) i przechowywanie z licznikiem prób |
| `src/csv-transfer.ts` | CSV w układzie NordPass: parser, eksport, podsumowanie importu |
| `src/clipboard.ts`, `src/background.ts`, `src/offscreen.ts` | czyszczenie schowka po minucie (alarm + dokument offscreen) |
| `src/page-mode.ts`, `src/open-in-tab.ts` | tryby strony, przycisk „Otwórz w karcie ↗” |
| `src/ui/dom.ts` | pomocniki DOM: `h`, `show`, `form`, `passwordField`, `pinInput`, `confirmButton`, `busy` |
| `src/ui/page.ts` | `MODE`, `IN_TAB`, `showInTab(tryb, widok)`, `openInTabButton` |
| `src/ui/phone-url-fields.ts` | pola adresów telefonu (`phoneUrlFields`), wzorzec zgody, prośby o zgodę Chrome |
| `src/ui/state.ts` | jeden `VaultStore` strony, wspólny dla widoków |
| `src/views/*.ts` | ekrany: `connect` (parowanie), `locked`, `list`, `edit`, `addresses`, `pin-settings`, `transfer` |

## `android/`

Dwa moduły Gradle: `core` (czysta JVM, testy bez emulatora) i `app` (Jetpack Compose).

| Plik (`android/core/.../core/`) | Co robi |
|---|---|
| `Encoding.kt`, `Kdf.kt`, `Cipher.kt`, `Vault.kt`, `Generator.kt` | odpowiedniki plików z `core/src/` (`Vault.kt`: `Credentials`, `VaultCrypto` do klucza sejfu) |
| `Protocol.kt` | `RemoteRecord`, `ChangeRequest`, `Accepted`, `SyncResponse` |
| `p2p/Hlc.kt`, `EntryV2.kt`, `P2pJson.kt` | HLC, wpisy v2, wspólny `Json` |
| `p2p/Ristretto255.kt`, `Cpace.kt`, `Pairing.kt`, `PairingHost.kt` | parowanie: grupa, CPace, kod i zapieczętowane wiadomości, strona telefonu po HTTP |
| `p2p/Noise.kt`, `Frames.kt`, `P2pHost.kt`, `HostSync.kt` | Noise KK, ramki, host synchronizacji, `processSync` i `MemorySyncStore` |
| `p2p/SyncHttpServer.kt`, `PhoneRouter.kt`, `LocalAddresses.kt` | serwer HTTP na porcie 8787 z limitami, trasy `/p2p/v1/*`, adresy telefonu |
| `p2p/PhoneVaultStore.kt`, `PhoneVault.kt`, `FileSyncStore.kt`, `HostState.kt` | sejf telefonu: tworzenie, odtwarzanie, blokada (15 min), wpisy, urządzenia; pliki `records.jsonl` i `host.json` |

| Plik (`android/app/.../app/`) | Co robi |
|---|---|
| `PassHolderApp.kt` | obiekt procesu: jeden `PhoneVaultStore`, `LeaveLock`, ustawienia, odcisk |
| `MainActivity.kt` | `onStart` / `onStop` (powrót i wyjście z aplikacji), ekran nie gaśnie w trybie Synchronizacja, blokada zrzutów ekranu |
| `AppViewModel.kt` | stan ekranów (`UiState`) i operacje na sejfie w tle (`launchVaultOperation`) |
| `SyncController.kt` | tryb Synchronizacja: start i stop serwera, kod parowania, zdarzenia, zatrzymanie po 5 min bez połączeń |
| `KeystoreSecretWrapper.kt` | zawija klucz tożsamości telefonu kluczem z Android Keystore |
| `LockController.kt` | kiedy sejf się blokuje (wyjście z aplikacji, 15 minut, „Zablokuj”) i kiedy samo otwiera się okno odcisku |
| `LeaveLock.kt` | minutnik blokady 60 s po wyjściu z aplikacji |
| `BiometricController.kt`, `BiometricUnlock.kt` | odcisk palca: klucz w Android Keystore, zapisany klucz sejfu |
| `SecureClipboard.kt` | kopiowanie i czyszczenie schowka po minucie (WorkManager) |
| `ui/*.kt` | ekrany Compose: `StartScreen`, `LockedScreen`, `ListScreen`, `EditScreen`, `SyncScreen`, `DevicesScreen`, `RestoreScreen`, `FingerprintDialog`, `Common`, `PassHolderUi` (wybór ekranu) |

## Przepływ synchronizacji

```
Telefon: [Synchronizacja] → SyncController.start → SyncHttpServer :8787 (PhoneRouter)
Wtyczka: [Synchronizuj]
  → VaultStore.sync()
      adresy z zgodą Chrome → pickPhone (najpierw lastPhoneUrl, ping 4 s)
      noiseTransport: POST /p2p/v1/handshake (Noise KK, klucze z parowania)
                      POST /p2p/v1/sync { epoch, sinceRevision, changes = wpisy dirty } w ramkach Noise
  → telefon: P2pHost → HostSync.process (epoka, processSync, stronicowanie po 500) → FileSyncStore
  ← accepted, conflicts, changes, addresses, more
      odszyfruj i sprawdź rekordy, konflikty po HLC, zapisz sejf, dopisz nowe adresy
      more albo lokalny wpis wygrał → kolejna runda
```

Parowanie (`/p2p/v1/pair/hello`, `start`, `finish`) i odtwarzanie z wtyczki:
[SYNCHRONIZACJA.md](SYNCHRONIZACJA.md) punkty 3 i 8.
