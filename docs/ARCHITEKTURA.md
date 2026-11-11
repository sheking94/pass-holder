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
| `src/autofill/` | autouzupełnianie, czyste funkcje (bez DOM i `chrome.*`, podścieżka `@passholder/core/autofill`): `match.ts` (`matchUrl`, `matchLogins`), `fields.ts` (`classifyField` po opisie pola), `keywords.ts` (słowa kluczowe PL/EN), `values.ts` (`planFor` → `FillPlan`, `fillValue`: karta, `<select>`, kontakt); wektory `test-vectors/autofill/{match,fields,values}.json` |
| `src/save/` | pytanie o zapis, czyste funkcje (podścieżka `@passholder/core/save`): `url.ts` (`saveUrl`: domena do zapisu, `saveName`), `decide.ts` (`decideSave` → `none`/`create`/`update`, `newLogin`, `withPassword`); wektory `test-vectors/save/{url,decide}.json` |
| `scripts/gen-vectors.ts`, `gen-vectors-v2.ts`, `gen-vectors-v3.ts` | `test-vectors/v1.json` (KDF, klucz sejfu), `v2.json` (P2P) i `v3.json` (wpisy v3, limity) |

## `extension/` (Chrome, Manifest V3)

Budowanie: `extension/build.mjs` (esbuild) kopiuje `static/` i skleja cztery punkty wejścia do `extension/dist/`:
`popup.ts` (strona `popup.html`), `background.ts` (service worker), `offscreen.ts` (czyszczenie schowka),
`autofill-content.ts` (`autofill-content.js`, iife wstrzykiwany do strony przy wypełnianiu; cel `chrome127`), oraz `save-prompt.ts` (strona `save-prompt.html`) i `save-watch.ts` (`save-watch.js`, iife rejestrowany dynamicznie dla pytania o zapis).

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
| `src/clipboard.ts`, `src/background.ts`, `src/offscreen.ts` | czyszczenie schowka po minucie (alarm + dokument offscreen); `background.ts` obsługuje też autouzupełnianie (komunikat `fill`, polecenie `fill-login`) |
| `src/autofill/fill-tab.ts` | `fillTab` (sprawdza sejf, wpis, adres karty, https, `matchLogins`; wstrzykuje skrypt), `onFillCommand` (skrót), `chromeTabApi` (`tabs.get`, `scripting.executeScript`, przypięty origin) |
| `src/autofill/fill-page.ts`, `src/autofill-content.ts` | `fillPage` w stronie: pola, widoczność, ramki tego samego origin, wpisanie wartości; `autofill-content.ts` wystawia `globalThis.passholderFill` |
| `src/ui/active-tab.ts` | `activeTab` (karta pod okienkiem) i `requestFill` (komunikat `fill` do service workera) |
| `src/save/read-form.ts`, `watch.ts`, `src/save-watch.ts` | skrypt w stronie: `readLogin` (hasło i login, `formSignature`), `loginScope`, `emptyLoginForms`; `startSaveWatch` (submit, Enter, klik; ramka główna i ramki tego samego origin; panel jako `<iframe>` w zamkniętym Shadow DOM) |
| `src/save/candidates.ts` | `SaveCandidates` w service workerze: kandydat w `chrome.storage.session` (`saveCandidates`), lista „Nigdy” w `chrome.storage.local`; `onCandidate`, `onPending`, `info`, `answer`, alarm 2 min (`save-expire:<karta>`), `onTabRemoved`; operacje po kolei (`serial`) |
| `src/save/registration.ts` | `syncSaveWatch`: rejestracja skryptu `save-watch` zgodna z uprawnieniem `https://*/*`; `disableSavePrompt` |
| `src/save/messages.ts`, `prompt-view.ts`, `src/save-prompt.ts` | typy wiadomości (`save-candidate`, `save-pending`, `save-info`, `save-answer`, `save-show`, `save-hide`); `promptView`: pytanie wspólne dla panelu (`save-prompt.html`) i okienka |
| `src/views/save-settings.ts`, `save-question.ts` | „Zapis haseł” (przełącznik, lista „Nigdy”) i pytanie w okienku po odblokowaniu (`showUnlocked` w `locked.ts` pyta tło o kandydata karty) |
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
| `transfer/Common.kt`, `Csv.kt`, `JsonText.kt`, `PassHolderJson.kt`, `BitwardenJson.kt`, `NordPassCsv.kt`, `Transfer.kt` | pakiet `core.transfer`: port `core/src/transfer/` (`contentKey`, `sortForExport` na `RuleBasedCollator` zgodnym z wektorem `sort.json`, CSV RFC 4180, serializacja JSON jak `JSON.stringify`, `Transfer.parseImportFile` i `exportFile`); te same pliki przykładowe z `core/test-vectors/transfer/` |
| `p2p/PhoneVaultStore.kt`, `PhoneVault.kt`, `FileSyncStore.kt`, `HostState.kt` | sejf telefonu: tworzenie, odtwarzanie, blokada (15 min), wpisy (`entries()` zwraca wszystkie typy, `upsert` zachowuje resztę pól i odmawia nadpisania wpisu innego typu), urządzenia; pliki `records.jsonl` i `host.json`; import: `importContents` (duplikaty po `contentKey`, jeden zapis) i `allContents` |
| `autofill/Keywords.kt`, `Fields.kt`, `Values.kt`, `Match.kt` | port `core/src/autofill/` 1:1 (`classifyField`, `planFor`, `fillValue`, `matchUrl` z własnym parserem adresu, `matchLogins`) na tych samych wektorach `{match,fields,values}.json`; `matchApp`: zaufana przeglądarka (13 pakietów, `TRUSTED_BROWSERS`) z `webDomain` → `matchLogins`, inaczej loginy z pakietem w `androidApps`, po nazwie; wektory `test-vectors/autofill/app.json` (tylko Kotlin) |
| `autofill/Planner.kt` | `planRequest`: grupa formularza (login, karta, kontakt) i jej pola; `planDatasets`: pasujące wpisy → wartości pól (`ListIndex` dla list), bez wpisów bez wartości, najwyżej 10; generyczne po typie id pola, więc testowane bez Androida |
| `SyncStore.putAll` (w `p2p/HostSync.kt`), `p2p/FileSyncStore.kt` | `putAll`: wiele rekordów jednym dopisem i `fsync` (import atomowy); domyślnie pętla `put` |

| Plik (`android/app/.../app/`) | Co robi |
|---|---|
| `PassHolderApp.kt` | obiekt procesu: jeden `PhoneVaultStore`, `LeaveLock`, ustawienia, odcisk, haki testowe autouzupełniania |
| `MainActivity.kt` | `onStart` / `onStop` (powrót i wyjście z aplikacji), ekran nie gaśnie w trybie Synchronizacja, blokada zrzutów ekranu |
| `AppViewModel.kt` | stan ekranów (`UiState`) i operacje na sejfie w tle (`launchVaultOperation`) |
| `SyncController.kt` | tryb Synchronizacja: start i stop serwera, kod parowania, zdarzenia, zatrzymanie po 5 min bez połączeń |
| `KeystoreSecretWrapper.kt` | zawija klucz tożsamości telefonu kluczem z Android Keystore |
| `LockController.kt` | kiedy sejf się blokuje (wyjście z aplikacji, 15 minut, „Zablokuj”) i kiedy samo otwiera się okno odcisku |
| `LeaveLock.kt` | minutnik blokady 60 s po wyjściu z aplikacji |
| `ImportSummary.kt`, `TransferFiles.kt` | podsumowanie importu (port `import-summary.ts`); czytanie pliku (limit 10 MiB, ścisły UTF-8) i zapis, nazwa pliku |
| `BiometricController.kt`, `BiometricUnlock.kt` | odcisk palca: klucz w Android Keystore, zapisany klucz sejfu |
| `InstalledApps.kt` | aplikacje z ikoną w launcherze (`PackageManager`; w manifeście `<queries>` MAIN + LAUNCHER, bez `QUERY_ALL_PACKAGES`) |
| `entries/EntryTypes.kt` | `EntryType`, opis wiersza, wyszukiwanie, `tidy`, walidacja (port `extension/src/entry-types.ts`) |
| `SecureClipboard.kt` | kopiowanie i czyszczenie schowka po minucie (WorkManager) |
| `autofill/ViewNodeReader.kt` | `AssistStructure` → `ParsedRequest`: pakiet, `webDomain`/`webScheme`, widoczne i włączone pola tekstowe i list (`describeNode`: `htmlInfo`, `autofillHints`, `inputType`, `idEntry`, podpowiedź) |
| `autofill/PassHolderAutofillService.kt` | usługa (`BIND_AUTOFILL_SERVICE`): `respond` (własny pakiet, brak pól, brak sejfu → `null`; zablokowany → „Odblokuj PassHolder”; inaczej `buildFillResponse`), praca w osobnym wątku; `onSaveRequest` nic nie robi |
| `autofill/ResponseBuilder.kt` | `FillResponse`: `Dataset` z wierszem `res/layout/autofill_item.xml` i, na API 30+, podpowiedzią w pasku klawiatury (`androidx.autofill` `InlineSuggestionUi`, ≤ `min(10, maxSuggestionCount)`); bez `SaveInfo` |
| `autofill/AutofillUnlockActivity.kt`, `ui/AutofillUnlockScreen.kt` | ekran odblokowania z podpowiedzi (`exported="false"`, `FLAG_SECURE`): hasło albo odcisk, potem `EXTRA_AUTHENTICATION_RESULT` i ponowna blokada (D1) |
| `AutofillStatus.kt` | czy PassHolder jest usługą autouzupełniania (`hasEnabledAutofillServices`), wiersz w `SettingsScreen` |
| `ui/*.kt` | ekrany Compose: `StartScreen`, `LockedScreen`, `ListScreen` (dolny pasek zakładek), `EditScreen` (powłoka formularza), `SettingsScreen`, `TransferScreen` (import i eksport; okno wyboru pliku 60 s w `LockController.expectFilePicker`), `VaultTopBar`, `SyncScreen`, `DevicesScreen`, `RestoreScreen`, `FingerprintDialog`, `Common` (m.in. `SecretField`), `PassHolderUi` (wybór ekranu) |
| `ui/forms/*.kt` | `LoginForm`, `ContactForm`, `CardForm`, `DocumentForm` (notatka używa samej powłoki), `ListEditor`, `CustomFieldsEditor`, `GeneratorCard`, `AppPickerDialog` |

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
                                                                                         decision, locked}
                                           save-answer: save → decyzja od nowa → putEntry ◄── „Zapisz” / „Nie teraz” / „Nigdy”
 save-hide ◄──────────────────────────────  (od razu po „Nie teraz”/„Nigdy”, 2 s po zapisie)
 nowa strona ── save-pending ─────────────► kandydat żyje? ten sam pusty formularz? → {candidateId}
```

Skrypt rejestruje service worker (`chrome.scripting.registerContentScripts`, `id: "save-watch"`) tylko przy
uprawnieniu `https://*/*`: to uprawnienie jest przełącznikiem (bez flagi w `storage`), a `syncSaveWatch`
uzgadnia rejestrację przy starcie, instalacji i zmianie uprawnień. Zablokowany sejf: panel ma „Odblokuj i
zapisz” (`chrome.action.openPopup()`), a okienko po odblokowaniu pyta o kandydata karty (`save-info` z `tabId`).
Odczyt sejfu dla pytania nie przedłuża blokady (`resume({touch: false})`); zapis (`touch: true`) tak.

Bezpieczeństwo: adres z `sender.url`, nie z wiadomości; ramki z innym origin pomijane; `save-info` i
`save-answer` tylko ze stron wtyczki; panel nie dostaje hasła; kandydat tylko w pamięci sesji (domyślnie
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
