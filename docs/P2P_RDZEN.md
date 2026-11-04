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
| `sync.ts` | Stan lokalny wtyczki (`LocalVaultV2`), `upsertEntryV2`, `deleteEntryV2` i `syncVaultV2`: pętla wysyłania zmian i pobierania cudzych, z rozstrzyganiem konfliktów po HLC. |
| `host-sync.ts` | Strona telefonu: `processP2pSync` opakowuje `processSync` z v1 o pole `epoch` i `addresses`. Żądanie z obcą epoką nie jest przetwarzane. |
| `cpace.ts` | CPace `CPACE-RISTR255-SHA512` (draft-irtf-cfrg-cpace-21), ustawienie initiator-responder. `cpaceStart` zwraca stan i wiadomość, `cpaceFinish` zwraca ISK (64 B) albo rzuca błąd dla elementu neutralnego i śmieci. |
| `noise.ts` | `Noise_KK_25519_AESGCM_SHA256` (Noise rev. 34): `NoiseKK` (uzgadnianie w dwóch wiadomościach), `CipherState`, `generateKeyPair`, `P2P_PROLOGUE = "passholder/v2/noise"`. |
| `pairing.ts` | Kod parowania (`generatePairingCode`: 8 cyfr z CSPRNG, bajty >= 250 odrzucane, więc bez przewagi cyfr), `pairingKey(ISK)` (HKDF-SHA256, info `passholder/v2/pair-key`), `sealPairingMessage` / `openPairingMessage` z rygorystyczną walidacją pól. |
| `frames.ts` | `encryptFrames` / `decryptFrames`: JSON dzielony na ramki Noise (patrz punkt 5). |
| `host.ts` | `P2pHost`: referencyjny host HTTP (uzgadnianie, sesje, jedno żądanie sync na sesję). Nie otwiera gniazda, `handle(path, body)` zwraca `{status, body}`. |
| `transport.ts` | `noiseTransport`: klient wtyczki, jedno wywołanie = jedno uzgadnianie + jedno żądanie sync. HTTP wstrzykiwany jako `FetchJson`. |
| `index.ts` | Eksportuje całość. |

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
2. Obie strony: `cpaceStart(kod, CI, sid, ad)` i wymiana wiadomości `lv_cat(Y, ad)`.
3. Obie strony: `cpaceFinish(stan, wiadomośćPartnera, rola)` daje to samo ISK, jeśli kody są równe.
4. `pairingKey(ISK)` daje 32-bajtowy klucz parowania.
5. Pod tym kluczem (AES-256-GCM, AAD `passholder/v2/pair/<rodzaj>`) idą wiadomości:
   - `identity` (`deviceId`, `name`, `staticPublicKey` X25519) od obu stron,
   - `vault-info` (`epoch` 16 B, parametry KDF, `wrappedVaultKey`, `addresses`) od telefonu do wtyczki.
6. Zły kod daje inne ISK, więc pierwsza wiadomość nie otwiera się (błąd tagu GCM). Telefon nie próbuje
   drugi raz. Po udanym otwarciu każda strona zapisuje klucz publiczny partnera, a telefon dopisuje
   wtyczkę do listy urządzeń.

## 3. Synchronizacja krok po kroku

1. `syncVaultV2(vault, vaultKey, clock, transport)` buduje żądanie `{epoch, sinceRevision, changes}` z
   wpisów oznaczonych `dirty`. Nieznana epoka jest wysyłana jako `""` (wtyczka tylko chce ją poznać).
2. `noiseTransport` na **każde** żądanie robi osobne uzgadnianie Noise KK: jedno uzgadnianie na rundę,
   sesja nie jest używana ponownie. Klucze statyczne obu stron są znane z parowania.
3. Telefon (`processP2pSync`):
   - inna epoka: odpowiada samą epoką i adresami, nic nie przetwarza,
   - ta sama epoka: `processSync` z v1 (przyjęte zmiany, konflikty, zmiany od `sinceRevision`).
4. Wtyczka po odpowiedzi:
   - **inna epoka** (też pierwsza): `adoptEpoch` zeruje `lastSyncRevision` i oznacza **wszystkie** wpisy
     (także nagrobki) jako `dirty` z `revision = 0`, żeby nowy telefon dostał wszystko; pętla rusza od
     nowa z pełnym budżetem rund, ale tylko raz (druga zmiana epoki w jednej synchronizacji to błąd),
   - **ta sama epoka**: `applyResponse` zapisuje potwierdzone rewizje i rozstrzyga konflikty.
5. Reguła HLC: dla wpisu z lokalną zmianą (`dirty`) wygrywa zmiana lokalna tylko wtedy, gdy jej HLC jest
   większy od zdalnego; w przeciwnym razie przyjmujemy wersję zdalną. Każdy odebrany HLC przesuwa zegar
   lokalny (`observe`). Gdy wygrała zmiana lokalna, kolejna runda wysyła ją ponownie (domyślnie do
   3 rund, potem błąd „Sync did not settle”).
6. Lista adresów telefonu z odpowiedzi jest dopisywana do `vault.addresses` bez duplikatów.

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
| 400 | sync: brak `session`, `frames` puste, więcej niż 18 ramek albo ramka nie jest tekstem; nie da się odszyfrować; odszyfrowane żądanie ma zły kształt |
| 401 | sync: nieznana lub wygasła sesja (też po powtórzeniu żądania) |
| 500 | błąd przy budowaniu odpowiedzi |

Sesja:

- żyje w pamięci **60 s** (`SESSION_TTL_MS`),
- jest **jednorazowa**: usuwana przy pierwszej próbie sync, bez względu na wynik, więc powtórzone żądanie
  dostaje 401,
- szyfry odbioru i wysyłania są używane tylko przez to jedno żądanie.

### Ramki

Treść żądania i odpowiedzi to JSON zaszyfrowany szyfrem transportowym Noise i podzielony na ramki:

- jedna ramka niesie **najwyżej 65519 B tekstu jawnego** (limit wiadomości Noise 65535 B minus tag 16 B),
- ramki idą w kolejności, każda jest osobnym wywołaniem `encrypt` (rosnący nonce), bez danych
  dodatkowych (AD puste),
- liczba ramek: **od 1 do 18** (`MAX_FRAMES = ceil(1 MiB / 65519) + 1`),
- odbiorca odszyfrowuje po kolei, skleja bajty i parsuje JSON.

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
| `pairingMessage` | stały klucz i nonce, `identity` i `vault-info`, wynikowy blob |
| `frames` | `MAX_FRAME_PLAINTEXT = 65519`, `MAX_FRAMES = 18`, JSON o długości 65519 + 10 B dzieli się na ramki o długościach `[65519, 10]` |

Test `core/test/p2p/vectors-v2.test.ts` odtwarza każdą wartość kodem z `p2p`. Wartości zależne od
losowości mają stałe klucze i nonce (parametry `nonce` w `seal`, `encryptPayloadV2` i
`sealPairingMessage`). Oczekiwane wyniki `hlcCompare` są wpisane ręcznie w generatorze, który przerywa
pracę, gdy `compareHlc` się z nimi nie zgadza.

## 6. Znane ograniczenia

- **LWW dla zmian równoległych.** Gdy dwa urządzenia zmienią ten sam wpis bez kontaktu, wygrywa większy
  HLC, a druga zmiana ginie bez scalania pól.
- **Brak stronicowania.** Cały zestaw zmian idzie w jednym żądaniu i odpowiedzi; limit to 1 MiB ciała
  (413) i 18 ramek, więc bardzo duży sejf nie zsynchronizuje się w jednej rundzie.
- **Sesje 60 s przeżywają usunięcie urządzenia.** Host sprawdza listę urządzeń przy uzgadnianiu, więc
  sesja otwarta tuż przed usunięciem urządzenia może wykonać jeszcze jedno żądanie sync.
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
