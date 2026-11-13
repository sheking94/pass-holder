# Synchronizacja telefon–wtyczka

Jak wtyczka Chrome i telefon wymieniają sejf bez serwera. Telefon z Androidem jest **kotwicą** (hostem),
wtyczka łączy się tylko z nim: parowanie jednorazowym kodem (CPace), potem każda synchronizacja przez
Noise KK po zwykłym HTTP. Klucze i format szyfrogramu opisuje [SPEC.md](SPEC.md), mapę plików
[ARCHITEKTURA.md](ARCHITEKTURA.md).

Implementacja referencyjna to TypeScript w `core/src/p2p/`. Telefon ma tę samą logikę w Kotlinie
(`android/core/.../core/p2p/`); przy rozbieżności wzorcem jest TypeScript. Zgodność sprawdzają wektory
`core/test-vectors/v2.json`, `v3.json`, `files/files.json` i testy współpracy ([TESTY.md](TESTY.md)).

Spis: [1. Założenia](#1-założenia) · [2. Architektura](#2-architektura) · [3. Parowanie](#3-parowanie) ·
[4. Synchronizacja](#4-synchronizacja) · [5. Kontrakt HTTP](#5-kontrakt-http) · [6. Telefon](#6-telefon) ·
[7. Wtyczka](#7-wtyczka) · [8. Odtwarzanie z wtyczki](#8-odtwarzanie-z-wtyczki) ·
[9. Ograniczenia](#9-ograniczenia) · [10. Wariant produkcyjny](#10-wariant-produkcyjny)

## 1. Założenia

| # | Wymaganie |
|---|---|
| W1 | Brak centralnego serwera. |
| W2 | Pełna zaszyfrowana kopia tylko na urządzeniach użytkownika. |
| W3 | Wtyczka synchronizuje się tylko z telefonem (bez wtyczka–wtyczka). |
| W4 | Jeden telefon z sejfem. |
| W5 | Po utracie telefonu sejf da się odtworzyć z wtyczki. |
| W6 | Parowanie krótkim kodem chronionym przez PAKE. |
| W7 | Zmiana sieci (inny router, inne IP) nie wymaga ponownego parowania. |

Ograniczenia, które wyznaczyły projekt:

- **Wtyczka MV3 nie nasłuchuje** (może tylko sama łączyć się przez `fetch`), więc stroną nasłuchującą jest
  telefon.
- **Wtyczka nie przypnie samopodpisanego certyfikatu.** Transport to zwykłe HTTP, a poufność i
  uwierzytelnienie daje Noise.
- **Private Network Access:** potwierdzone 2026-11-04 (Chrome 156.0.8078.79), że service worker wtyczki z
  `host_permissions` `"http://*/*"` wysyła `GET` i `POST` pod `http://<IP w LAN>:8787`. Niesprawdzone: adres
  Tailscale i strona wtyczki z prawdziwą prośbą o zgodę (testy ręczne T4 i T7, [TESTY.md](TESTY.md)).

Cel projektu to nauka, więc projekt świadomie zawiera własne CPace, Noise i HLC.

## 2. Architektura

```
 ┌──────────────────────┐   HTTP + Noise KK    ┌───────────────────────────────┐
 │ Wtyczka Chrome (1..n)│ ───────────────────► │ Android: tryb „Synchronizacja”│
 │ pełna zaszyfrowana   │  POST /p2p/v2/...    │ - lista sparowanych urządzeń  │
 │ kopia sejfu          │ ◄─────────────────── │ - licznik revision, epoch     │
 └──────────────────────┘                      │ - pełna zaszyfrowana kopia    │
                                               └───────────────────────────────┘
```

- **Telefon** w trybie „Synchronizacja” uruchamia serwer HTTP na porcie **8787** na wszystkich interfejsach
  (Wi-Fi, Tailscale). Tryb wyłącza się sam po 5 min bez żądań i po wyjściu z aplikacji.
- Telefon trzyma rekordy `{id, revision, deleted, blob}` i przyjmuje zmiany z `baseRevision` (`processSync`).
  Jego własne zmiany idą prosto do tej samej bazy z nową `revision` (`PhoneVault`).
- Telefon nie sprawdza hasła głównego: dostęp daje klucz urządzenia z parowania. Host widzi tylko
  szyfrogramy.
- **Wtyczka** działa offline na swojej kopii i pamięta listę adresów telefonu.

## 3. Parowanie

### 3.1. Przebieg

1. Telefon: Synchronizacja → „Dodaj wtyczkę”. Telefon pokazuje adresy i **8-cyfrowy kod** (CSPRNG, bajty
   ≥ 250 odrzucane; ważny 2 min, jedna próba) oraz losuje `sid` (16 B).
2. Wtyczka (inicjator CPace) i telefon (odpowiednik) wykonują **CPace** `CPACE-RISTR255-SHA512`
   (draft-irtf-cfrg-cpace-21): `PRS` = kod, `CI` = `passholder/v2/pair`, `sid` od telefonu, `ad` =
   identyfikator strony. Wiadomość na drucie to `lv_cat(Y, ad)` (wybór projektu, Kotlin musi go powtórzyć).
3. `pairingKey = HKDF-SHA256(ISK, info = "passholder/v2/pair-key")` (32 B).
4. Pod tym kluczem (AES-256-GCM, AAD `passholder/v2/pair/<rodzaj>/<rola nadawcy>`) strony wymieniają:
   - `identity` od obu: `deviceId` (1..64 znaki), `name` (1..64), `staticPublicKey` (X25519, 32 B),
   - `vault-info` od telefonu: `epoch` (16 B), parametry KDF, `wrappedVaultKey`, `addresses` (≤ 16).
   Rola w AAD sprawia, że wiadomość odbita do nadawcy się nie otworzy.
5. Zły kod daje inny klucz, więc pierwsza wiadomość się nie otwiera. Kod przepada niezależnie od wyniku.

Dlaczego 8 cyfr wystarcza: PAKE nie daje podsłuchującemu nic do zgadywania offline, a atak online ma jedną
próbę (1:10⁸). Hasło główne nie jest wejściem PAKE, bo każda próba byłaby okazją do jego zgadywania.

### 3.2. Po HTTP

Telefon ma najwyżej jedną ofertę `{code, sid, mode, expiresAt}`; `mode` to `"pair"` albo `"restore"`.

| Ścieżka | Żądanie | Odpowiedź 200 | Błędy |
|---|---|---|---|
| `/p2p/v1/ping` | `{}` | `{"ok":true}` | |
| `/p2p/v1/pair/hello` | `{}` | `{sid, mode}` | 404 `no pairing` |
| `/p2p/v1/pair/start` | `{sid, message}` | `{message}` | 400 `malformed request`, 404 `no pairing`, 400 `pairing failed` |
| `/p2p/v1/pair/finish` | `{sid, identity, vaultInfo?}` | `{identity, vaultInfo}` | 400 `malformed request`, 404 `no pairing`, 403 `pairing failed` |

- `/pair/start` zużywa ofertę od razu, także przy błędzie. Klucz czeka na `/pair/finish` najwyżej 30 s;
  `finish` jest jednorazowe.
- `vaultInfo` w żądaniu jest wymagane wtedy i tylko wtedy, gdy `mode = "restore"` (patrz punkt 8).
- 403 w `finish` oznacza, że wtyczka użyła innego kodu.
- Udane `finish` dopisuje urządzenie (to samo `deviceId` zastępuje stary wpis).

### 3.3. Epoka

Telefon ma losowy `epoch` (16 B), tworzony przy zakładaniu i odtwarzaniu sejfu. Wtyczka dostaje go przez
`applyVaultInfo`. Inna epoka znaczy, że numery `revision` nie pasują do niczego, co wtyczka zna, więc
wtyczka robi reset (punkt 4.2). **`vault.epoch` nigdy nie przypisuje się bezpośrednio**, tylko przez
`applyVaultInfo` albo `adoptEpoch`.

## 4. Synchronizacja

### 4.1. Transport (Noise KK)

- Wzorzec **Noise_KK_25519_AESGCM_SHA256** (rev. 34), prolog `passholder/v2/noise`. Obie strony znają swoje
  klucze statyczne z parowania: obustronne uwierzytelnienie i poufność do przodu.
- Każde żądanie to osobne uzgadnianie: `POST /p2p/v2/handshake`, potem jedno `POST /p2p/v2/sync` albo
  `POST /p2p/v2/file` (pliki, punkt 5.3).
- **Wersje ścieżek:** parowanie (`/p2p/v1/pair/*`) i `/p2p/v1/ping` bez zmian. Synchronizacja przeniosła się na
  `/p2p/v2/*` razem z formatem wpisu v3 ([SPEC.md](SPEC.md) punkt 4). Stara wtyczka wołająca
  `/p2p/v1/handshake` albo `/p2p/v1/sync` dostaje `410 {"error":"update required"}` i pokazuje swój ogólny
  błąd synchronizacji. Nowa wtyczka przy starym telefonie dostaje 404 na `/p2p/v2/*` i pokazuje „Zaktualizuj
  aplikację na telefonie”. Obie aplikacje trzeba więc zaktualizować razem.
- Noise chroni metadane (które `id`, kiedy, ile). Wpisy są dodatkowo zaszyfrowane kluczem sejfu end-to-end.
- **Tożsamość to klucz, nie adres.** Zmiana IP nie wymaga parowania; obce urządzenie pod starym adresem nie
  przejdzie Noise KK.

### 4.2. Runda synchronizacji

1. Wtyczka (`syncVaultV2`) wysyła `{epoch, sinceRevision, changes}`: wpisy `dirty`, najwyżej 500 naraz i
   najwyżej `MAX_BLOB_BYTES_PER_ROUND` znaków bloba (pierwszy wpis zawsze wchodzi). Nieznana epoka idzie jako `""`.
2. Telefon (`processP2pSync` / `HostSync.process`):
   - inna epoka: odpowiada samą epoką i adresami, nic nie zapisuje,
   - ta sama epoka: walidacja całego żądania (punkt 5.2), potem `processSync` (przyjęte zmiany, konflikty,
     zmiany od `sinceRevision`),
   - odpowiedź: najwyżej 500 rekordów w `changes` (konflikty ogranicza tylko budżet bajtów i rozmiar żądania)
     oraz `MAX_BLOB_BYTES_PER_ROUND` znaków bloba łącznie; zmiany idą w kolejności `revision`. Budżet
     schodzi najpierw na `conflicts`, potem na `changes`, a pierwszy rekord zawsze wchodzi. `changes` trafiają
     do odpowiedzi tylko wtedy, gdy zmieściły się wszystkie konflikty. Przy każdym ucięciu `more = true`, a
     `currentRevision` to rewizja ostatniego rekordu w `changes` albo `sinceRevision` żądania, gdy żadna zmiana
     nie weszła (pominięte konflikty zostają `dirty` u wtyczki, która wyśle je ponownie).
3. Wtyczka po odpowiedzi:
   - **inna epoka:** `adoptEpoch` zeruje `lastSyncRevision` i oznacza wszystkie wpisy i nagrobki jako `dirty`
     z `revision = 0`; pętla rusza od nowa (najwyżej jedna zmiana epoki na synchronizację),
   - **`currentRevision < lastSyncRevision`** (telefon się cofnął): ten sam reset,
   - **ta sama epoka:** zapisuje potwierdzone rewizje i rozstrzyga konflikty. Wpis przestaje być `dirty` tylko,
     gdy ma nadal HLC z chwili wysłania.
4. Kolejne rundy, dopóki są zmiany ponad limit albo `more = true`; razem najwyżej 1000 rund
   („Sync exceeded the round limit”). Gdy wygrała zmiana lokalna, idzie jeszcze raz (do 3 rund, potem
   „Sync did not settle”); rundy ucięte (`more`) nie wliczają się do tych 3, bo każda rozstrzyga co najmniej
   jeden rekord.

**Budżet rundy: 512 KiB** (`MAX_BLOB_BYTES_PER_ROUND = 524288`), liczony jako suma długości blobów w jednym
żądaniu i w jednej odpowiedzi. Specyfikacja podawała 768 KiB, ale ramki idą jako Base64 (×4/3), więc 768 KiB
blobów dałoby ≥ 1 MiB i przekroczyło limit ciała (413); 512 KiB plus metadane 500 zmian mieści się w nim z
zapasem. Wpis do 64 KiB zawsze się mieści, a ucięty nadmiar idzie w następnych rundach.
5. Adresy z odpowiedzi są dopisywane do listy; przy zmianie epoki lista jest zastępowana.

### 4.3. Konflikty (HLC)

Wpis zamiast czasu modyfikacji ma w szyfrogramie **hybrydowy zegar logiczny** `{"ms", "c", "d": deviceId}`:

- lokalna zmiana: `ms' = max(ms, teraz)`; gdy `ms'` się nie zmienił, `c + 1`, inaczej `c = 0`,
- każdy odebrany HLC przesuwa zegar lokalny (`observe`), także przed edycją nadpisywanej wersji,
- porównanie `(ms, c, d)`, `d` w jednostkach UTF-16 (jak `String.compareTo` w Kotlinie). Remisów nie ma.

Reguła: lokalny wpis `dirty` wygrywa tylko z większym HLC; inaczej wygrywa wersja z telefonu. Zmiana
zrobiona po zobaczeniu innej zawsze ma większy HLC, nawet przy rozjechanych zegarach.

**Łączenie załączników:** gdy obie wersje są żywe, a lokalna `dirty`, HLC wybiera wpis, ale lista
`attachments` jest łączona (`mergeAttachments`): lista zwycięzcy, potem opisy przegranej, których `id` zwycięzca
nie ma (w kolejności przegranej; przy tym samym `id` zostaje opis zwycięzcy). Gdy to dodaje pliki, wtyczka
zapisuje `{...zwycięzca, attachments: połączona, hlc: nowy tick}` jako lokalną zmianę `dirty`, która idzie w
następnej rundzie (także gdy wygrał telefon). Gdy połączona lista miałaby > 40 opisów albo wpis przekroczyłby
`MAX_ENTRY_BLOB_LENGTH`, zostaje sama lista zwycięzcy. Pusta lista nigdy nie jest zapisywana. Wada: plik
usunięty na jednym urządzeniu przy równoczesnej edycji wpisu na drugim może wrócić.

**Usuwanie:** nagrobek ma `deleted = true` jawnie, a w szyfrogramie tylko `{hlc}`. „Edycja kontra
usunięcie” rozstrzyga HLC. Telefon trzyma nagrobki na stałe; wpis, który nigdy nie trafił na telefon,
wtyczka kasuje lokalnie.

## 5. Kontrakt HTTP

### 5.1. Noise po HTTP

JSON, binaria w Base64 z dopełnieniem.

| Ścieżka | Żądanie | Odpowiedź 200 |
|---|---|---|
| `POST /p2p/v2/handshake` | `{deviceId, message}` | `{session, message}` (`session` = 16 B) |
| `POST /p2p/v2/sync` | `{session, frames: string[]}` | `{frames: string[]}` |
| `POST /p2p/v2/file` | `{session, frames: string[]}` | `{frames: string[]}` (punkt 5.3) |

Błędy `{error: "…"}`, w tej kolejności:

| Kod | Kiedy |
|---|---|
| 413 | ciało > 1 MiB (sprawdzane pierwsze) |
| 410 | stare ścieżki `/p2p/v1/handshake` i `/p2p/v1/sync` (`update required`) |
| 404 | nieznana ścieżka |
| 400 | handshake: brak pól, zły Base64, nieudane uzgadnianie; ciało nie jest obiektem JSON |
| 403 | handshake: `deviceId` spoza listy urządzeń |
| 503 | handshake: 32 żywe sesje (`too many sessions`); telefon bez sejfu (`vault not ready`) |
| 400 | sync: brak `session`, 0 albo > 18 ramek, ramka nie jest tekstem |
| 401 | sync: nieznana lub wygasła sesja (też powtórzone żądanie) |
| 403 | sync: urządzenia nie ma już na liście |
| 400 | sync: nie da się odszyfrować albo żądanie nie przechodzi walidacji |
| 500 | błąd przy budowaniu odpowiedzi |

Sesja żyje w pamięci 60 s, jest jednorazowa (usuwana przy pierwszej próbie sync) i przy `/sync` urządzenie
jest sprawdzane jeszcze raz, więc usunięcie urządzenia odcina też otwartą sesję. `handshake` i `sync`
działają przy zablokowanym sejfie telefonu (host przenosi tylko szyfrogramy).

**Ramki:** JSON zaszyfrowany szyframi transportowymi Noise, po najwyżej 65519 B tekstu jawnego na ramkę,
1..18 ramek, AD puste. Ramki nie mają znacznika końca: ucięcie wykrywa nieudany `JSON.parse`, więc treść
zawsze jest obiektem JSON.

### 5.2. Walidacja żądania sync

`validateP2pSyncRequest` / `HostSync.validate` (400, nic nie zapisane): `epoch` tekstem, `sinceRevision`
bezpieczną liczbą całkowitą ≥ 0, najwyżej 500 zmian, w każdej `id` 1..128 znaków, `baseRevision` ≥ 0,
`deleted` logiczne, `blob` tekstem o długości ≤ 65536 (`blob too large`). Powtórzone `id` → `duplicate change`; `baseRevision != 0` dla
nieznanego `id` → `unknown base revision`. Gdy `sinceRevision > currentRevision` (telefon cofnięty), host
niczego nie zapisuje i odpowiada swoim `currentRevision`.

Kotlin dodatkowo: liczby z sieci (`safeLong`) muszą być liczbą JSON z zakresu `0..2^53-1`; tekst liczby
dłuższy niż 32 znaki i `0e<ogromny wykładnik>` są odrzucane (ochrona pamięci). Limit 1 MiB liczy surowe
bajty ciała.

### 5.3. Pliki (`/p2p/v2/file`)

`POST /p2p/v2/file` działa jak `/p2p/v2/sync`: osobne uzgadnianie, jedna sesja = jedno żądanie, te same ramki,
limit 1 MiB i błędy sesji (punkt 5.1); działa przy zablokowanym telefonie. Treść żądania w ramkach to jedna
operacja (host referencyjny `processP2pFile` w `core/src/files/host-files.ts`):

| `op` | Żądanie | Odpowiedź 200 (w ramkach) |
|---|---|---|
| `status` | `{op, epoch, ids}` (0..500 `id`) | `{files: [{id, chunks, have, complete}]}`; nieznane `id` → `chunks: 0, have: [], complete: false` |
| `put` | `{op, epoch, id, index, chunks, blob}` | `{have}` (liczba zapisanych kawałków) |
| `get` | `{op, epoch, id, index}` | `{chunks, blob}` |

- **Inna epoka** (każda operacja poprawnego żądania; zniekształcone dostaje najpierw 400): 200 `{epoch}` z epoką telefonu, nic nie zapisane.
- **400 `malformed file request`:** zły `op`, `epoch` nie tekstem, `id` nie jest UUID v4 małymi literami,
  `put`: `0 ≤ index < chunks ≤ 40` (liczby całkowite), `blob` tekstem ≤ 349564 znaków; `get`: `0 ≤ index ≤ 39`;
  `status`: `ids` listą ≤ 500 poprawnych `id`.
- **400 `chunk count mismatch`:** `put` z innym `chunks` niż przy pierwszym kawałku tego `id`.
- **409 `chunk differs`:** kawałek już jest i ma inny blob (pliki są niezmienne); ten sam blob → 200 bez zmian.
- **404 `chunk not found`:** `get` kawałka, którego nie ma (też nieznany plik i `index ≥ chunks`).
- **507 `insufficient storage`:** brak miejsca na nowy kawałek, nic nie zapisane (ponowny identyczny `put` nie
  potrzebuje miejsca).
- Statusy inne niż 200 idą jawnie (`{error}`), jak w sync. Stary telefon odpowiada 404 `not found` (nieznana
  ścieżka); klient rozróżnia po tekście i rzuca „Zaktualizuj aplikację na telefonie” (`PHONE_UPDATE_REQUIRED`).

**Przebieg w kliencie** (`syncFiles` w `core/src/files/client.ts`, po udanej synchronizacji wpisów, przy
odblokowanym sejfie):

1. Kandydaci: załączniki żywych wpisów, które lokalnie nie są kompletne albo nie mają `uploadedEpoch` równego
   epoce sejfu. Jedno `status` na każde 500 `id`.
2. **Wysyłanie:** plik kompletny lokalnie, a niekompletny na telefonie → `put` brakujących kawałków, potem
   `uploadedEpoch = epoka`. Gdy telefon ma go już całego, tylko `uploadedEpoch`.
3. **Pobieranie:** plik niekompletny lokalnie, a kompletny na telefonie → `get` brakujących kawałków (każdy
   zapisywany od razu), potem `decryptFile` (`size`, `sha256`); niezgodność kasuje lokalne kawałki i dopisuje
   nazwę do `corrupted`.
4. Plik, którego nikt nie ma całego (np. dodany na innej wtyczce i niewysłany), albo zgubiony kawałek → `pending`,
   na następną synchronizację. Bez ponowień: błąd transportu przerywa fazę, a następne uruchomienie wznawia od
   brakujących kawałków. Inna epoka w odpowiedzi → `Epoch changed, sync again`.
5. `uploadedEpoch` zamiast flagi: zmiana epoki (`adoptEpoch`) sama sprawia, że pliki trzeba wysłać ponownie.

**Sprzątanie:** telefon (`orphanFileIds`, przy odblokowanym sejfie) usuwa pliki nieużywane przez żaden żywy wpis
i starsze niż 24 h (`ORPHAN_FILE_AGE_MS = 86400000`, od pierwszego kawałka, ściśle starsze); 24 h chroni plik
wysłany przed wpisem, który go używa. Wtyczka po synchronizacji usuwa nieużywane pliki od razu
(`pruneLocalFiles`). Wektory hosta i sprzątania: `core/test-vectors/files/files.json`.

**Host na telefonie (Kotlin, `core/files/`):** `P2pHost` obsługuje `/p2p/v2/file` przez `FileHost`, gdy dostał magazyn;
bez niego odpowiada 404 jak na nieznaną ścieżkę. Zasady zgodne z hostem referencyjnym (walidacja, potem epoka, potem
operacja; przy `put` 400 `chunk count mismatch` przed 409).

- **Magazyn na dysku** (`DiskFileStore`): `filesDir/p2p/files/<id>/` z `meta.json` (`{chunks, createdAt}`) i kawałkami
  `<i>`. Każdy kawałek trafia najpierw do `<i>.tmp`, potem `fsync` i atomowy `rename` na `<i>`, więc istniejący `<i>`
  jest zawsze cały i osobny znacznik „kompletny” nie jest potrzebny: plik jest kompletny, gdy liczba kawałków równa się
  `chunks`. Zabicie aplikacji w trakcie zapisu zostawia co najwyżej `*.tmp` (kasowane przy otwarciu magazynu) albo
  brakujący kawałek, który wtyczka dośle przy następnej synchronizacji. Dwa równoległe `put` tego samego kawałka dają jeden zapis i dwa 200.
- **507 `insufficient storage`:** gdy po zapisie kawałka zostałoby mniej niż 50 MB wolnego miejsca (`MIN_FREE_BYTES = 52428800`).
- **Sprzątanie** (`PhoneVaultStore.pruneFiles`): po odblokowaniu i po każdym zapisie lub usunięciu wpisu; usuwa pliki
  nieużywane przez żaden żywy wpis i starsze niż 24 h. Pomijane (nic się nie kasuje), gdy którykolwiek wpis jest
  nieczytelny, bo nie wiadomo, jakich plików używa. Błąd sprzątania nie psuje zapisu wpisu.
- **Zmiana epoki** (nowy sejf, odtwarzanie od zera, rozłączenie) kasuje cały `p2p/files/`; „Odtwórz z wtyczki”
  po zakończeniu nie zmienia epoki, więc pliki wysłane w trakcie zostają.
- Plik dodany na telefonie (`PhoneVaultStore.addFile`) trafia od razu do magazynu jako kompletny; wpis zapisuje ekran
  „Zapisz”, a 24 h chroni plik przed sprzątaniem do tego czasu. Ekrany plików telefonu i ręczny test **T22** dochodzą w krokach 3–4.

## 6. Telefon

### 6.1. Serwer HTTP (`SyncHttpServer.kt`)

Każdy w sieci może się połączyć przed uwierzytelnieniem, więc serwer ma limity:

| Limit | Wartość | Przekroczenie |
|---|---|---|
| Ciało | 1 MiB z `Content-Length` | 413 |
| Nagłówki | 16 KiB | 431 |
| Czas na żądanie | 15 s łącznie, odczyt ≤ 10 s | zerwanie połączenia |
| Równoległe połączenia | 4 wątki + kolejka 16 | 503 `busy` |
| Błędy `accept()` | 20 pod rząd | serwer się kończy |

- Ścisły parser: tylko `POST` (405), wymagany `Content-Length` (411), bez `Transfer-Encoding` (501).
- **`Host` musi być literałem IPv4 albo `localhost`** (inaczej 403 `forbidden host`): ochrona przed DNS
  rebinding. Dlatego adres telefonu we wtyczce musi być IPv4; MagicDNS i IPv6 nie działają.
- Tylko znane ścieżki liczą się jako aktywność, więc skaner w sieci nie utrzyma trybu przy życiu.

### 6.2. Dane na telefonie (`filesDir/p2p/`)

- **`records.jsonl`** (`FileSyncStore`): jeden rekord w linii, każdy zapis z `fsync`. Urwana ostatnia linia
  jest odrzucana; nieczytelna linia w środku to „Corrupt sync store”. Plik jest kompaktowany, gdy ma więcej
  niż `2 × rekordy + 100` linii.
- **`host.json`** (`HostStateStore`): `deviceId`, `epoch`, `wrappedStaticKey`, `kdf`, `wrappedVaultKey`,
  `keyCheck` (HMAC klucza sejfu do sprawdzania hasła) i lista `devices`. Zapis atomowy (`.tmp` + zamiana).
- Zapisy do sklepu idą pod `synchronized(store)` (host i ekran telefonu piszą równolegle).
- **Klucz statyczny Noise** jest zawinięty kluczem AES z Android Keystore (`passholder-p2p-wrap`), bez
  wymogu uwierzytelnienia, bo telefon odpowiada też przy zablokowanym sejfie. Klucz sejfu chroni tylko
  hasło główne.
- **Kopie zapasowe wyłączone** (`allowBackup=false`, `data_extraction_rules.xml`): odtworzony `host.json`
  miałby starą epokę i rewizje. Kopią sejfu jest wtyczka (punkt 8).
- Nieczytelny `host.json`: aplikacja pokazuje tylko „Usuń sejf z telefonu” i niczego nie nadpisuje.

### 6.3. Tryb Synchronizacja (`SyncController.kt`)

- Włącza go przycisk „Synchronizacja” przy odblokowanym sejfie. Ekran pokazuje adresy `http://<IPv4>:8787`
  (Tailscale `100.64.0.0/10` na końcu) i nie gaśnie (`FLAG_KEEP_SCREEN_ON`).
- Wyłącza się: po 5 min bez połączeń (sprawdzane co 15 s), po wyjściu z aplikacji, po blokadzie sejfu,
  przyciskiem „Zakończ”.
- Każdy start trybu ma własny kod; stara oferta jest odrzucana. Lista wpisów odświeża się po każdej
  synchronizacji.
- „Urządzenia”: sparowane wtyczki z datą parowania i ostatniej synchronizacji; „Usuń” sprawia, że wtyczka
  dostaje 403.

## 7. Wtyczka

### 7.1. Parowanie (`vault-store.ts`, `views/connect.ts`)

Okienko przenosi parowanie do karty `?setup`, bo Chrome zamyka okienko przy prośbie o zgodę.

1. Krok 1: adresy, kod, nazwa przeglądarki. „Sparuj” prosi Chrome o zgodę na `http://<ip>:8787/*` (na
   kliknięciu, przed `await`), potem `pairStart`: `pickPhone` wybiera działający adres, nowe `deviceId` i
   klucz X25519, `pairWithPhone`. Wynik czeka w `chrome.storage.session` jako `pendingPairing`.
2. Krok 2: hasło główne sejfu telefonu odwija `wrappedVaultKey`. Złe hasło można poprawiać bez nowego kodu
   (także po zamknięciu karty). Po 10 min parowanie wygasa.
3. Dobre hasło: zapis konta, `applyVaultInfo`, pierwsza synchronizacja. Jej błąd nie cofa parowania
   (`PairedButSyncFailed`).

Kod musi mieć 8 cyfr przed wysłaniem, więc literówka nie spala kodu. Gdy telefon czeka na odtwarzanie,
zwykłe parowanie kończy się błędem bez spalenia kodu.

### 7.2. Synchronizacja i adresy (`phone-urls.ts`, `phone-client.ts`)

- `sync()` używa tylko adresów ze zgodą Chrome; `pickPhone` próbuje najpierw `lastPhoneUrl`, potem
  pozostałe (ping 4 s). Całe żądanie ma limit 30 s.
- Adresy podane przez telefon są dopisywane, ale bez zgody Chrome są pomijane, dopóki nie klikniesz
  „Zapisz” w „Adresy telefonu”.
- `normalizePhoneUrl` przyjmuje tylko `http://<IPv4>:<port>` albo `localhost` (domyślnie 8787).
- Po synchronizacji konto jest czytane ponownie: jeśli w międzyczasie inna strona sparowała inny telefon
  albo odłączyła przeglądarkę, nie jest nadpisywane.

### 7.3. Dane w `chrome.storage`

| Klucz | Gdzie | Co |
|---|---|---|
| `accountV2` | `local` | adresy, `deviceId`, nazwa, tożsamość telefonu, `kdf`, `wrappedVaultKey`, `sealedStaticKey` (AAD `passholder/v2/ext-static-key`) |
| `vaultV2` | `local` | `LocalVaultV2` (epoka, `lastSyncRevision`, adresy, wpisy), AAD `passholder/v2/local-vault` |
| `pendingPairing` | `session` | parowanie czekające na hasło |
| `keys` | `session` | `{vaultKey, unlockedUntil}` odblokowanej sesji |
| `corruptFiles` | `local` | `id` plików uszkodzonych po pobraniu (pomijane przy synchronizacji) |
| `pinLock`, `generator` | | PIN ([FUNKCJE.md](FUNKCJE.md#pin-we-wtyczce)) i ustawienia generatora |

### 7.4. Inny telefon i odłączanie

- „Adresy telefonu” → „Sparuj z innym telefonem / odtwórz telefon”: hasło sprawdzane przed siecią, potem
  parowanie z tym samym `deviceId` i kluczem. Telefon z sejfem musi mieć **ten sam** klucz sejfu, inaczej
  „To inny sejf…” i nic się nie zmienia. Pusty telefon w trybie `restore`: punkt 8.
- „Odłącz tę przeglądarkę” (ekran blokady, drugie kliknięcie potwierdza) usuwa konto, sejf, PIN,
  `pendingPairing` i pliki z IndexedDB. Telefon zachowuje to, co dostał; przeglądarkę usuwa się tam w „Urządzenia”.

### 7.5. Pliki we wtyczce (`vault-store.ts`, `files/idb-file-store.ts`)

- **Kolejność w `sync()`:** najpierw wpisy (punkt 4.2), potem faza plików (`syncFiles` z rdzenia, punkt 5.3). Błąd fazy
  plików nie cofa wpisów: trafia do wyniku (`files.error`), a okno pokazuje „Nie wszystkie pliki zsynchronizowane: …”.
  Stary telefon (404 na `/p2p/v2/file`) daje „Zaktualizuj aplikację na telefonie”. Pierwsza synchronizacja po
  parowaniu i „Odtwórz telefon” (`pairFinish`, `repair`) też ją uruchamiają.
- **Postęp:** „Pliki: 3 z 12” przy „Synchronizuj”; po zakończeniu „wysłano N, pobrano M” i liczba plików czekających.
- **Wznawianie:** kawałek trafia do IndexedDB od razu po pobraniu. Zamknięcie karty lub okienka w połowie nic nie
  psuje, a następna synchronizacja bierze tylko brakujące kawałki. Plik dodany tu i jeszcze niewysłany to
  „czeka na synchronizację”; plik dodany gdzie indziej i niewysłany tam też.
- **Plik dodany na formularzu:** szyfrowany od razu w pamięci (`encryptFile`), do IndexedDB trafia dopiero w `putEntry`,
  przed zapisem wpisu. „Anuluj” nie zostawia nic. Zablokowany sejf (15 min) → „Sejf jest zablokowany”, nic nie
  zapisane.
- **Uszkodzone:** plik z innym rozmiarem lub `sha256` po pobraniu jest kasowany lokalnie, a jego `id` zapisany w
  `chrome.storage.local` (`corruptFiles`). Kolejne synchronizacje go pomijają (`skip` w `syncFiles`; plik jest
  niezmienny, ponowna próba nic nie da), a wpis pokazuje „Plik jest uszkodzony”. `id` znika z listy, gdy żaden wpis go
  nie używa.
- **Sprzątanie** (`pruneUnusedFiles`): po udanej fazie plików oraz po każdym `putEntry` i usunięciu wpisu kasuje
  lokalne pliki, których nie używa żaden żywy wpis. Wyjątek: plik kompletny, dodany tu i nigdy niewysłany, zostaje
  (może należeć do wpisu zapisanego w innej karcie, jeszcze niezsynchronizowanego). Usunięty załącznik znika więc
  lokalnie od razu, a na telefonie po jego sprzątaniu (24 h). Błąd sprzątania nie psuje zapisu.
- **Odłączenie** („Odłącz tę przeglądarkę”) usuwa też wszystkie pliki z IndexedDB i listę `corruptFiles`.

## 8. Odtwarzanie z wtyczki

1. Nowy (albo wyczyszczony) telefon: „Odtwórz z wtyczki” → „Rozpocznij odtwarzanie”. Telefon tworzy nową
   tożsamość i epokę bez sejfu (`kdf == null`) i pokazuje kod z `mode = "restore"`.
2. Wtyczka paruje się i w `finish` wysyła `vaultInfo` (`kdf`, `wrappedVaultKey`). Nowa epoka resetuje jej
   wpisy do `dirty` z `revision = 0`, więc pierwsza synchronizacja wysyła wszystko.
3. Telefon prosi o hasło główne, odwija klucz sejfu, zapisuje `keyCheck` i od tej chwili jest kotwicą.
4. Kolejne wtyczki parują się z nowym telefonem; ich wpisy wracają jako konflikty i rozstrzyga je HLC.

Tylko w tym trybie telefon przyjmuje metadane sejfu od wtyczki. Po pierwszej wtyczce w tym odtwarzaniu
druga dostaje 500. „Przerwij odtwarzanie” kasuje wszystko.

## 9. Ograniczenia

**Protokół**

- **LWW dla zmian równoległych:** gdy wpis zmienią dwa urządzenia bez kontaktu, wygrywa większy HLC, a druga
  zmiana przepada.
- **Bez telefonu nie ma synchronizacji** (także między dwoma komputerami).
- **Odwołanie nie wymazuje danych:** usunięta wtyczka zachowuje kopię chronioną hasłem głównym. Pełne
  odcięcie (nowy vaultKey) jest poza zakresem.
- **Rozmiar:** wpis ≤ 64 KiB (blob), runda ≤ 500 zmian i 512 KiB blobów; nadmiar idzie w kolejnych rundach.
  Host nie widzi treści, więc nie sprawdza typów wpisów, tylko rozmiar.
- **Cofnięcie telefonu wykrywane częściowo** (tylko gdy `currentRevision` spadnie). Dlatego kopie zapasowe
  telefonu są wyłączone.
- **Pliki:** do 10 MiB i 40 kawałków po 256 KiB, najwyżej 20 na wpis przy dodawaniu (40 po łączeniu).
  Bez limitu łącznego, tylko wolne miejsce (507). Telefon nie widzi, które pliki są używane (wie to
  dopiero przy odblokowanym sejfie), więc plik osierocony zostaje co najmniej 24 h od pierwszego kawałka, a
  faktycznie do pierwszego sprzątania przy odblokowanym sejfie. Eksport PassHolder JSON pomija pliki (ekran eksportu we wtyczce mówi, ile ich pominie). Ekrany telefonu to krok 4 planu;
  wtyczka ma już pliki (punkt 7.5). Wtyczka trzyma kawałki w IndexedDB bez limitu (`unlimitedStorage`).
- **Własne CPace i Noise** w dwóch językach: wektory testowe zmniejszają ryzyko, ale to nie audyt.
- **ristretto255 w Kotlinie bez stałego czasu** (`BigInteger`). Akceptowane tylko dla jednorazowego CPace
  (skalar i kod są jednorazowe); klucze długoterminowe liczy X25519 z Bouncy Castle. Klasy nie wolno używać
  do niczego innego.

**Telefon**

- Tylko IPv4 (`Host`), więc bez MagicDNS i IPv6.
- Kod parowania można spalić z sieci (każdy w LAN zna `sid` i jedną złą próbą zużywa kod).
- `stop()` nie zamyka już przyjętych połączeń (kończą się po 15 s); 413 i 503 mogą dojść jako reset.
  Gdy serwer padnie po 20 błędach `accept()`, ekran tego nie pokazuje.
- Brak `fsync` katalogu po zamianie pliku; niektóre błędy to 500 zamiast 4xx (przyczyna tylko w logcat).
- Android może ubić serwer w tle, więc tryb działa tylko z aplikacją na wierzchu.

**Wtyczka**

- Lista adresów tylko rośnie; martwy adres kosztuje do 4 s.
- Po „Anuluj parowanie”, wygaśnięciu albo „To inny sejf” przeglądarka zostaje w „Urządzenia” telefonu
  (komunikat podaje nazwę do usunięcia).
- Prośba o zgodę Chrome i Private Network Access nie mają testów automatycznych (testy ręczne T4, T7).

## 10. Wariant produkcyjny

Gdyby celem nie była nauka, zmieniłoby się to:

| Obszar | Tu | Wariant produkcyjny |
|---|---|---|
| Parowanie | własne CPace, 8-cyfrowy kod | Noise XX z gotowej biblioteki + porównanie 6 cyfr z uzgadniania |
| Transport | własny Noise KK w TS i Kotlinie | dojrzała implementacja (np. z libp2p) |
| Konflikty | LWW, przegrana wersja przepada | historia wpisu albo kopia konfliktu |
| Odwołanie | usunięcie klucza | nowe hasło główne, nowy vaultKey, przeszyfrowanie |
| Kopia awaryjna | ręczny eksport do pliku | klucz awaryjny + automatyczny zaszyfrowany eksport |
| Ochrona lokalna | hasło główne | klucze w Android Keystore/StrongBox |
| Weryfikacja | testy i wektory | model zagrożeń, fuzzing, zewnętrzny audyt |

Dla „najlepiej działa” prostszy byłby magazyn zaszyfrowanych blobów (WebDAV, dysk w chmurze), a
najbezpieczniejsza gotowa, audytowana aplikacja (Bitwarden z Vaultwarden, KeePassXC). Własny menedżer haseł
ma sens przede wszystkim jako projekt do nauki.
