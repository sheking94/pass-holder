# Przegląd czystości kodu V3

- Data: 2026-11-16. Stan: `main` @ `ff3b013` (po PR #55).
- Narzędzie: skill `clean-code-reviewer` (zasady Clean Code R. C. Martina).
- Zakres: cały kod produkcyjny `core/src`, `extension/src`, `android/core/src/main`, `android/app/src/main`.
- To jest tylko przegląd. Kod nie został zmieniony.
- Poprzedni przegląd: [archive/PRZEGLAD_CZYSTOSCI_KODU.md](archive/PRZEGLAD_CZYSTOSCI_KODU.md) (2026-10-31).

Skróty ścieżek w tym dokumencie:

| Skrót | Pełna ścieżka |
|---|---|
| `core/` | `core/src/` |
| `ext/` | `extension/src/` |
| `acore/` | `android/core/src/main/kotlin/io/github/sheking94/passholder/core/` |
| `aapp/` | `android/app/src/main/kotlin/io/github/sheking94/passholder/app/` |

## 1. Podsumowanie

| Moduł | Pliki | Linie | Krytyczne | Wysokie | Średnie | Niskie |
|---|---|---|---|---|---|---|
| `core/` (TypeScript) | 44 | 4405 | 3 | 8 | 11 | 4 |
| `extension/` (wtyczka) | 58 | 5385 | 5 | 6 | 14 | 2 |
| `android/` (Kotlin) | 101 | 12240 | 6 | 14 | 16 | 4 |
| **Razem (różne znaleziska)** | 203 | 22030 | **8** | **16** | **19** | **4** |

Jedno znalezisko często dotyczy kilku modułów (rdzeń Kotlina jest portem rdzenia TS), dlatego wiersze nie sumują się do wiersza „Razem”.

Wagi według progów skilla:

- **Krytyczne**: funkcja ponad 50 linii, 5+ parametrów, 4+ poziomy zagnieżdżenia, klasa z wieloma odpowiedzialnościami.
- **Wysokie**: funkcja 20–50 linii, 4 parametry, niejasne nazwy, znaczna duplikacja.
- **Średnie**: drobna duplikacja, komentarze tłumaczące kod, formatowanie.
- **Niskie**: drobna czytelność.

„Krytyczne” oznacza tu „najtrudniejsze w utrzymaniu”, a nie „błąd”. Nie znalazłem w tym przeglądzie błędu działania.

Pięć najważniejszych wniosków:

1. Trzy klasy robią prawie wszystko: `VaultStore` (wtyczka), `PhoneVaultStore` i `AppViewModel` (Android). To CK1–CK3.
2. Błędy są rozpoznawane po tekście komunikatu (TS) albo po ogólnym typie wyjątku (Kotlin). To CW1.
3. Te same małe pomocniki, stałe i teksty są przepisane w wielu plikach. To CW2, CS1–CS4, CS6.
4. W kodzie produkcyjnym leży stare API „tylko login”, którego używają już tylko testy (81 wywołań). To CW3.
5. Import i eksport oraz widoki mają funkcje po 50–107 linii. To CK4, CK6, CK7.

## 2. Metoda

**Co wiem na pewno**

- Przeczytałem w całości każdy plik produkcyjny. Wyjątki: tablice danych `Keywords.kt`, arytmetyka `Ristretto255.kt` (tylko początek), `KeystoreSecretWrapper.kt`, `InstalledApps.kt`, `AutofillStatus.kt` (razem 108 linii).
- Długość funkcji, liczba parametrów i zagnieżdżenie pochodzą z własnego skryptu, sprawdzone czytaniem. Długość może się różnić o 1–3 linie.
- Liczniki powtórzeń pochodzą z `grep` na `main` @ `ff3b013`.
- Cykle importów: `core/` 0, wtyczka 1 (CW13).
- W repo nie ma lintera ani formatera (TS i Kotlin).

**Co oceniam (moja opinia)**

- Wagi są formalne, według progów. Tam, gdzie próg zawyża wagę, piszę to wprost (CK8).
- Propozycje podziału klas to kierunek, a nie gotowy projekt.

**Czego nie sprawdzałem**

- Testy (ok. 24,5 tys. linii), skrypty, konfiguracja Gradle i npm.
- Kod generowany: `psl-rules.ts`, `public_suffix_rules.txt`.
- Nie uruchamiałem testów, bo kod się nie zmienił.

## 3. Znaleziska krytyczne

### CK1. `VaultStore` robi wszystko (wtyczka)

`ext/vault-store.ts:347–1092` (plik ma 1092 linie, klasa ok. 50 metod)

```ts
constructor(
  private readonly local: KeyValueStore,
  private readonly session: KeyValueStore,
  private readonly makeClient: (url: string) => PhoneClient = (url) => new PhoneClient(url),
  private readonly now: () => number = Date.now,
  private readonly canReach: (url: string) => Promise<boolean> = async () => true,
  private readonly fileStore: files.LocalFileStore = new files.MemoryLocalFileStore(),
) {
```

**Problem:** jedna klasa odpowiada za sesję i autoblokadę, wpisy, parowanie, synchronizację z fazą plików, pliki, import i eksport, PIN, adresy i rozłączanie. Konstruktor ma 6 parametrów pozycyjnych, a `ext/ui/state.ts:9–17` powtarza wartości domyślne, żeby dojść do piątego.

**Poprawka:** wydzielić współpracowników (sesja i blokada, parowanie, synchronizacja, pliki, import i eksport). `VaultStore` zostaje cienką fasadą. Zależności przekazać jednym obiektem opcji.

### CK2. `PhoneVaultStore` robi wszystko (Android)

`acore/p2p/PhoneVaultStore.kt` (825 linii, ok. 45 metod)

**Problem:** tworzenie i odtwarzanie sejfu, zmiana hasła, blokada, wpisy, pliki, import archiwum, urządzenia, router synchronizacji, parowanie i reset stanu w jednej klasie.

**Poprawka:** wydzielić: cykl życia sejfu i klucze, wpisy, pliki, import, stan hosta i parowanie. Zachować publiczne API oraz kolejność blokad opisaną w nagłówku klasy.

### CK3. `AppViewModel` robi wszystko (Android)

`aapp/AppViewModel.kt` (797 linii, ok. 60 funkcji publicznych)

**Problem:** nawigacja, blokada, tworzenie i odtwarzanie, odblokowanie, hasło główne, odcisk palca, wpisy, załączniki, import i eksport, synchronizacja, ustawienia. Pola stanu są w środku pliku (`addedFiles` :465, `exportApproved` :580, `refreshing` :771).

**Poprawka:** dokończyć zaczęty podział (`LockController`, `BiometricController`, `SyncController` już są): osobno załączniki, import i eksport, nawigacja.

### CK4. Długie funkcje importu i eksportu (TS i Kotlin)

| Funkcja | TypeScript | Kotlin |
|---|---|---|
| NordPass: czytanie CSV | `core/transfer/nordpass-csv.ts:44` (87 linii, zagn. 6) | `acore/transfer/NordPassCsv.kt:54` (71) |
| Bitwarden: eksport wpisu | `core/transfer/bitwarden-json.ts:200` (82) | `acore/transfer/BitwardenJson.kt:233` (77) |
| Bitwarden: import tożsamości | `core/transfer/bitwarden-json.ts:68` (59, 4 par.) | `acore/transfer/BitwardenJson.kt:88` (65, 4 par.) |
| ZIP: eksport | – | `acore/transfer/PassHolderZip.kt:59` (71, 4 par.) |
| Import archiwum | `ext/vault-store.ts:565` (ok. 65, zagn. 5) | `acore/p2p/PhoneVaultStore.kt:510` (56, zagn. 5) |

**Problem:** każda robi kilka rzeczy naraz (rozpoznanie typu, budowa wpisu, zbieranie pominiętych; plan, indeks, zapis ZIP). `importArchive` w Kotlinie zwraca `Pair<ParsedArchive, ArchiveImportResult>` i buduje zagnieżdżone pary `parsed to (contents to skips)`.

**Poprawka:** jedna funkcja na typ wpisu, `guessKind()` i `rowToEntry()` dla CSV, nazwany typ wyniku zamiast par. Zmieniać TS i Kotlin razem.

### CK5. Długie funkcje protokołu synchronizacji i plików

- `core/p2p/sync.ts:171` `applyResponse`: 53 linie, 5 parametrów, zagnieżdżony `?:` (198–200). Dwie prace: oznaczenie przyjętych zmian i scalanie zdalnych.
- `core/files/client.ts:250` `syncFiles`: 68 linii, 5 parametrów. Plan, wysyłki i pobrania w jednej funkcji.
- `core/p2p/host-sync.ts:79` `processP2pSync` (52) i `acore/p2p/HostSync.kt:117` `process` (56, 4 par.): walidacja, ponowne parsowanie i stronicowanie w domknięciu `fits`.
- `acore/files/FileHost.kt:87` `process`: 59 linii, 4 parametry, zagn. 5. Trzy operacje (status, put, get) w jednym `when`.
- `ext/vault-store.ts:767` `repair`: 55 linii.

**Poprawka:** `markAccepted()` i `resolveRemote()`; osobno plan, wysyłka i pobranie plików; `pageRecords()`; w `FileHost` funkcja na operację.

### CK6. Długie funkcje widoków wtyczki

`ext/save/prompt-view.ts:19` (107 linii), `ext/views/list.ts:81` (96, do tego zmienna modułu `let currentType` :37), `ext/views/forms/attachments.ts:45` (ok. 100), `ext/views/addresses.ts:23` (77, dwa formularze), `ext/views/edit.ts:42` (67), `ext/views/connect.ts:86` (53, zagn. 5), `ext/views/transfer.ts:45` (52).

**Problem:** jedna funkcja buduje DOM, trzyma stan i obsługuje zdarzenia kilku wariantów ekranu.

**Poprawka:** funkcja na wariant lub sekcję (np. osobno pytanie przy zablokowanym i odblokowanym sejfie), obsługa zdarzeń w nazwanych funkcjach.

### CK7. Długie ekrany Compose

`aapp/ui/TransferScreen.kt:71` (103, zagn. 5), `aapp/ui/forms/AttachmentsEditor.kt:41` (80, zagn. 7), `aapp/ui/ListScreen.kt:37` (69, zagn. 7), `aapp/ui/EditScreen.kt:40` (54), `aapp/ui/forms/LoginForm.kt:26` (52).

**Poprawka:** wydzielić wiersz listy, sekcje eksportu i importu oraz okna dialogowe do osobnych funkcji `@Composable`.

### CK8. Funkcje z 5 i więcej parametrami

- Kotlin, logika: `FileChunks.build` (7) `acore/files/FileChunks.kt:53`, `encryptFixed` (6, tylko testy) :33, `Pairing.seal` (5) `acore/p2p/Pairing.kt:88`, `Cpace.start` (5) `acore/p2p/Cpace.kt:137`, `FileStore.put` (5) `acore/files/FileHost.kt:21`, `ResponseBuilder.locked` i `inlinePresentation` (5) `aapp/autofill/ResponseBuilder.kt:74, 111`, `authenticate` (5) `aapp/BiometricUnlock.kt:161, 171`.
- TS: `applyResponse` (5), `syncFiles` (5), `decideFor(store, c, username, password, touch)` `ext/save/candidates.ts:165`, konstruktor `VaultStore` (6).
- Compose: `ListEditor` (7) `aapp/ui/forms/ListEditor.kt:38`, `PasswordField` (8) i `SecretField` (8) `aapp/ui/Common.kt:77, 117`, `SaveReviewScreen` (9) `aapp/ui/SaveReviewScreen.kt:22`.

**Ocena:** w bezstanowych funkcjach Compose (stan + wywołania zwrotne) długa lista parametrów to przyjęty styl, realna waga jest niska. W logice waga jest realna.

**Poprawka:** obiekt parametrów w logice (np. `id, index, chunks` jako jeden typ). W Compose klasa stanu tylko tam, gdzie parametrów jest ponad 6.

## 4. Znaleziska wysokie

### CW1. Błędy rozpoznawane po tekście albo po ogólnym typie wyjątku

```ts
// ext/phone-client.ts:32–39
if (message === "P2P host returned 403: device not paired") return new Error(PHONE_FORGOT_BROWSER);
if (message === "P2P host returned a malformed response" || message.startsWith("Noise:")) return new Error(PHONE_MALFORMED);
const status = /^P2P host returned (\d+): (.*)$/.exec(message);
```

```kotlin
// aapp/AppViewModel.kt:500–503
val bytes = try {
    store.readFile(a)
} catch (_: IllegalArgumentException) {
    throw IllegalArgumentException(AttachmentFiles.CORRUPTED)
```

- `core/`: stałe porównywane przez `.message ===`: `FILE_CORRUPTED` (`core/files/client.ts:234`), `ZIP_ENTRY_TOO_LARGE` (`core/transfer/zip.ts:254`, `core/transfer/passholder-zip.ts:83`), `ZIP_INVALID` (:72), `PHONE_UPDATE_REQUIRED`, `FILE_SYNC_EPOCH_MISMATCH`, prefiks `ENTRY_TOO_LARGE_TO_SYNC`.
- Dwie różne stałe mają ten sam tekst `"Entry too large"`: `core/p2p/entry.ts:46` i `core/transfer/zip.ts:5`.
- Literał `"P2P host returned a malformed response"` występuje 6 razy (`core/p2p/transport.ts:45, 50, 82`, `core/p2p/pair-client.ts:15`, `core/files/client.ts:9`, `ext/phone-client.ts:34`).
- Wtyczka wyciąga status z tekstu wyrażeniem regularnym, choć klasa `P2pHostError` (`core/p2p/transport.ts:16`) już istnieje. Kolejne porównania tekstu: `ext/vault-store.ts:212, 269, 465, 514`.
- Kotlin: w kodzie produkcyjnym 50 razy `throw IllegalArgumentException(` i 18 razy `throw IllegalStateException(`, 21 bloków `catch` na te typy, tylko 3 własne klasy wyjątków. Wywołujący łapie typ ogólny: `aapp/AppViewModel.kt:502` i `:650`, `aapp/TransferFiles.kt:155`, `aapp/BiometricController.kt:49`, `acore/p2p/P2pHost.kt:129–133`.

**Problem:** zmiana tekstu komunikatu zmienia zachowanie. Błąd programisty (zły argument) wygląda jak „plik uszkodzony”. Kompilator niczego nie pilnuje.

**Poprawka:** jedna rodzina błędów domenowych z kodem (TS: klasa z polem `code`, Kotlin: hierarchia wyjątków). Tłumaczenie kodu na polski tekst w jednym miejscu na platformę.

### CW2. Powielone pomocniki ścisłego JSON

- TS: `isRecord` zdefiniowane 4 razy (`core/p2p/host.ts:50`, `core/p2p/pairing.ts:79`, `core/files/client.ts:139`, `core/files/host-files.ts:101`), do tego `isObj` (`core/transfer/bitwarden-json.ts:19`) i co najmniej 10 kopii wpisanych ręcznie. `str()` 3 razy (`core/p2p/entry.ts:161`, `pair-client.ts:20`, `transport.ts:49`). `fail()` z `INVALID_ENTRY` 2 razy (`core/p2p/entry.ts:50, 141`, `core/files/attachment.ts:16, 56`). Sprawdzenie „dokładnie te klucze” 3 razy (`entry.ts:145`, `attachment.ts:70–74`, `core/transfer/passholder-json.ts:38–41`).
- Kotlin: „napis albo null” 7 razy (`P2pHost.kt:106`, `HostSync.kt:69`, `FileHost.kt:84`, `PairingHost.kt:94`, `Pairing.kt:116, 145`, `Hlc.kt:27`). Odpowiedź błędu `fail(status, error)` 5 razy (`P2pHost.kt:69`, `PairingHost.kt:75`, `PhoneRouter.kt:42`, `FileHost.kt:77`, `SyncHttpServer.kt:207`). Ścisłe `str()` 3 razy (`EntryV3.kt:254`, `Attachment.kt:89`, `PassHolderJson.kt:37`). „Dokładnie te klucze” 5 razy.
- Funkcja ucieczki znaków w napisie JSON skopiowana dosłownie: `acore/p2p/EntryV3.kt:200–220` i `acore/transfer/JsonText.kt:58–78`.

**Poprawka:** jeden moduł pomocników ścisłego JSON na platformę (`strict-json.ts`, `StrictJson.kt`).

### CW3. Martwy kod i kod tylko dla testów w źródłach produkcyjnych

- Wtyczka, stare API „tylko login”: `VaultStore.entries()` :386, `entry()` :390, `upsert()` :481, typy `EntryFields` :176 i `LiveEntry` :183, `loginView` :237, `loginContent` :246, `NOT_A_LOGIN` :204 (wszystko w `ext/vault-store.ts`). Produkcja: 0 użyć, testy: 44.
- Android: `PhoneVault.upsert(id, Credentials)` (`acore/p2p/PhoneVault.kt:42`), `PhoneVaultStore.upsert` :375, typ `Credentials` (`acore/Vault.kt:7`). Produkcja: 0 użyć, testy: 37.
- `MemorySyncStore` (`acore/p2p/HostSync.kt:29`) i `MemoryFileStore` (`acore/files/FileHost.kt:37`) leżą w `main`, a używają ich tylko testy.
- `core/`: wzorcowy host i magazyny w pamięci (`protocol.ts`, `p2p/host.ts`, `p2p/host-sync.ts`, `files/host-files.ts`) służą tylko testom i skryptom. Wtyczka ich nie importuje.
- `authKey` (`core/kdf.ts:46–49`, `acore/Kdf.kt:24–28`) jest wyliczany i zerowany, ale nigdy nieużywany. Komentarz „zmiana zmieniłaby encKey” jest nieprawdziwy: `encKey` i `authKey` to dwa niezależne wywołania HKDF.

**Problem:** czytelnik nie wie, które API jest aktualne. Martwy kod trzeba utrzymywać przy każdej zmianie.

**Poprawka:** przepisać testy na aktualne API i usunąć stare. Kod wzorcowy przenieść do katalogu testów albo wyraźnie oznaczyć. Wymaga decyzji D2.

### CW4. Duplikacja wewnątrz `PhoneVaultStore`

`acore/p2p/PhoneVaultStore.kt`

- Opakowanie klucza hasłem: 171–179 i 258–265. Sprawdzenie hasła: 252–257 i 284–289.
- `try { start(vaultKey) } catch (e: Throwable) { vaultKey.fill(0); throw e }` 4 razy (180–191, 223–235, 299–307, 323–328).
- „Użyte identyfikatory załączników” 3 razy (468, 490, 551). `"No host state"` 4 razy (665, 678, 690, 819).
- `!!` na stanie (252, 284, 298, 300, 319), bo `requireVault()` :807 sprawdza pola, ale zwraca typ z polami nullowalnymi.

**Poprawka:** `wrapWithPassword()`, `verifyPassword()`, `startOrWipe()`. `requireVault()` zwraca typ bez nulli (patrz CS10).

### CW5. Duplikacja w `AppViewModel` i obok

- `e.message ?: e.javaClass.simpleName` 14 razy w `aapp/` (9 w `AppViewModel.kt`, 2 w `AutofillAuthActivity.kt`, 2 w `BiometricController.kt`, 1 w `SyncController.kt`).
- „Uruchom, złap `CancellationException`, resztę pokaż jako błąd” 4 razy (`AppViewModel.kt:246–256, 682–690, 707–717, 777–788`).
- `confirmExport` (590–594) powtarza obsługę zajętości z `launchVaultOperation`. `exportTo` i `exportArchiveTo` mają ten sam początek (609–612, 625–628).

**Poprawka:** `Throwable.userMessage()`, jedna funkcja uruchamiająca operację z obsługą błędu.

### CW6. Lista pól każdego typu wpisu zapisana trzy razy

`acore/p2p/EntryV3.kt`: `fields` (136–182), `parseFields` (293–319), `fieldsJson` (371–397)

**Problem:** dodanie pola wymaga zmiany w trzech miejscach jednego pliku. `str` i `labeled` są przeciążone raz do zapisu, raz do odczytu. Nazwy jednoliterowe (`c`, `sb`, `s`, `f`, `a`, `h`, `o`, `l`, `v`).

**Poprawka:** jeden opis pól na typ (nazwa, odczyt, zapis), z którego korzystają wszystkie trzy funkcje. Osobne nazwy dla zapisu i odczytu.

### CW7. Walidacja, a potem ponowne parsowanie z `!!`

```kotlin
// acore/p2p/HostSync.kt:123–131
epoch = obj["epoch"].string()!!,
sinceRevision = P2pJson.safeLong(obj["sinceRevision"])!!,
changes = (obj["changes"] as JsonArray).map { c ->
    c as JsonObject
    ChangeRequest(id = c["id"].string()!!, …
```

**Problem:** `validate` (`HostSync.kt:78`) sprawdza kształt, a `process` czyta to samo drugi raz i 8 razy używa `!!`. Walidacja jest też wołana dwa razy: `acore/p2p/P2pHost.kt:191` i `HostSync.kt:119`; w TS `core/p2p/host.ts:191` i `core/p2p/host-sync.ts:85`.

**Poprawka:** jedna funkcja `parse`, która zwraca gotowe żądanie albo błąd. Wołana raz.

### CW8. Import Bitwarden: wynik typu `Any`, liczby magiczne, skrótowe nazwy

```kotlin
// acore/transfer/BitwardenJson.kt:155, 205–206
private fun importItem(item: JsonObject): Any {
…
val r: Any = if (item is JsonObject) importItem(item) else "zły format wpisu"
if (r is String) skipped.add(ImportSkip("wpis ${i + 1}", r)) else entries.add(r as EntryContentV3)
```

**Problem:** napis w wyniku oznacza powód pominięcia (w TS `EntryContentV3 | string`). Typy pozycji 1–4 i typy pól 0–3 są wpisane liczbami (`BitwardenJson.kt:66–70, 157, 162–186, 240–289`; `core/transfer/bitwarden-json.ts:45–48, 129–162, 207–262`). Pomocniki nazywają się `s()`, `nn()`, `jo()`, `num()`, `obj()`, stałe `L_*`. `kind!!` w :137.

**Poprawka:** wynik jako typ `Imported | Skipped`, nazwane stałe typów Bitwarden, pełne nazwy pomocników.

### CW9. Ekrany dostają cały `AppViewModel` (punkt 15 z przeglądu 1, nadal otwarty)

24 funkcje `@Composable` w `aapp/ui/` mają parametr `vm: AppViewModel`.

**Problem:** ekran może wywołać dowolną z ok. 60 funkcji. Nie da się go pokazać w podglądzie ani przetestować bez całego modelu.

**Poprawka:** ekran dostaje stan i wywołania zwrotne. Wzór już jest w repo: `AutofillUnlockScreen` i `SaveReviewScreen`.

### CW10. Argumenty-flagi i argumenty „null zmienia tryb”

```kotlin
// aapp/ui/ListScreen.kt:95–96
TextButton(onClick = { vm.copy("login", login.username, false) }) { Text("Login") }
TextButton(onClick = { vm.copy("hasło", login.password, true) }) { Text("Hasło") }
```

- Android: `copy(label, value, sensitive)` `aapp/AppViewModel.kt:451`; `launchSync(offerCodeUntilPaired)` :244; `parse(raw, wwwBeforeDot = false)` `acore/autofill/Match.kt:74` (flaga utrwala przypadkową różnicę kolejności między `match.ts` i `url.ts`); `matchLogins`/`matchApp(…, exactOnly)` :147, :177; `defaultFileName(format, day, zip)` `aapp/TransferFiles.kt:89`; `SyncController.stop(reason: String?)` `aapp/SyncController.kt:109` (7 wywołań `stop(null)`); `runUnlock(unlock: (() -> Unit)?)` `aapp/autofill/AutofillAuthActivity.kt:240`; `readData(e, limit: Int?)` `acore/transfer/ArchiveReader.kt:223`.
- Wtyczka: `entryRow(e, status, fillable, copyable = true)` `ext/views/list.ts:55`, wołane `entryRow(e, status, true, false)` :117; `listView(message, isError, type)` wołane `listView(SAVED, false, type)` (`ext/views/edit.ts:72, 79, 100`); `candidatesIn(…, strict = false)` `ext/autofill/fill-page.ts:126`; `enablePin(pin, rememberAfterRestart)`, `pinInput(autocomplete, long)`.

**Poprawka:** dwie nazwane funkcje (`copySecret` i `copyText`, `stop()` i `stopWithReason()`), typ wyliczeniowy albo obiekt opcji z nazwanymi polami.

### CW11. `AutofillAuthActivity`: stan w siedmiu flagach

`aapp/autofill/AutofillAuthActivity.kt`

**Problem:** `relock: Boolean?` (:312) ma trzy znaczenia. Siedem zmiennych flag (`busy`, `status`, `fingerprintOffered`, `delivered`, `skipping`, `lockPendingFromStop`, `relock`). `onCreate` (:93) ma 41 linii i 6 poziomów zagnieżdżenia, `runUnlock` (:240) 41 linii. Komentarze odwołują się do kodów „D1” i „R2”, których plik nie wyjaśnia.

**Poprawka:** jeden zamknięty typ stanu (`sealed`), kroki `onCreate` w nazwanych funkcjach, odwołania do dokumentu z nazwą pliku.

### CW12. Numery wersji w nazwach typów i funkcji

- TS: `LocalVaultV2`, `LocalEntryV2`, `upsertEntryV2`, `deleteEntryV2`, `liveEntriesV2`, `syncVaultV2`, `emptyVaultV2`, `entryAadV2`, `encryptPayloadV2`, `decryptPayloadV2`, `TombstoneDataV2` obok `EntryDataV3`, `EntryContentV3`.
- Kotlin: `EntryV3`, `EntryFieldsV3`, `EntryContentV3`, `EntryDataV3`, a `TombstoneData` bez przyrostka.

**Problem:** w kodzie jest tylko jedna wersja, więc przyrostek niczego nie odróżnia. `V2` (protokół) i `V3` (format wpisu) to dwie różne osie, co myli czytelnika.

**Poprawka:** usunąć przyrostki. Wersja zostaje w danych (`version: 3`, AAD `passholder/v2/…`). Wymaga decyzji D3.

### CW13. Cykl importów 9 plików widoków (wtyczka)

`ext/views/`: `addresses`, `connect`, `edit`, `list`, `locked`, `pin-settings`, `save-question`, `save-settings`, `transfer` importują się nawzajem.

**Poprawka:** mały router lub rejestr widoków. Widok prosi o przejście po nazwie i nie importuje innego widoku.

### CW14. `save/candidates.ts`: za dużo w jednym miejscu

`ext/save/candidates.ts`

**Problem:** `doAnswer` (:284) ma 47 linii i obsługuje trzy odpowiedzi. Nazwy jednoliterowe `m`, `s`, `c`. Klucz złożony `origin|signature` jest rozbijany przez `split("|")` w trzech miejscach (89, 199, 227). Zagnieżdżony `?:` z `await` (:245). `doInfo` najpierw decyduje, potem dopasowuje drugi raz (247, 256).

**Poprawka:** funkcja na odpowiedź, typ `{ origin, signature }` zamiast sklejonego napisu, pełne nazwy.

### CW15. `pairing.ts`: `kind` i rzutowania zamiast typowanych par

`core/p2p/pairing.ts:52, 115`, `core/p2p/pair-client.ts:86, 92–93`

**Problem:** `sealPairingMessage(kind, value)` i `openPairingMessage` zwracają unię, a wywołujący rzutuje (`as DeviceIdentity`, `o.restore as VaultInfo`). Kotlin ma już lepszy wzór: `sealIdentity` i `sealVaultInfo`.

**Poprawka:** typowane pary funkcji jak w Kotlinie. W Kotlinie przy okazji: cztery funkcje `sealIdentity`/`sealVaultInfo` (z `nonce` i bez) o tej samej treści (`acore/p2p/Pairing.kt:68–79`) oraz pola najpierw sprawdzane, a potem czytane drugi raz (125–153).

### CW16. Funkcje 20–50 linii warte podziału

Liczba funkcji 21–50 linii: `android/app` 44, `android/core` 39, wtyczka 32, `core/` 27. Najbardziej warte podziału:

- `core/autofill/values.ts:63` `candidates` (45 linii, 4 par., trzy plany) i `acore/autofill/Values.kt:64` (50).
- `ext/vault-store.ts`: `importContents` :498 (34), `sync` :972 (33), `pairStart` :643 (29), `pairFinish` :716 (30).
- `acore/transfer/ArchiveReader.kt`: `inflateUntilEnd` :293 (50), `inflateKnown` :240 (48, zagn. 5), `readDirectory` :182 (39).
- `acore/transfer/NordPassCsv.kt:130` `exportRow` (48), `acore/transfer/Csv.kt:11` `parse` (48), `acore/transfer/PassHolderJson.kt:64` (43).
- `acore/p2p/P2pHost.kt:108` `handshake` (45), `acore/autofill/Match.kt:74` `parse` (45), `acore/p2p/PairingHost.kt:137` `finish` (39), `acore/p2p/SyncHttpServer.kt:209` `readRequest` (37).
- `aapp/autofill/ViewNodeReader.kt:78` (41), `aapp/autofill/PassHolderAutofillService.kt:104` (32), `aapp/autofill/AutofillSaveActivity.kt:32` (30, 5 wyjść).

**Poprawka:** dzielić przy okazji grup, które dotykają danego pliku. Nie warto robić z tego osobnego zadania.

## 5. Znaleziska średnie

### CS1. Te same stałe i limity w kilku miejscach

- TS: `MAX_STATUS_IDS = 500` (`core/files/client.ts:10`, `core/files/host-files.ts:5`); długość `deviceId` 64 (`core/p2p/pairing.ts:86` obok `MAX_DEVICE_ID_LENGTH` w `hlc.ts:10`); długość kodu parowania 8 (`pairing.ts:35, 37`, `pair-client.ts:65`); `DOCUMENT_KINDS` (`core/p2p/entry.ts:52`, `core/transfer/bitwarden-json.ts:8`); `MAX_CHUNK_INDEX = 40` (`ext/files/idb-file-store.ts:8`) obok `MAX_FILE_CHUNKS`; `ENTRY_TYPES` (`ext/entry-types.ts:8`) obok `ENTRY_TYPE_ORDER` (`core/transfer/common.ts:4`).
- Kotlin: `MAX_DEVICE_ID_LENGTH = 64` 3 razy (`Hlc.kt:8`, `PhoneVault.kt:8`, `Pairing.kt:42`); `isTailscale` (`acore/p2p/LocalAddresses.kt:33`, `aapp/SyncNetworks.kt:45`); `sha256Hex` (`acore/files/FileChunks.kt:21`, `aapp/AppTrust.kt:37`).
- Wyrażenie regularne daty ważności karty: 3 kopie na platformę (`core/autofill/values.ts:58`, `core/transfer/bitwarden-json.ts:225`, `ext/entry-types.ts:129`; `BitwardenJson.kt:231`, `Values.kt:62`, `aapp/entries/EntryTypes.kt:46`).
- Sprawdzenie daty kalendarzowej 2 razy na platformę (`ext/entry-types.ts:88` i `core/autofill/values.ts:15`; `Values.kt:25` i `EntryTypes.kt:97`).

**Poprawka:** jedna definicja w rdzeniu, reszta importuje.

### CS2. Liczby magiczne (punkt 16 z przeglądu 1, nadal otwarty)

- Rozmiary wpisane cyframi: 10485760, 262144, 349564, 524288, 268435456, 86_400_000, 52_428_800 (`core/files/attachment.ts`, `acore/files/Attachment.kt:37–49`, `acore/transfer/PassHolderZip.kt:28, 35`, `acore/p2p/HostSync.kt:67`, `acore/files/DiskFileStore.kt:108`). W innych plikach jest czytelny zapis `1024 * 1024`.
- Długości klucza, znacznika i nonce (32, 16, 12, 29) jako literały: `core/cipher.ts:7, 32`, `core/kdf.ts`, `core/vault.ts:7, 17`, `core/p2p/noise.ts:83, 162, 183`; `Cipher.kt:23, 34, 36`, `Noise.kt:97, 149, 170`, `Kdf.kt:52, 60, 78`, `Vault.kt:13, 21`, `Pairing.kt:48–59`, `P2pHost.kt:119, 134`.
- Inne: `delay(15_000)` (`aapp/AppViewModel.kt:142`), poziomy SDK 33 i 28 (`aapp/SecureClipboard.kt:35, 80`), rozmiary nagłówków ZIP 30/46/22 i metody 0/8 (`core/transfer/zip.ts`, `ArchiveReader.kt`), 16 i 80 (`ext/save/prompt-window.ts:29–30`).

**Poprawka:** nazwane stałe (`KEY_BYTES`, `TAG_BYTES`, `10 * MIB`), `Build.VERSION_CODES`.

### CS3. Limity wpisane w teksty dla użytkownika

„20 plików” i „10 MB” (`ext/views/forms/attachments.ts:13–18`, `aapp/AttachmentFiles.kt:23, 25`), „limit 10 MiB” (`aapp/TransferFiles.kt:26`), „limit 256 MiB” (`PassHolderZip.kt:32`), „64 KiB” (`ext/phone-client.ts:37`), „5 min” (`aapp/SyncController.kt:50`, `aapp/ui/SyncScreen.kt:42`), „15 minut” (`ext/popup.ts:18`, `aapp/LockController.kt:102`), „60 s” (`LockController.kt:154`, `aapp/ui/SettingsScreen.kt:84`), „12 znaków” (`aapp/ui/StartScreen.kt:48`, `ChangePasswordScreen.kt:32`), „2 minuty” (`aapp/autofill/AutofillSaveActivity.kt:37`).

**Problem:** zmiana stałej nie zmieni tekstu.

**Poprawka:** tekst budowany ze stałej.

### CS4. Powielone teksty i etykiety

- Polskie etykiety pól („Rodzaj dokumentu”, „Data ważności”, „Wystawca”…) osobno w imporcie Bitwarden i NordPass, w TS i w Kotlinie. Nazwy rodzajów dokumentu: `DOCUMENT_KIND_NAMES` (rdzeń) i `DOCUMENT_KIND_LABELS` (UI) na obu platformach.
- „Złe hasło główne” 6 razy (Android). „Odblokuj PassHolder” 4 razy. „Hasła się różnią” 2 razy. „Nowe hasło musi być inne niż obecne” w `AppViewModel.kt:308` i `PhoneVaultStore.kt:251`.
- „Plik jest pusty”, „zły format wpisu”, „brak nazwy” po 2–3 razy na platformę. „inny rozmiar niż w opisie” 4 razy (`ext/vault-store.ts:594`, `core/transfer/passholder-zip.ts:79`, `ArchiveReader.kt:127`, `PhoneVaultStore.kt:525`).
- Koperta `{format: "passholder", version: 3}` budowana 2 razy na platformę.

**Poprawka:** jeden plik tekstów na platformę. Łączy się z CW1 i decyzją D4.

### CS5. Trzy wersje normalizacji adresu

`core/autofill/match.ts:19–31`, `core/save/url.ts:4–17`, `core/transfer/nordpass-csv.ts:32–38`; `acore/autofill/Match.kt:74`, `acore/save/SaveUrl.kt:9`, `acore/transfer/NordPassCsv.kt:39–48`.

**Problem:** kolejność kroków (prefiks schematu, `www.`, końcowa kropka) różni się między `match.ts:28` a `url.ts:12`, a Kotlin utrwala tę różnicę flagą `wwwBeforeDot`. Komentarz w `NordPassCsv.kt` przyznaje różnicę zachowania względem TS (host IDN zostaje w Unicode). Domyślny port jest liczony w dwóch miejscach.

**Poprawka:** jedna funkcja normalizacji na platformę. Najpierw test, który pokaże, czy różnica kolejności jest zamierzona.

### CS6. Drobne narzędzia przepisane kilka razy

- TS: łączenie tablic bajtów 3 razy (`core/encoding.ts:42`, `core/transfer/zip.ts:58`, `core/p2p/frames.ts:29–34`); typ `Reply` i `fail()` 2 razy (`core/p2p/host.ts:34, 49`, `core/files/host-files.ts:97, 99`); `sha256Hex` (`ext/clipboard.ts:16`, `core/files/chunks.ts:20`); `sameBytes` (`ext/vault-store.ts:272`, `core/p2p/host.ts:52`); ścieżki `/p2p/v1/…` jako literały (`core/p2p/pair-client.ts:38, 44, 73, 87`, `core/p2p/host.ts:87`), choć ścieżki `/p2p/v2/…` mają stałe (`core/p2p/transport.ts:7–9`).
- Kotlin: zapis atomowy (plik tymczasowy, `fsync`, przeniesienie) 3 razy (`FileSyncStore.kt:65–75`, `DiskFileStore.kt:51–64`, `HostState.kt:62–70`); ścisłe dekodowanie UTF-8 3 razy (`Encoding.kt:18`, `ArchiveReader.kt:413`, `aapp/TransferFiles.kt:62`); `readCapped` 2 razy (`TransferFiles.kt:49`, `AttachmentFiles.kt:100`); ścieżki HTTP jako literały w `PhoneRouter.kt:34–39`, `P2pHost.kt:76–80`, `PairingHost.kt:69–71`.
- Tłumaczenie `IOException`/`SecurityException` na polski `IOException` 5 razy, w 4 z nich bez przyczyny (`TransferFiles.kt:37–44, 78–85, 129–135`, `AttachmentFiles.kt:74–82, 128–136`).

**Poprawka:** po jednej funkcji (`concat`, `writeAtomically`, `decodeUtf8Strict`, `readFailing`), zawsze z przyczyną wyjątku.

### CS7. Cztery style zgłaszania błędu

- Wyjątek; tekst błędu jako wynik (`validateContent(): String?` `aapp/entries/EntryTypes.kt:111` i `ext/entry-types.ts:101`, `HostSync.validate(): String?`, `phoneUrlFields().read()` `ext/ui/phone-url-fields.ts:39`); `null` jako porażka (`SaveReviewModel` `aapp/autofill/SaveReview.kt:181–201`); wyjątek jako wynik (`forgetFingerprint(): Exception?` `aapp/AppViewModel.kt:289`).
- Typ `{ok: true} | {ok: false; error}` zdefiniowany 3 razy (`ext/autofill/fill-tab.ts:25`, `ext/save/messages.ts:52`, `ext/save/candidates.ts:57`).
- Wyjątek bez komunikatu jako „pomiń ten wpis”: `throw new Error()` 9 razy (`core/transfer/passholder-json.ts:38–51, 84`), `fail(): Nothing` z `catch (_: Exception)` (`PassHolderJson.kt:35, 94`).

**Poprawka:** jedna zasada: wyjątek domenowy dla błędu, jeden wspólny typ wyniku dla walidacji.

### CS8. Dwa języki w komunikatach rdzenia

Polskie teksty dla użytkownika są rzucane z rdzenia (`core/p2p/pair-client.ts:11–14`, `core/transfer/*`, `PhoneVaultStore.kt`) obok angielskich (`"ZIP too large"` `core/transfer/zip.ts:104`, `"No host state"`, `"Sync store was reset"`).

**Poprawka:** rdzeń zgłasza kod, warstwa UI wybiera tekst. Wymaga decyzji D4.

### CS9. Ta sama praca wykonywana dwa razy

- JSON parsowany dwukrotnie: `core/transfer/detect.ts` i właściwy parser; `acore/transfer/Transfer.kt:32` i `BitwardenJson.kt:198–199`; `PhoneRouter.kt:48` i `P2pHost.kt:100`.
- `PhoneVault`: `listSince(0)` odszyfrowane dwa razy w `importContents` (89, 91) oraz osobno w `entries()` i `unreadableIds()`.
- `aapp/autofill/PassHolderAutofillService.kt`: plan liczony dwa razy (:29, :53), `saveSpecFor` wołane do trzech razy.
- `ext/vault-store.ts`: `pairFinish` sprawdza KDF dwa razy (725, 333) i dwa razy czyta `pendingPairing` (717–718).

**Poprawka:** policzyć raz i przekazać wynik dalej.

### CS10. `HostState`: stan zakodowany w trzech polach nullowalnych i mylący komentarz

```kotlin
// acore/p2p/HostState.kt:31
 * kdf == null means a restore from the extension is in progress.
// acore/p2p/PhoneVaultStore.kt:153
val restoreInProgress: Boolean get() = synchronized(stateLock) { state?.let { it.keyCheck == null } == true }
```

**Problem:** komentarz mówi o `kdf`, kod sprawdza `keyCheck` (153, 216, 625, 691). Sprawdzenia nulli są rozrzucone po klasie i wymuszają `!!` (CW4).

**Poprawka:** jawny typ stanu (np. `Ready` i `Restoring`), poprawiony komentarz. Mylący komentarz o `authKey` opisuje CW3.

### CS11. Powielona logika we wtyczce

- `fromExtensionPage`: `ext/background.ts:17` i `ext/save/candidates.ts:181`, z różnymi warunkami.
- Parsowanie adresu http(s): `candidates.ts:74–86` i `ext/autofill/fill-tab.ts:45–53`. `topOrigin` (`fill-page.ts:192`) i `frameRole` (`ext/save/watch.ts:17`). Typ `FieldElement` w `fill-page.ts:4` i `ext/save/read-form.ts:5`.
- Mapowanie wpisu na `MatchCandidate` 4 razy (`ext/views/list.ts:106–109`, `fill-tab.ts:68, 96`, `candidates.ts:156`).
- „Zapisz albo usuń, gdy puste” (`candidates.ts:105–112`, `ext/save/prompt-window.ts:41–48`).
- „Odczytaj adresy, poproś o uprawnienie, pokaż zajętość” 3 razy (`ext/views/connect.ts:49–59`, `ext/views/addresses.ts:33–41, 48–65`).
- Budowa komunikatów pytania o zapis (`ext/views/save-question.ts:9–23`, `ext/save/prompt-page.ts:15–37`).

**Poprawka:** wspólne funkcje w jednym module na temat.

### CS12. Kolizje nazw i pozostałości we wtyczce

- `TabApi` i `chromeTabApi` istnieją w dwóch plikach (`ext/open-in-tab.ts:12, 19`, `ext/autofill/fill-tab.ts:15, 27`) i znaczą co innego.
- `LOCKED` w `fill-tab.ts:4` i `vault-store.ts:29` ma różne teksty; `candidates.ts` importuje ten z `autofill`.
- `ApiError` (`ext/phone-client.ts:3`): nazwa z czasów serwera Pi, `status 0` znaczy „nieosiągalny”, pola `.status` nikt nie czyta.
- Stałe z przyrostkiem `_PL`. Klucz `"copiedPasswordHash"` (`ext/background.ts:28, 139, 141`) poza `STORAGE_KEYS`.

**Poprawka:** rozróżnić nazwy (`OpenTabApi`, `FillTabApi`), `ApiError` → `PhoneUnreachableError`, klucz do `STORAGE_KEYS`.

### CS13. Niebezpieczne rzutowania i `!!`

- Wtyczka: `(error as Error).message` (`ext/ui/dom.ts:47`, `ext/ui/phone-url-fields.ts:44`, `ext/views/locked.ts:68`, `ext/save/prompt-view.ts:76`); `.catch((err: Error) => …)` (`dom.ts:78`, `list.ts:74, 76`); rzutowania w `validateContent` (`ext/entry-types.ts:107, 116, 121, 128`); `id!` (`ext/views/edit.ts:70, 77`).
- Kotlin: 20 razy `!!` w kodzie produkcyjnym (`HostSync` 8, `PhoneVaultStore` 5, `BitwardenJson` 2, `Noise` 2, `FileHost` 2, `Pairing` 1).

**Poprawka:** `errorMessage(e: unknown)`, zawężanie typów zamiast rzutowań. `!!` znikną po CW4, CW7 i CW8.

### CS14. Powielone elementy interfejsu

- Android: okno „Usunąć sejf z tego telefonu?” dosłownie 2 razy (`aapp/ui/StartScreen.kt:81–88`, `LockedScreen.kt:63–70`); ten sam kształt `AlertDialog` jeszcze w `EditScreen.kt:84–92`, `DevicesScreen.kt:57–66`, `AttachmentsEditor.kt:105–119`. Trzy prawie identyczne wiersze z przełącznikiem (`SettingsScreen.kt:58–72, 79–91, 98–110`). `PasswordField` i `SecretField` (`Common.kt:77, 117`). `LockedScreen` i `AutofillUnlockScreen` mają ten sam formularz. Pomocnik `pick(launch)` 2 razy (`TransferScreen.kt:87–95`, `AttachmentsEditor.kt:65–74`).
- Wtyczka: `passwordField` i `secretField` (`ext/ui/dom.ts:54–64, 70–94`); pole kodu parowania (`connect.ts:44`, `addresses.ts:45`); przycisk „wstecz” 4 razy.

**Poprawka:** `ConfirmDialog`, `SettingSwitchRow`, jedno pole sekretu z opcjami.

### CS15. Logika w funkcjach Compose i globalny dostęp do aplikacji

- `aapp/ui/forms/LoginForm.kt:49, 69` sięga po `PassHolderApp` przez `LocalContext` i woła `appTrust.remember` w korutynie.
- `aapp/ui/forms/GeneratorCard.kt:66–73` generuje hasło i zapisuje opcje.
- `PassHolderApp` ma ok. 10 publicznych pól `var` „podmienianych w testach”. Klucze ustawień w `Settings` są wpisane po 2 razy.

**Poprawka:** logika do modelu (razem z CW9), zależności przez konstruktor.

### CS16. Nazwy, które mylą

- „unlock keys” w liczbie mnogiej dla jednego klucza (`exportUnlockKeys`, `unlockWithKeys`, `UnlockKeyProtector`).
- Pytanie i polecenie w jednej funkcji: `PendingSave.peek(): Boolean`, `LeaveLock.cancel(): Boolean`. `LeaveLock.schedule(delayMs)` zawsze dostaje `DELAY_MS`.
- `PhoneVault.read` zwraca `Hlc`, a `readData` dane. Pozycyjne wartości logiczne `RemoteRecord(id, rev, false, blob)` (78, 107, 120).
- `core/p2p/host.ts`: `#o` (opcje), `#session` (metoda nazwana rzeczownikiem), `#full` (zwraca odpowiedź, a brzmi jak pytanie tak/nie).
- `syncVaultV2(…, maxRounds)`: nikt nie przekazuje, nazwa koliduje z `MAX_SYNC_ROUNDS`, a to limit ponowień po konflikcie.
- Nazwy jednoliterowe w `PhoneVaultStore` (`s`, `a`, `t`, `fs`, `enc`). Pary `onX`/`doX` w `candidates.ts` nazwane niekonsekwentnie.

**Poprawka:** zmiana nazw. Wymaga decyzji D3 tylko w części o przyrostkach (CW12).

### CS17. Sprytny kod

```kotlin
// acore/transfer/NordPassCsv.kt:70–73
declared != "" -> TYPES[declared.lowercase()] ?: run {
    skipped.add(ImportSkip(at, "typ „$declared” nie jest obsługiwany"))
    null
} ?: continue
```

```ts
// ext/vault-store.ts:979
for (const u of account.phoneUrls) ((await this.canReach(u)) ? allowed : skipped).push(u);
```

Także: ten sam chwyt w `PassHolderZip.kt:114–117`, sztuczka z próbnym `Intent` (`aapp/autofill/SaveReview.kt:98–102`), gęsty `?:` w `core/autofill/match.ts:45`, rodzaj wpisu jako napis `"login" | "note" | "card" | "contact"` zapisany 2 razy (`core/transfer/nordpass-csv.ts:25, 59`).

**Poprawka:** zwykły `if` z wczesnym `continue`, nazwana funkcja `samePort()`, typ wyliczeniowy.

### CS18. Drobne powtórzenia w Androidzie

- `if (app.leaveLock.expired()) store.lock()` 4 razy (`AutofillAuthActivity.kt:141`, `SaveLogin.kt:25`, `PassHolderAutofillService.kt:55`, `SaveReview.kt:115`).
- Literał „Nie udało się zapisać w PassHolder” (`PassHolderAutofillService.kt:130`) obok stałej `SAVE_FAILED` (`SaveReview.kt:207`). Pomocnik komunikatu toast 2 razy.
- `aapp/autofill/SaveLogin.kt:28` buduje `SaveReview` tylko po to, by przekazać go dalej.
- `acore/autofill/Match.kt` łączy 4 tematy, w tym tablicę `TRUSTED_BROWSERS`.
- `acore/p2p/SyncHttpServer.kt`: `throw HttpError(400, "bad request")` 7 razy; `closeQuietly` (:298) istnieje, ale nie jest użyte w 73–76 i 95–98.
- `aapp/ui/TransferScreen.kt:44`: komentarz KDoc o `zip` stoi nad `CSV_WARNING` zamiast nad `ExportChoice`.
- `aapp/autofill/ResponseBuilder.kt`: warunek `inline != null && SDK >= R` 3 razy (54, 77, 82).

### CS19. Drobne rzeczy w `core/` i wtyczce

- `FileSyncResult.corrupted` i `corruptedIds` to dwie równoległe tablice (`core/files/client.ts:134–136`). Lepiej jedna lista `{id, name}`.
- `pairStart` i `repair` przyjmują `urls: string | readonly string[]`, a produkcja zawsze podaje tablicę (`ext/vault-store.ts:644, 769`). `pairStart` zwraca stałe `{ needsPassword: true }` (:670).
- `[baseUrl, ...typed.filter(…)]` 2 razy (660, 809). Stałe komunikatów w dwóch blokach (29–39, 203–208).

## 6. Znaleziska niskie

### CN1. Brak formatera i lintera

Nie ma ESLint, Prettier, ktlint, detekt ani `.editorconfig`. Linie ponad 140 znaków: Kotlin 54, wtyczka 45, `core/` 3 (ponad 120 znaków w Kotlinie: 254). W `ext/autofill/fill-page.ts:7` został komentarz `eslint-disable-next-line`, choć ESLint nie jest używany.

**Poprawka:** formater i minimalny linter ze sprawdzeniem w CI. Wymaga decyzji D1.

### CN2. Zaczepy testowe w sygnaturach produkcyjnych

Parametry `nonce` w `seal` i `wrapVaultKey`, `ya` w `cpaceStart`, `e` w opcjach Noise, `encryptFixed`, `_cpaceInternals`, wewnętrzne konstruktory w Kotlinie.

**Poprawka:** wstrzykiwane źródło losowości albo osobne funkcje wewnętrzne dla testów.

### CN3. Niespójne konwencje

`private` obok `#private` (`core/protocol.ts:63`, `core/transfer/zip.ts:75`); `catch (e)`, `(err)`, `(error)`; `null` obok `undefined` jako „brak”; stałe najwyższego poziomu obok stałych w `companion` (Kotlin); typy na końcu pliku (`PassHolderJson.kt:120–129`); pełne nazwy pakietów w kodzie (`AppViewModel.kt:465`, `Frames.kt:31`).

### CN4. Drobna czytelność

- `core/protocol.ts:49–53`: kolejność `if`/`else`/`continue` (punkt 17 z przeglądu 1, nadal otwarty).
- `Hlc {ms, c, d}` bez opisu pól (TS i Kotlin). `strings()` w `core/p2p/entry.ts:166` to `list(v, str)`.
- `aapp/BiometricUnlock.kt` zawiera 7 typów. `reportError` leży w `PairingHost.kt:180`, a używają go 3 inne pliki. Obejście `parcelable` dla API 33 w 2 miejscach (`AutofillUnlockActivity.kt:52`, `SaveState.kt:40`).
- `ext/background.ts`: trzy osobne nasłuchy `onMessage`. `SavePromptInfo.decision | null` plus `locked` zamiast unii z dyskryminatorem.

## 7. Punkty z przeglądu 1

| Punkt | Stan | Gdzie teraz |
|---|---|---|
| 15. Ekrany dostają cały `AppViewModel` | otwarty | CW9 |
| 16. Liczby magiczne | otwarty, miejsc przybyło | CS2 |
| 17. Drobna czytelność `protocol.ts` | otwarty | CN4 |

## 8. Dobre praktyki

- Małe, spójne moduły w `core/`. Brak cykli importów w rdzeniu.
- Komentarze mówią „dlaczego”: odwołania do specyfikacji (sekcje Noise, szkic CPace, RFC 9496), kolejność blokad, osobliwości Chrome i Androida, identyfikatory z przeglądu bezpieczeństwa.
- Ścisłe parsery danych z zewnątrz. Wspólne wektory testowe TS i Kotlina.
- Zależności systemowe za małymi interfejsami: `TabApi`, `WindowApi`, `AlarmApi`, `KeyValueStore` (wtyczka); `FingerprintPrompt`, `UnlockKeyProtector`, `AppSigners`, `SecretWrapper`, `FileStore`, `SyncStore` (Android). Zegar jest wstrzykiwany.
- Typy zamknięte i unie z dyskryminatorem: `Screen`, `AfterUnlock`, `SaveDecision`, `SaveTarget`, `FillPlan`.
- `LockController`, `BiometricController`, `SyncController` są już wydzielone i mają opis „kiedy blokuje”.
- Konsekwentne zerowanie kluczy (`useAndWipe`).
- Wzorcowe ekrany bezstanowe: `SaveReviewScreen`, `AutofillUnlockScreen`. Wzorcowy mały plik: `ext/popup.ts` (23 linie).
- Typowane wiadomości z `satisfies` i formularze `FieldsForm<T>` we wtyczce.

## 9. Proponowane grupy poprawek

Każda grupa to jeden wątek i jeden PR, w tej kolejności.

| Nr | Grupa | Znaleziska | Moduły | Rozmiar |
|---|---|---|---|---|
| G1 | Formater i linter (po decyzji D1) | CN1 | wszystkie | mały, duży diff |
| G2 | Martwy kod i kod tylko dla testów (po decyzji D2) | CW3 | wszystkie | średni |
| G3 | Nazwy (po decyzji D3) | CW12, CS16, CN3, CN4 | wszystkie | średni |
| G4 | Błędy z kodami: TypeScript | CW1, CS7, CS8, CS12, CS13 (część TS) | core, wtyczka | duży |
| G5 | Błędy z kodami: Kotlin | CW1, CS7, CS8 (część Kotlin) | android | duży |
| G6 | Wspólne pomocniki | CW2, CS6 | core, android | średni |
| G7 | Stałe, limity i teksty w jednym miejscu | CS1, CS2, CS3, CS4 | wszystkie | średni |
| G8 | Protokół synchronizacji i plików | CK5, CW7, CW15, CK8 (logika), CN2 | core, android | duży |
| G9 | Import, eksport i format wpisu | CK4, CW6, CW8, CS5 | core, wtyczka, android | duży |
| G10 | Podział `VaultStore` i `save/candidates.ts` | CK1, CW14, CS19 | wtyczka | duży |
| G11 | Widoki wtyczki | CK6, CW10, CW13, CS11, CS14 (część wtyczki) | wtyczka | duży |
| G12 | Podział `PhoneVaultStore` | CK2, CW4, CS10, CS13 (część Kotlin) | android | duży |
| G13 | Podział `AppViewModel`, ekrany bez całego modelu | CK3, CW5, CW9, CS15 | android | duży |
| G14 | Ekrany i autouzupełnianie Androida | CK7, CK8 (Compose), CW10, CW11, CS14, CS18 | android | średni |

CW16 (funkcje 20–50 linii), CS9 (podwójna praca) i CS17 (sprytny kod) wchodzą do grup G8–G14 według pliku.

Zasady dla każdej grupy:

- Zachowanie bez zmian. Testy i wektory testowe bez zmian, poza G2, gdzie testy przechodzą na aktualne API.
- Znaleziska lustrzane poprawiać w TS i w Kotlinie w tym samym PR.
- Po G11, G13 i G14 potrzebny krótki test ręczny, bo zmieniają interfejs, a testy ręczne T15 i T17–T30 są niepotwierdzone.
- Po zmianie plików lub klas aktualizować `docs/ARCHITEKTURA.md`.

Największy zysk przy najmniejszym ryzyku dają G2, G4, G5, G6 i G7. Największe ryzyko mają G10, G12 i G13 (podział klas z blokadami i stanem).

## 10. Decyzje właściciela

| Nr | Pytanie | Moja rekomendacja |
|---|---|---|
| D1 | Czy dodać formater i linter (Prettier i ESLint dla TS, ktlint dla Kotlina) ze sprawdzeniem w CI? | Tak, jako pierwszy PR. Koszt: jeden duży commit z samym formatowaniem. |
| D2 | Czy usunąć stare API „tylko login” i przepisać 81 wywołań w testach? | Tak. |
| D3 | Czy usunąć przyrostki `V2`/`V3` z nazw (`LocalVault`, `upsertEntry`, `EntryContent`)? | Tak. Wersja zostaje w danych. |
| D4 | Polskie teksty w rdzeniu: (a) rdzeń zgłasza kody, teksty w warstwie UI, czy (b) teksty zostają w rdzeniu, ale w jednym pliku? | (a). Więcej pracy, ale rozwiązuje CW1, CS4 i CS8 naraz. |
| D5 | Długie listy parametrów w funkcjach Compose: poprawiać? | Nie, poza `SaveReviewScreen` (9 parametrów). |
| D6 | Zakres: wszystkie 14 grup czy tylko część? | Wszystkie, po kolei. Można przerwać po każdej grupie bez szkody. |
