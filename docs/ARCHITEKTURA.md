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

Formatowanie i lint dla całego repo: `.editorconfig`, `.prettierrc.json`, `.prettierignore`,
`eslint.config.mjs` i plugin ktlint w `android/build.gradle.kts` (opis w [TESTY.md](TESTY.md#formatowanie-i-lint-przegląd-czystości-v3-cn1)).

## `core/` (TypeScript, wspólny)

| Plik | Co robi |
|---|---|
| `src/errors.ts` | `PassHolderError` (pole `code: ErrorCode`, `detail`, `cause`) i `hasErrorCode`: błędy, które aplikacja rozpoznaje albo pokazuje użytkownikowi (patrz „Błędy” niżej) |
| `src/encoding.ts` | UTF-8 z normalizacją NFC, Base64, hex, `randomBytes`, `concat` / `concatAll`, `sameBytes` (porównanie w stałym czasie) |
| `src/web-address.ts` | jedna normalizacja adresu: `normalizeHost`, `parseWebAddress` (autouzupełnianie i zapis), `hostOf` (nazwa wiersza NordPass); patrz „Import, eksport i format wpisu” niżej |
| `src/strict-json.ts` | pomocniki ścisłego JSON: `isRecord`, `hasExactKeys`, `requireString` (patrz „Wspólne pomocniki” niżej) |
| `src/kdf.ts` | Argon2id, HKDF (`encKey`), granice `MIN_KDF` / `MAX_KDF` |
| `src/cipher.ts` | AES-256-GCM w formacie `0x01 ‖ nonce ‖ szyfrogram ‖ tag` (`seal`, `open`; `sealWithNonce` dla wektorów) |
| `src/vault.ts` | klucz sejfu: `newVaultKey`, `wrapVaultKey`, `unwrapVaultKey` |
| `src/protocol.ts` | `RemoteRecord`, `SyncStore`, `processSync`, `MemorySyncStore`: logika hosta (numery `revision`, `baseRevision`); `processSync` i `MemorySyncStore` to host wzorcowy (tylko testy i skrypty) |
| `src/generator.ts` | generator haseł (CSPRNG z odrzucaniem, Fisher-Yates) |
| `src/p2p/hlc.ts` | hybrydowy zegar logiczny (HLC) do rozstrzygania konfliktów |
| `src/p2p/entry.ts` | wpis v3 i nagrobek: typy, ścisły parser (`parseEntryData`, `parseTombstoneData`, `parseEntryContent` dla wpisu bez `v` i `hlc`), zwarta serializacja w stałej kolejności kluczy, limit `MAX_ENTRY_BLOB_LENGTH`, odczyt v2 jako login; AAD `passholder/v2/entry/<id>` |
| `src/p2p/sync.ts` | sejf wtyczki (`LocalVault`) i `syncVault` (odpowiedź: `markAccepted`, potem `resolveRemote` dla każdego rekordu); budżet bajtów żądania, rundy ucięte (`more`) poza limitem ponowień po konflikcie (`MAX_CONFLICT_RESYNCS` = 3; wszystkie rundy razem: `MAX_SYNC_ROUNDS`) |
| `src/p2p/host-sync.ts` | strona hosta: `parseP2pSyncRequest` (kształt, też blob ≤ 64 KiB; błąd `InvalidSyncRequestError`), `processP2pSync` (parsuje raz, na `processSync`), epoka, `pageRecords`: stronicowanie po 500 zmianach i `MAX_BLOB_BYTES_PER_ROUND` (tnie też `conflicts`) |
| `src/p2p/cpace.ts`, `pairing.ts`, `pair-client.ts` | parowanie: CPace, kod 8 cyfr, zapieczętowane wiadomości (`sealIdentity`/`openIdentity`, `sealVaultInfo`/`openVaultInfo`), klient HTTP parowania wtyczki |
| `src/p2p/noise.ts`, `frames.ts`, `transport.ts` | Noise KK (każdy błąd: kod `NOISE_FAILED`), ramki, `noiseTransport` i `callP2pHost`; stałe ścieżek `P2P_*_PATH` (`/p2p/v2/*` i parowanie `/p2p/v1/*`), `responseString`, 404 na uzgadnianiu → kod `PHONE_UPDATE_REQUIRED`; `P2pHostError` (status ≠ 200: `HOST_ERROR` albo `DEVICE_NOT_PAIRED`), `malformedResponse()` (`HOST_MALFORMED`) |
| `src/p2p/host.ts`, `host-reply.ts` | `P2pHost`: referencyjny host (uzgadnianie, sesje, sync; tylko testy i skrypty, telefon ma host w Kotlinie); `/p2p/v1/handshake` i `/p2p/v1/sync` → 410; `HostReply` i `errorReply` (wspólne z `files/host-files.ts`) |
| `src/files/attachment.ts` | opis załącznika: stałe (`MAX_FILE_SIZE`, `FILE_CHUNK_SIZE`, limity 20/40), `parseAttachments`, `attachmentJson` (stała kolejność kluczy), `canAddAttachment`, wzorzec UUID v4 |
| `src/files/chunks.ts` | szyfrowanie pliku kawałkami: `encryptFile` (`encryptFileFixed` dla wektorów), `decryptChunk`, `decryptFile` (rozmiar, `sha256`), AAD `passholder/v3/file/<id>/<i>/<n>` |
| `src/files/host-files.ts` | strona hosta `/p2p/v2/file`: `FileStore` (`put(FileChunk, now)`), `MemoryFileStore`, `processP2pFile` (parsowanie do typu, potem funkcja na operację `status`/`put`/`get`; 400/404/409/507), `orphanFileIds` (24 h) |
| `src/files/client.ts` | klient: `LocalFileStore`, `syncFiles(vault, files, send, { onProgress, skip })` (plan, potem wysyłanie i pobieranie brakujących kawałków, `uploadedEpoch`), `noiseFileTransport`, `pruneLocalFiles` |
| `src/files/merge.ts` | `mergeAttachments`: łączenie list załączników przy konflikcie (używa `src/p2p/sync.ts`) |
| `src/transfer/` | import i eksport plików, czyste funkcje (bez DOM i `chrome.*`): `common.ts` (`contentKey`, `sortForExport`), `csv.ts` (RFC 4180), `passholder-json.ts`, `bitwarden-json.ts`, `nordpass-csv.ts`, `detect.ts` (`parseImportFile`, `exportFile`), `zip.ts` (CRC-32, zapis i odczyt ZIP, deflate przez `CompressionStream`, limity zip-bomb), `passholder-zip.ts` (`exportPassHolderZip`, `openPassHolderZip`: indeks + pliki, `ArchiveEntry.position`; `exportArchive` / `importArchive` to metody `VaultStore`); pliki przykładowe w `test-vectors/transfer/` |
| `src/autofill/` | autouzupełnianie, czyste funkcje (bez DOM i `chrome.*`, podścieżka `@passholder/core/autofill`): `match.ts` (`matchUrl`, `matchLogins` z `exactOnly`), `psl.ts` (`publicSuffix`, `registrableDomain`; reguły w wygenerowanym `psl-rules.ts`, skrypt `scripts/gen-psl.ts`), `fields.ts` (`classifyField` po opisie pola), `keywords.ts` (słowa kluczowe PL/EN), `values.ts` (`planFor` → `FillPlan`, `fillValue`: karta, `<select>`, kontakt); wektory `test-vectors/autofill/{match,psl,fields,values}.json` |
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
| `src/popup.ts` | `start()`: ładuje `views/index.ts`, wybiera pierwszy widok (`views().connect/addresses/unlocked/locked`) i włącza automatyczną blokadę strony |
| `src/vault-store.ts` | `VaultStore`: cienka fasada nad częściami z `src/vault/` (opis w „Podział `VaultStore`”); sama robi tylko odblokowanie (hasło, PIN), ustawienia PIN-u i odłączenie. Tworzona jednym obiektem opcji `{ local, session, makeClient?, now?, canReach?, fileStore? }`; publiczne API bez zmian. Re-eksportuje typy i teksty z `src/vault/` |
| `src/vault/*.ts` | części sejfu wtyczki: `session.ts` (stan odblokowania i blokada po 15 min), `account.ts` (konto, hasło główne, klucz statyczny), `local-vault.ts` (zapis sejfu na dysku), `entries.ts`, `files.ts`, `transfer.ts` (import i eksport), `sync.ts`, `pairing.ts` (`pairStart`, `pairFinish`, `repair`: też nowym hasłem z telefonu po zmianie hasła głównego), `messages.ts` (teksty i błędy `UnsyncedChanges`, `PairedButSyncFailed`) |
| `src/entry-types.ts` | typy wpisów w kolejności zakładek (`ENTRY_TYPES`, `TYPE_INFO`), rodzaje dokumentu, pusty wpis, opis wiersza (`entrySummary`), wyszukiwanie, sprzątanie przed zapisem (`tidyContent`) i sprawdzanie formatów (`validateContent`) |
| `src/storage.ts` | klucze `chrome.storage` (`STORAGE_KEYS`), `chromeStore`, `memoryStore` do testów, `setOrRemove` (zapis listy lub mapy, pusta usuwa klucz) |
| `src/phone-client.ts` | `PhoneClient`: JSON `POST` do telefonu z limitem 30 s; brak odpowiedzi → `PhoneUnreachableError` |
| `src/error-messages.ts` | jedyne miejsce, gdzie kody błędów rdzenia stają się polskim tekstem: `errorMessage(error: unknown)` (tekst dla użytkownika z dowolnej wartości), `toUserError` (błąd z tekstem dla ekranu, oryginał w `cause`), wspólne teksty (`PHONE_UNREACHABLE`, `UNLOCK_AND_RETRY`…) |
| `src/result.ts` | `ActionResult` (`{ ok: true }` albo `{ ok: false; error }`): wynik akcji przesyłany między tłem a stronami (wypełnianie, odpowiedź na pytanie o zapis) |
| `src/phone-urls.ts` | adresy telefonu: `normalizePhoneUrl` (tylko IPv4), `requirePhoneUrls` (co najmniej jeden), `learnedPhoneUrls`, `withLearned`, `answeredFirst`, `pickPhone` (wybór działającego adresu, ping 4 s) |
| `src/auto-lock.ts` | blokada po 15 minutach: `watchIdle` na stronie i alarm w service workerze |
| `src/pin-lock.ts`, `src/pin-store.ts` | PIN: kryptografia (`createPinLock`, `openPinLock`) i przechowywanie z licznikiem prób |
| `src/import-summary.ts`, `src/plural.ts` | polskie podsumowanie importu (dodano, duplikaty, pominięte) i odmiana „wpis/wpisy/wpisów” oraz zdanie o pominiętych plikach (`skippedFilesPhrase`) |
| `src/clipboard.ts`, `src/background.ts`, `src/offscreen.ts` | czyszczenie schowka po minucie (alarm + dokument offscreen); `background.ts` ma jeden nasłuch `onMessage`, który rozdziela komunikaty po `type` (`password-copied`, `fill`, `save-*`), i obsługuje polecenie `fill-login` |
| `src/autofill/fill-tab.ts` | `fillTab` (sprawdza sejf, wpis, adres karty, https, `matchSavedLogins`; wstrzykuje skrypt), `onFillCommand` (skrót: tylko login dokładnego hosta), `chromeFillTabApi` (`FillTabApi`: `tabs.get`, `scripting.executeScript`, przypięty origin) |
| `src/autofill/fill-page.ts`, `src/autofill-content.ts` | `fillPage` w stronie: pola, widoczność (`isVisible(el, "basic" | "strict")`, dla kontaktu i karty `"strict"`: `clip-path`/`clip`, min. 10 px, `overflow` rodzica, `elementFromPoint`), kontakt i karta tylko w formularzu pola z kursorem, ramki tego samego origin, wpisanie wartości; `autofill-content.ts` wystawia `globalThis.passholderFill` |
| `src/ui/active-tab.ts` | `activeTab` (karta pod okienkiem) i `requestFill` (komunikat `fill` do service workera) |
| `src/save/read-form.ts`, `watch.ts`, `src/save-watch.ts` | skrypt w stronie: `readLogin` (hasło i login, `formSignature`), `loginScope`, `emptyLoginForms`; `startSaveWatch` (submit, Enter, klik tylko od użytkownika: `isTrusted`, przy submit też `navigator.userActivation`; ramka główna i ramki tego samego origin; nic nie dodaje do strony) |
| `src/save/candidates.ts` | `SaveCandidates` w service workerze: kandydat w `chrome.storage.session` (`saveCandidates`), lista „Nigdy” w `chrome.storage.local`; `onCandidate` (ten sam login z tej samej karty zachowuje id), `onPending`, `onInfo`, `onPreview`, `onAnswer`, `onAlarm` (alarm 2 min `save-expire:<karta>`), `onTabRemoved`, `onWindowClosed` (okno zamknięte przez użytkownika: tylko odznaka), `onUnlockRequest`; publiczne `onX` kolejkują pracę (`serial`), prywatne `handleX` ją wykonują; okno i odznakę obsługuje przez `SavePrompt` (`PromptWindows`); każde usunięcie poza zapisem i zamknięciem karty zamyka okno i zdejmuje odznakę |
| `src/save/registration.ts` | `syncSaveWatch`: rejestracja skryptu `save-watch` zgodna z uprawnieniem `https://*/*` (wywołania po kolei); `disableSavePrompt` |
| `src/save/messages.ts`, `prompt-view.ts`, `prompt-page.ts`, `src/save-prompt.ts` | typy wiadomości (`save-candidate`, `save-pending`, `save-info`, `save-preview` (decyzja dla wpisanego loginu i hasła), `save-answer` (z `draft {name, username, password}`), `save-unlock`); `promptView`: podgląd z edycją (Nazwa, Login, Hasło; przy zmianie hasła uwaga o „Poprzednie hasło”), wspólny dla okna (`save-prompt.html`) i okienka; `startPromptPage`: strona okna (brak kandydata → zamyka okno, sejf zablokowany po załadowaniu → „Odblokuj i zapisz”) |
| `src/save/prompt-window.ts` | `PromptWindows`: okno pytania (`chrome.windows.create`, `type: "popup"`, 380 × 420 przy prawym górnym rogu okna karty), odznaka „?” (`chrome.action.setBadgeText` dla karty), mapa karta → okno w `storage.session`, `show`/`hide`/`closeWindow`/`badge`/`closedByUser` |
| `src/views/save-settings.ts`, `save-question.ts` | „Zapis haseł” (przełącznik `onToggle`, lista „Nigdy” `neverHosts`) i pytanie w okienku po odblokowaniu (`showUnlocked` w `locked.ts` pyta tło o kandydata karty) |
| `src/page-mode.ts`, `src/open-in-tab.ts` | tryby strony, przycisk „Otwórz w karcie ↗” (`OpenTabApi`, `chromeOpenTabApi`) |
| `src/ui/dom.ts` | pomocniki DOM: `h`, `show`, `form`, `passwordField` i `secretField` (pole wrażliwe: „Pokaż/Ukryj”, „Kopiuj”; oba na wspólnym `visibilityToggle`), `pinInput({ autocomplete?, long? })`, `confirmButton`, `confirmBox`, `busy` |
| `src/ui/copy.ts`, `src/ui/status.ts` | kopiowanie (`copyText`, `copySecret` z czyszczeniem schowka), linia statusu |
| `src/ui/list-editor.ts` | `listEditor`: lista z „+ Dodaj” i „Usuń” (adresy, aplikacje, telefony, własne pola) |
| `src/ui/page.ts` | `MODE`, `IN_TAB`, `showInTab(tryb, widok)`, `openInTabButton` |
| `src/ui/phone-url-fields.ts`, `src/ui/pairing-code.ts` | pola adresów telefonu (`phoneUrlFields`), wzorzec zgody, prośby o zgodę Chrome, `submitPhoneUrls` (odczyt adresów → zgoda → `busy`); pole kodu parowania z etykietą (`pairingCodeField`) |
| `src/files/idb-file-store.ts`, `src/files/format-size.ts` | `IdbFileStore` (IndexedDB `passholder-files`: opisy plików i kawałki, zapis kawałek po kawałku, `uploadedEpoch`); `formatSize` („N KB”, „4,6 MB”) |
| `src/views/forms/attachments.ts`, `src/ui/download.ts` | sekcja „Załączniki” formularza (dodawanie, limity, ostrzeżenia, pobieranie) i zapis pliku przez `Blob` |
| `src/ui/state.ts` | jeden `VaultStore` strony, wspólny dla widoków |
| `src/views/*.ts` | ekrany: `connect` (parowanie), `locked`, `list` (zakładki typów), `edit` (formularz wpisu), `addresses`, `pin-settings`, `transfer`; `router.ts` (przejścia między ekranami po nazwie), `index.ts` (rejestracja), `notes.ts` (`skippedNote`) |
| `src/views/forms/*.ts` | części formularza: `login` (z `generator`), `contact`, `card`, `document`, `note`, `custom-fields` (własne pola) |
| `scripts/screenshots.mjs`, `test/screens/harness.ts` | zrzuty ekranów w Chromium z przykładowymi wpisami ([TESTY.md](TESTY.md#zrzuty-ekranów-wtyczki)) |

## `android/`

Dwa moduły Gradle: `core` (czysta JVM, testy bez emulatora) i `app` (Jetpack Compose).

| Plik (`android/core/.../core/`) | Co robi |
|---|---|
| `Encoding.kt`, `Kdf.kt`, `Aead.kt`, `VaultCrypto.kt`, `Generator.kt` | odpowiedniki plików z `core/src/` (`VaultCrypto`: klucz sejfu; `Encoding.fromUtf8OrNull`: ścisłe UTF-8 bez wyjątku) |
| `WebAddress.kt` | port `core/src/web-address.ts` (`normalizeHost`, `parseWebAddress`, `hostOf`) z własnym parserem adresu (IDN jak WHATWG) |
| `StrictJson.kt`, `AtomicFiles.kt` | pomocniki ścisłego JSON (`string`, `boolean`, `appendQuoted`) i zapis atomowy pliku (patrz „Wspólne pomocniki” niżej) |
| `Errors.kt` | `PassHolderException` (pole `code: ErrorCode`, `detail`, `cause`), `hasErrorCode`, `requireCode`/`checkCode`: odpowiednik `core/src/errors.ts` (patrz „Błędy” niżej) |
| `Protocol.kt` | `RemoteRecord`, `ChangeRequest`, `Accepted`, `SyncResponse` |
| `p2p/Hlc.kt`, `Entry.kt`, `P2pJson.kt` | HLC, wpis v3 (`EntryCodec`: modele, ścisły parser, serializacja w kolejności z TypeScriptu, limit, odczyt v2 jako login), wspólny `Json` |
| `p2p/RistrettoPoint.kt`, `Cpace.kt`, `Pairing.kt`, `PairingHost.kt`, `ReportError.kt` | parowanie: grupa, CPace, kod i zapieczętowane wiadomości, strona telefonu po HTTP; `reportError` (wspólny dla hostów: błąd zgłaszany bez wpływu na odpowiedź) |
| `p2p/Noise.kt`, `Frames.kt`, `P2pHost.kt`, `HostSync.kt`, `P2pPaths.kt` | Noise KK, ramki, host synchronizacji (`/p2p/v2/*`, stare ścieżki → 410; `HostReply.error`; `handle` przyjmuje bajty albo gotowy `JsonObject` z `PhoneRouter`), stałe ścieżek HTTP, `HostSync.parse` (błąd `InvalidSyncRequest` → 400), `processSync` i budżet bajtów rundy (`pageRecords`) |
| `p2p/SyncHttpServer.kt`, `PhoneRouter.kt`, `LocalAddresses.kt` | serwer HTTP na porcie 8787 z limitami, trasy `/p2p/v1/pair/*`, `/p2p/v1/ping` i `/p2p/v2/*` (stare `/p2p/v1/handshake` i `/sync` przekazane do hosta, który odpowiada 410), adresy telefonu |
| `transfer/Common.kt`, `Csv.kt`, `JsonText.kt`, `PassHolderJson.kt`, `BitwardenJson.kt`, `NordPassCsv.kt`, `Transfer.kt`, `PassHolderZip.kt`, `ArchiveReader.kt` | pakiet `core.transfer`: ZIP bez `ZipInputStream` (własny strumieniowy parser: CRC i pomijanie pliku bez rozpakowania, budżet rozpakowywania; zapis `java.util.zip`); port `core/src/transfer/` (`contentKey`, `sortForExport` na `RuleBasedCollator` zgodnym z wektorem `sort.json`, CSV RFC 4180, serializacja JSON jak `JSON.stringify`, `Transfer.parseImportFile` i `exportFile`); te same pliki przykładowe z `core/test-vectors/transfer/` |
| `files/Attachment.kt`, `FileChunks.kt`, `FileHost.kt`, `DiskFileStore.kt` | pliki w sejfie (port `core/src/files/` bez klienta): opis załącznika (stałe, ścisły parser), szyfrowanie kawałkami (`FileSecrets`), host `/p2p/v2/file` (`FileHost`: `parse` do `FileRequest`, funkcja na operację; `FileStore.put(FileChunk, now)`) i magazyn na dysku telefonu (`p2p/files/`, zapis przez `AtomicFiles.write`); `P2pHost` dostaje magazyn jako ostatni parametr |
| `p2p/PhoneVaultStore.kt` (fasada) i jego części `HostStorage.kt`, `VaultLifecycle.kt`, `VaultKeys.kt`, `PhoneSession.kt`, `PhoneEntries.kt`, `PhoneFiles.kt`, `PhoneArchiveImport.kt`, `PhoneSyncMode.kt` (patrz „Podział `PhoneVaultStore`” niżej); `PhoneVault.kt`, `FileSyncStore.kt`, `HostState.kt` (`HostPhase`) | sejf telefonu: tworzenie, odtwarzanie, blokada (15 min), wpisy (`entries()` zwraca wszystkie typy, `upsertContent` zapisuje dokładnie podaną treść i odmawia nadpisania wpisu innego typu), urządzenia; pliki `records.jsonl` i `host.json`; import: `importContents` (duplikaty po `contentKey`, jeden zapis) i `allContents`; pliki: `addFile`, `isFileComplete`, `readFile`, `pruneFiles`, `discardFiles` (kasuje podane pliki poza używanymi przez żywy wpis), kasowanie przy zmianie epoki |
| `autofill/Keywords.kt`, `Fields.kt`, `Values.kt`, `Match.kt`, `AppRequest.kt`, `PublicSuffix.kt` | port `core/src/autofill/` 1:1 (`classifyField`, `planFor`, `fillValue`, `matchUrl` na `parseWebAddress`, `matchLogins`, `publicSuffix`/`registrableDomain` z zasobu `public_suffix_rules.txt`) na tych samych wektorach `{match,psl,fields,values}.json`; `matchApp`: przeglądarka zweryfikowana podpisem (`AppRequest.browserVerified`; 13 pakietów z certyfikatami SHA-256 w `TRUSTED_BROWSERS`) z `webDomain` → `matchLogins` (brak `webScheme` = `http`, `pageScheme`), inaczej loginy z pakietem w `androidApps`, po nazwie, tylko przy `appVerified`; `verifyApp` ustawia obie flagi z certyfikatów pakietu i zapamiętanych (V3-S3; `AppRequest`, `TRUSTED_BROWSERS` i `verifyApp` w `AppRequest.kt`); wektory `test-vectors/autofill/app.json` (tylko Kotlin) |
| `autofill/Planner.kt` | `planRequest`: grupa formularza (login, karta, kontakt) i jej pola; `planDatasets`: pasujące wpisy → wartości pól (`ListIndex` dla list), bez wpisów bez wartości, najwyżej 10; generyczne po typie id pola, więc testowane bez Androida |
| `save/SaveUrl.kt`, `Decide.kt`, `SaveFields.kt` | port `core/src/save/` (`saveUrl`, `saveName`, `decideSave`; te same wektory `core/test-vectors/save/{url,decide}.json`) plus `saveFields` (pole hasła: pierwsze nowe hasło, inaczej hasło; login: pole loginu, inaczej ostatni e-mail przed hasłem), `saveTargetFor` (zaufana przeglądarka z domeną → `Web`, inaczej `App` z pakietem), `newLogin`, `withPassword` |
| `SyncStore.putAll` (w `p2p/HostSync.kt`), `p2p/FileSyncStore.kt` | `putAll`: wiele rekordów jednym dopisem i `fsync` (import atomowy); domyślnie pętla `put` |

| Plik (`android/app/.../app/`) | Co robi |
|---|---|
| `PassHolderApp.kt` | obiekt procesu: jeden `PhoneVaultStore`, `LeaveLock`, ustawienia (m.in. `askToSave`), `pendingSave`, odcisk, haki testowe autouzupełniania |
| `MainActivity.kt` | `onStart` / `onStop` (powrót i wyjście z aplikacji), ekran nie gaśnie w trybie Synchronizacja, blokada zrzutów ekranu |
| `AppViewModel.kt`, `UiState.kt`, `UiStateHolder.kt`, `*Model.kt` | model ekranów złożony z części (zob. [Podział `AppViewModel`](#podział-appviewmodel)): stan `UiState`, operacje na sejfie w tle (`launchOperation`), nawigacja, sejf, odcisk, synchronizacja, ustawienia, wpisy, załączniki, import i eksport |
| `SyncController.kt` | tryb Synchronizacja: start i stop serwera, kod parowania, zdarzenia, zatrzymanie po 5 min bez synchronizacji |
| `SyncNetworks.kt` | adresy, na których odpowiada tryb Synchronizacja: Wi-Fi, Ethernet i Tailscale, bez sieci komórkowej (`ConnectivityManager`) |
| `KeystoreSecretWrapper.kt` | zawija klucz tożsamości telefonu kluczem z Android Keystore |
| `LockController.kt` | kiedy sejf się blokuje (wyjście z aplikacji, 15 minut, „Zablokuj”) i kiedy samo otwiera się okno odcisku |
| `LeaveLock.kt` | minutnik blokady 60 s po wyjściu z aplikacji (`schedule()`, `expired()`, `cancel()`; pytanie o upływ czasu jest osobno od zatrzymania); `lockNow()` przy wyłączeniu ekranu (odbiornik `ACTION_SCREEN_OFF` w `PassHolderApp`) |
| `MasterPasswordRules.kt` | reguły nowego hasła głównego: 12 znaków i bez oczywistych wzorców |
| `ErrorMessages.kt` | `errorMessage(error)`: jedyne miejsce, gdzie kod błędu rdzenia staje się polskim tekstem (odpowiednik `extension/src/error-messages.ts`) |
| `ImportSummary.kt`, `TransferFiles.kt` | podsumowanie importu (port `import-summary.ts`, także pliki ZIP); czytanie pliku (limit 10 MiB, ścisły UTF-8), rozpoznanie ZIP, strumień archiwum (limit 256 MiB, `PhoneVaultStore.importArchive`) i zapis, nazwa pliku |
| `AttachmentFiles.kt`, `FileSize.kt` | wybrany plik (nazwa i rozmiar z `OpenableColumns`, najwyżej 10 MiB + 1 bajt, kolejność sprawdzeń jak we wtyczce), zapis przez `CreateDocumentOf` (własny kontrakt: nazwa i typ, tryb `"wt"`); `formatSize` („N KB”, „4,6 MB”) |
| `BiometricController.kt`, `BiometricUnlock.kt`, `BiometricKeyProtector.kt`, `FingerprintPrompt.kt` | odcisk palca: zaszyfrowany klucz sejfu (`BiometricUnlock`, `exportVaultKey`/`unlockWithVaultKey`), klucz w Android Keystore (`BiometricKeyProtector`/`KeystoreKeyProtector`; StrongBox, gdy jest; tylko przy odblokowanym telefonie), systemowe okno odcisku (`FingerprintPrompt`) |
| `InstalledApps.kt` | aplikacje z ikoną w launcherze (`PackageManager`; w manifeście `<queries>` MAIN + LAUNCHER, bez `QUERY_ALL_PACKAGES`) |
| `AppTrust.kt` | V3-S3: `SystemAppSigners` czyta SHA-256 certyfikatów pakietu (Android 9+: historia podpisu albo wszyscy sygnatariusze, niżej `signatures`; niewidoczny pakiet → `null`); `AppTrust.verify` ustawia flagi `AppRequest` (`verifyApp` z rdzenia), `remember`/`rememberIfNew` zapamiętują certyfikat pakietu w `SharedPreferences` `app_certs`. Wołane w `buildFillResponse` (i tam zaufanie przy pierwszym użyciu dla pakietu z `androidApps`), `readSaveData`, `saveSubmitted` (nowy login aplikacji) i przy wyborze aplikacji w formularzu loginu; w manifeście `<queries>` także 13 pakietów przeglądarek |
| `entries/EntryTypes.kt` | `EntryType`, opis wiersza, wyszukiwanie, `tidy`, walidacja (port `extension/src/entry-types.ts`) |
| `SecureClipboard.kt` | kopiowanie i czyszczenie schowka po minucie (WorkManager; w zadaniu tylko HMAC hasła z kluczem procesu) |
| `autofill/ViewNodeReader.kt` | `AssistStructure` → `ParsedRequest`: pakiet, `webDomain`/`webScheme`, widoczne i włączone pola tekstowe i list (`describeNode`: `htmlInfo`, `autofillHints`, `inputType`, `idEntry`, podpowiedź) |
| `autofill/PassHolderAutofillService.kt` | usługa (`BIND_AUTOFILL_SERVICE`): `respond` (własny pakiet, brak sejfu → `null`; ekran bez pól do wypełnienia: odpowiedź tylko z `SaveInfo`, gdy ma pole hasła, inaczej `null`; zablokowany → „Odblokuj PassHolder”; inaczej `buildFillResponse`), praca w osobnym wątku; `onSaveRequest` czyta `readSaveData`: API ≥ 28 zawsze kandydat do `pendingSave` i `onSuccess(savePendingIntent)` (podgląd w `AutofillSaveActivity`); API < 28 `saveLogin` od razu, zablokowany → `onFailure`. Ekran logowania bez pasujących wpisów też dostaje `SaveInfo` |
| `autofill/ResponseBuilder.kt` | `ResponseBuilder(context, inline)` (`datasets`, `locked`, `inlinePresentation`) i `saveOnlyResponse`; `FillResponse`: `Dataset` z wierszem `res/layout/autofill_item.xml` i, na API 30+, podpowiedzią w pasku klawiatury (`androidx.autofill` `InlineSuggestionUi`, ≤ `min(10, maxSuggestionCount)`); `SaveInfo` (hasło + login, `FLAG_SAVE_ON_ALL_VIEWS_INVISIBLE`) dla każdego ekranu z polem hasła (także „nowe hasło”, każda grupa) przy włączonym „Pytaj o zapis haseł”, id pól i opis aplikacji w `clientState` |
| `autofill/AutofillUnlockActivity.kt`, `ui/AutofillUnlockScreen.kt` | ekran odblokowania z podpowiedzi (podklasa `AutofillAuthActivity`): po odblokowaniu buduje odpowiedź i zwraca `EXTRA_AUTHENTICATION_RESULT` |
| `autofill/SaveState.kt` | `SaveSpec` (pola i aplikacja z chwili wypełniania), `saveSpecFor` (przełącznik, pole hasła; grupa bez znaczenia), `clientState` i jego odczyt (`saveSpecIds`); obejście API 33 dla `Parcelable` w `autofill/Parcelables.kt` (`Intent.parcelable`, `Bundle.parcelable`) |
| `autofill/SaveLogin.kt` | `saveLogin` (tylko API 26–27: zapis bez podglądu, przez `saveSubmitted` z danymi jak wpisane; wynik `SAVED`/`UPDATED`/`NOTHING`/`LOCKED`), `readSaveData` (wartości po id ze wszystkich `fillContexts`, od ostatniego), komunikaty, `appLabelOf` |
| `autofill/PendingSave.kt` | kandydat każdego zapisu (API ≥ 28) do chwili otwarcia podglądu: tylko pamięć procesu, 2 minuty (`app.clock`), jeden naraz; `take()` zabiera, `hasFresh()` tylko pyta |
| `autofill/AutofillAuthActivity.kt`, `AutofillSaveActivity.kt` | wspólna baza (stan w jednym typie `AuthPhase`: `Locked`/`Skipping`/`Open`/`Delivered`; odblokowanie tylko gdy sejf zablokowany: hasło / odcisk; haki `afterUnlock`, `UnlockedContent`, `onLockedWhileOpen`, `unlockAgain`; Wstecz i Anuluj = `RESULT_CANCELED`, blokada D1 także po wyjściu w tło, anulowanie starego terminu 60 s) i ekran zapisu: odblokowanie, potem podgląd (`exported="false"`, `FLAG_SECURE`) |
| `autofill/SaveReview.kt`, `ui/SaveReviewScreen.kt` | `SaveReview` (wpisy sejfu odszyfrowane raz, `decision`/`title`/`initialDraft` z `SaveDraft`), `saveReviewed`/`saveSubmitted` (ponowny odczyt sejfu, `decideSave` od nowa, `upsertContent`; wynik `SaveOutcome`), `SaveReviewModel` (ViewModel: kandydat, szkic, blokada w trakcie podglądu; bez stanu instancji) i ekran Compose „Zapisz w PassHolder” (Nazwa, Login, Hasło, adres/aplikacja tylko do odczytu) |
| `AutofillStatus.kt` | czy PassHolder jest usługą autouzupełniania (`hasEnabledAutofillServices`), wiersz w `SettingsScreen` |
| `ui/*.kt` | ekrany Compose: `StartScreen`, `LockedScreen`, `ListScreen` (dolny pasek zakładek), `EditScreen` (powłoka formularza), `SettingsScreen`, `ChangePasswordScreen` (zmiana hasła głównego), `TransferScreen` (import i eksport; okno wyboru pliku 60 s w `LockController.expectFilePicker`), `VaultTopBar`, `SyncScreen`, `DevicesScreen`, `RestoreScreen`, `FingerprintDialog`, `Common` (`SecretField`, `MasterPasswordField`, `SettingSwitchRow`…), `UnlockForm`, `Dialogs` (`ConfirmDialog`, `DisconnectDialog`), `FilePicker` (`launchPicker`), `PassHolderUi` (wybór ekranu i przekazanie grup akcji), `ScreenActions` (interfejsy akcji dla ekranów) |
| `ui/forms/*.kt` | `LoginForm`, `ContactForm`, `CardForm`, `DocumentForm` (notatka używa samej powłoki), `ListEditor`, `AttachmentsEditor` (sekcja „Załączniki”), `CustomFieldsEditor`, `GeneratorCard`, `AppPickerDialog` |

## Konwencje nazw i kodu

Ustalone w grupie G3 przeglądu czystości kodu V3.

- **Bez numerów wersji w nazwach.** Typy i funkcje nazywają się `LocalVault`, `EntryContent`, `syncVault`,
  `EntryCodec`. Wersja zostaje tylko w danych: `version: 3` we wpisie, AAD `passholder/v2/…`, klucze
  `chrome.storage` (`vaultV2`, `accountV2`), nazwy plików wektorów (`v2.json`, `v3.json`) i ich testów.
- **Pytanie osobno od polecenia.** Funkcja, która coś zmienia, nie zwraca odpowiedzi tak/nie (`LeaveLock.cancel()`
  nic nie zwraca, pyta się `expired()`; `PendingSave.hasFresh()` tylko pyta, `take()` zabiera).
- **Nazwa mówi, co zwraca.** `readHlc` zwraca HLC, `#sessionLimitReply` odpowiedź 503 albo `undefined`.
  Bez nazw jednoliterowych poza krótkimi lambdami i pętlami (`hostState`, `attachment`, `fileStore`).
- **Prywatne pola w TypeScript:** w `core/` `#pole` (prywatne także w czasie działania), we wtyczce `private`
  (klasy z parametrami konstruktora `private readonly deps`).
- **Zmienna błędu:** `catch (error)` w TypeScript, `catch (e: Typ)` w Kotlinie, `catch (_: Typ)`, gdy nieużywana.
- **Brak wartości w TypeScript:** `undefined` dla pola opcjonalnego i wyniku „nie znaleziono”; `null` tylko tam,
  gdzie wartość jest częścią formatu JSON albo stanu („brak decyzji”, `decision: null`). Istniejący kod nie był
  przepisywany masowo.
- **Stałe w Kotlinie:** stała jednej klasy w jej `companion object`, stała modułu (kilku klas) na poziomie pliku.
- **Pliki w Kotlinie:** plik z jedną klasą nosi jej nazwę (reguła ktlint `standard:filename`, włączona);
  typy pomocnicze stoją przed kodem, który ich używa; bez pełnych nazw pakietów w kodzie (zawsze `import`).
- **Wiadomości we wtyczce:** jeden nasłuch na kontekst, rozdział po `type`; publiczne metody `SaveCandidates`
  to `onX` (kolejkują w `serial`), prywatne `handleX` (wykonują).
- **Stan jako unia:** zamiast pary pól, z których jedno ma sens tylko przy drugim, unia z dyskryminatorem
  (`SavePromptInfo`: `{ locked: true; decision: null }` albo `{ locked: false; decision; entryName? }`).

## Błędy

Ustalone w grupie G4 przeglądu czystości kodu V3 (decyzja D4: rdzeń zgłasza kody, teksty w warstwie UI).

- **Rdzeń (`core/`) rzuca `PassHolderError` z kodem** dla wszystkiego, co aplikacja musi rozpoznać albo pokazać:
  rozmowa z telefonem (`HOST_MALFORMED`, `HOST_ERROR`, `DEVICE_NOT_PAIRED`, `PHONE_UPDATE_REQUIRED`,
  `NOISE_FAILED`), parowanie (`PAIRING_*`), wpisy i synchronizacja (`ENTRY_TOO_LARGE`, `ENTRY_TOO_LARGE_TO_SYNC`
  z nazwą w `detail`, `SYNC_*`), pliki (`FILE_*`), import (`IMPORT_*`, linia CSV w `detail`) i ZIP (`ZIP_*`,
  `ARCHIVE_FILE_*`). Komunikat jest po angielsku, tylko do logów; teksty rdzenia, które trafiają do wektorów
  testowych (np. „Invalid entry payload”), nie zmieniły się.
- **Rozpoznawanie tylko po kodzie:** `hasErrorCode(error, "ENTRY_TOO_LARGE")`, nigdy `error.message === …`.
  Nowy kod dopisuje się do unii `ErrorCode`; kompilator wymaga wtedy tekstu w `extension/src/error-messages.ts`
  (`Record<ErrorCode, …>`).
- **Błędy programisty** (zły argument, zła długość klucza, niespójny stan Noise poza `NOISE_FAILED`) zostają
  zwykłym `Error`: użytkownik nie powinien ich zobaczyć.
- **Wtyczka tłumaczy w jednym miejscu:** `VaultStore` przepuszcza wywołania rdzenia przez `inUserTerms` /
  `toUserError`, więc jego błędy mają polski `message`; ekrany pokazują każdy błąd przez `errorMessage(error)`
  (też kody, które ominęły `VaultStore`, np. `parseImportFile` w widoku importu). Własne błędy wtyczki
  („Złe hasło główne”, „Sejf jest zablokowany”) są polskie od razu.
- **Trzy kształty porażki:** wyjątek dla błędu akcji; `ActionResult` dla wyniku przesyłanego wiadomością;
  walidacja formularza zwraca pierwszy tekst błędu albo `undefined` (`validateContent`, `phoneUrlFields().read()`).
- **Bez rzutowań błędu:** `catch (error)` ma typ `unknown`; tekst bierze się przez `errorMessage(error)`, nie
  `(error as Error).message`. Błąd rzucony w `catch` dostaje `cause` (reguła ESLint `preserve-caught-error`).

### Kotlin (Android)

Ustalone w grupie G5, te same zasady co w TypeScripcie.

- **`android/core` rzuca `PassHolderException` z kodem** (`enum class ErrorCode` w `Errors.kt`): sejf na
  telefonie (`VAULT_*`, `NO_VAULT`, `WRONG_MASTER_PASSWORD`, `WRONG_UNLOCK_KEYS`, `PASSWORD_UNCHANGED`,
  `NO_SPACE`), odtwarzanie (`RESTORE_*`), wpisy (`ENTRY_TOO_LARGE`, `ENTRY_TYPE_MISMATCH`; zastąpiły klasy
  `EntryTooLargeException` i `EntryTypeMismatchException`), generator (`GENERATOR_*`), Noise (`NOISE_FAILED`,
  komunikat „Noise: …” jak w `noise.ts`), pliki (`FILE_*`), import (`IMPORT_*`, linia CSV w `detail`) i ZIP
  (`ZIP_*`). Nazwy kodów wspólnych z TS są takie same. Komunikat jest po angielsku; teksty z wektorów testowych
  („Invalid entry payload”, „Entry too large”) się nie zmieniły.
- **Rozpoznawanie tylko po kodzie:** `catch (e: PassHolderException) { if (e.code != ErrorCode.X) throw e … }`
  albo `e.hasErrorCode(…)`, nigdy po `message` ani po ogólnym typie. Przykłady: `P2pHost` (nieudane Noise → 400),
  `ArchiveReader.readIndex` (`IMPORT_NOT_PASSHOLDER` → `ZIP_NOT_PASSHOLDER`), `TransferFiles.writeArchive`
  (`VAULT_LOCKED` → „Nie udało się zapisać pliku…”), `TransferModel.readForExport` (`FILE_CORRUPTED` → plik
  pominięty), `BiometricController.unlock` (`WRONG_UNLOCK_KEYS` → odcisk wyłączony).
- **Teksty:** `errorMessage(error)` w `app/ErrorMessages.kt`; `when` bez `else`, więc nowy kod nie skompiluje
  się bez tekstu. Ekrany i `launchVaultOperation` pokazują każdy błąd przez `errorMessage`. Własne błędy
  aplikacji (`TransferFiles`, `AttachmentFiles`, `SyncController`, `BiometricController`) są polskie od razu.
- **Zostają zwykłymi wyjątkami:** błędy programisty (`require`/`check` bez kodu), stan wewnętrzny (`"No host
  state"`, uszkodzony `host.json` / `records.jsonl` jako `IllegalStateException` łapany tylko w
  `HostStorage.reload`) i walidacja danych z sieci po stronie hosta (CPace, `Pairing`, Base64, HLC,
  `Frames` poza `NOISE_FAILED`): ta zamienia się na kod HTTP w jednym miejscu i nie trafia do użytkownika.
- **Porażka bez wyjątku:** `PassHolderJson` zwraca `null` dla złego wpisu indeksu (zamiast pustego
  `IllegalArgumentException` jako „pomiń”), `forgetFingerprint()` zwraca `Result<Unit>`. Powody pominięcia
  w podsumowaniu importu (`ImportSkip.reason`) są nadal polskim tekstem rdzenia, tak jak w TS.

## Wspólne pomocniki

Ustalone w grupie G6 przeglądu czystości kodu V3. Mały pomocnik, którego potrzebują dwa pliki, ma jedno miejsce;
nowy kod używa go zamiast pisać własną kopię.

| Potrzeba | TypeScript | Kotlin |
|---|---|---|
| obiekt JSON (nie `null`, nie tablica) | `isRecord` (`core/src/strict-json.ts`) | `value is JsonObject` |
| dokładnie te klucze | `hasExactKeys(value, keys)` | `value.keys != KEYS` (zbiór) |
| napis albo porażka | `requireString(value, () => błąd)`; w transporcie `responseString` (`HOST_MALFORMED`) | `StrictJson.string(value)` (null dla innego typu), `?: fail()` |
| prawda/fałsz albo null | – | `StrictJson.boolean(value)` (napis `"true"` to null) |
| napis JSON jak `JSON.stringify` | – | `StrictJson.appendQuoted(sb, s)` (`EntryCodec`, `JsonText`) |
| „Invalid entry payload” | `INVALID_ENTRY`, `invalidEntry()` w `files/attachment.ts` (też dla `p2p/entry.ts`) | `INVALID_ENTRY` w każdym parserze |
| odpowiedź błędu hosta | `errorReply(status, error)` (`p2p/host-reply.ts`) | `HostReply.error(status, error)`; `FileHost` ma własny `FileReply` |
| ścieżki HTTP | `P2P_*_PATH` w `p2p/transport.ts` | `P2pPaths` (`p2p/P2pPaths.kt`) |
| łączenie bajtów | `concat(...parts)`, dla długiej listy `concatAll(parts)` | `+` / `copyInto` |
| porównanie bajtów | `sameBytes` (stały czas, `encoding.ts`) | `contentEquals` / `MessageDigest.isEqual` |
| SHA-256 jako hex | `files.sha256Hex(bytes)` (wtyczka: `sha256Hex(utf8(text))` w `clipboard.ts`) | `Encoding.sha256Hex(bytes)` |
| adres Tailscale (100.64.0.0/10) | – | `LocalAddresses.isTailscale(address)` |
| ścisłe UTF-8 | `fromUtf8` | `Encoding.fromUtf8` (wyjątek) / `fromUtf8OrNull` |
| zapis atomowy pliku | – | `AtomicFiles.write(file, bytes)`: `.tmp`, `fsync`, `rename`, `fsync` katalogu |
| plik z systemowego okna wyboru | – | `ProviderStreams.readCapped(input, limit, knownSize)` i `failingAs(tekst) { … }` (`app/ProviderStreams.kt`) |

- **`failingAs`** zamienia błąd dostawcy dokumentu (`IOException`, `SecurityException`; z `anyRuntime = true`
  każdy `RuntimeException`) na `IOException` z polskim tekstem i **zawsze z przyczyną** (`cause`), więc log
  pokazuje prawdziwy błąd, a użytkownik nasz tekst.
- **`readCapped`** czyta najwyżej `limit + 1` bajtów do jednej tablicy i zeruje każdą większą (bez buforów
  strumienia, które trzymałyby jawny tekst). Bajt ponad limit oznacza „za duży”; komunikat wybiera wywołujący.

## Stałe, limity i teksty

Ustalone w grupie G7 przeglądu czystości kodu V3. Każda liczba i każdy limit mają jedną definicję. Tekst, który
podaje limit („najwyżej 20 plików”, „10 MB”, „15 minut”), jest budowany ze stałej, więc zmiana stałej zmienia też tekst.

**Rozmiary i długości kryptograficzne.** `core/src/sizes.ts` i `android/core/.../core/Sizes.kt` mają `KIB`, `MIB`,
`KEY_BYTES` (32), `SALT_BYTES` (16), `GCM_NONCE_BYTES` (12), `GCM_TAG_BYTES` (16) i `RANDOM_ID_BYTES` (16: epoka, id sesji).
Narzut `seal` (1 + 12 + 16 = 29) to `SEAL_OVERHEAD_BYTES` w `cipher.ts` / `Aead.kt`. Wartości pochodne liczy się
ze stałych, np. `MAX_FILE_CHUNKS = MAX_FILE_SIZE / FILE_CHUNK_SIZE`, `MAX_FRAME_PLAINTEXT = 65535 − GCM_TAG_BYTES`,
`MAX_FILE_BLOB_LENGTH = 4 · ⌈(29 + FILE_CHUNK_SIZE) / 3⌉`. W ZIP rozmiary nagłówków (30/46/22) i metody (0/8) mają nazwy.

**Gdzie jest która stała** (TS / Kotlin):

| Stała | TypeScript | Kotlin |
|---|---|---|
| długość `deviceId` (64) | `MAX_DEVICE_ID_LENGTH` w `p2p/hlc.ts` | `MAX_DEVICE_ID_LENGTH` w `p2p/Hlc.kt` (najwyżej poziom pakietu) |
| kod parowania: 8 cyfr, 2 min | `PAIRING_CODE_LENGTH`, `PAIRING_CODE_TTL_MS` w `p2p/pairing.ts` | `Pairing.CODE_LENGTH`, `PAIRING_CODE_TTL_MS` w `PairingHost.kt` |
| najwięcej id w `status` (500) | `MAX_STATUS_IDS` w `files/host-files.ts` | `Attachments.MAX_STATUS_IDS` |
| typy wpisów i ich kolejność | `ENTRY_TYPES` w `p2p/entry.ts` (z niej typ `EntryType`) | `ENTRY_TYPE_ORDER` w `transfer/Common.kt` |
| rodzaje dokumentów | `DOCUMENT_KINDS`, `isDocumentKind` w `p2p/entry.ts` | `DocumentKind` (enum) |
| data ważności karty `MM/RR`, data `RRRR-MM-DD` | `CARD_EXPIRY`, `isCalendarDate` w `field-formats.ts` | `FieldFormats.CARD_EXPIRY`, `FieldFormats.isCalendarDate` |

`field-formats.ts` nie importuje niczego, bo trafia do skryptu autouzupełniania wstrzykiwanego do strony. W Kotlinie
wzorce używają `[0-9]`, nie `\d` (na Androidzie `\d` łapie też cyfry spoza ASCII).

**Teksty.** Błędy z kodami są w `extension/src/error-messages.ts` i `app/ErrorMessages.kt` (grupy G4/G5). Teksty
wspólne dla kilku ekranów: `extension/src/ui/texts.ts` (`MASTER_PASSWORD_LABEL`, `LOCKED_TITLE`),
`extension/src/ui/pairing-code.ts` (pole kodu parowania i jego etykieta) oraz `app/UiTexts.kt` (`UNLOCK_TITLE`,
`PASSWORDS_DIFFER`); podpowiedź pod hasłem głównym to `MasterPasswordRules.HINT`. Kod sprawdzany w aplikacji bez
wyjątku dostaje tekst przez `errorMessage(ErrorCode)`.

Teksty, które trafiają do plików eksportu, są w rdzeniu (`transfer/common.ts`, `transfer/Common.kt`):
`DOCUMENT_KIND_NAMES` (nazwy rodzajów dokumentu, też w formularzu i na liście), `DOCUMENT_LABELS` /
`DocumentLabels` (etykiety pól dokumentu w Bitwarden i NordPass; numer ma różne etykiety: „Numer dokumentu” i „Numer”)
oraz powody pominięcia `SKIP_BAD_ENTRY` i `SKIP_NO_NAME`. Kopertę pliku PassHolder (`format`, `version: 3`, `entries`)
buduje jedna funkcja: `passHolderJsonText` / `PassHolderJson.text`, dla eksportu JSON i dla indeksu ZIP.

## Protokół synchronizacji i plików

Ustalone w grupie G8 przeglądu czystości kodu V3. Zachowanie i wektory testowe się nie zmieniły.

- **Żądanie parsowane raz.** Host zamienia odszyfrowany JSON na typ jedną funkcją (`parseP2pSyncRequest` /
  `HostSync.parse`, w plikach `parseRequest` / `FileHost.parse`), która zwraca gotowe żądanie albo zgłasza błąd
  z tekstem odpowiedzi 400 (`InvalidSyncRequestError` / `InvalidSyncRequest`). Bez ponownego czytania pól i bez `!!`.
  `processP2pSync` / `HostSync.process` wołają ją same; host (`P2pHost`) nie waliduje osobno, tylko zamienia ten błąd
  na 400. Sprawdzenie `baseRevision` w magazynie (`checkBaseRevisions`) jest w tej samej blokadzie co zapis.
- **Jedna funkcja, jedna praca.** Odpowiedź telefonu w kliencie: `markAccepted` (rewizje przyjętych zmian) i
  `resolveRemote` (jeden rekord: HLC, łączenie załączników, starsza wersja ignorowana). Faza plików: `planFiles`,
  `uploadAll`, `downloadAll`. Host: `pageRecords` tnie odpowiedź do budżetu; host plików ma funkcję na operację.
  `P2pHost.handshake` (Kotlin) ma osobne `respond` (Noise), `PairingHost.finish` osobne `completePairing`,
  `SyncHttpServer.readRequest` osobne `parseHeaders`, `contentLength`, `readBody`.
- **Mniej parametrów.** Wspólny stan to obiekt: `SyncContext` (sejf, klucz, zegar), `FileContext` (magazyn,
  transport, epoka), `FileSyncOptions` (`onProgress`, `skip`), `FileChunk` (`id`, `index`, `chunks`, `blob`) w
  `FileStore.put(chunk, now)`, `FileSecrets` (`id`, klucz, nonce) w szyfrowaniu plików.
- **JSON parsowany raz na telefonie.** `PhoneRouter` parsuje ciało i podaje `JsonObject` do `P2pHost.handle`.
  Limit `MAX_BODY_BYTES` sprawdza wtedy `SyncHttpServer` (przed czytaniem ciała); wariant z bajtami sprawdza go sam.
- **Parowanie typowane.** TS ma pary `sealIdentity`/`openIdentity` i `sealVaultInfo`/`openVaultInfo` jak Kotlin
  (bez `kind` i rzutowań). Pola sprawdzane raz: `checkBase64` zwraca sprawdzony tekst.
- **Zaczepy testowe poza publicznym API.** Funkcje produkcyjne nie mają parametrów „tylko dla wektorów”. Stała
  losowość ma osobne funkcje: TS `sealWithNonce`, `encryptFileFixed`, `NoiseKK.initiatorWithEphemeral` /
  `responderWithEphemeral`, `_cpaceInternals.startWithScalar`; Kotlin przeciążenia `internal` (`Aead.seal(…, nonce)`,
  `Pairing.sealIdentity(…, nonce)`, `Cpace.start(…, ya)`, `NoiseKK.initiator(…, e)`, `FileChunks.encryptFixed`).
  Wektory pary i wpisów w TS sprawdza `sealWithNonce` na tym samym tekście JSON, który pieczętuje kod produkcyjny.
- **Poza G8:** `VaultStore.repair`, `decideFor` i konstruktor `VaultStore` (zrobione w G10, zob. „Podział
  `VaultStore` i pytania o zapis”), `ResponseBuilder` i `BiometricUnlock.authenticate` (G14), bo te grupy i tak
  zmieniają te pliki.

## Import, eksport i format wpisu

Ustalone w grupie G9 przeglądu czystości kodu V3 (CK4, CW6, CW8, CS5). Wektory testowe się nie zmieniły.

- **NordPass CSV** (`nordpass-csv.ts`, `NordPassCsv.kt`): pętla wierszy tylko składa kroki. `guessKind` daje typ
  wiersza (kolumna `type` albo zgadywanie po wypełnionych kolumnach) albo powód pominięcia, `rowToEntry` buduje wpis
  danego typu (kontakt: `contactFields`). Wiersz to funkcja `Row` (TS) / klasa `Row` (Kotlin): tekst kolumny albo `""`.
- **Bitwarden JSON** (`bitwarden-json.ts`, `BitwardenJson.kt`): wynik pozycji to typ `{ entry } | { skip }` /
  `ItemResult.Imported | Skipped` (bez napisu w roli błędu i `Any`). Typy pozycji i pól mają nazwy (`ItemType`,
  `FieldType`), etykiety pól własnych są w `LABELS` / `Labels`. Import: funkcja na typ (`importLogin`, `importCard`,
  `importContact`, `importDocument`; tożsamość wybiera między kontaktem a dokumentem), wspólne `ItemBase` (nazwa,
  notatka, pola własne). Eksport: `itemParts` → `exportLogin`/`exportCard`/`exportContact`/`exportDocument` zwracają
  typ, treść i dodatkowe pola (`ItemParts`), `exportItem` składa pozycję. Pomocniki mają pełne nazwy: `text`,
  `orNull`, `filledCustom`, `filledFields`.
- **Eksport ZIP** (Kotlin `PassHolderZip.export`): `plan` (pierwsze przejście: które pliki da się odczytać, numery
  ścieżek), `indexJson` (passholder.json), `writeZip` (indeks, potem pliki; `missing` z obu przejść).
- **Import archiwum**: wtyczka `VaultStore.importArchive` (od G10 w `VaultTransfer`) → `storeArchivedFiles` (pliki jednego wpisu) i
  `readArchivedFile` (rozmiar jak w opisie); typ `OpenedArchive` z `openPassHolderZip`. Telefon
  `PhoneVaultStore.importArchive` (od G12 w `PhoneArchiveImport`) → `prepare` → `storeFiles`; wynik to `ImportedArchive(parsed,
  result)` zamiast zagnieżdżonych par.
- **Format wpisu** (Kotlin `EntryCodec`): pola każdego typu opisane raz, w `FieldsSpec` (`write`: obiekt JSON w
  kolejności serializacji, `read`: budowa pól przez `FieldReader`). `FieldReader` notuje odczytane klucze, więc
  brakujący, nadmiarowy albo źle typowany klucz daje ten sam błąd „Invalid entry payload” co wcześniej.
  `serialize` i `contentJson` piszą to samo drzewo (`appendJson`: zwarty JSON jak `JSON.stringify`).
- **Normalizacja adresu** (`web-address.ts`, `WebAddress.kt`): `normalizeHost` (małe litery, bez `www.` na początku,
  potem bez jednej kropki na końcu), `parseWebAddress(tekst, assumeHttps)` (http/https, port `""` = domyślny),
  `hostOf` (host z dowolnym schematem). Kolejność kroków ustala wektor zapisu „empty host after www removal”:
  host `www.` nie ma hosta. Jedyna zmiana zachowania w G9: autouzupełnianie (`matchUrl`), które wcześniej z `www.`
  robiło `www`, też go odrzuca. Przy okazji Kotlin wyrównał się do wtyczki: nazwa wiersza NordPass z hostem IDN jest
  w punycode, a `saveUrl` bez `://` zwraca null (telefon zawsze podaje schemat).

## Podział `VaultStore` i pytania o zapis

Ustalone w grupie G10 przeglądu czystości kodu V3 (CK1, CW14, CS19, z G8: `repair`, `decideFor`). Zachowanie bez
zmian; zmieniły się tylko wywołania w kodzie (opcje konstruktora, adresy zawsze jako tablica).

`VaultStore` (fasada) tworzy części i podaje im wspólne zależności:

| Część | Plik | Za co odpowiada |
|---|---|---|
| `VaultSession` | `vault/session.ts` | sejf, klucz i zegar w pamięci strony; `require*` rzuca „Sejf jest zablokowany” po 15 min; `start`, `save` (sejf na dysk + przesunięcie terminu), `loadVault`, `resume`, `lockIfIdle`, `noteActivity`, `lock`; `isCurrent(vault)` = ta sama sesja |
| `AccountStore` | `vault/account.ts` | konto w `chrome.storage.local` (`get`, `require`, `save`, `setPhoneUrls`); funkcje `unwrapWithPassword`, `sealStaticKey`/`openStaticKey`/`opensStaticKey`, `identityOf` |
| `VaultEntries` | `vault/entries.ts` | `list`, `get`, `put` (pliki przed wpisem, przy odmowie usuwane), `delete`, `pendingCount`, `allContents` |
| `VaultFiles` | `vault/files.ts` | stan i odczyt pliku, `add`, `discard`, `prune` (pliki bez wpisu), `removeAll`, faza plików synchronizacji (`syncPhase`, lista uszkodzonych) |
| `VaultTransfer` | `vault/transfer.ts` | `importContents`, `exportArchive`, `importArchive` → `withStoredFiles` → `storeArchivedFiles` |
| `VaultSync` | `vault/sync.ts` | `sync`: adresy z zgodą Chrome (`splitByPermission`), wpisy, pliki, potem `learnAddresses` |
| `VaultPairing` | `vault/pairing.ts` | `start`, `finish`, `cancel`, `pendingInfo`, `repair` |

- **`repair`** składa kroki: `localCopy` (sejf tej przeglądarki, jeśli hasło go otwiera), sprawdzenie trybu telefonu
  (`phoneMode`), `pairWithPhone` (z `restoreInfo`, gdy jest lokalna kopia), w trybie „pair” `adoptPhoneVault`
  (klucz z kopii telefonu musi być kluczem tego sejfu), zapis konta i pierwsza synchronizacja. Kolejność sprawdzeń
  hasła i zużycia kodu jak wcześniej.
- **Adresy**: `pairStart` i `repair` przyjmują tylko tablicę (`readonly string[]`); `pairStart` nic nie zwraca.
  „Adres, który odpowiedział, potem reszta” to `answeredFirst`.
- **Uszkodzone pliki** (`FileSyncResult.corrupted`): jedna lista `{ id, name }` zamiast dwóch równoległych.
- **`save/candidates.ts`**: kandydat trzyma formularz jako `form: { origin, signature }` (było sklejone
  `origin|podpis` i rozcinane `split`). Loginy dla adresu są dopasowywane raz (`matching`), decyzję liczy
  `decideFor(logins, login, hasło)`, podgląd `previewDecision`. `handleAnswer` tylko rozdziela: `answerSave`
  („Zapisz”), `addToNever` i usunięcie kandydata („Później”, „Nigdy”). Pełne nazwy (`message`, `sender`, `candidate`).
  Kandydaci żyją w `chrome.storage.session`, którą Chrome czyści przy aktualizacji wtyczki, więc stary format
  nie wymaga migracji.

## Podział `PhoneVaultStore`

Ustalone w grupie G12 przeglądu czystości kodu V3 (CK2, CW4, CS10, CS13 część Kotlin). Zachowanie, publiczne API,
format `host.json` i kolejność blokad bez zmian.

`PhoneVaultStore` (fasada, `android/core/.../core/p2p/`) tworzy części i podaje im wspólne zależności (blokadę
sejfu, zegar, `onError`). Każda metoda fasady to jedno wywołanie części.

| Część | Plik | Za co odpowiada |
|---|---|---|
| `HostStorage` | `HostStorage.kt` | `host.json`, `records.jsonl`, `files/`; blokada stanu (każda metoda bierze ją sama, `locked { }` łączy kroki); `reload`, `save`, `update`, `reset`, `deleteAll`, `requireVault`; zamykane magazyny `ResettableStore`/`ResettableFileStore`; zbudowany `P2pHost` (`host(build)`) |
| `VaultKeys` | `VaultKeys.kt` | `keyCheck`, `matchesKeyCheck` (stały czas), `wrapWithPassword` (nowy salt), `unwrap` (granice KDF, V3-I5), `verifyPassword`, `wipeOnFailure` (zeruje klucz, gdy blok rzuci) |
| `VaultLifecycle` | `VaultLifecycle.kt` | `create`, `startRestore`, `finishRestore`, `changeMasterPassword`, `confirmMasterPassword`, `unlock`, `unlockWithVaultKey`, `exportVaultKey`, `disconnect`; `hasVault`, `restoreInProgress` |
| `PhoneSession` | `PhoneSession.kt` | klucz sejfu w pamięci, `require` (`VAULT_LOCKED`), `open`, `lock`, `touch`, `lockIfIdle` |
| `PhoneEntries` | `PhoneEntries.kt` | lista, odczyt, zapis, import, eksport (`allContents`), usuwanie, nieczytelne rekordy |
| `PhoneFiles` | `PhoneFiles.kt` | `add`, `isComplete`, `read`, `prune`, `discard`, `dropNew`, `usedIds` (pliki używane przez żywe wpisy, było 3 razy) |
| `PhoneArchiveImport` | `PhoneArchiveImport.kt` | import ZIP: `import` → `prepare` → `storeFiles` |
| `PhoneSyncMode` | `PhoneSyncMode.kt` | urządzenia, kody parowania (`PairingHost`), `router`, budowa `P2pHost`; odwołania parowania `identity`, `vaultInfo`, `onPaired` |

- **Stan hosta jako typ** (`HostState.phase`): `HostPhase.Ready(vault, keyCheck)`, `HostPhase.Restoring(sent)`
  (`sent` = KDF i klucz od wtyczki albo `null`), `HostPhase.Inconsistent` (sprawdzenie klucza bez KDF; tego stanu
  aplikacja nie zapisuje, traktowany jak brak sejfu). Plik `host.json` ma nadal pola nullowalne; kod czyta je tylko
  przez `phase` i `wrappedVault`. Poprawiony komentarz: odtwarzanie trwa, gdy `keyCheck == null` (nie `kdf`).
- **Bez `!!`**: `requireVault()` zwraca `HostPhase.Ready` z polami bez nulli. W kodzie produkcyjnym Androida nie ma
  już żadnego `!!`.
- **Blokady**: blokada sejfu to prywatny obiekt fasady (wcześniej monitor samej fasady; nikt z zewnątrz go nie
  używał). Kolejność: blokada sejfu → `PairingHost` → blokada stanu → magazyn rekordów / plików.
- **Zaczepy testowe**: `openedRecordsForTest()` i `builtHostForTest()` (`internal`) zamiast odczytu pól prywatnych
  przez refleksję w `PhoneVaultStoreTest`.

## Podział `AppViewModel`

Ustalone w grupie G13 przeglądu czystości kodu V3 (CK3, CW5, CW9, CS15). Zachowanie i wygląd ekranów bez zmian.

`AppViewModel` (`android/app/.../app/`) tylko składa części i obsługuje cykl życia aktywności (`onLeftApp`,
`onReturn`, `checkAutoLock` co 15 s, `touch`, `onCleared`). Ekrany nie dostają już całego modelu, tylko stan
(`UiState`) i grupy akcji, których używają. Grupy to interfejsy w `ui/ScreenActions.kt`; implementują je części
modelu. `PassHolderUi` rozdaje je ekranom (`vm.navigation`, `vm.vault`…).

| Część | Plik | Interfejs dla ekranów | Za co odpowiada |
|---|---|---|---|
| `UiStateHolder` | `UiStateHolder.kt` | `StatusActions` | `UiState` (`update`, `replace`), wiersz stanu (`fail`, `clearError`, `showStatus`), lista (`showList`, `refresh` z `Mutex`, `refreshInBackground`); `launchOperation(postęp, onSuccess) { }` (operacja na sejfie, jedna naraz, `busy`) i `launchCatching { }` (krótka praca, tylko błąd na wierszu stanu) |
| `NavigationModel` | `NavigationModel.kt` | `Navigation` | przejścia między ekranami, `openEntry` (wpis czytany od nowa), zakładki; wyjście z formularza usuwa niezapisane pliki |
| `VaultModel` | `VaultModel.kt` | `VaultActions` | nowy sejf, odtwarzanie z wtyczki, odblokowanie, blokada, usunięcie z telefonu, zmiana hasła głównego |
| `FingerprintModel` | `FingerprintModel.kt` | `FingerprintActions` | włączanie i wyłączanie odcisku, odblokowanie odciskiem, okno odcisku na ekranie blokady (`BiometricController` robi klucze) |
| `SyncModel` | `SyncModel.kt` | `SyncActions` | start trybu Synchronizacja (bilet startu), „Zakończ”, kod parowania, usuwanie urządzeń (`SyncController` prowadzi serwer) |
| `SettingsModel` | `SettingsModel.kt` | `SettingsActions` | przełączniki „Blokuj dopiero po 60 s” i „Pytaj o zapis haseł”, stan autouzupełniania |
| `EntriesModel` | `EntriesModel.kt` | `EntryActions` | zapis i usuwanie wpisu, kopiowanie pola, generator haseł (tworzy hasło i zapamiętuje opcje), aplikacje do wyboru i zapamiętanie certyfikatu wybranej (V3-S3) |
| `AttachmentsModel` | `AttachmentsModel.kt` | `AttachmentActions` | dodanie pliku, czy plik jest gotowy, „Pobierz”; pliki dodane w formularzu i jeszcze niezapisane (`discardAdded`) |
| `TransferModel` | `TransferModel.kt` | `TransferActions` | import (ZIP lub tekst), hasło główne przed eksportem (`confirmExport`), eksport tekstu i ZIP (wspólny początek `approvedTarget`) |

Okno wyboru pliku (60 s przed blokadą) to `FilePicks` (`beginFilePick`, `endFilePick`), część `AttachmentActions`
i `TransferActions`; obie przekazują je do `LockController`.

- **Jedna obsługa błędów** (CW5): wzór „uruchom, przepuść `CancellationException`, resztę pokaż jako błąd” jest
  tylko w `UiStateHolder.launchOperation` i `launchCatching` (było 4 razy). `confirmExport` używa
  `launchOperation` z `onSuccess` zamiast własnej obsługi `busy`.
- **Bez globalnego dostępu z ekranów** (CS15): `LoginForm` (aplikacje, certyfikat wybranej), `GeneratorCard`,
  `SettingsScreen` (autouzupełnianie) i `FingerprintDialog` (okno odcisku) nie sięgają po `PassHolderApp` przez
  `LocalContext`. Części dostają zależności przez konstruktor; to, co testy podmieniają w `PassHolderApp`
  (`fingerprintPrompt`, `installedApps`, `autofillStatus`, `appTrust`), części czytają przy każdym użyciu.
  Pola `var` w `PassHolderApp` zostają: to punkty podmiany w testach Robolectric.
- **Klucze ustawień** w `Settings` są stałymi (`GENERATOR`, `LOCK_DELAY`, `ASK_TO_SAVE`), bez powtórzeń.
- **Kolejność tworzenia** w `AppViewModel`: `UiStateHolder` → `SyncController` → `SyncModel` → `LockController` →
  pozostałe części. Odwołania wstecz (`locks.onOperationFinished`, `navigation.backToList`) są w lambdach, więc
  działają po zakończeniu konstrukcji.
- **Testy** wołają akcje przez grupy (`vm.transfer.importFrom(…)`, `vm.navigation.selectTab(…)`); treść testów
  bez zmian. Zostało `vm.reloadEntries()` dla testów, które zmieniają sejf poza ekranami.
- Zostawione na G14 (zrobione tam): długie ekrany i powtórzone okna dialogowe (CK7, CS14), flaga `sensitive` w `copy` (CW10).

## Ekrany i autouzupełnianie Androida

Ustalone w grupie G14 przeglądu czystości kodu V3 (CK7, CK8, CW10, CW11, CS14, CS18 oraz odłożone z G8 i G13).
Zachowanie i teksty bez zmian (`android/app/.../app/`).

**Wspólne elementy ekranów (CS14)**

| Element | Plik | Zastępuje |
|---|---|---|
| `SecretField(value, onValueChange, label, onCopy?, onDone?, …)` | `ui/Common.kt` | `PasswordField` i `SecretField`; „Kopiuj” tylko z `onCopy`, klawisz „Gotowe” tylko z `onDone` |
| `MasterPasswordField` | `ui/Common.kt` | `PasswordField(…, "Hasło główne")` w 7 miejscach (etykieta domyślna `UiTexts.MASTER_PASSWORD`) |
| `SettingSwitchRow(label, checked, enabled, onCheckedChange, hint?)` | `ui/Common.kt` | trzy wiersze z przełącznikiem w `SettingsScreen` |
| `ConfirmDialog(text, onConfirm, onDismiss, title?, confirmLabel = "Usuń")` | `ui/Dialogs.kt` | okna „Usunąć…?” w `EditScreen`, `DevicesScreen`; `DisconnectDialog` = „Usunąć sejf z tego telefonu?” (`StartScreen`, `LockedScreen`) |
| `UnlockForm(title, busy, status, fingerprintOn, onUnlock, onFingerprint, secondaryAction)` | `ui/UnlockForm.kt` | ten sam formularz w `LockedScreen` i `AutofillUnlockScreen` |
| `FilePicks.launchPicker(onMissing) { }` | `ui/FilePicker.kt` | pomocnik `pick` w `TransferScreen` i `AttachmentsEditor` (tekst `UiTexts.NO_FILE_PICKER`) |

Okno „Pobrać plik?” w `AttachmentsEditor` zostaje osobne (`DownloadDialog`): nic nie usuwa, więc „Pobierz” nie
jest w kolorze błędu.

**Długie ekrany podzielone (CK7)**

- `TransferScreen`: `ImportSection`, `ExportSection`, `ExportChoices`; wybór eksportu to `ExportChoice.TextFile(format)`
  albo `ExportChoice.Zip` (zamiast `format` + flagi `zip`), okna zapisu w `ExportLaunchers` (JSON, CSV, ZIP).
- `AttachmentsEditor`: `AttachmentRow`, `DownloadDialog`. `ListScreen`: `TypeTabs`, `EntryRow`.
  `EditScreen`: `TypeSection` (pola typu wpisu). `LoginForm`: `AndroidAppsEditor`.
- `SaveReviewScreen` (decyzja D5): stan w `SaveReviewUi`, ekran ma 4 parametry zamiast 9.

**Flagi zamienione na nazwy (CW10)**

| Było | Jest |
|---|---|
| `EntryActions.copy(label, value, sensitive)` | `copyText(label, value)`, `copySecret(label, value)` |
| `SyncController.stop(reason: String?)`, 7× `stop(null)` | `stop()`, `stopWithReason(reason)`; wspólne `stopServer` prywatne |
| `TransferFiles.defaultFileName(format, day, zip)` | `defaultFileName(format, day)`, `archiveFileName(day)` |
| `ArchiveReader.readData(e, limit: Int?)` | `readData(e, limit: Int)`, `skipData(e)` |
| `AutofillAuthActivity.runUnlock(unlock: (() -> Unit)?)` | `unlockAndContinue(unlock)`, `continueWithOpenVault()` |

Zostały świadomie: `matchLogins`/`matchApp(…, exactOnly = true)` i prywatne `SyncModel.launch(offerCodeUntilPaired = …)`
— w Kotlinie wywołanie z nazwanym argumentem czyta się jak obiekt opcji z G11.

**`AutofillAuthActivity`: jeden typ stanu (CW11)**

Siedem flag (`busy`, `skipping`, `delivered`, `lockPendingFromStop`, `relock: Boolean?`…) zastąpił `AuthPhase` w
ViewModelu `AuthScreenState`:

```
Locked(busy) ──hasło/odcisk──► Locked(busy = true) ──afterUnlock──► Deliver → Delivered (RESULT_OK, finish)
     ▲                                                        └───► Stay → Open(locksOnLeave, lockStarted)
     └──────── unlockAgain / leaveUnlocked / błąd ◄───────────────────────┘
Skipping: sejf otwarty na starcie (skipsUnlockWhenOpen), praca za pustym ekranem
```

`locksOnLeave` to dawne `relock == true` (sejf otworzył ten ekran, więc zamknięcie go blokuje, D1). `lockStarted` to
dawne `lockPendingFromStop`. `onCreate` woła `startPhase()` i `Content()`. Po obrocie zostaje tylko `Open`; przerwana
praca startuje od nowa jak wcześniej. Błąd z korutyny zamkniętego (obróconego) ekranu nie zmienia stanu nowego
(`isActive`), bo stan jest w ViewModelu. Odwołania „D1” w komentarzach wskazują sekcję „Przepływ autouzupełniania
(Android)”; „R2” zastąpił opis wprost.

**Autouzupełnianie i powtórzenia (CK8, CS9, CS18, CW16)**

- `ResponseBuilder(context, inline)`: kontekst i żądanie klawiatury raz w konstruktorze; `locked(ids, auth, save)`,
  `inlinePresentation(index, title, subtitle)` (było po 5 parametrów). Warunek API 30 jest w `inlinePresentation`,
  drugi raz tylko w `locked` dla przeciążenia `setAuthentication` z API 30.
- `FingerprintPrompt.authenticate(activity, title, cipher, onResult)`: wynik `FingerprintResult`
  (`Authorized`, `Failed`, `Cancelled`) zamiast `onSuccess` + `onError(String?)`.
- `respond`/`buildFillResponse`: plan i `saveSpecFor` liczone raz, wspólne `datasetsFor(…)`.
  `onSaveRequest` → `save(…)`; `AutofillSaveActivity.afterUnlock` → `readReview`, `startReview`;
  `readRequest` → `fillableNode`.
- `LeaveLock.lockIfExpired()` zamiast 4× `if (leaveLock.expired()) store.lock()`; `showToast` (`autofill/Toasts.kt`)
  zamiast dwóch kopii; `SAVE_FAILED` także w usłudze.
- `saveLogin` nie buduje już `SaveReview`: woła `saveSubmitted(app, data, appLabel, draft)`; `saveReviewed` to cienka
  nakładka dla podglądu.
- Rdzeń: `AppRequest`, `TRUSTED_BROWSERS` i `verifyApp` w `core/autofill/AppRequest.kt` (`Match.kt` tylko dopasowuje);
  `SyncHttpServer`: `badRequest()` zamiast 6× `HttpError(400, "bad request")`, `closeQuietly` użyte w `start`/`stop`.

Test ręczny: T33 w `docs/TESTY.md`.

## Widoki wtyczki

Ustalone w grupie G11 przeglądu czystości kodu V3 (CK6, CW10, CW13, CS11, CS14 część wtyczki). Zachowanie i
wygląd bez zmian.

**Router widoków** (`src/views/router.ts`). Widoki nie importują się nawzajem (wcześniej 9 plików tworzyło cykl).
Widok prosi o przejście po nazwie: `views().list({ message, error, type })`, `views().edit(typ, id)`,
`views().locked()`, `views().unlocked()`, `views().connect()`, `views().addresses()`, `views().transfer()`,
`views().pinSettings()`, `views().saveSettings()`, `views().saveQuestion(info)`. Rejestr wypełnia raz
`src/views/index.ts` (jedyny plik importujący wszystkie widoki); ładuje go `popup.ts`, a w testach `setupPopup`
i `test/screens/harness.ts`. Bez rejestracji `views()` rzuca błąd. `backToListButton(etykieta)` to wspólny przycisk
„Wróć” / „Wróć do listy”.

**Długie funkcje podzielone** (funkcja na sekcję lub wariant, obsługa zdarzeń w nazwanych funkcjach):

| Plik | Części |
|---|---|
| `views/list.ts` | `typeTabs`, `matchesSection` („Pasujące do tej strony”), `entryRow(e, status, "list" \| "matches")`, `openButton`, `copyButton`, `listActions`, `sync`; `listView` tylko składa ekran. Zapamiętana zakładka (`currentType`) celowo zostaje stanem modułu: każdy powrót do listy ma trafić na ostatnią zakładkę |
| `views/edit.ts` | `formContent` (wpis z formularza), `leaveForm` (powrót na zakładkę typu), `editView` |
| `views/addresses.ts` | `addressesSection` (zapis adresów) i `repairSection` („Sparuj z innym telefonem / odtwórz telefon”) |
| `views/connect.ts` | `pairingSteps`, `codeStep`, `passwordStep`, `finish`, `cancelButton` |
| `views/transfer.ts` | `formatChoices`, `exportAs`, `exportSection`, `importFile`, `importSection` |
| `views/forms/attachments.ts` | klasa `AttachmentsForm`: `render`, `row`, `askDownload`, `download`, `remove`, `add`, `chooser`, `read` |
| `save/prompt-view.ts` | `promptFields`, klasa `SavePrompt` (nagłówek wg decyzji, podgląd, wysyłka odpowiedzi, `draft`), `lockedLayout` i `unlockedLayout` |

**Argumenty-flagi zamienione na nazwy**: `listView(message, isError, type)` → `listView({ message, error, type })`;
`entryRow(…, fillable, copyable)` → miejsce wiersza `"list" | "matches"`; `candidatesIn(root, strict)` i
`isVisible(el, strict)` → `VisibilityCheck` `"basic" | "strict"`; `enablePin(pin, remember)` →
`enablePin(pin, { rememberAfterRestart })` (`PinOptions`, też w `PinStore.enable`); `pinInput(autocomplete, long)` →
`pinInput({ autocomplete, long })`.

**Wspólna logika w jednym miejscu**:

| Co | Gdzie | Używają |
|---|---|---|
| `parseUrl`, `webUrl` (tylko http/https), `fromExtensionPage(sender, idWtyczki)` | `src/web-url.ts` | `background.ts`, `save/candidates.ts`, `autofill/fill-tab.ts` |
| `frameRole`, typ `FieldElement` | `src/page-frame.ts` | `autofill/fill-page.ts` (`topOrigin`), `save/watch.ts`, `save/read-form.ts` |
| `matchSavedLogins(adres, wpisy, opcje)` (wpis → `MatchCandidate`) | `src/autofill/saved-logins.ts` | lista, `fillTab`, `onFillCommand`, `SaveCandidates` |
| `setOrRemove` | `src/storage.ts` | lista „Nigdy”, kandydaci, okna pytań |
| `submitPhoneUrls` | `src/ui/phone-url-fields.ts` | parowanie, zapis adresów, ponowne parowanie |
| `savePreviewMessage`, `saveAnswerMessage` | `src/save/messages.ts` | okno pytania (`prompt-page.ts`) i okienko (`save-question.ts`) |

`fromExtensionPage` w `SaveCandidates` sprawdza teraz pełny początek adresu `chrome-extension://<id>/` jak
`background.ts` (wcześniej tylko protokół); w praktyce wynik jest ten sam, bo skrypt wtyczki nie działa na stronach innych wtyczek.

## Przepływ autouzupełniania (Chrome)

```
 okienko (list.ts)                    service worker (background.ts)              strona (wszystkie ramki)
 „Wypełnij” ── {fill, entryId, tabId} ──► strona wtyczki (sender.id i sender.url)?  ──nie──► ignoruje
 skrót Ctrl+Shift+L ── onCommand ───────► fillTab:
                                           sejf odblokowany? wpis → planFor
                                           tabs.get(tabId) → adres (http/https)
                                           login: matchLogins; karta: https
                                           executeScript(autofill-content.js, allFrames)
                                           executeScript(func: passholderFill(plan, origin)) ──► fillPage:
                                                                                      ten sam origin co góra i = origin?
                                                                                      pola → classifyField → wartość
                                                                                      kontakt/karta: formularz z kursorem,
                                                                                      tylko pola naprawdę widoczne
 { ok } albo komunikat ◄────────────────── suma wypełnionych pól (0 → „Nie znaleziono pól…”)
```

Okienko zamyka się po powodzeniu; błąd zostaje w linii statusu. Skrót wypełnia sam tylko przy jednym pasującym
loginie, w pozostałych przypadkach otwiera okienko.

## Przepływ pytania o zapis (Chrome)

```
 strona (save-watch.js)                service worker (SaveCandidates, PromptWindows)  okno wtyczki (save-prompt.html)
 submit / Enter / klik użytkownika      sender.id własne, sender.tab, origin ramki = origin karty?
   (isTrusted; submit też aktywacja) ─ save-candidate ─►
   {login, hasło, podpis}                  adres = saveUrl(sender.url); host na liście „Nigdy”? → koniec
                                           decideSave (sejf odblokowany; none → koniec)
                                           kandydat → storage.session, alarm 2 min
                                           odznaka „?” na karcie, chrome.windows.create(popup) ──► save-info → {id, host, username,
                                                                                                    password, decision, entryName, locked}
                                           save-preview {candidateId, username, password} ◄──────── edycja loginu / hasła → decyzja
                                           save-answer {draft}: decyzja od nowa → putEntry ◄────── „Zapisz” / „Nie teraz” / „Nigdy”
                                             (update: withPassword, stare → „Poprzednie hasło”)
                                           zamyka okno, zdejmuje odznakę (od razu po „Nie teraz”/„Nigdy”, po 2 min; 2 s po zapisie)
 nowa strona ── save-pending ─────────────► kandydat żyje? ten sam pusty formularz → zamyka okno (odznaka zostaje);
                                           okno zamknięte przez użytkownika → tylko odznaka; inaczej okno
```

Skrypt rejestruje service worker (`chrome.scripting.registerContentScripts`, `id: "save-watch"`) tylko przy
uprawnieniu `https://*/*`: to uprawnienie jest przełącznikiem (bez flagi w `storage`), a `syncSaveWatch`
uzgadnia rejestrację przy starcie, instalacji i zmianie uprawnień. Zablokowany sejf: okno ma „Odblokuj i
zapisz” (`save-unlock` → service worker aktywuje kartę i `chrome.action.openPopup({windowId})`), a okienko po
odblokowaniu pyta o kandydata karty (`save-info` z `tabId`). `PromptWindows` trzyma w `storage.session`
(`savePromptWindows`) kartę → okno; `windows.onRemoved` dla okna z tej mapy to zamknięcie przez użytkownika
(kandydat dostaje `dismissed`). Okno poza ekranem (błąd „Bounds must be at least 50%…”) Chrome ustawia sam.
Odczyt sejfu dla pytania nie przedłuża blokady (`resume({touch: false})`); zapis (`touch: true`) tak.

Bezpieczeństwo: adres z `sender.url`, nie z wiadomości; ramki z innym origin pomijane; `save-info`, `save-preview` i
`save-answer` i `save-unlock` tylko ze stron wtyczki; pytanie w osobnym oknie, nie w stronie (strona go nie widzi
ani nie przykryje; `save-prompt.html` nie jest `web_accessible_resources`); okno dostaje hasło kandydata (nie
innych wpisów);
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
odczyt:  blob → AES-GCM (AAD z id) → JSON → parseEntryData / EntryCodec.parse
           {v:3, ...} ścisły typ  → wpis v3 (nieznany klucz = „Invalid entry payload”)
           {name, username, password, hlc} (bez v) → login, reszta pól pusta
           {hlc} + deleted=true → nagrobek (inny klucz = „Invalid tombstone payload”)
zapis:   zawsze v3: serializeEntryData / EntryCodec.serialize (stała kolejność kluczy, zwarty JSON)
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
Drugi, pełny przegląd po V3: [archive/PRZEGLAD_BEZPIECZENSTWA_V3.md](archive/PRZEGLAD_BEZPIECZENSTWA_V3.md) (2026-11-15;
wszystkie 5 grup poprawek zrobione, PR #51–#55).

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
| V3-N1, V3-N2 | grupa 4 (PR #52): host pamięta przyjęte pierwsze wiadomości Noise (kopia → 400) i trzyma ≤ 4 sesje na urządzenie; tryb Synchronizacja liczy aktywność tylko po udanej synchronizacji, pliku lub parowaniu; 403 dla obcego `Origin`, 415 bez JSON; odpowiada tylko w Wi-Fi, Ethernecie i Tailscale ([SYNCHRONIZACJA.md](SYNCHRONIZACJA.md#61-serwer-http-synchttpserverkt)) |
| V3 (2026-11-15) | pełny przegląd po V3: 0 K, 0 W, 4 S, 7 N, 5 I; poprawki w grupach 1–5, PR #51–#55 ([archive/PRZEGLAD_BEZPIECZENSTWA_V3.md](archive/PRZEGLAD_BEZPIECZENSTWA_V3.md)) |
| V3-S1, V3-N3, V3-S4, V3-I4 | grupa 1: pytanie o zapis w osobnym oknie wtyczki z odznaką, tylko zdarzenia użytkownika, stare hasło w „Poprzednie hasło”; kontakt i karta tylko w widocznych polach formularza z kursorem; `fill` i `password-copied` tylko ze stron wtyczki ([FUNKCJE.md](FUNKCJE.md#pytanie-o-zapis)) |
| V3-S2, V3-N5 | grupa 2: subdomena pasuje tylko w obrębie domeny rejestrowalnej z wbudowanej listy sufiksów publicznych (TS i Kotlin, ta sama lista); Ctrl+Shift+L wypełnia tylko login dokładnego hosta; pytanie o zapis (wtyczka i telefon) zmienia hasło tylko we wpisie dokładnego hosta; Android: strona bez schematu = `http` ([FUNKCJE.md](FUNKCJE.md#autouzupełnianie)) |
| V3-S3 | przeglądarki rozpoznawane po certyfikacie podpisu, aplikacje wpisu po zapamiętanym certyfikacie (`AppTrust.kt`, [FUNKCJE.md](FUNKCJE.md#android-1)) |
| V3 grupa 5 (PR #54) | N4: próby PIN-u pod `navigator.locks`; N6: hasło główne przed eksportem (wtyczka `confirmMasterPassword`, telefon `confirmExport`); N7: `distributionSha256Sum` i `.github/workflows/ci.yml`; I1: SPEC §8 i PIN w FUNKCJE; I2: wtyczka odrzuca starszy HLC; I3: „Odłącz” kasuje `saveNever` i `saveCandidates` (HMAC schowka nie, uzasadnienie w raporcie); I5: granice KDF przy odczycie z dysku |

## Stan przeglądu czystości kodu

Raporty: [archive/PRZEGLAD_CZYSTOSCI_KODU.md](archive/PRZEGLAD_CZYSTOSCI_KODU.md) (2026-10-31, PR #6 i #16) i
[archive/PRZEGLAD_CZYSTOSCI_KODU_V3.md](archive/PRZEGLAD_CZYSTOSCI_KODU_V3.md) (2026-11-16, 47 znalezisk). Wszystkie
14 grup poprawek V3 (G1–G14) zrobione w PR #58–#71; ich wynik opisują sekcje „Konwencje nazw i kodu”, „Błędy”,
„Wspólne pomocniki”, „Stałe, limity i teksty” i kolejne „Podział …” wyżej.
