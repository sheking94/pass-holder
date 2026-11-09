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
        │  POST http://<IPv4 telefonu>:8787/p2p/...             │ SyncHttpServer (tylko w trybie
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
| `src/p2p/entry.ts` | wpis v3 i nagrobek: typy, ścisły parser (`parseEntryData`, `parseTombstoneData`, `parseEntryContent` dla wpisu bez `v` i `hlc`), zwarta serializacja w stałej kolejności kluczy, limit `MAX_ENTRY_BLOB_LENGTH`, odczyt v2 jako login; AAD `passholder/v2/entry/<id>` |
| `src/p2p/sync.ts` | sejf wtyczki (`LocalVaultV2`) i `syncVaultV2`; budżet bajtów żądania, rundy ucięte (`more`) poza limitem rund konfliktów |
| `src/p2p/host-sync.ts` | strona hosta: `validateP2pSyncRequest` (też blob ≤ 64 KiB), `processP2pSync` (na `processSync`), epoka, stronicowanie po 500 zmianach i `MAX_BLOB_BYTES_PER_ROUND` (tnie też `conflicts`) |
| `src/p2p/cpace.ts`, `pairing.ts`, `pair-client.ts` | parowanie: CPace, kod 8 cyfr, zapieczętowane tożsamości, klient HTTP parowania wtyczki |
| `src/p2p/noise.ts`, `frames.ts`, `transport.ts` | Noise KK, ramki, `noiseTransport` i `callP2pHost`; ścieżki `/p2p/v2/*`, 404 → „Phone app needs an update” |
| `src/p2p/host.ts` | `P2pHost`: referencyjny host (uzgadnianie, sesje, sync); `/p2p/v1/handshake` i `/p2p/v1/sync` → 410 |
| `src/transfer/` | import i eksport plików, czyste funkcje (bez DOM i `chrome.*`): `common.ts` (`contentKey`, `sortForExport`), `csv.ts` (RFC 4180), `passholder-json.ts`, `bitwarden-json.ts`, `nordpass-csv.ts`, `detect.ts` (`parseImportFile`, `exportFile`); pliki przykładowe w `test-vectors/transfer/` |
| `scripts/gen-vectors.ts`, `gen-vectors-v2.ts`, `gen-vectors-v3.ts` | `test-vectors/v1.json` (KDF, klucz sejfu), `v2.json` (P2P) i `v3.json` (wpisy v3, limity) |

## `extension/` (Chrome, Manifest V3)

Budowanie: `extension/build.mjs` (esbuild) kopiuje `static/` i skleja trzy punkty wejścia do `extension/dist/`:
`popup.ts` (strona `popup.html`), `background.ts` (service worker), `offscreen.ts` (czyszczenie schowka).

`popup.html` działa w okienku przy ikonie i w zwykłej karcie. Okienko zamyka się, gdy traci fokus (okno zgody
Chrome, wybór pliku), dlatego parowanie, adresy i import/eksport pokazują się w karcie. Tryb strony odczytuje
`page-mode.ts` z adresu: `popup`, `tab`, `setup`, `addresses`, `transfer`.

| Plik | Co robi |
|---|---|
| `src/popup.ts` | `start()`: wybiera pierwszy widok i włącza automatyczną blokadę strony |
| `src/vault-store.ts` | `VaultStore`: konto, lokalny sejf, parowanie (`pairStart`, `pairFinish`, `repair`), `sync`, adresy, PIN, import; serce wtyczki. Wpisy każdego typu: `listEntries(typ)`, `getEntry`, `putEntry` (odmowa zapisu pod `id` innego typu); import przez `importContents` (wszystkie typy, jeden zapis), eksport przez `allContents`; starą treść v2 czyta jako login |
| `src/entry-types.ts` | typy wpisów w kolejności zakładek (`ENTRY_TYPES`, `TYPE_INFO`), rodzaje dokumentu, pusty wpis, opis wiersza (`entrySummary`), wyszukiwanie, sprzątanie przed zapisem (`tidyContent`) i sprawdzanie formatów (`validateContent`) |
| `src/storage.ts` | klucze `chrome.storage` (`STORAGE_KEYS`), `chromeStore`, `memoryStore` do testów |
| `src/phone-client.ts` | `PhoneClient`: JSON `POST` do telefonu z limitem 30 s, polskie komunikaty błędów (też „Zaktualizuj aplikację na telefonie”) |
| `src/phone-urls.ts` | adresy telefonu: `normalizePhoneUrl` (tylko IPv4), `learnedPhoneUrls`, `pickPhone` (wybór działającego adresu, ping 4 s) |
| `src/auto-lock.ts` | blokada po 15 minutach: `watchIdle` na stronie i alarm w service workerze |
| `src/pin-lock.ts`, `src/pin-store.ts` | PIN: kryptografia (`createPinLock`, `openPinLock`) i przechowywanie z licznikiem prób |
| `src/import-summary.ts`, `src/plural.ts` | polskie podsumowanie importu (dodano, duplikaty, pominięte) i odmiana „wpis/wpisy/wpisów” |
| `src/clipboard.ts`, `src/background.ts`, `src/offscreen.ts` | czyszczenie schowka po minucie (alarm + dokument offscreen) |
| `src/page-mode.ts`, `src/open-in-tab.ts` | tryby strony, przycisk „Otwórz w karcie ↗” |
| `src/ui/dom.ts` | pomocniki DOM: `h`, `show`, `form`, `passwordField`, `secretField` (pole wrażliwe: „Pokaż/Ukryj”, „Kopiuj”), `pinInput`, `confirmButton`, `busy` |
| `src/ui/copy.ts`, `src/ui/status.ts` | kopiowanie (`copyText`, `copySecret` z czyszczeniem schowka), linia statusu |
| `src/ui/list-editor.ts` | `listEditor`: lista z „+ Dodaj” i „Usuń” (adresy, aplikacje, telefony, własne pola) |
| `src/ui/page.ts` | `MODE`, `IN_TAB`, `showInTab(tryb, widok)`, `openInTabButton` |
| `src/ui/phone-url-fields.ts` | pola adresów telefonu (`phoneUrlFields`), wzorzec zgody, prośby o zgodę Chrome |
| `src/ui/state.ts` | jeden `VaultStore` strony, wspólny dla widoków |
| `src/views/*.ts` | ekrany: `connect` (parowanie), `locked`, `list` (zakładki typów), `edit` (formularz wpisu), `addresses`, `pin-settings`, `transfer` |
| `src/views/forms/*.ts` | części formularza: `login` (z `generator`), `contact`, `card`, `document`, `note`, `custom-fields` (własne pola) |
| `scripts/screenshots.mjs`, `test/screens/harness.ts` | zrzuty ekranów w Chromium z przykładowymi wpisami ([TESTY.md](TESTY.md#zrzuty-ekranów-wtyczki)) |

## `android/`

Dwa moduły Gradle: `core` (czysta JVM, testy bez emulatora) i `app` (Jetpack Compose).

| Plik (`android/core/.../core/`) | Co robi |
|---|---|
| `Encoding.kt`, `Kdf.kt`, `Cipher.kt`, `Vault.kt`, `Generator.kt` | odpowiedniki plików z `core/src/` (`Vault.kt`: `Credentials`, `VaultCrypto` do klucza sejfu) |
| `Protocol.kt` | `RemoteRecord`, `ChangeRequest`, `Accepted`, `SyncResponse` |
| `p2p/Hlc.kt`, `EntryV3.kt`, `P2pJson.kt` | HLC, wpis v3 (`EntryV3`: modele, ścisły parser, serializacja w kolejności z TypeScriptu, limit, odczyt v2 jako login), wspólny `Json` |
| `p2p/Ristretto255.kt`, `Cpace.kt`, `Pairing.kt`, `PairingHost.kt` | parowanie: grupa, CPace, kod i zapieczętowane wiadomości, strona telefonu po HTTP |
| `p2p/Noise.kt`, `Frames.kt`, `P2pHost.kt`, `HostSync.kt` | Noise KK, ramki, host synchronizacji (`/p2p/v2/*`, stare ścieżki → 410), `processSync`, budżet bajtów rundy i `MemorySyncStore` |
| `p2p/SyncHttpServer.kt`, `PhoneRouter.kt`, `LocalAddresses.kt` | serwer HTTP na porcie 8787 z limitami, trasy `/p2p/v1/pair/*`, `/p2p/v1/ping` i `/p2p/v2/*` (stare `/p2p/v1/handshake` i `/sync` przekazane do hosta, który odpowiada 410), adresy telefonu |
| `p2p/PhoneVaultStore.kt`, `PhoneVault.kt`, `FileSyncStore.kt`, `HostState.kt` | sejf telefonu: tworzenie, odtwarzanie, blokada (15 min), wpisy (`entries()` zwraca wszystkie typy, `upsert` zachowuje resztę pól i odmawia nadpisania wpisu innego typu), urządzenia; pliki `records.jsonl` i `host.json` |

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
| `InstalledApps.kt` | aplikacje z ikoną w launcherze (`PackageManager`; w manifeście `<queries>` MAIN + LAUNCHER, bez `QUERY_ALL_PACKAGES`) |
| `entries/EntryTypes.kt` | `EntryType`, opis wiersza, wyszukiwanie, `tidy`, walidacja (port `extension/src/entry-types.ts`) |
| `SecureClipboard.kt` | kopiowanie i czyszczenie schowka po minucie (WorkManager) |
| `ui/*.kt` | ekrany Compose: `StartScreen`, `LockedScreen`, `ListScreen` (dolny pasek zakładek), `EditScreen` (powłoka formularza), `SettingsScreen`, `VaultTopBar`, `SyncScreen`, `DevicesScreen`, `RestoreScreen`, `FingerprintDialog`, `Common` (m.in. `SecretField`), `PassHolderUi` (wybór ekranu) |
| `ui/forms/*.kt` | `LoginForm`, `ContactForm`, `CardForm`, `DocumentForm` (notatka używa samej powłoki), `ListEditor`, `CustomFieldsEditor`, `GeneratorCard`, `AppPickerDialog` |

## Przepływ synchronizacji

```
Telefon: [Synchronizacja] → SyncController.start → SyncHttpServer :8787 (PhoneRouter)
Wtyczka: [Synchronizuj]
  → VaultStore.sync()
      adresy z zgodą Chrome → pickPhone (najpierw lastPhoneUrl, ping 4 s)
      noiseTransport: POST /p2p/v2/handshake (Noise KK, klucze z parowania)
                      POST /p2p/v2/sync { epoch, sinceRevision, changes = wpisy dirty } w ramkach Noise
  → telefon: P2pHost → HostSync.process (epoka, blob ≤ 64 KiB, processSync,
             ucięcie: 500 zmian albo 512 KiB blobów) → FileSyncStore
  ← accepted, conflicts, changes, addresses, more
      odszyfruj i sprawdź rekordy (parseEntryData: v3 albo v2 jako login), konflikty po HLC,
      zapisz sejf, dopisz nowe adresy
      more albo lokalny wpis wygrał → kolejna runda
```

## Przepływ v2 → v3 (format wpisu)

```
odczyt:  blob → AES-GCM (AAD z id) → JSON → parseEntryData / EntryV3.parse
           {v:3, ...} ścisły typ  → wpis v3 (nieznany klucz = „Invalid entry payload”)
           {name, username, password, hlc} (bez v) → login, reszta pól pusta
           {hlc} + deleted=true → nagrobek (inny klucz = „Invalid tombstone payload”)
zapis:   zawsze v3: serializeEntryData / EntryV3.serialize (stała kolejność kluczy, zwarty JSON)
           długość bloba > 65536 → „Entry too large” (aplikacje: „Wpis jest za duży”)
```

Bloby na telefonie zostają v2, dopóki wpis nie zostanie edytowany. We wtyczce cały lokalny sejf jest przy
odblokowaniu w pamięci zamieniany na v3 i zapisywany jako v3 przy najbliższym zapisie dowolnego rodzaju; po
zmianie epoki (`adoptEpoch`) wpisy idą na telefon ponownie jako v3. Obie implementacje serializują
bajt w bajt tak samo (`core/test-vectors/v3.json`).

**Reguła ucinania rundy** (`processP2pSync` / `HostSync.process`, to samo wtyczka przy wysyłaniu): najpierw
`conflicts`, potem `changes` po rosnącej `revision`; rekord wchodzi, dopóki suma długości blobów mieści się w 524288
(pierwszy rekord zawsze wchodzi, więc runda zawsze coś niesie); limit 500 dotyczy tylko `changes`, a `changes`
dochodzą dopiero, gdy zmieściły się wszystkie konflikty. Gdy cokolwiek ucięto, `more = true`, a `currentRevision`
to rewizja ostatniego rekordu w `changes` (albo `sinceRevision` żądania, gdy żadnej zmiany nie dołączono). Konflikt, który się nie
zmieścił, zostawia wpis `dirty`, więc wtyczka wyśle go w następnej rundzie. Rundy z `more` nie liczą się do
limitu rund konfliktów (3), tylko do ogólnego (1000).

Parowanie (`/p2p/v1/pair/hello`, `start`, `finish`) i odtwarzanie z wtyczki:
[SYNCHRONIZACJA.md](SYNCHRONIZACJA.md) punkty 3 i 8.
