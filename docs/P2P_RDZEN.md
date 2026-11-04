# Rdzeń P2P (`core/src/p2p/`)

Dokument opisuje krok z gałęzi `claude/p2p-sync-design`: transportowo-niezależny rdzeń synchronizacji
bez Pi (projekt w `SYNCHRONIZACJA_P2P.md`). Telefon jest kotwicą, wtyczka paruje się z nim kodem
(CPace) i synchronizuje przez Noise KK. Kod to TypeScript w `core/`; wersję Kotlinową piszemy w
następnym planie, a `core/test-vectors/v2.json` pozwala sprawdzić, że wynik jest bit w bit ten sam.

Pliki v1 (`core/src/sync.ts`, `protocol.ts`, `vault.ts`, `server/`, `extension/`, `android/`) nie
zostały zmienione. Nowy kod używa tylko `processSync` i `SyncStore` z `protocol.ts`.

## 1. Moduły

| Plik | Co robi |
|---|---|
| `hlc.ts` | Hybrydowy zegar logiczny `{ms, c, d}`. `compareHlc` porównuje `(ms, c, d)`, a `d` (deviceId) w kolejności jednostek UTF-16, jak `String.compareTo` w Kotlinie. `HlcClock.tick()` rośnie nawet gdy zegar ściany się cofnie, `observe()` przesuwa zegar za zegar zdalny. `parseHlc` waliduje dane z sieci. |
| `entry.ts` | Treść wpisu v2 (`name`, `username`, `password`, `hlc`) i nagrobek (`hlc`). Szyfruje AES-256-GCM z AAD `passholder/v2/entry/<id>`. Parametr `nonce` służy tylko do wektorów. |
| `sync.ts` | Stan lokalny wtyczki (`LocalVaultV2`), `upsertEntryV2`, `deleteEntryV2`, `applyVaultInfo` (przekazanie epoki i adresów z parowania), `clockForVault` (zegar wznowiony po największym HLC w sejfie) i `syncVaultV2`: pętla wysyłania zmian i pobierania cudzych, ze stronicowaniem i rozstrzyganiem konfliktów po HLC. |
| `host-sync.ts` | Strona telefonu: `validateP2pSyncRequest` sprawdza żądanie przed jakimkolwiek zapisem, `processP2pSync` opakowuje `processSync` z v1 o pola `epoch`, `addresses` i `more` (stronicowanie). Żądanie z obcą epoką nie jest przetwarzane. Stałe `MAX_CHANGES_PER_REQUEST = MAX_CHANGES_PER_RESPONSE = 500`. |
| `cpace.ts` | CPace `CPACE-RISTR255-SHA512` (draft-irtf-cfrg-cpace-21), ustawienie initiator-responder. `cpaceStart` zwraca stan i wiadomość, `cpaceFinish` zwraca ISK (64 B) albo rzuca błąd dla elementu neutralnego i śmieci. |
| `noise.ts` | `Noise_KK_25519_AESGCM_SHA256` (Noise rev. 34): `NoiseKK` (uzgadnianie w dwóch wiadomościach), `CipherState`, `generateKeyPair`, `P2P_PROLOGUE = "passholder/v2/noise"`. |
| `pairing.ts` | Kod parowania (`generatePairingCode`: 8 cyfr z CSPRNG, bajty >= 250 odrzucane, więc bez przewagi cyfr), `pairingKey(ISK)` (HKDF-SHA256, info `passholder/v2/pair-key`), `sealPairingMessage` / `openPairingMessage` (z rolą nadawcy, `pairingAad`) z rygorystyczną walidacją pól. |
| `frames.ts` | `encryptFrames` / `decryptFrames`: JSON dzielony na ramki Noise (patrz punkt 5). |
| `host.ts` | `P2pHost`: referencyjny host HTTP (uzgadnianie, sesje, jedno żądanie sync na sesję, najwyżej `MAX_SESSIONS = 32` żywych sesji). Nie otwiera gniazda, `handle(path, body)` zwraca `{status, body}`. |
| `transport.ts` | `noiseTransport`: klient wtyczki, jedno wywołanie = jedno uzgadnianie + jedno żądanie sync. HTTP wstrzykiwany jako `FetchJson`. |
| `index.ts` | Eksportuje całość, z `frames.ts` tylko stałe `MAX_FRAMES` i `MAX_FRAME_PLAINTEXT`. `_cpaceInternals` z `cpace.ts` służy wyłącznie testom. |

## 2. Parowanie krok po kroku

Role CPace: **wtyczka jest inicjatorem** (`"initiator"`), **telefon odpowiednikiem** (`"responder"`).
Wejścia obu stron:

- `PRS` = bajty UTF-8 8-cyfrowego kodu,
- `CI` = `PAIRING_CI` = `passholder/v2/pair`,
- `sid` = 16 losowych bajtów wybranych przez telefon i przekazanych wtyczce razem z adresem (kod nie jest
  częścią `sid`),
- `ad` = dowolny identyfikator strony (w testach `ext` i `phone`); wchodzi do transkryptu.

Kroki:

1. Telefon pokazuje adresy i kod (`generatePairingCode`, ważny krótko, jedna próba).
2. Obie strony: `cpaceStart(kod, CI, sid, ad)` i wymiana wiadomości `lv_cat(Y, ad)`. Draft nie ustala
   formatu wiadomości na drucie; `lv_cat(Y, AD)` to **wybór projektu** i wersja Kotlinowa musi go
   powtórzyć dokładnie (`cpaceFinish` odrzuca wszystko, co nie jest dokładnie dwoma polami `lv_cat`
   z `Y` o długości 32 B).
3. Obie strony: `cpaceFinish(stan, wiadomośćPartnera, rola)` daje to samo ISK, jeśli kody są równe.
4. `pairingKey(ISK)` daje 32-bajtowy klucz parowania.
5. Pod tym kluczem (AES-256-GCM, AAD `passholder/v2/pair/<rodzaj>/<rola>`) idą wiadomości. `<rola>` to
   rola CPace **nadawcy** (`initiator` dla wtyczki, `responder` dla telefonu), więc wiadomość odbita z
   powrotem do nadawcy się nie otworzy. `sealPairingMessage(klucz, rodzaj, from, wartość)` dostaje
   własną rolę, `openPairingMessage(klucz, rodzaj, from, blob)` rolę partnera:
   - `identity` (`deviceId` 1..64 znaki, `name` 1..64 znaki, `staticPublicKey` X25519 32 B) od obu stron,
   - `vault-info` (`epoch` 16 B, parametry KDF z `salt` w kanonicznym Base64 16 B, `wrappedVaultKey`,
     `addresses`: najwyżej 16 tekstów po 1..256 znaków) od telefonu do wtyczki.
6. Zły kod daje inne ISK, więc pierwsza wiadomość nie otwiera się (błąd tagu GCM). Telefon nie próbuje
   drugi raz. Po udanym otwarciu każda strona zapisuje klucz publiczny partnera, a telefon dopisuje
   wtyczkę do listy urządzeń.
7. Wtyczka przekazuje `vault-info` do sejfu przez `applyVaultInfo(vault, info)`: przy innej epoce
   (także gdy `vault.epoch` było `null`) wykonuje ten sam reset co zmiana epoki w synchronizacji
   (punkt 3, krok 4), a `vault.addresses` **zastępuje** listą z `info.addresses`. Przy tej samej epoce
   zmienia tylko adresy. **`vault.epoch` nigdy nie wolno przypisywać bezpośrednio**: ominięcie resetu sprawia,
   że stare `revision` i `lastSyncRevision` trafiają do nowego telefonu i wpisy się nie wysyłają.

## 3. Synchronizacja krok po kroku

1. `syncVaultV2(vault, vaultKey, clock, transport)` buduje żądanie `{epoch, sinceRevision, changes}` z
   wpisów oznaczonych `dirty`, najwyżej `MAX_CHANGES_PER_REQUEST = 500` naraz, i zapamiętuje HLC każdej
   wysłanej zmiany. Nieznana epoka jest wysyłana jako `""` (wtyczka tylko chce ją poznać).
2. `noiseTransport` na **każde** żądanie robi osobne uzgadnianie Noise KK: jedno uzgadnianie na rundę,
   sesja nie jest używana ponownie. Klucze statyczne obu stron są znane z parowania.
3. Telefon (`processP2pSync`):
   - inna epoka: odpowiada samą epoką i adresami, nic nie przetwarza,
   - ta sama epoka: najpierw `validateP2pSyncRequest` (punkt 4), potem `processSync` z v1 (przyjęte
     zmiany, konflikty, zmiany od `sinceRevision`),
   - `changes` ma najwyżej `MAX_CHANGES_PER_RESPONSE = 500` rekordów w kolejności `revision`. Gdy lista
     została ucięta, `more = true`, a `currentRevision` to `revision` ostatniego zwróconego rekordu, więc
     następne `sinceRevision` zaczyna dokładnie tam. Pominięte rekordy o niższej rewizji to te z
     `accepted` i `conflicts`, które klient już dostał. Bez ucięcia `more = false`.
4. Wtyczka po odpowiedzi:
   - **inna epoka** (też pierwsza): `adoptEpoch` zeruje `lastSyncRevision` i oznacza **wszystkie** wpisy
     (także nagrobki) jako `dirty` z `revision = 0`, żeby nowy telefon dostał wszystko; pętla rusza od
     nowa z pełnym budżetem rund, ale tylko raz (druga zmiana epoki w jednej synchronizacji to błąd),
   - **ta sama epoka, ale `currentRevision < lastSyncRevision`**: telefon cofnął się (np. odtworzony z
     kopii), więc wtyczka robi ten sam reset co przy zmianie epoki; liczy się to do tego samego limitu
     jednej zmiany epoki na synchronizację,
   - **ta sama epoka**: `applyResponse` zapisuje potwierdzone rewizje i rozstrzyga konflikty. Potwierdzony
     wpis przestaje być `dirty` tylko wtedy, gdy ma nadal HLC z chwili wysłania. Wpis zmieniony w trakcie
     żądania dostaje nową `revision`, ale zostaje `dirty` i pójdzie w następnej synchronizacji. Wpis z
     `revision = 0` usunięty w trakcie swojego pierwszego wysłania wraca jako nagrobek `dirty` z
     potwierdzoną `revision`, bo telefon już go ma.
5. Reguła HLC: dla wpisu z lokalną zmianą (`dirty`) wygrywa zmiana lokalna tylko wtedy, gdy jej HLC jest
   większy od zdalnego; w przeciwnym razie przyjmujemy wersję zdalną. Każdy odebrany HLC przesuwa zegar
   lokalny (`observe`). `upsertEntryV2` i `deleteEntryV2` też wołają `observe` na HLC nadpisywanej wersji
   przed `tick()`, więc edycja po restarcie zegara (np. `new HlcClock` bez zapisanego stanu) i tak jest
   późniejsza od tego, co nadpisuje. `clockForVault(vault, deviceId)` tworzy zegar wznowiony po
   największym HLC w sejfie. Gdy wygrała zmiana lokalna, kolejna runda wysyła ją ponownie (domyślnie do
   3 takich rund, potem błąd „Sync did not settle”).
6. Pętla trwa, dopóki zostały zmiany ponad limit żądania albo host zwrócił `more = true`. Te rundy nie
   zużywają budżetu konfliktów, ale wszystkie rundy jednej synchronizacji razem mają limit bezpieczeństwa
   `MAX_SYNC_ROUNDS = 1000` (potem błąd „Sync exceeded the round limit”).
7. Przy tej samej epoce adresy telefonu z odpowiedzi są dopisywane do `vault.addresses` bez duplikatów;
   przy zmianie epoki lista jest **zastępowana** adresami z odpowiedzi.

## 4. Kontrakt HTTP hosta

Ciała są w JSON, binaria w standardowym Base64 z dopełnieniem.

| Ścieżka | Ciało żądania | Odpowiedź 200 |
|---|---|---|
| `POST /p2p/v1/handshake` | `{deviceId, message}` (wiadomość 1 Noise) | `{session, message}` (wiadomość 2 Noise, `session` = 16 B Base64) |
| `POST /p2p/v1/sync` | `{session, frames: string[]}` | `{frames: string[]}` |

Błędy mają postać `{error: "<tekst>"}`. Kolejność sprawdzeń i kody:

| Kod | Kiedy |
|---|---|
| 413 | ciało większe niż 1 MiB; sprawdzane **jako pierwsze**, przed wszystkim innym |
| 404 | nieznana ścieżka |
| 400 | uzgadnianie: brak `deviceId`/`message`, zły Base64 albo nieudane uzgadnianie (zły klucz, obcięta lub zmieniona wiadomość) |
| 403 | uzgadnianie: `deviceId` nie ma na liście sparowanych urządzeń; host nic nie przetwarza |
| 503 | uzgadnianie: żyje już `MAX_SESSIONS = 32` sesji (po usunięciu wygasłych); `{error: "too many sessions"}` |
| 400 | sync: brak `session`, `frames` puste, więcej niż 18 ramek albo ramka nie jest tekstem |
| 401 | sync: nieznana lub wygasła sesja (też po powtórzeniu żądania) |
| 403 | sync: urządzenia sesji nie ma już na liście (albo ma inny klucz statyczny); sesja jest zużyta |
| 400 | sync: nie da się odszyfrować; odszyfrowane żądanie nie przechodzi `validateP2pSyncRequest` (niżej) |
| 500 | błąd przy budowaniu odpowiedzi |

`validateP2pSyncRequest` (400, sklep bez zmian) wymaga: `epoch` tekstem, `sinceRevision` bezpieczną
liczbą całkowitą >= 0, `changes` tablicą najwyżej 500 elementów, a w każdej zmianie: `id` tekstem
1..128 znaków, `baseRevision` bezpieczną liczbą całkowitą >= 0, `deleted` wartością logiczną, `blob`
tekstem. Powtórzone `id` daje `"duplicate change"`. Przy tej samej epoce każda zmiana z
`baseRevision != 0` dla `id`, którego host nie zna, daje `"unknown base revision"`. Wszystkie zmiany są
sprawdzane przed pierwszym zapisem, więc zła zmiana nie zostawia wcześniejszych zapisanych.

Sesja:

- żyje w pamięci **60 s** (`SESSION_TTL_MS`),
- jest **jednorazowa**: usuwana przy pierwszej próbie sync, bez względu na wynik, więc powtórzone żądanie
  dostaje 401,
- szyfry odbioru i wysyłania są używane tylko przez to jedno żądanie,
- pamięta `deviceId` i klucz statyczny urządzenia; `/sync` sprawdza listę urządzeń jeszcze raz, więc
  usunięcie urządzenia odcina też sesję otwartą tuż przed usunięciem,
- żywych sesji jest najwyżej 32; kolejne uzgadnianie dostaje 503, dopóki któraś nie wygaśnie lub nie
  zostanie użyta.

### Ramki

Treść żądania i odpowiedzi to JSON zaszyfrowany szyfrem transportowym Noise i podzielony na ramki:

- jedna ramka niesie **najwyżej 65519 B tekstu jawnego** (limit wiadomości Noise 65535 B minus tag 16 B),
- ramki idą w kolejności, każda jest osobnym wywołaniem `encrypt` (rosnący nonce), bez danych
  dodatkowych (AD puste),
- liczba ramek: **od 1 do 18** (`MAX_FRAMES = ceil(1 MiB / 65519) + 1`),
- odbiorca odszyfrowuje po kolei, skleja bajty i parsuje JSON,
- ramki nie mają własnego znacznika końca. Odcięcie ostatnich ramek wykrywa się tylko dlatego, że żaden
  właściwy prefiks obiektu JSON nie jest poprawnym JSON-em (obiekt zamyka dopiero ostatnie `}`), więc
  `JSON.parse` sklejonych bajtów się nie uda. Treść ramek musi więc zawsze być obiektem JSON.

## 5. Testy i wektory

Z katalogu głównego repo:

```
npm test && npm run typecheck          # wszystkie workspace'y
npx vitest run test/p2p                # tylko rdzeń P2P (w katalogu core/)
npm run gen-vectors-v2 -w core         # odtwarza core/test-vectors/v2.json
```

`core/test-vectors/v2.json` (`v1.json` bez zmian):

| Sekcja | Zawartość |
|---|---|
| `hlcCompare` | pary HLC i wynik -1/0/1: rozstrzyga `ms`, `c`, `d`, remis i para, w której kolejność UTF-16 (`"\u{1F600}"` < `"～"`) różni się od kolejności punktów kodowych |
| `entryPayload` | stały klucz, `id`, nonce, wpis i nagrobek, wynikowy blob |
| `pairingKey` | ISK (`ISK_IR` z wektora CPace) i wynikowy klucz |
| `cpace`, `noiseKk` | odnośniki do `cpace-ristretto255.json` (draft CPace, dodatek B.3) i `noise-kk.json` (Cacophony) |
| `pairingMessage` | stały klucz i nonce, `identity` (od telefonu i od wtyczki) i `vault-info`, rola nadawcy `from`, AAD `aad`, wynikowy blob |
| `frames` | `MAX_FRAME_PLAINTEXT = 65519`, `MAX_FRAMES = 18`, JSON o długości 65519 + 10 B dzieli się na ramki o długościach `[65519, 10]` |
| `paging` | `MAX_CHANGES_PER_REQUEST = 500`, `MAX_CHANGES_PER_RESPONSE = 500` |

Test `core/test/p2p/vectors-v2.test.ts` odtwarza każdą wartość kodem z `p2p` (także pola `aad`), a
`cpace.test.ts` sprawdza wartości pośrednie draftu (`generator_string`, `generator_hash`, `g`, `K`). Wartości zależne od
losowości mają stałe klucze i nonce (parametry `nonce` w `seal`, `encryptPayloadV2` i
`sealPairingMessage`). Oczekiwane wyniki `hlcCompare` są wpisane ręcznie w generatorze, który przerywa
pracę, gdy `compareHlc` się z nimi nie zgadza.

## 6. Znane ograniczenia

- **LWW dla zmian równoległych.** Gdy dwa urządzenia zmienią ten sam wpis bez kontaktu, wygrywa większy
  HLC, a druga zmiana ginie bez scalania pól.
- **Rozmiar wpisu a limit 1 MiB.** Stronicowanie dzieli zmiany po 500, ale nie po bajtach. 500 zmian
  musi się zmieścić w 1 MiB ciała (po Base64 ramek), czyli średnio około 1,5 KB JSON-u na zmianę
  (z blobem).
  Dla obecnych pól (`name`, `username`, `password`) to dużo zapasu; dłuższe pola wymagałyby limitu
  bajtowego.
- **Cofnięcie stanu telefonu wykrywamy tylko częściowo.** Wtyczka widzi je, gdy `currentRevision` spadnie
  poniżej jej `lastSyncRevision`. Jeśli odtworzony telefon zdąży przyjąć tyle nowych zapisów, że
  `currentRevision` znów jest wyższe, numery rewizji się zderzą. **Do planu 2 (Android):** wyłączyć bazę
  hosta z Android Auto Backup albo przy odtworzeniu z kopii zawsze tworzyć nową epokę.
- Pełne odcięcie urządzenia (nowy vaultKey) pozostaje poza zakresem, jak w `SYNCHRONIZACJA_P2P.md`.

## 7. Spike z Task 0: potwierdzony

Spike sprawdzał, czy wtyczka MV3 może zrobić `fetch` po zwykłym HTTP pod adres w sieci lokalnej.
**Wynik: działa.** 2026-11-04 Google Chrome 156.0.8078.79 na Ubuntu, service worker wtyczki MV3 z
`host_permissions` `"http://*/*"` połączył się z `http://192.168.50.164:8787/` (inne urządzenie w tej samej
sieci LAN) po czystym HTTP; użytkownik zgłosił, że zadziałało (plakietka OK).

Dokładny wynik zgłoszony przez użytkownika:

```
GET http://192.168.50.164:8787/ -> 200
POST http://192.168.50.164:8787/ -> 501
```

Kod 501 pochodzi z `python http.server`, który nie obsługuje POST; dowodzi, że żądanie POST dotarło do
serwera (a właśnie POST używa protokół z tego dokumentu).

Nie sprawdzono jeszcze adresu Tailscale. Pierwsza próba celowała w serwer w podsieci nieosiągalnej z
komputera testowego i dlatego nic nie rozstrzygnęła; potwierdzenie pochodzi z drugiej próby w tej samej
sieci. Warstwa HTTP (`host.ts`, `transport.ts`) jest cienka, więc ewentualne różnice dla innych adresów
dotyczyłyby tylko jej.
