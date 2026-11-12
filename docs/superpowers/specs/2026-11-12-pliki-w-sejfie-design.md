# Pliki w sejfie (załączniki) – projekt

Data: 2026-11-12. Etap V3 „pliki” (backlog: [passholder-v3-backlog]). Status: do akceptacji (po przeglądzie recenzenta).

## 1. Cel i dlaczego

Właściciel chce trzymać w sejfie pliki, głównie zdjęcia i skany dokumentów, ale dowolnego formatu. Plik jest
**załącznikiem do dowolnego wpisu** (np. skan dowodu przy wpisie typu dokument). PassHolder plików **nie
otwiera**: tylko je dodaje, przechowuje zaszyfrowane, synchronizuje i pozwala pobrać.

Ustalenia właściciela (2026-11-12):

- plik do **10 MB** (10 485 760 B), dowolny format,
- **pełna kopia na obu urządzeniach** (offline-first, jak wpisy): pobranie w Chrome działa bez telefonu w sieci,
- pobieranie w Chrome i na telefonie, przed pobraniem **ostrzeżenie**: „Pobierasz plik, który zostanie
  odszyfrowany i będzie dostępny na tym urządzeniu”,
- przesyłanie **osobnym kanałem** (wariant 2, punkt 3), nie jako zwykłe rekordy sync.

## 2. Cele, nie-cele, anty-cele

**Cele:** dodanie, lista, pobranie i usunięcie załączników przy każdym typie wpisu, we wtyczce i na
telefonie; szyfrowanie end-to-end jak wpisy; synchronizacja przerwana w połowie wznawia się przy następnej.

**Nie-cele:** podgląd plików (miniatury, przeglądarka PDF), zmiana nazwy załącznika, wersjonowanie pliku,
wyszukiwanie w treści plików, pliki w NordPass CSV i Bitwarden JSON.

**Anty-cele (porażka, nawet jeśli działa):**

- telefon albo ktoś w sieci widzi treść lub nazwę pliku (nazwa, typ i klucz są tylko w zaszyfrowanym wpisie),
- duże pliki spowalniają zwykłą synchronizację wpisów albo start aplikacji (sejf wpisów nie może trzymać
  treści plików),
- odszyfrowany plik zostaje na urządzeniu bez wyraźnej decyzji użytkownika (tylko po ostrzeżeniu i „Pobierz”).

## 3. Rozważone podejścia

| | Opis | Za | Przeciw |
|---|---|---|---|
| 1 | Plik dzielony na kawałki ~48 KiB, każdy jako zwykły rekord sync | protokół bez zmian | telefon trzyma cały `records.jsonl` w pamięci (`FileSyncStore`, `HashMap`) i przepisuje go przy kompaktowaniu; wtyczka trzyma sejf w `chrome.storage`; kilka plików po 10 MB = setki MB w pamięci |
| **2** | **Opis załącznika we wpisie, treść pliku osobno, nowa ścieżka do przesyłania kawałków** | wpisy zostają małe, pliki niezmienne (bez konfliktów) | więcej kodu: nowa ścieżka, magazyn plików w TS i Kotlinie |
| 3 | Pliki tylko na telefonie, wtyczka pobiera na żądanie | lekka wtyczka | pobranie w Chrome wymaga telefonu w sieci; odrzucone przez właściciela (wybrał pełną kopię) |

Wybrane: **2** (wybór właściciela).

## 4. Format danych

### 4.1. Opis załącznika we wpisie

Treść wpisu v3 dostaje **opcjonalny** klucz `attachments` między `custom` a `hlc`:

```json
{"v":3,"type":"document","name":"Dowód","note":"","fields":{…},"custom":[],
 "attachments":[{"id":"<uuid>","name":"dowod-przod.jpg","mime":"image/jpeg","size":483211,
                 "chunks":2,"sha256":"<hex>","key":"<Base64 32 B>"}],"hlc":{…}}
```

- `id`: UUID v4 pliku, nadawany przy dodaniu. `name`: 1..255 znaków, bez `/`, `\` i znaków sterujących.
  `mime`: tekst ≤ 127 znaków (puste = `application/octet-stream`). `size`: 1..10 485 760.
  `chunks`: `ceil(size / CHUNK)`. `sha256`: skrót treści jawnej (64 małe znaki hex). `key`: losowy klucz
  pliku AES-256 (32 B).
- Klucz `attachments` jest **zapisywany tylko, gdy lista nie jest pusta**. Wpis bez plików ma więc te same
  bajty co dziś (wektory `v3.json` bez zmian). Kolejność kluczy załącznika jak wyżej; ścisły odczyt
  (nieznany klucz, zły typ, przekroczony limit → `Invalid entry payload`).
- Najwyżej **20 załączników na wpis** przy dodawaniu na ekranie; parser przyjmuje do **40** (zapas na
  łączenie przy konflikcie, punkt 6.5). Powtórzone `id` → błąd.
- Nagrobek bez zmian (`{hlc}`). Import/eksport PassHolder JSON: patrz punkt 8.

**Zgodność (moja decyzja):** ścieżki sync bez zmian (bez `/p2p/v3`). Stara aplikacja ze ścisłym parserem
odrzuci wpis z `attachments`, więc jej synchronizacja skończy się ogólnym błędem, bez komunikatu „zaktualizuj”.
Przy jednym użytkowniku, który aktualizuje obie aplikacje razem, to wystarczy. Nowa wtyczka przy starym
telefonie dostaje 404 na `/p2p/v2/file` i pokazuje „Zaktualizuj aplikację na telefonie”.

### 4.2. Szyfrowanie treści pliku

- `CHUNK = 262144` (256 KiB) bajtów jawnych; ostatni kawałek krótszy. 10 MB → najwyżej 40 kawałków.
- Kawałek `i` (od 0) z `n`: `blob = seal(fileKey, kawałek, aad = "passholder/v3/file/<id>/<i>/<n>")`, ten sam
  format co punkt 3 SPEC (`0x01 || nonce || ct || tag`, Base64). AAD wiąże kawałek z plikiem, pozycją i
  liczbą kawałków, więc host nie może ich zamienić, uciąć ani przestawić.
- Po złożeniu odbiorca sprawdza `size` i `sha256`; niezgodność → plik odrzucony („Plik jest uszkodzony”).
- Na obu urządzeniach plik leży **w postaci zaszyfrowanych kawałków** (tak, jak przyszedł). Odszyfrowanie
  tylko przy pobieraniu.

## 5. Magazyny

- **Telefon:** `filesDir/p2p/files/<id>/<i>` (kawałki) + znacznik kompletności (np. plik `complete`
  zapisany po ostatnim kawałku, atomowo). Kawałki niekompletnego pliku zostają do wznowienia.
- **Wtyczka:** IndexedDB (baza `passholder-files`), rekord na kawałek + rekord stanu pliku
  `{id, chunks, complete, uploaded}`. Nowe uprawnienie **`unlimitedStorage`**. Sejf wpisów zostaje w
  `chrome.storage` bez zmian.
- Przy zmianie epoki / „Nowy sejf” / „Odtwórz z wtyczki” telefon kasuje pliki razem z rekordami; wtyczka przy
  `adoptEpoch` oznacza wszystkie swoje pliki `uploaded = false`.

## 6. Synchronizacja plików

### 6.1. Ścieżka

`POST /p2p/v2/file` po Noise KK, jak `/p2p/v2/sync` (osobne uzgadnianie, jedna sesja = jedno żądanie, te same
limity ciała 1 MiB i ramek). Działa przy zablokowanym telefonie (host przenosi tylko szyfrogramy). Treść
żądania (w ramkach) to jedna z operacji:

| `op` | Żądanie | Odpowiedź |
|---|---|---|
| `status` | `{epoch, ids: string[]}` (≤ 500) | `{files: [{id, chunks, have: number[]}]}` – które kawałki telefon ma; `complete` gdy wszystkie |
| `put` | `{epoch, id, index, chunks, blob}` | `{have: number}` (ile kawałków ma) |
| `get` | `{epoch, id, index}` | `{chunks, blob}` albo 404 `not found` |

- Inna epoka → odpowiedź z samą epoką, nic nie zapisane (jak sync).
- Walidacja (400): `id` UUID, `0 ≤ index < chunks ≤ 40`, `blob` ≤ `4·ceil((29 + CHUNK)/3)` znaków, `chunks`
  zgodne z już zapisanymi kawałkami tego `id`. Kawałek, który już jest, nadpisuje się tylko identycznym
  (inaczej 409) – pliki są niezmienne.
- Mało miejsca na telefonie (< 50 MB wolnego po zapisie) → 507 `insufficient storage`.
- Budżet: kawałek 256 KiB → Base64 w JSON ×4/3, ramki Noise w Base64 ×4/3 ≈ 455 KiB ciała, z zapasem do 1 MiB.

### 6.2. Przebieg we wtyczce

Po udanej synchronizacji wpisów (i tylko przy odblokowanym sejfie, jak dziś):

1. **Wysyłanie:** dla plików `uploaded = false`, które są w żywym wpisie: `status`, potem `put` brakujących
   kawałków, na końcu `uploaded = true`.
2. **Pobieranie:** dla załączników z żywych wpisów, których wtyczka nie ma kompletnych: `status`, potem `get`
   brakujących kawałków; po ostatnim sprawdzenie `size`/`sha256`, `complete = true`. Plik, którego telefon
   jeszcze nie ma (dodany na innej wtyczce i niewysłany), zostaje na następną synchronizację.
3. Faza plików działa tam, gdzie dziś synchronizacja: w popupie albo karcie (moja decyzja). LAN: 10 MB to
   40 krótkich żądań, kilka–kilkanaście sekund. Zamknięcie popupu przerywa fazę; wznowienie przy następnej
   synchronizacji od brakujących kawałków. Przeniesienie do service workera poza zakresem.
4. Postęp na ekranie: „Pliki: 3 z 12”. Błąd fazy plików nie cofa synchronizacji wpisów; komunikat „Nie
   wszystkie pliki zsynchronizowane” i wznowienie przy następnej.

### 6.3. Telefon

Telefon jest hostem: plik dodany na telefonie trafia od razu do jego magazynu jako kompletny. Plik
dodany we wtyczce pojawia się na telefonie po jej synchronizacji.

### 6.4. Sprzątanie (pliki osierocone)

Telefon jako host nie widzi, które pliki są używane (opisy są w zaszyfrowanych wpisach). Dlatego:

- **Telefon** sprząta, gdy sejf jest **odblokowany** (np. po odblokowaniu i po zapisie wpisu): usuwa pliki
  nieużywane przez żaden żywy wpis i starsze niż **24 h** (czas pierwszego kawałka). 24 h chroni plik
  wysłany przez wtyczkę przed wpisem, który go używa.
- **Wtyczka** po udanej synchronizacji usuwa z IndexedDB pliki nieużywane przez żaden żywy wpis
  lokalnego sejfu.
- Usunięcie załącznika albo wpisu na jednym urządzeniu usuwa więc plik na obu po synchronizacji.

### 6.5. Konflikty: łączenie załączników (decyzja właściciela 2026-11-12)

Konflikt nadal rozstrzyga HLC dla całego wpisu, ale lista załączników jest **łączona**: wynik = załączniki
zwycięzcy + te z przegranej wersji, których `id` nie ma u zwycięzcy (w kolejności: najpierw zwycięzca).
Gdy połączona lista różni się od zwycięskiej, urządzenie rozstrzygające (wtyczka) zapisuje ją jako nową
lokalną zmianę (nowy HLC, `dirty`), która idzie na telefon w następnej rundzie. Wada przyjęta przez
właściciela: plik usunięty na jednym urządzeniu przy równoczesnej edycji na drugim może wrócić. Nagrobek, który
wygrywa, usuwa wpis razem z plikami (świadome usunięcie). Wektory: przypadki łączenia w TS i Kotlinie.

## 7. Ekrany

**Wspólne:** w formularzu każdego typu sekcja „Załączniki”: lista (nazwa, rozmiar, np. „472 KB”), przyciski
„Pobierz” i „Usuń” przy pliku, „+ Dodaj plik”. Dodanie: plik > 10 MB → „Plik jest za duży (limit 10 MB)”;
więcej niż 20 → „Najwyżej 20 plików we wpisie”. Plik czekający na synchronizację: dopisek „czeka na
synchronizację”, a „Pobierz” nieaktywne, gdy urządzenie nie ma kompletnego pliku. Usunięcie załącznika
działa jak zmiana pola: zapisuje się dopiero przyciskiem „Zapisz” wpisu. Na liście wpisów ikona/licznik
spinacza przy wpisach z plikami.

**Pobieranie (oba):** okno potwierdzenia z tekstem właściciela: „Pobierasz plik, który zostanie odszyfrowany
i będzie dostępny na tym urządzeniu.” i przyciski „Pobierz” / „Anuluj”.

**Wtyczka:** wybór pliku tylko w karcie (popup Chrome zamyka się przy oknie wyboru pliku, jak przy imporcie):
„+ Dodaj plik” w popupie otwiera formularz w karcie. Pobieranie jak eksport (Blob + `<a download>`), nazwa
pliku z opisu.

**Telefon:** dodanie przez systemowy wybór pliku (`OpenDocument`, bez uprawnień do pamięci), pobranie przez
`CreateDocument` z nazwą i typem z opisu. Okno 60 s bez blokady przy wyborze pliku, jak przy imporcie/eksporcie.

## 8. Import i eksport

Decyzja właściciela (2026-11-12): **eksport z plikami**, jako osobny, ostatni krok (krok 5).

- Nowy format **PassHolder ZIP**: `passholder.json` (jak dziś, wpisy z listą `attachments` bez `key`/`sha256`,
  z polem `path` do pliku w archiwum) + odszyfrowane pliki w `files/`. Archiwum jest jawne, jak eksport JSON,
  więc przed eksportem to samo ostrzeżenie o ryzyku.
- Import rozpoznaje ZIP po treści; pliki dostają nowe `id` i klucze, trafiają do magazynu i synchronizują
  się normalnie. Limit importu dla ZIP wyższy niż 10 MiB (wartość w planie kroku 5).
- Do czasu kroku 5 eksport PassHolder JSON pomija pliki i mówi o tym („N plików nie zostanie
  wyeksportowanych”). NordPass i Bitwarden bez plików na stałe.

## 9. Kroki (1 krok = 1 wątek, jak dotąd)

1. **Rdzeń TS** (`core/src/files/` + zmiany w `core/src/p2p/`): opis załącznika w wpisie, szyfrowanie
   kawałków, host referencyjny `/p2p/v2/file`, klient synchronizacji plików, wektory
   `core/test-vectors/files/`.
2. **Rdzeń Kotlin + host telefonu:** port formatu i kawałków, `FileStore` na dysku, `/p2p/v2/file` w
   `PhoneRouter`, sprzątanie, te same wektory.
3. **Wtyczka:** IndexedDB, `unlimitedStorage`, faza plików w synchronizacji, sekcja „Załączniki”, pobieranie.
4. **Android – ekrany:** sekcja „Załączniki”, wybór i zapis plików, ostrzeżenie.
5. **Eksport/import ZIP z plikami** we wtyczce i na Androidzie (punkt 8).

Każdy krok: plan (writing-plans) do akceptacji, wykonanie subagentami, testy, opis w `docs/` (SPEC,
SYNCHRONIZACJA, FUNKCJE, TESTY), PR.

## 10. Testy

- Wektory: wpis z załącznikami, odrzucane opisy (nieznany klucz, `size` 0 i > 10 MB, 21 załączników, zła
  nazwa), kawałki z AAD; TS i Kotlin dają te same bajty.
- Host: `status`/`put`/`get`, zła epoka, 409 przy innym kawałku, 404, wznowienie po przerwaniu, 507.
- Klient: wysyłanie i pobieranie z przerwą w połowie, plik nieobecny na telefonie, zły `sha256`.
- Sprzątanie: 24 h, plik używany zostaje.
- Ręczny T22: dodaj zdjęcie 5 MB we wtyczce → sync → pobierz na telefonie (i odwrotnie), usuń → znika na obu.

## 11. Decyzje właściciela i moje założenia

**Ustalone przez właściciela:** punkt 1, łączenie załączników przy konflikcie (6.5), eksport ZIP z plikami (8).

**Moje założenia (do sprawdzenia):** limit 20 plików na wpis; kawałek 256 KiB; brak limitu łącznego (tylko
wolne miejsce: 507 na telefonie, `unlimitedStorage` we wtyczce); sprzątanie po 24 h; brak zmiany nazwy
załącznika; `attachments` jako opcjonalny klucz w v3 (bez `v: 4`); bez nowej ścieżki sync (4.1); faza
plików w popupie/karcie (6.2).
