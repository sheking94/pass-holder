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
| `src/files/attachment.ts` | opis załącznika: stałe (`MAX_FILE_SIZE`, `FILE_CHUNK_SIZE`, limity 20/40), `parseAttachments`, `attachmentJson` (stała kolejność kluczy), `canAddAttachment`, wzorzec UUID v4 |
| `src/files/chunks.ts` | szyfrowanie pliku kawałkami: `encryptFile`, `decryptChunk`, `decryptFile` (rozmiar, `sha256`), AAD `passholder/v3/file/<id>/<i>/<n>` |
| `src/files/host-files.ts` | strona hosta `/p2p/v2/file`: `FileStore`, `MemoryFileStore`, `processP2pFile` (`status`/`put`/`get`, 400/404/409/507), `orphanFileIds` (24 h) |
| `src/files/client.ts` | klient: `LocalFileStore`, `syncFiles` (wysyłanie i pobieranie brakujących kawałków, `uploadedEpoch`), `noiseFileTransport`, `pruneLocalFiles` |
| `src/files/merge.ts` | `mergeAttachments`: łączenie list załączników przy konflikcie (używa `src/p2p/sync.ts`) |
| `src/transfer/` | import i eksport plików, czyste funkcje (bez DOM i `chrome.*`): `common.ts` (`contentKey`, `sortForExport`), `csv.ts` (RFC 4180), `passholder-json.ts`, `bitwarden-json.ts`, `nordpass-csv.ts`, `detect.ts` (`parseImportFile`, `exportFile`), `zip.ts` (CRC-32, zapis i odczyt ZIP, deflate przez `CompressionStream`, limity zip-bomb), `passholder-zip.ts` (`exportPassHolderZip`, `openPassHolderZip`: indeks + pliki, `ArchiveEntry.position`; `exportArchive` / `importArchive` to metody `VaultStore`); pliki przykładowe w `test-vectors/transfer/` |
| `src/autofill/` | autouzupełnianie, czyste funkcje (bez DOM i `chrome.*`, podścieżka `@passholder/core/autofill`): `match.ts` (`matchUrl`, `matchLogins`), `fields.ts` (`classifyField` po opisie pola), `keywords.ts` (słowa kluczowe PL/EN), `values.ts` (`planFor` → `FillPlan`, `fillValue`: karta, `<select>`, kontakt); wektory `test-vectors/autofill/{match,fields,values}.json` |
| `src/save/` | pytanie o zapis, czyste funkcje (podścieżka `@passholder/core/save`): `url.ts` (`saveUrl`: domena do zapisu, `saveName`), `decide.ts` (`decideSave` → `none`/`create`/`update`, `newLogin`, `withPassword`); wektory `test-vectors/save/{url,decide}.json` |
| `scripts/gen-vectors.ts`, `gen-vectors-v2.ts`, `gen-vectors-v3.ts`, `gen-vectors-files.ts` | `test-vectors/v1.json` (KDF, klucz sejfu), `v2.json` (P2P), `v3.json` (wpisy v3, limity) i `files/files.json` (załączniki, kawałki, host plików) |

## `extension/` (Chrome, Manifest V3)

Budowanie: `extension/build.mjs` (esbuild) kopiuje `static/` i skleja sześć punktów wejścia do `extension/dist/`:
`popup.ts` (strona `popup.html`), `background.ts` (service worker), `offscreen.ts` (czyszczenie schowka),
`autofill-content.ts` (`autofill-content.js`, iife wstrzykiwany do strony przy wypełnianiu; cel `chrome127`), `save-prompt.ts` (strona `save-prompt.html`) i `save-watch.ts` (`save-watch.js`, iife rejestrowany dynamicznie dla pytania o zapis).

`popup.html` działa w okienku przy ikonie i w zwykłej karcie. Okienko zamyka się, gdy traci fokus (okno zgody
Chrome, wybór pliku), dlatego parowanie, adresy i import/eksport pokazują się w karcie. Tryb strony odczytuje
`page-mode.ts` z adresu: `popup`, `tab`, `setup`, `addresses`, `transfer`, `edit` (`?edit&type=&id=`, formularz wpisu w karcie, bo wybór pliku zamyka okienko).

**Pliki w sejfie.** Zaszyfrowane kawałki plików leżą w IndexedDB `passholder-files` (magazyny `files` i `chunks`;
`src/files/idb-file-store.ts`), wspólnej dla wszystkich stron wtyczki, a nie w `chrome.storage` (limity rozmiaru).
Manifest ma uprawnienie `unlimitedStorage`, bo sejf może mieć setki MB plików. Magazyn jest za interfejsem
`LocalFileStore` z rdzenia; `VaultStore` dostaje go w konstruktorze (w testach `MemoryLocalFileStore`, IndexedDB testowany
osobno przez `fake-indexeddb`). Treść jawna nigdy nie jest zapisywana: odszyfrowanie dopiero w „Pobierz”.

| Plik | Co robi |
|---|---|
| `src/popup.ts` | `start()`: wybiera pierwszy widok i włącza automatyczną blokadę strony |
| `src/vault-store.ts` | `VaultStore`: konto, lokalny sejf, parowanie (`pairStart`, `pairFinish`, `repair`: też nowym hasłem z telefonu po zmianie hasła głównego), `sync`, adresy, PIN, import, `exportArchive` / `importArchive` (ZIP: plik po pliku, odszyfrowanie na czas jednego pliku; błąd archiwum albo blokada sejfu usuwa dodane pliki); serce wtyczki. Wpisy każdego typu: `listEntries(typ)`, `getEntry`, `putEntry` (odmowa zapisu pod `id` innego typu); import przez `importContents` (wszystkie typy, jeden zapis), eksport przez `allContents`; starą treść v2 czyta jako login |
| `src/entry-types.ts` | typy wpisów w kolejności zakładek (`ENTRY_TYPES`, `TYPE_INFO`), rodzaje dokumentu, pusty wpis, opis wiersza (`entrySummary`), wyszukiwanie, sprzątanie przed zapisem (`tidyContent`) i sprawdzanie formatów (`validateContent`) |
| `src/storage.ts` | klucze `chrome.storage` (`STORAGE_KEYS`), `chromeStore`, `memoryStore` do testów |
| `src/phone-client.ts` | `PhoneClient`: JSON `POST` do telefonu z limitem 30 s, polskie komunikaty błędów (też „Zaktualizuj aplikację na telefonie”) |
| `src/phone-urls.ts` | adresy telefonu: `normalizePhoneUrl` (tylko IPv4), `learnedPhoneUrls`, `pickPhone` (wybór działającego adresu, ping 4 s) |
| `src/auto-lock.ts` | blokada po 15 minutach: `watchIdle` na stronie i alarm w service workerze |
| `src/pin-lock.ts`, `src/pin-store.ts` | PIN: kryptografia (`createPinLock`, `openPinLock`) i przechowywanie z licznikiem prób |
| `src/import-summary.ts`, `src/plural.ts` | polskie podsumowanie importu (dodano, duplikaty, pominięte) i odmiana „wpis/wpisy/wpisów” oraz zdanie o pominiętych plikach (`skippedFilesPhrase`) |
| `src/clipboard.ts`, `src/background.ts`, `src/offscreen.ts` | czyszczenie schowka po minucie (alarm + dokument offscreen); `background.ts` obsługuje też autouzupełnianie (komunikat `fill`, polecenie `fill-login`) |
| `src/autofill/fill-tab.ts` | `fillTab` (sprawdza sejf, wpis, adres karty, https, `matchLogins`; wstrzykuje skrypt), `onFillCommand` (skrót), `chromeTabApi` (`tabs.get`, `scripting.executeScript`, przypięty origin) |
| `src/autofill/fill-page.ts`, `src/autofill-content.ts` | `fillPage` w stronie: pola, widoczność, ramki tego samego origin, wpisanie wartości; `autofill-content.ts` wystawia `globalThis.passholderFill` |
| `src/ui/active-tab.ts` | `activeTab` (karta pod okienkiem) i `requestFill` (komunikat `fill` do service workera) |
| `src/save/read-form.ts`, `watch.ts`, `src/save-watch.ts` | skrypt w stronie: `readLogin` (hasło i login, `formSignature`), `loginScope`, `emptyLoginForms`; `startSaveWatch` (submit, Enter, klik; ramka główna i ramki tego samego origin; panel jako `<iframe>` w zamkniętym Shadow DOM) |
| `src/save/candidates.ts` | `SaveCandidates` w service workerze: kandydat w `chrome.storage.session` (`saveCandidates`), lista „Nigdy” w `chrome.storage.local`; `onCandidate` (ten sam login z tej samej karty zachowuje id), `onPending`, `info`, `preview`, `answer`, alarm 2 min (`save-expire:<karta>`), `onTabRemoved`; operacje po kolei (`serial`); każde usunięcie poza zapisem i zamknięciem karty wysyła `save-hide` |
| `src/save/registration.ts` | `syncSaveWatch`: rejestracja skryptu `save-watch` zgodna z uprawnieniem `https://*/*` (wywołania po kolei); `disableSavePrompt` |
| `src/save/messages.ts`, `prompt-view.ts`, `prompt-page.ts`, `src/save-prompt.ts` | typy wiadomości (`save-candidate`, `save-pending`, `save-info`, `save-preview` (decyzja dla wpisanego loginu i hasła), `save-answer` (z `draft {name, username, password}`), `save-show`, `save-hide`); `promptView`: podgląd z edycją (Nazwa, Login, Hasło), wspólny dla panelu (`save-prompt.html`) i okienka; `startPromptPage`: strona panelu (brak kandydata → prosi o zamknięcie, sejf zablokowany po załadowaniu → „Odblokuj i zapisz”) |
| `src/views/save-settings.ts`, `save-question.ts` | „Zapis haseł” (przełącznik, lista „Nigdy”) i pytanie w okienku po odblokowaniu (`showUnlocked` w `locked.ts` pyta tło o kandydata karty) |
| `src/page-mode.ts`, `src/open-in-tab.ts` | tryby strony, przycisk „Otwórz w karcie ↗” |
| `src/ui/dom.ts` | pomocniki DOM: `h`, `show`, `form`, `passwordField`, `secretField` (pole wrażliwe: „Pokaż/Ukryj”, „Kopiuj”), `pinInput`, `confirmButton`, `busy` |
| `src/ui/copy.ts`, `src/ui/status.ts` | kopiowanie (`copyText`, `copySecret` z czyszczeniem schowka), linia statusu |
| `src/ui/list-editor.ts` | `listEditor`: lista z „+ Dodaj” i „Usuń” (adresy, aplikacje, telefony, własne pola) |
| `src/ui/page.ts` | `MODE`, `IN_TAB`, `showInTab(tryb, widok)`, `openInTabButton` |
| `src/ui/phone-url-fields.ts` | pola adresów telefonu (`phoneUrlFields`), wzorzec zgody, prośby o zgodę Chrome |
| `src/files/idb-file-store.ts`, `src/files/format-size.ts` | `IdbFileStore` (IndexedDB `passholder-files`: opisy plików i kawałki, zapis kawałek po kawałku, `uploadedEpoch`); `formatSize` („N KB”, „4,6 MB”) |
| `src/views/forms/attachments.ts`, `src/ui/download.ts` | sekcja „Załączniki” formularza (dodawanie, limity, ostrzeżenia, pobieranie) i zapis pliku przez `Blob` |
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
| `transfer/Common.kt`, `Csv.kt`, `JsonText.kt`, `PassHolderJson.kt`, `BitwardenJson.kt`, `NordPassCsv.kt`, `Transfer.kt`, `PassHolderZip.kt`, `ArchiveReader.kt` | pakiet `core.transfer`: ZIP bez `ZipInputStream` (własny strumieniowy parser: CRC i pomijanie pliku bez rozpakowania, budżet rozpakowywania; zapis `java.util.zip`); port `core/src/transfer/` (`contentKey`, `sortForExport` na `RuleBasedCollator` zgodnym z wektorem `sort.json`, CSV RFC 4180, serializacja JSON jak `JSON.stringify`, `Transfer.parseImportFile` i `exportFile`); te same pliki przykładowe z `core/test-vectors/transfer/` |
| `files/Attachment.kt`, `FileChunks.kt`, `FileHost.kt`, `DiskFileStore.kt` | pliki w sejfie (port `core/src/files/` bez klienta): opis załącznika (stałe, ścisły parser), szyfrowanie kawałkami, host `/p2p/v2/file` (`FileHost`, `FileStore`, `MemoryFileStore`) i magazyn na dysku telefonu (`p2p/files/`, zapis przez `.tmp` i `rename`); `P2pHost` dostaje magazyn jako ostatni parametr |
| `p2p/PhoneVaultStore.kt`, `PhoneVault.kt`, `FileSyncStore.kt`, `HostState.kt` | sejf telefonu: tworzenie, odtwarzanie, blokada (15 min), wpisy (`entries()` zwraca wszystkie typy, `upsert` zachowuje resztę pól i odmawia nadpisania wpisu innego typu), urządzenia; pliki `records.jsonl` i `host.json`; import: `importContents` (duplikaty po `contentKey`, jeden zapis) i `allContents`; pliki: `addFile`, `isFileComplete`, `readFile`, `pruneFiles`, `discardFiles` (kasuje podane pliki poza używanymi przez żywy wpis), kasowanie przy zmianie epoki |
| `autofill/Keywords.kt`, `Fields.kt`, `Values.kt`, `Match.kt` | port `core/src/autofill/` 1:1 (`classifyField`, `planFor`, `fillValue`, `matchUrl` z własnym parserem adresu, `matchLogins`) na tych samych wektorach `{match,fields,values}.json`; `matchApp`: zaufana przeglądarka (13 pakietów, `TRUSTED_BROWSERS`) z `webDomain` → `matchLogins`, inaczej loginy z pakietem w `androidApps`, po nazwie; wektory `test-vectors/autofill/app.json` (tylko Kotlin) |
| `autofill/Planner.kt` | `planRequest`: grupa formularza (login, karta, kontakt) i jej pola; `planDatasets`: pasujące wpisy → wartości pól (`ListIndex` dla list), bez wpisów bez wartości, najwyżej 10; generyczne po typie id pola, więc testowane bez Androida |
| `save/SaveUrl.kt`, `Decide.kt`, `SaveFields.kt` | port `core/src/save/` (`saveUrl`, `saveName`, `decideSave`; te same wektory `core/test-vectors/save/{url,decide}.json`) plus `saveFields` (pole hasła: pierwsze nowe hasło, inaczej hasło; login: pole loginu, inaczej ostatni e-mail przed hasłem), `saveTargetFor` (zaufana przeglądarka z domeną → `Web`, inaczej `App` z pakietem), `newLogin`, `withPassword` |
| `SyncStore.putAll` (w `p2p/HostSync.kt`), `p2p/FileSyncStore.kt` | `putAll`: wiele rekordów jednym dopisem i `fsync` (import atomowy); domyślnie pętla `put` |

| Plik (`android/app/.../app/`) | Co robi |
|---|---|
| `PassHolderApp.kt` | obiekt procesu: jeden `PhoneVaultStore`, `LeaveLock`, ustawienia (m.in. `askToSave`), `pendingSave`, odcisk, haki testowe autouzupełniania |
| `MainActivity.kt` | `onStart` / `onStop` (powrót i wyjście z aplikacji), ekran nie gaśnie w trybie Synchronizacja, blokada zrzutów ekranu |
| `AppViewModel.kt` | stan ekranów (`UiState`, `askToSave`) i operacje na sejfie w tle (`launchVaultOperation`) |
| `SyncController.kt` | tryb Synchronizacja: start i stop serwera, kod parowania, zdarzenia, zatrzymanie po 5 min bez połączeń |
| `KeystoreSecretWrapper.kt` | zawija klucz tożsamości telefonu kluczem z Android Keystore |
| `LockController.kt` | kiedy sejf się blokuje (wyjście z aplikacji, 15 minut, „Zablokuj”) i kiedy samo otwiera się okno odcisku |
| `LeaveLock.kt` | minutnik blokady 60 s po wyjściu z aplikacji; `lockNow()` przy wyłączeniu ekranu (odbiornik `ACTION_SCREEN_OFF` w `PassHolderApp`) |
| `MasterPasswordRules.kt` | reguły nowego hasła głównego: 12 znaków i bez oczywistych wzorców |
| `ImportSummary.kt`, `TransferFiles.kt` | podsumowanie importu (port `import-summary.ts`, także pliki ZIP); czytanie pliku (limit 10 MiB, ścisły UTF-8), rozpoznanie ZIP, strumień archiwum (limit 256 MiB, `PhoneVaultStore.importArchive`) i zapis, nazwa pliku |
| `AttachmentFiles.kt`, `FileSize.kt` | wybrany plik (nazwa i rozmiar z `OpenableColumns`, najwyżej 10 MiB + 1 bajt, kolejność sprawdzeń jak we wtyczce), zapis przez `CreateDocumentOf` (własny kontrakt: nazwa i typ, tryb `"wt"`); `formatSize` („N KB”, „4,6 MB”) |
| `BiometricController.kt`, `BiometricUnlock.kt` | odcisk palca: klucz w Android Keystore (StrongBox, gdy jest; tylko przy odblokowanym telefonie), zapisany klucz sejfu |
| `InstalledApps.kt` | aplikacje z ikoną w launcherze (`PackageManager`; w manifeście `<queries>` MAIN + LAUNCHER, bez `QUERY_ALL_PACKAGES`) |
| `entries/EntryTypes.kt` | `EntryType`, opis wiersza, wyszukiwanie, `tidy`, walidacja (port `extension/src/entry-types.ts`) |
| `SecureClipboard.kt` | kopiowanie i czyszczenie schowka po minucie (WorkManager; w zadaniu tylko HMAC hasła z kluczem procesu) |
| `autofill/ViewNodeReader.kt` | `AssistStructure` → `ParsedRequest`: pakiet, `webDomain`/`webScheme`, widoczne i włączone pola tekstowe i list (`describeNode`: `htmlInfo`, `autofillHints`, `inputType`, `idEntry`, podpowiedź) |
| `autofill/PassHolderAutofillService.kt` | usługa (`BIND_AUTOFILL_SERVICE`): `respond` (własny pakiet, brak sejfu → `null`; ekran bez pól do wypełnienia: odpowiedź tylko z `SaveInfo`, gdy ma pole hasła, inaczej `null`; zablokowany → „Odblokuj PassHolder”; inaczej `buildFillResponse`), praca w osobnym wątku; `onSaveRequest` czyta `readSaveData`: API ≥ 28 zawsze kandydat do `pendingSave` i `onSuccess(savePendingIntent)` (podgląd w `AutofillSaveActivity`); API < 28 `saveLogin` od razu, zablokowany → `onFailure`. Ekran logowania bez pasujących wpisów też dostaje `SaveInfo` |
| `autofill/ResponseBuilder.kt` | `FillResponse`: `Dataset` z wierszem `res/layout/autofill_item.xml` i, na API 30+, podpowiedzią w pasku klawiatury (`androidx.autofill` `InlineSuggestionUi`, ≤ `min(10, maxSuggestionCount)`); `SaveInfo` (hasło + login, `FLAG_SAVE_ON_ALL_VIEWS_INVISIBLE`) dla każdego ekranu z polem hasła (także „nowe hasło”, każda grupa) przy włączonym „Pytaj o zapis haseł”, id pól i opis aplikacji w `clientState` |
| `autofill/AutofillUnlockActivity.kt`, `ui/AutofillUnlockScreen.kt` | ekran odblokowania z podpowiedzi (podklasa `AutofillAuthActivity`): po odblokowaniu buduje odpowiedź i zwraca `EXTRA_AUTHENTICATION_RESULT` |
| `autofill/SaveState.kt` | `SaveSpec` (pola i aplikacja z chwili wypełniania), `saveSpecFor` (przełącznik, pole hasła; grupa bez znaczenia), `clientState` i jego odczyt (`saveSpecIds`, bez `Bundle.getParcelable(String, Class)` poniżej API 33) |
| `autofill/SaveLogin.kt` | `saveLogin` (tylko API 26–27: zapis bez podglądu, przez `saveReviewed` z danymi jak wpisane; wynik `SAVED`/`UPDATED`/`NOTHING`/`LOCKED`), `readSaveData` (wartości po id ze wszystkich `fillContexts`, od ostatniego), komunikaty, `appLabelOf` |
| `autofill/PendingSave.kt` | kandydat każdego zapisu (API ≥ 28) do chwili otwarcia podglądu: tylko pamięć procesu, 2 minuty (`app.clock`), jeden naraz |
| `autofill/AutofillAuthActivity.kt`, `AutofillSaveActivity.kt` | wspólna baza (odblokowanie tylko gdy sejf zablokowany: hasło / odcisk; haki `afterUnlock`, `UnlockedContent`, `onLockedWhileOpen`, `unlockAgain`; Wstecz i Anuluj = `RESULT_CANCELED`, blokada D1 także po wyjściu w tło, anulowanie starego terminu 60 s) i ekran zapisu: odblokowanie, potem podgląd (`exported="false"`, `FLAG_SECURE`) |
| `autofill/SaveReview.kt`, `ui/SaveReviewScreen.kt` | `SaveReview` (wpisy sejfu odszyfrowane raz, `decision`/`title`/`initialDraft` z `SaveDraft`), `saveReviewed` (ponowny odczyt sejfu, `decideSave` od nowa, `upsertContent`; wynik `SaveOutcome`), `SaveReviewModel` (ViewModel: kandydat, szkic, blokada w trakcie podglądu; bez stanu instancji) i ekran Compose „Zapisz w PassHolder” (Nazwa, Login, Hasło, adres/aplikacja tylko do odczytu) |
| `AutofillStatus.kt` | czy PassHolder jest usługą autouzupełniania (`hasEnabledAutofillServices`), wiersz w `SettingsScreen` |
| `ui/*.kt` | ekrany Compose: `StartScreen`, `LockedScreen`, `ListScreen` (dolny pasek zakładek), `EditScreen` (powłoka formularza), `SettingsScreen`, `TransferScreen` (import i eksport; okno wyboru pliku 60 s w `LockController.expectFilePicker`), `VaultTopBar`, `SyncScreen`, `DevicesScreen`, `RestoreScreen`, `FingerprintDialog`, `Common` (m.in. `SecretField`), `PassHolderUi` (wybór ekranu) |
| `ui/forms/*.kt` | `LoginForm`, `ContactForm`, `CardForm`, `DocumentForm` (notatka używa samej powłoki), `ListEditor`, `AttachmentsEditor` (sekcja „Załączniki”), `CustomFieldsEditor`, `GeneratorCard`, `AppPickerDialog` |

## Przepływ autouzupełniania (Chrome)

```
 okienko (list.ts)                    service worker (background.ts)              strona (wszystkie ramki)
 „Wypełnij” ── {fill, entryId, tabId} ──► sender.id == własne?  ──nie──► ignoruje
 skrót Ctrl+Shift+L ── onCommand ───────► fillTab:
                                           sejf odblokowany? wpis → planFor
                                           tabs.get(tabId) → adres (http/https)
                                           login: matchLogins; karta: https
                                           executeScript(autofill-content.js, allFrames)
                                           executeScript(func: passholderFill(plan, origin)) ──► fillPage:
                                                                                      ten sam origin co góra i = origin?
                                                                                      pola → classifyField → wartość
 { ok } albo komunikat ◄────────────────── suma wypełnionych pól (0 → „Nie znaleziono pól…”)
```

Okienko zamyka się po powodzeniu; błąd zostaje w linii statusu. Skrót wypełnia sam tylko przy jednym pasującym
loginie, w pozostałych przypadkach otwiera okienko.

## Przepływ pytania o zapis (Chrome)

```
 strona (save-watch.js)                service worker (SaveCandidates)               panel (save-prompt.html)
 submit / Enter / klik ─ save-candidate ─► sender.id własne, sender.tab, origin ramki = origin karty?
   {login, hasło, podpis}                  adres = saveUrl(sender.url); host na liście „Nigdy”? → koniec
                                           decideSave (sejf odblokowany; none → koniec)
                                           kandydat → storage.session, alarm 2 min
 save-show ◄─────────────────────────────── ramka główna karty
 iframe (zamknięty Shadow DOM) ─────────────────────────────────────────────────────► save-info → {id, host, username,
                                                                                         password, decision, entryName, locked}
                                           save-preview {candidateId, username, password} ◄──────────────────────── edycja loginu / hasła → decyzja
                                           save-answer {draft}: decyzja od nowa z draftu → putEntry ◄── „Zapisz” / „Nie teraz” / „Nigdy”
 save-hide ◄──────────────────────────────  (od razu po „Nie teraz”/„Nigdy”, po 2 min i gdy login już jest; 2 s po zapisie)
 nowa strona ── save-pending ─────────────► kandydat żyje? ten sam pusty formularz? → {candidateId}
```

Skrypt rejestruje service worker (`chrome.scripting.registerContentScripts`, `id: "save-watch"`) tylko przy
uprawnieniu `https://*/*`: to uprawnienie jest przełącznikiem (bez flagi w `storage`), a `syncSaveWatch`
uzgadnia rejestrację przy starcie, instalacji i zmianie uprawnień. Zablokowany sejf: panel ma „Odblokuj i
zapisz” (`chrome.action.openPopup()`), a okienko po odblokowaniu pyta o kandydata karty (`save-info` z `tabId`).
Odczyt sejfu dla pytania nie przedłuża blokady (`resume({touch: false})`); zapis (`touch: true`) tak.

Bezpieczeństwo: adres z `sender.url`, nie z wiadomości; ramki z innym origin pomijane; `save-info`, `save-preview` i
`save-answer` tylko ze stron wtyczki; panel dostaje hasło kandydata (nie innych wpisów; strona go nie czyta);
kandydat tylko w pamięci sesji (domyślnie
dostępnej tylko dla stron wtyczki); lista „Nigdy” jawna w `storage.local`.

## Przepływ autouzupełniania (Android)

```
 aplikacja / przeglądarka      system Android                  PassHolderAutofillService (wątek)
 stuknięcie pola ────────────► onFillRequest(AssistStructure) ─► readRequest → ParsedRequest
                                                                 własny pakiet / brak pól / brak sejfu → null
                                                                 planRequest → grupa (login, karta, kontakt)
                                                                 zablokowany → locked: „Odblokuj PassHolder”
                                                                 otwarty → entries() → planDatasets → datasets
 lista pod polem i pasek     ◄── FillResponse ◄─────────────────┘
 klawiatury (API 30+)
 „Odblokuj PassHolder” ──────► AutofillUnlockActivity: hasło / odcisk → unlock → buildFillResponse
                               ◄── RESULT_OK + EXTRA_AUTHENTICATION_RESULT; blokada po 60 s albo od razu
 wybór wpisu ◄──────────────── system wpisuje wartości datasetu w pola
```

Usługa nie trzyma wpisów ani kluczy: każde żądanie czyta sejf od nowa. Decyzje (2026-11-11):

- **D1** Po odblokowaniu z podpowiedzi sejf blokuje się jak przy wyjściu z aplikacji: `LeaveLock` 60 s przy
  „Blokuj dopiero po 60 s”, inaczej od razu; Anuluj/Wstecz w trakcie odblokowania → blokada od razu. Sejf
  otwarty wcześniej w aplikacji zostaje przy jej blokadzie. Powrót do aplikacji przy otwartym sejfie pokazuje listę.
- **D2** Samo pole e-mail → loginy (pierwszy krok logowania); kontakty wymagają innego pola kontaktu.
- **D3** Karta w zaufanej przeglądarce tylko przy `webScheme` `https` (albo bez `webScheme`, albo `localhost`);
  w aplikacjach zawsze.
- **D4** Podpowiedzi także w pasku klawiatury (Android 11+, `androidx.autofill` 1.1.0), obok listy pod polem.
- **D5** Wektory `matchApp` w `core/test-vectors/autofill/app.json`, czytane tylko przez Kotlin.

## Przepływ pytania o zapis (Android)

```
 formularz logowania           system Android                  PassHolderAutofillService (wątek)
 stuknięcie pola ────────────► onFillRequest ─────────────────► respond: pole hasła (każda grupa) + „Pytaj o zapis”
                                                                 → SaveInfo; id pól, pakiet, domena → clientState
                                                                 brak wpisów → odpowiedź tylko z SaveInfo
 wysłanie, ekran znika ──────► okno systemu ─ tak ─► onSaveRequest → readSaveData (id z clientState,
                                                                 wszystkie fillContexts)
                                                                 API ≥ 28: pendingSave.put (zawsze)
                                                                 API < 28: otwarty → saveLogin (decideSave →
                                                                 upsertContent → toast), zablokowany → onFailure
 ◄── onSuccess(savePendingIntent) ──────────────────────────────┘
 AutofillSaveActivity: odblokowanie tylko gdy zablokowany → pendingSave.take → SaveReview
   → ekran podglądu (edycja; nagłówek z decideSave na bieżąco) → „Zapisz” → saveReviewed (sejf czytany od nowa)
   → toast; RESULT_OK; blokada D1. Sejf zablokowany w trakcie podglądu → odblokowanie i powrót z tym samym szkicem;
   wyjście w tło → D1
```

Decyzje (2026-11-12): **P1** API 26–27 i zablokowany sejf: `onFailure`, bez kandydata (`SaveCallback.onSuccess(IntentSender)` od API 28).
**P2** id pól i opis aplikacji w `clientState` (czytnik pomija pola niewidoczne, a przy zapisie formularz bywa
już ukryty). **P3** pole hasła: pierwsze „nowe hasło”, inaczej hasło. **P4** adres dla `saveUrl`:
`"${webScheme ?: "https"}://$webDomain"`. **P5** po odblokowaniu decyzja „nic”: okno zamyka się bez komunikatu (od API 28 zastąpione przez podgląd, spec 5.4: komunikat „Ten login jest już zapisany”).
Kandydat żyje tylko w pamięci (2 minuty); Wstecz i Anuluj go kasują. Zapis po odblokowaniu anuluje stary termin
60 s (`leaveLock.cancel()`), inaczej sejf wyglądałby na zablokowany.

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
      potem faza plików: syncFiles (POST /p2p/v2/file: status, put, get) z IndexedDB, uszkodzone pomijane,
      błąd tej fazy nie cofa wpisów; na końcu sprzątanie nieużywanych plików
```

## Przepływ importu archiwum ZIP

```
Wybór pliku → pierwsze 4 bajty PK\x03\x04? (nie → JSON / CSV jak dotąd)
  > 256 MiB → „Plik jest za duży (limit 256 MiB)”: wtyczka sprawdza rozmiar wybranego pliku i go nie czyta;
    telefon czyta strumieniowo i przerywa, gdy licznik przeczytanych bajtów przekroczy limit
  wtyczka: VaultStore.importArchive(bajty)   telefon: PhoneVaultStore.importArchive(strumień)
    wtyczka: katalog centralny i rekord końca (openPassHolderZip), potem pliki po ścieżkach z indeksu
    telefon (ArchiveReader): indeks passholder.json (musi być pierwszy), potem pliki po kolei, na końcu
      katalog centralny i rekord końca (zgodne z wpisami, jeden dysk, nic za nimi; inaczej błąd archiwum)
      zanim cokolwiek trafi do sejfu
    limity i CRC w trakcie inflate; plik z błędem → na listę pominiętych (wpis wchodzi bez niego);
      zły CRC samego passholder.json → błąd całego archiwum
    duplikat wpisu (contentKey, tylko względem sejfu) → pominięty razem z plikami
    dla pliku: odszyfrowany odczyt z ZIP → nowy id i klucz → szyfrowanie kawałkami → magazyn plików
    wpisy dopiero po plikach, jednym zapisem (atomowo)
    wyjątek, blokada sejfu albo brak miejsca w dowolnym momencie → usunięcie dodanych plików, nic nie wchodzi
  → podsumowanie: dodano / duplikaty / pominięte wpisy i pliki; synchronizacja jak zwykle po „Synchronizuj”
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

## Stan przeglądu bezpieczeństwa

Raport: [archive/PRZEGLAD_BEZPIECZENSTWA.md](archive/PRZEGLAD_BEZPIECZENSTWA.md) (2026-11-01, jeszcze z serwerem Pi).
Drugi, pełny przegląd po V3: [PRZEGLAD_BEZPIECZENSTWA_V3.md](PRZEGLAD_BEZPIECZENSTWA_V3.md) (2026-11-15).

| Punkt | Stan |
|---|---|
| S1–S4, N3 | poprawione w PR #18 ([archive/POPRAWKI_BEZPIECZENSTWA.md](archive/POPRAWKI_BEZPIECZENSTWA.md)); S2 w wersji P2P: ścisłe nagrobki (V3, PR #29) |
| N1 | wyłączenie ekranu blokuje sejf od razu (`LeaveLock.lockNow`, [FUNKCJE.md](FUNKCJE.md#blokada-po-wyjściu)) |
| N2 | ostrzeżenie pod eksportem NordPass CSV; wartości bez zmian (import musi je odtworzyć) |
| N4 | nieaktualne: nie ma serwera ani tokenu instalacyjnego; sejf zakłada się na telefonie, parowanie kodem z ekranu |
| N5 | opcjonalny własny klucz wydania (`android/keystore.properties`, [INSTALACJA.md](INSTALACJA.md#22-instalacja)); domyślnie nadal klucz debug (decyzja właściciela) |
| N6 | w zadaniu WorkManagera HMAC z kluczem procesu zamiast SHA-256 hasła |
| N7 | nieaktualne: sesje P2P są jednorazowe, żyją 60 s i nie zależą od blokady sejfu |
| I1 | zmiana hasła głównego na telefonie (`PhoneVaultStore.changeMasterPassword`, ekran „Zmień hasło główne”): nowy salt, ten sam vaultKey, telefon zapomina sparowane wtyczki, odcisk palca wyłączony; wtyczka paruje się nowym hasłem (`repair`), PIN wyłączony ([FUNKCJE.md](FUNKCJE.md#zmiana-hasła-głównego)) |
| I2 | klucz odcisku w StrongBox (gdy jest) i tylko przy odblokowanym telefonie |
| I3 | ograniczenie platform, bez zmian: hasła jako `String` w JS i Kotlinie nie dają się wyzerować; klucze na Androidzie są zerowane (`fill(0)`), we wtyczce trzymane jako Base64 w `chrome.storage.session` (pamięć przeglądarki) |
| I4 | `MasterPasswordRules`: 12 znaków i bez oczywistych wzorców |
| I5 | `npm audit`: 0 podatności; Gradle do sprawdzenia ręcznie ([TESTY.md](TESTY.md#zależności-przegląd-bezpieczeństwa-i5)) |
| V3 (2026-11-15) | pełny przegląd po V3: 0 K, 0 W, 4 S, 7 N, 5 I; poprawki w osobnych wątkach ([PRZEGLAD_BEZPIECZENSTWA_V3.md](PRZEGLAD_BEZPIECZENSTWA_V3.md)) |
