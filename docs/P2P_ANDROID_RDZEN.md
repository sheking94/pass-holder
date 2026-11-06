# Rdzeń P2P w Kotlinie (`android/core`, pakiet `core.p2p`)

Dokument opisuje plan 2 z 4 synchronizacji bez Pi (projekt w `SYNCHRONIZACJA_P2P.md`): przeniesienie
rdzenia P2P z TypeScriptu (`core/src/p2p/`, opis w `P2P_RDZEN.md`) do Kotlina, tak żeby telefon mógł być
**hostem** synchronizacji i stroną parowania. Kod leży w
`android/core/src/main/kotlin/io/github/sheking94/passholder/core/p2p/` (czysty Kotlin/JVM, bez Androida),
testy w `android/core/src/test/kotlin/io/github/sheking94/passholder/core/p2p/`. Gałąź:
`claude/p2p-android-core`.

Zachowanie jest takie samo jak w `P2P_RDZEN.md` (kontrakt HTTP, kody błędów, ramki, stronicowanie, epoka);
ten dokument opisuje tylko to, co w Kotlinie jest inne albo dodatkowe. W razie rozbieżności wzorcem jest
wersja TypeScript. Zgodność sprawdzają wektory (`core/test-vectors/v2.json` i trzy wektory kryptograficzne)
oraz test współpracy z prawdziwym klientem wtyczki w TypeScripcie.

Kod v1 (`android/core/src/main`, `android/app`, `core/src`, `server/`, `extension/`) nie został zmieniony.
Nowy kod używa z v1 tylko `Encoding`, `Aead`, `Kdf`, `KdfParams`, `Credentials`, `RemoteRecord`,
`ChangeRequest`, `Accepted` i `SyncResponse`. Jedyna zmiana w plikach v1 to przekazanie zmiennej
`PASSHOLDER_INTEROP_TEST` w `android/core/build.gradle.kts`. Nie doszły żadne nowe zależności.

## 1. Pliki i odpowiedniki w TypeScripcie

| Plik Kotlin | Odpowiednik TS | Co robi |
|---|---|---|
| `P2pJson.kt` | brak (`JSON.stringify`, `Number.isSafeInteger`) | Jedyny obiekt `Json { encodeDefaults = true }` dla całego rdzenia (bez spacji, pola w kolejności z TS, więc szyfrogramy wektorów wychodzą bajt w bajt) i `safeLong`: liczba JSON całkowita w zakresie `0..9_007_199_254_740_991`, tekst i ułamki odrzucane (punkt 3). |
| `Hlc.kt` | `hlc.ts` | `Hlc(ms, c, d)` z porządkiem `(ms, c, d)`; `d` porównywane `String.compareTo`, czyli w jednostkach UTF-16, jak w JS. `HlcClock` (`tick`, `observe`, metody `@Synchronized`), `parseHlc` dla danych z sieci. |
| `EntryV2.kt` | `entry.ts` | `EntryDataV2`, `TombstoneDataV2`, `EntryV2.encrypt` / `encryptTombstone` / `decrypt` / `parseEntry` / `parseTombstone`; AES-256-GCM z AAD `passholder/v2/entry/<id>`. |
| `Ristretto255.kt` | `@noble/curves` (`ristretto255`) | Grupa ristretto255 według RFC 9496 na `BigInteger` (Bouncy Castle 1.82 jej nie ma): dekodowanie z odrzucaniem niekanonicznych kodowań, kodowanie, dodawanie, mnożenie, `fromUniformBytes` (mapa jednokierunkowa). Klasa `internal`. **Bez stałego czasu wykonania** (punkt 4). |
| `Cpace.kt` | `cpace.ts` | CPace `CPACE-RISTR255-SHA512` (draft-irtf-cfrg-cpace-21), `Cpace.start` / `Cpace.finish`, `CpaceRole`, `PAIRING_CI`, `lvCat`. Wiadomość na drucie to `lv_cat(Y, ad)`, jak w TS. |
| `Noise.kt` | `noise.ts` | `Noise_KK_25519_AESGCM_SHA256` (rev. 34): `NoiseKK.initiator` / `responder`, `CipherState`, `NoiseKeys.generate` / `fromPrivateKey`, `KeyPair`, `TransportCiphers`, `P2P_PROLOGUE`. X25519 z Bouncy Castle, AES-GCM i HMAC z JCA. W TS szyfrowanie jest asynchroniczne (WebCrypto), tu synchroniczne. |
| `Pairing.kt` | `pairing.ts` | `Pairing.generateCode` (8 cyfr, bajty >= 250 odrzucane), `Pairing.key` (HKDF-SHA256, info `passholder/v2/pair-key`), `aad`, `sealIdentity` / `openIdentity`, `sealVaultInfo` / `openVaultInfo` z tą samą walidacją pól co w TS. TS ma jedno `seal`/`open` z rodzajem; tu są osobne funkcje dla każdego rodzaju, żeby wynik miał typ. |
| `Frames.kt` | `frames.ts` | `Frames.encrypt` / `decrypt`, `MAX_FRAME_PLAINTEXT = 65519`, `MAX_FRAMES = 18`. Każdy błąd (Base64, tag, UTF-8, JSON) wychodzi jako `IllegalArgumentException`. |
| `HostSync.kt` | `host-sync.ts` oraz `SyncStore` / `MemorySyncStore` / `processSync` z `protocol.ts` | `SyncStore`, `MemorySyncStore`, `P2pSyncRequest`, `P2pSyncResponse`, `HostSync.validate` (tekst błędu albo `null`), `HostSync.process` (epoka, cofnięty telefon, stronicowanie po 500), `processSync` przeniesione z v1. |
| `P2pHost.kt` | `host.ts` | `P2pHost.handle(path, body)` zwraca `HostReply(status, body)`; `PairedDevice`; stałe `MAX_BODY_BYTES`, `SESSION_TTL_MS`, `MAX_SESSIONS`. Nie otwiera gniazda (to plan 3). |
| `PhoneVault.kt` | brak (najbliżej `upsertEntryV2` / `deleteEntryV2` z `sync.ts`) | Własne zmiany telefonu: `upsert`, `delete`, `entries`, `unreadableIds`. Pisze prosto do `SyncStore` z kolejną `revision` i HLC telefonu (punkt 2). |

Testy (`src/test/.../p2p/`): `HlcTest`, `P2pJsonTest`, `EntryV2Test`, `Ristretto255Test`, `CpaceTest`,
`NoiseTest`, `PairingTest`, `FramesTest`, `HostSyncTest`, `P2pHostTest`, `PhoneVaultTest`, `P2pVectorsTest`,
`P2pInteropTest` oraz pomocniczy klient `TestP2pClient` (uzgadnianie i sync przeciw `P2pHost` w pamięci).

### Co nie zostało przeniesione i dlaczego

- **Klient synchronizacji wtyczki** (`sync.ts`: `LocalVaultV2`, `syncVaultV2`, `applyVaultInfo`,
  `clockForVault`, `adoptEpoch` i reszta) oraz **`noiseTransport`** (`transport.ts`). Telefon jest kotwicą i
  nigdy nie synchronizuje się jako klient, więc ten kod w Kotlinie nie miałby wywołującego. Jego zgodność
  z hostem w Kotlinie sprawdza `P2pInteropTest`: prawdziwy `syncVaultV2` i `noiseTransport` z TypeScriptu
  rozmawiają przez HTTP z `P2pHost`.
- **`index.ts`** (eksporty) nie ma odpowiednika; w Kotlinie widoczność ustalają `internal` i `private`.
  Odpowiednikiem `_cpaceInternals` są funkcje `internal` w `Cpace` (`generatorString`, `generatorHash`,
  `calculateGenerator`, `sharedPoint`), widoczne tylko w testach modułu.

## 2. Różnice względem TypeScriptu

### `handle` dostaje surowe bajty ciała

W TS `P2pHost.handle(path, body)` jest asynchroniczne i dostaje już sparsowany JSON (rozmiar liczy się po
ponownym `JSON.stringify`). W Kotlinie `handle(path: String, body: ByteArray): HostReply` jest synchroniczne
i dostaje bajty ciała HTTP, więc warstwa HTTP z planu 3 tylko kopiuje ścieżkę, ciało, kod i odpowiedź.
Kolejność sprawdzeń jest ta sama co w `P2P_RDZEN.md` §4:

1. ciało dłuższe niż 1 MiB (`1024 * 1024` bajtów surowego ciała) → 413 `body too large`, przed wszystkim innym,
2. nieznana ścieżka → 404,
3. ciało, które nie jest poprawnym UTF-8, nie jest poprawnym JSON-em albo nie jest obiektem JSON → **400
   `malformed request`**, tak samo jak brak pól (w TS takie ciało odrzuca już parser HTTP).

Reszta kodów i tekstów `error` jest identyczna z tabelą w `P2P_RDZEN.md` §4.

### Wyjątki

Błędne dane z sieci rzucają `IllegalArgumentException` z tymi samymi komunikatami co w TS
(`"CPace: invalid peer element"`, `"Noise: decryption failed"`, `"Invalid HLC"` i tak dalej). Noise rzuca
dodatkowo `IllegalStateException` przy złej kolejności kroków albo złym stanie (`writeMessage` dwa razy,
`split()` przed końcem uzgadniania, wyczerpany nonce). Host łapie oba rodzaje i odpowiada 400
`handshake failed`. `Frames.decrypt` zamienia każdy inny błąd (np. `AEADBadTagException`, zły UTF-8) na
`IllegalArgumentException`. Host egzekwuje też liczbę ramek 1..`MAX_FRAMES` (18) przed odszyfrowaniem.

Wyjątek rzucony przez wywołanie zwrotne `devices()` (np. błąd odczytu listy urządzeń z bazy) **nie jest
łapany**: wychodzi z `P2pHost.handle`. Warstwa HTTP z planu 3 musi go zamienić na 500. Błąd przy budowaniu
odpowiedzi sync (`HostSync.process`, szyfrowanie ramek, `addresses()`) host sam zamienia na 500
`internal error`.

### `PhoneVault`

W TS nie ma odpowiednika: tam własne zmiany robi tylko wtyczka (`upsertEntryV2` w `LocalVaultV2`, potem
`syncVaultV2`). Telefon jest hostem, więc swoje zmiany zapisuje od razu w `SyncStore`, tym samym, który
obsługuje `P2pHost`:

- `upsert(id, credentials)` i `delete(id)` szyfrują wpis albo nagrobek kluczem sejfu z HLC telefonu i
  zapisują `RemoteRecord` z `revision = currentRevision() + 1`. Wtyczka dostaje go przy następnej
  synchronizacji jako zwykłą zmianę.
- Przed `tick()` zegar wywołuje `observe` na HLC nadpisywanej wersji (jak `upsertEntryV2` w TS), a
  konstruktor wznawia zegar po największym HLC w sklepie (jak `clockForVault`), więc edycja na telefonie
  jest zawsze późniejsza od tego, co nadpisuje, także po restarcie aplikacji.
- `delete` nieznanego `id` nic nie robi.
- `entries()` zwraca żywe wpisy posortowane po nazwie; rekordy, których nie da się odszyfrować albo
  odczytać, są pomijane, a `unreadableIds()` je wylicza (ekran może o nich ostrzec).
- Telefon nie ma flagi `dirty` ani konfliktów: zapis do sklepu jest od razu „wysłany”. Konflikt z
  równoległą zmianą z wtyczki rozstrzyga wtyczka po HLC (`P2P_RDZEN.md` §3 krok 5).

### Bezpieczeństwo wątków

Serwer HTTP z planu 3 będzie wołał `handle` z wielu wątków naraz, a ekran telefonu w tym czasie może
zapisywać przez `PhoneVault`. Zasady:

- Każda operacja na `SyncStore` z zapisem (i każdy odczyt, który musi być spójny z zapisem) idzie pod
  `synchronized(store)`. Robią to `HostSync.process`, `P2pHost` (przy `validate`) i wszystkie metody
  `PhoneVault`. `MemorySyncStore` sam niczego nie blokuje; trwały `SyncStore` z planu 3 musi przyjąć tę
  samą umowę (blokada na obiekcie sklepu, a nie wewnątrz niego), inaczej dwa zapisy dostaną tę samą `revision`.
- Mapa sesji jest pod `synchronized(sessions)`; limit `MAX_SESSIONS` jest sprawdzany jeszcze raz przy
  wstawianiu, bo równoległe uzgadniania mogły ją zapełnić.
- Sesja jest wyjmowana z mapy przy pierwszej próbie sync, więc jej `CipherState` (który sam nie jest
  bezpieczny wątkowo) obsługuje dokładnie jedno żądanie w jednym wątku.
- `HlcClock` i `NoiseKK` mają metody `@Synchronized`.
- `P2pHost` sprawdza żądanie (`validate`) pod blokadą sklepu, a `process` sprawdza je jeszcze raz w swoim
  bloku `synchronized(store)` przed pierwszym zapisem. Te dwa sprawdzenia nie są jednym atomowym blokiem,
  ale drugie wystarcza, żeby zła zmiana nigdy nie została zapisana; zmiana sklepu pomiędzy nimi kończy się
  najwyżej 500 zamiast 400.

`P2pHostTest.handlesConcurrentCallsFromManyThreads` i
`PhoneVaultTest.concurrentUpsertsAndHostProcessKeepRevisionsUnique` sprawdzają to na wielu wątkach.

## 3. Liczby z sieci (`safeLong`)

`revision`, `sinceRevision`, `baseRevision`, `ms`, `c` i parametry KDF z wiadomości parowania są w
Kotlinie typu `Long` i muszą być liczbą JSON (nie tekstem) całkowitą z zakresu
`0..Number.MAX_SAFE_INTEGER`, jak `Number.isSafeInteger` w TS. Zapis typu `5.0` albo `5e0` jest przyjmowany
(to ta sama liczba dla `JSON.parse`), `5.5`, `-1`, `"5"` i `2^53` nie.

Dwie świadome różnice, obie przeciw atakom na pamięć i czas (`BigDecimal` przyjmuje `1e999999999`, a
rozwinięcie takiej liczby zjada pamięć):

- tekst liczby dłuższy niż **32 znaki** jest odrzucany od razu, nawet jeśli to poprawna bezpieczna liczba
  całkowita zapisana z wieloma zerami (`5.000…0`),
- `0e<ogromny wykładnik>` (np. `0e999999999`) jest odrzucane, choć w JS to po prostu `0`.

`JSON.stringify` nigdy tak nie zapisuje liczb, więc klient TS (i każdy inny, który go używa) tego nie
odczuje; taki zapis od kogoś innego dostaje 400.

## 4. ristretto255 bez stałego czasu wykonania

`RistrettoPoint` liczy na `BigInteger`: czas mnożenia, odwrotności i pierwiastka zależy od wartości
(długość i bity skalara, rozgałęzienia zależne od danych, długość liczb). Ktoś, kto zmierzy czas tych
operacji wystarczająco dokładnie, dowie się czegoś o danych wejściowych. `multiply` przyjmuje tylko
nieujemne skalary (inne rzucają `IllegalArgumentException`), a CPace przekazuje skalary zredukowane
mod `L`.

Co to znaczy dla CPace, jedynego użytkownika tej klasy:

- **Skalar `y` jest jednorazowy.** `Cpace.start` losuje go na nowo przy każdym parowaniu, służy do dwóch
  mnożeń (`Y = y·g` i `K = y·Y_partnera`) i ginie razem ze stanem. Atak czasowy potrzebuje zwykle wielu
  pomiarów operacji na **tym samym** sekrecie; tu atakujący ma jedną lub dwie próbki na skalar, a następne
  parowanie ma inny skalar. Nawet częściowa wiedza o `y` nie przydaje się w kolejnej próbie.
- **Generator `g` zależy od kodu parowania**, więc czas jego wyliczenia (mapa z `fromUniformBytes`) też
  zależy od kodu. Kod jest jednorazowy, ważny krótko i telefon nie próbuje drugi raz po błędzie, więc
  atakujący nie może powtarzać pomiarów dla tego samego kodu. Zdalny pomiar przez Wi-Fi gubi tak małe
  różnice w szumie sieci; dokładny pomiar wymagałby kodu uruchomionego na samym telefonie, a wtedy
  atakujący ma prostsze drogi.
- Klucze długoterminowe (statyczne klucze Noise, X25519) **nie** idą przez tę klasę: liczy je Bouncy
  Castle (`X25519`), które działa w stałym czasie. AES-GCM, HMAC i SHA pochodzą z JCA.

Dlatego klasa jest `internal`, ma ostrzeżenie w KDoc i **nie wolno jej używać do kluczy długoterminowych**
ani do niczego, co liczy wiele razy na tym samym sekrecie. Gdyby Bouncy Castle (albo inna dopuszczona
biblioteka) dostała ristretto255 w stałym czasie, warto ją podmienić; wektory RFC 9496 i draftu CPace
pokażą, czy wynik jest ten sam.

## 5. Testy

W `android/` (PowerShell, Windows):

```powershell
$env:JAVA_HOME="$HOME\.jdks\jbr-21.0.11"     # JDK 21; JBR 25 z Android Studio nie działa z Gradle 8.14.3
.\gradlew.bat :core:test --console=plain                                   # cały android/core (v1 i p2p)
.\gradlew.bat :core:test --tests "io.github.sheking94.passholder.core.p2p.*" --console=plain   # tylko p2p
.\gradlew.bat :core:test --tests "*P2pHostTest*" --console=plain           # jeden plik
```

Test współpracy z prawdziwym klientem wtyczki (potrzebny Node.js i `npm install` w katalogu głównym, bo
skrypt importuje `core/src/index.ts` z zależnościami `@noble`):

```powershell
fnm env --shell powershell | Out-String | Invoke-Expression    # node nie jest na PATH bez tego
$env:PASSHOLDER_INTEROP_TEST="1"
.\gradlew.bat :core:test --tests "*P2pInteropTest*" --console=plain
Remove-Item Env:PASSHOLDER_INTEROP_TEST
```

Wyniki są w `android/core/build/test-results/test/` (XML) i `android/core/build/reports/tests/test/`.

Co sprawdzają testy:

| Test | Co sprawdza |
|---|---|
| `P2pVectorsTest` | `core/test-vectors/v2.json` bit w bit: `hlcCompare`, `entryPayload` (blob ze stałym nonce), `pairingKey`, `pairingMessage` (z `aad`), `frames`, `paging`. |
| `Ristretto255Test` | wektory RFC 9496 (`core/test-vectors/ristretto255-rfc9496.json`): wielokrotności generatora, niepoprawne kodowania, mapa jednokierunkowa, rząd `L`, stałe. |
| `CpaceTest` | wektor z dodatku B.3 draftu CPace (`cpace-ristretto255.json`) z wartościami pośrednimi; zły kod, role, element neutralny, śmieci, zła ramka `lv_cat`. |
| `NoiseTest` | wektor Cacophony (`noise-kk.json`), prolog, powtórzona ramka, zły klucz, kolejność kroków, limit 65535 B, nonce (cztery bajty zera i licznik big-endian), `nonce = 2^64-1`. |
| `PairingTest` | wiadomości parowania w obie strony, odbita wiadomość, zły klucz i rodzaj, granice pól, słaby KDF, pełne parowanie w pamięci kodem i z innym kodem. |
| `HlcTest`, `P2pJsonTest`, `EntryV2Test`, `FramesTest` | zegar i porządek, `safeLong` (też `1e999999999` szybko odrzucane), wpis i nagrobek z AAD, ramki (emoji na granicy ramki, brak, zamiana, zmiana bajtu). |
| `HostSyncTest` | rewizje, konflikty, stronicowanie po 500, obca epoka, cofnięty telefon bez zapisu, walidacja przed zapisem. |
| `P2pHostTest` | pełne kody HTTP z `P2P_RDZEN.md` §4, sesje (jednorazowe, TTL dokładnie 60 s, limit 32 i zwalnianie miejsca), usunięte i ponownie sparowane urządzenie, zmieniona środkowa ramka bez zmian w sklepie, wiele wątków. |
| `PhoneVaultTest` | zapis z HLC, edycja wpisu z przyszłości, nagrobek, wznowienie zegara, widoczność dla hosta i zmian z wtyczki, równoległe zapisy, nieczytelny rekord. |
| `P2pInteropTest` | opcjonalny (`PASSHOLDER_INTEROP_TEST=1`): Kotlin uruchamia `android/core/src/test/resources/p2p-interop.ts` w Node, a ten skrypt wywołuje prawdziwe `syncVaultV2` i `noiseTransport` z `core/src/p2p` przeciw `P2pHost` za `MockWebServer`. Sprawdza wymianę wpisów w obie strony (hasło z polskimi znakami i emoji, epoka, adresy) i duże sejfy (1300 wpisów z telefonu, 1200 z wtyczki, stronicowanie, co najmniej 3 wywołania sync). |

Node jest uruchamiany **bez** `--experimental-transform-types`: Node 26.13 odrzuca ten przełącznik, a
skrypt i `core/src/p2p` potrzebują tylko domyślnego usuwania typów (Node >= 22.18). Starszy Node
wymagałby przełącznika z powrotem.

Po stronie TypeScriptu nic się nie zmieniło: `npm test && npm run typecheck` w katalogu głównym.

## 6. Znane ograniczenia

- **ristretto255 bez stałego czasu** (punkt 4): akceptowane tylko dla jednorazowego CPace.
- **`safeLong` odrzuca więcej niż JS** (punkt 3): liczby zapisane dłużej niż 32 znakami i `0e<ogromny
  wykładnik>` dostają 400.
- **Wyjątki z `devices()` wychodzą z `handle`** (punkt 2); warstwa HTTP musi je zamienić na 500.
- **`MemorySyncStore` jest tylko w pamięci**, a epoka jest stała dla danego `P2pHost` (parametr
  konstruktora). Nowa epoka (odtworzenie, reset) to nowy obiekt hosta.
- **`PhoneVault.entries()` i `unreadableIds()` odszyfrowują cały sklep przy każdym wywołaniu.** Dla
  setek i tysięcy wpisów to milisekundy; przy większych sejfach przydałaby się pamięć podręczna.
- **Limit 1 MiB liczony od surowych bajtów.** W TS liczy się długość po `JSON.stringify`, więc w Kotlinie
  ciało z dużą liczbą spacji może dostać 413, choć w TS by przeszło. Klient TS nie wysyła spacji. Warstwa
  HTTP powinna przestać czytać ciało po 1 MiB + 1 bajcie, zanim zaalokuje więcej.
- **Test współpracy**: czytanie wyjścia procesu `node` blokuje, więc limit 5 minut z `waitFor` nie działa,
  gdy `node` się zawiesi (test wisi do przerwania Gradle). Wymaga Node z domyślnym usuwaniem typów.
- **`RealServerTest` (v1)** nadal uruchamia Node z `--experimental-transform-types`, więc z
  `PASSHOLDER_SERVER_TEST=1` na Node 26 by nie przeszedł. Kodu v1 nie zmieniamy w tym planie; i tak zniknie
  w planie 4 razem z serwerem Pi.
- Ograniczenia protokołu (LWW, rozmiar wpisu a 1 MiB, częściowe wykrywanie cofnięcia telefonu) są te same
  co w `P2P_RDZEN.md` §6.

## 7. Co dalej (plan 3)

Plan 3 to aplikacja Android i wtyczka:

- **trwały `SyncStore`** na telefonie (baza w pamięci aplikacji) z tą samą umową blokady na obiekcie
  sklepu i z zapisem epoki, kluczy statycznych i listy sparowanych urządzeń,
- **serwer HTTP** na telefonie (tryb „Synchronizacja”), który woła `P2pHost.handle` i zamienia wyjątki z
  `devices()` na 500, z limitem odczytu ciała 1 MiB,
- **endpointy parowania** na podstawie `Cpace` i `Pairing` (kod na ekranie telefonu, jedna próba, `sid`
  od telefonu), ekrany „Urządzenia” i „Odtwórz z wtyczki”, nowy transport we wtyczce,
- **Android Auto Backup**: zalecenie z `P2P_RDZEN.md` §6, czyli wyłączyć bazę hosta z kopii zapasowej
  albo po odtworzeniu z kopii zawsze tworzyć nową epokę, żeby numery rewizji odtworzonego telefonu nie
  zderzyły się z tymi, które wtyczka już zna.

Plan 4 usuwa `server/`, `deploy/`, kod v1 i część `INSTALACJA.md` o Pi.
