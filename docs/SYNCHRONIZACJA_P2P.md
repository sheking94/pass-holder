# Synchronizacja bez serwera (telefon jako kotwica): projekt

Status: rdzeń zaimplementowany w TypeScripcie (plan 1, [`P2P_RDZEN.md`](P2P_RDZEN.md)) i w Kotlinie po
stronie telefonu (plan 2, [`P2P_ANDROID_RDZEN.md`](P2P_ANDROID_RDZEN.md)); plan 3 gotowy: telefon jako host
([`P2P_TELEFON.md`](P2P_TELEFON.md)) i wtyczka sparowana z telefonem ([`P2P_WTYCZKA.md`](P2P_WTYCZKA.md));
usunięcie Pi (plan 4) zrobione ([`P2P_USUNIECIE_SERWERA.md`](P2P_USUNIECIE_SERWERA.md)). Dokument opisuje, jak PassHolder ma działać bez
Raspberry Pi: telefon z Androidem przejmuje rolę punktu wymiany, a wtyczka Chrome łączy się bezpośrednio
z telefonem. Zastąpił sekcje 5–7 dawnego `SPEC.md` (synchronizacja przez Pi); reszta (klucze, format
szyfrogramu, generator) zostaje. Projekt opisuje też punkt wyjścia (Pi), więc nazwy z v1 (`api.ts`,
`pickServer`, `server/`) są tu celowo.

## 1. Cel i wymagania

Ustalone z właścicielem projektu:

| # | Wymaganie |
|---|---|
| W1 | Brak centralnego serwera. Raspberry Pi i katalog `server/` przestają być potrzebne. |
| W2 | Mniej miejsc z kompletem zaszyfrowanych danych niż „serwer zawsze włączony w sieci”. |
| W3 | Telefon jest kotwicą. Wtyczka synchronizuje się tylko z telefonem. Synchronizacja wtyczka–wtyczka bez telefonu nie jest potrzebna. |
| W4 | Jeden telefon z sejfem. |
| W5 | Po utracie telefonu sejf da się odtworzyć z wtyczki na nowym telefonie. |
| W6 | Parowanie krótkim kodem wpisywanym we wtyczce, zabezpieczonym przez PAKE. |
| W7 | Zmiana sieci (np. dwa mieszkania, dwa routery, zmiana IP) nie wymaga ponownego parowania. |
| W8 | Migracja danych z Pi nie jest potrzebna: nowy sejf zakłada się na telefonie, hasła wraca się importem CSV. |

Cel projektu to nauka, więc projekt świadomie zawiera CPace, Noise i HLC. Tam, gdzie to możliwe, korzysta
jednak z istniejącego protokołu, żeby nie przepisywać działającego kodu.

## 2. Ograniczenia, które wyznaczyły projekt

- **Wtyczka Chrome MV3 nie nasłuchuje.** Service worker i dokument offscreen mogą tylko same nawiązywać
  połączenia (fetch, WebSocket, WebRTC). Dlatego stroną nasłuchującą musi być telefon.
- **Wtyczka nie przypnie samopodpisanego certyfikatu.** TLS do telefonu wymagałby dodawania CA do
  systemu przy każdym telefonie. Zamiast tego transport jest zwykłym HTTP, a poufność i uwierzytelnienie
  zapewnia warstwa aplikacji (Noise, sekcja 4.2).
- **Założenie potwierdzone (2026-11-04):** Chrome pozwala wtyczce z uprawnieniem do hosta wysłać `fetch`
  pod `http://<adres w sieci lokalnej>` (reguły Private Network Access). Sprawdzone w Google Chrome
  156.0.8078.79: service worker wtyczki MV3 z `host_permissions` `"http://*/*"` wysłał do
  `http://192.168.50.164:8787/` (inne urządzenie w tej samej sieci LAN) `GET` → 200 i `POST` → 501
  (`python http.server` nie obsługuje POST, więc 501 dowodzi, że żądanie dotarło). Adresu Tailscale
  i strony wtyczki (okienko, karta) z prawdziwą prośbą o zgodę jeszcze nie sprawdzono: testy T7 i T4 w
  `P2P_TELEFON.md` §11.2, wynik dopisać tutaj. Szczegóły w `P2P_RDZEN.md`, punkt 7.

## 3. Architektura

```
 ┌──────────────────────┐   HTTP + Noise KK    ┌───────────────────────────────┐
 │ Wtyczka Chrome (1..n)│ ───────────────────► │ Android: tryb „Synchronizacja”│
 │ pełna zaszyfrowana   │  POST /p2p/v1/...    │ - lista sparowanych urządzeń  │
 │ kopia sejfu          │ ◄─────────────────── │ - licznik revision, epoch     │
 └──────────────────────┘                      │ - pełna zaszyfrowana kopia    │
                                               └───────────────────────────────┘
```

- **Telefon** w trybie „Synchronizacja” (przycisk w aplikacji) uruchamia lekki serwer HTTP na stałym
  porcie, słuchający na wszystkich interfejsach (Wi-Fi i Tailscale). Tryb wyłącza się sam po kilku
  minutach bez żądań oraz po wyjściu z aplikacji. Port nie jest otwarty na stałe (bateria, powierzchnia
  ataku).
- **Telefon przejmuje logikę dzisiejszego serwera z sekcji 5 `SPEC.md`:** licznik `revision`, rekordy
  `{id, revision, deleted, blob}`, transakcyjne przyjmowanie zmian z `baseRevision`. Zmienia się warstwa
  przenosząca żądanie, nie sama synchronizacja.
- **Wtyczka** zmienia tylko transport (`api.ts`): zamiast HTTPS do Pi rozmawia z telefonem przez Noise.
  Pamięta listę adresów telefonu i wybiera adres istniejącym mechanizmem `pickServer`
  (`archive/WIELE_ADRESOW_SERWERA.md`; dziś `pickPhone` w `extension/src/phone-urls.ts`).
- **Telefon jest też klientem własnego sejfu:** jego lokalne zmiany idą bezpośrednio do własnej bazy
  z nowym `revision`, bez sieci.

Znika: logowanie `authKey`/`authHash`, tokeny sesji, `setupToken`, przypinanie certyfikatu na Androidzie.
Telefon nie musi sprawdzać hasła głównego, bo dostęp do synchronizacji daje klucz urządzenia z parowania.

## 4. Parowanie i transport

### 4.1 Parowanie (CPace)

1. Na telefonie: „Urządzenia → Dodaj wtyczkę”. Telefon włącza tryb synchronizacji i pokazuje swoje
   adresy oraz **8-cyfrowy kod** (CSPRNG, ważny 2 minuty, jedna próba).
2. We wtyczce: wpisujesz adres i kod.
3. Obie strony wykonują **CPace** (draft IETF `irtf-cfrg-cpace`, grupa ristretto255) z kodem jako hasłem
   i identyfikatorem sesji wybranym przez telefon. Wynik: wspólny klucz `K_pair`.
4. Pod `K_pair` (AES-256-GCM) strony wymieniają:
   - stałe klucze publiczne X25519 (`deviceStaticPub`), losowe `deviceId` i nazwy urządzeń,
   - od telefonu do wtyczki: `epoch`, parametry KDF, `wrappedVaultKey` (to, co dziś daje `prelogin`
     i `session`).
5. Telefon dopisuje wtyczkę do listy urządzeń, wtyczka zapisuje klucz publiczny telefonu. Kod przestaje
   działać, niezależnie od wyniku.

Dlaczego 8 cyfr wystarcza: PAKE nie daje podsłuchującemu nic do zgadywania offline, a atak online ma
jedną próbę na kod, czyli szansę 1:10⁸. Dlaczego nie hasło główne jako wejście PAKE: każda próba
połączenia byłaby okazją do zgadywania hasła głównego, a hasło to klucz do wszystkiego.

### 4.2 Każda synchronizacja (Noise KK)

- Wtyczka i telefon znają nawzajem swoje klucze statyczne, więc używają wzorca **Noise_KK_25519_AESGCM_SHA256**
  (dwie wiadomości uzgadniania, obustronne uwierzytelnienie, poufność do przodu dzięki kluczom
  efemerycznym).
- Przebieg po HTTP: `POST /p2p/v1/handshake` (wiadomość 1 → wiadomość 2 + identyfikator sesji), potem
  `POST /p2p/v1/sync` z ciałem zaszyfrowanym kluczem transportowym Noise. Treść to dokładnie dzisiejsze
  żądanie i odpowiedź `sync` z sekcji 5 `SPEC.md`, uzupełnione o pole `epoch` (4.4) i `addresses` (4.3).
- Telefon odrzuca uzgadnianie od klucza spoza listy urządzeń. Sesja Noise żyje tylko w pamięci, krótko.
- Szyfrowanie wpisów vaultKey zostaje bez zmian: Noise chroni metadane (które `id`, kiedy, ile), a nie
  zastępuje szyfrowania end-to-end.

### 4.3 Adresy i zmiana sieci (W7)

- **Tożsamość to klucz, nie adres.** Noise KK potwierdza, że po drugiej stronie jest sparowany telefon,
  pod jakimkolwiek IP. Zmiana sieci nigdy nie wymaga ponownego parowania.
- **Lista się uczy:** w każdej odpowiedzi `sync` telefon podaje swoje bieżące adresy (`addresses`),
  a wtyczka dopisuje nowe do listy. Po pierwszej synchronizacji w każdym mieszkaniu oba adresy są znane.
- **Pierwszy raz w nowej sieci:** telefon w trybie synchronizacji pokazuje adres, a Ty wpisujesz go we
  wtyczce, bez kodu. Zły adres jest bezpieczny, bo obce urządzenie nie przejdzie Noise KK.
- **Zalecane:** adres Tailscale telefonu (stały w każdej sieci) i rezerwacja DHCP w obu routerach.
- **Nie robimy:** skanowania podsieci. MV3 nie zna łatwo własnego adresu (Chrome ukrywa go w WebRTC),
  a skanowanie jest wolne i hałaśliwe.

### 4.4 Epoka

Telefon ma losowy identyfikator `epoch` (16 B), tworzony przy zakładaniu lub odtwarzaniu sejfu. Wtyczka
pamięta `epoch` z parowania. Gdy w odpowiedzi przyjdzie inna epoka, wtyczka wie, że numery `revision`
nie pasują do niczego, co zna (patrz 5.3).

## 5. Dane i konflikty

### 5.1 HLC zamiast `modifiedAt`

Treść wpisu (w szyfrogramie) zamiast `modifiedAt` zawiera **hybrydowy zegar logiczny**:

```
hlc = { "ms": <ms od epoki>, "c": <licznik>, "d": "<deviceId>" }
```

- Przy lokalnej zmianie: `ms' = max(ms_lokalne, teraz)`; jeśli `ms'` się nie zmienił, `c + 1`, w przeciwnym
  razie `c = 0`.
- Przy odebraniu wpisu z innym HLC urządzenie przesuwa swój zegar za ten odczyt (standardowa reguła HLC,
  Kulkarni i in., 2014).
- Porównanie leksykograficzne `(ms, c, d)`. Nie ma remisów, bo `deviceId` jest unikalny.

Skutek: zmiana zrobiona *po* zobaczeniu innej zawsze ma większy HLC, nawet gdy zegar urządzenia się
spieszy lub spóźnia. Dzisiejsza słabość z `SPEC.md` („rozjechany zegar może sprawić, że wygra starsza
zmiana”) znika dla zmian przyczynowo zależnych.

Reguła klienta z sekcji 5 `SPEC.md` zostaje, tylko z HLC: lokalny wpis `dirty` wygrywa, gdy ma większy
HLC niż wersja z telefonu; w przeciwnym razie wygrywa telefon.

### 5.2 Usuwanie

- Nagrobek: `deleted = true` jawnie, w szyfrogramie tylko `{ "hlc": … }`.
- „Edycja kontra usunięcie”: wygrywa większy HLC (usunięcie nie ma pierwszeństwa).
- Telefon trzyma nagrobki na stałe (kilkadziesiąt bajtów każdy). Wpis, który nigdy nie trafił na
  telefon, wtyczka kasuje lokalnie, jak dziś.

### 5.3 Odtworzenie po utracie telefonu (W5)

1. Nowy telefon: „Odtwórz z wtyczki”. Tworzy nową `epoch` i pokazuje kod parowania.
2. Wtyczka paruje się (4.1), zapomina klucz starego telefonu i widzi nową epokę.
3. Wtyczka zeruje swoje `revision`, oznacza wszystkie wpisy i nagrobki jako `dirty` z `baseRevision = 0`
   i wysyła: parametry KDF, `wrappedVaultKey`, wszystkie bloby.
4. Telefon prosi o hasło główne, odwija vaultKey i od tej chwili jest kotwicą.
5. Kolejne wtyczki parują się z nowym telefonem. Ich wpisy też trafiają jako `baseRevision = 0`;
   rekordy, które telefon już ma, wracają jako konflikty i rozstrzyga je HLC.

W tym trybie (i tylko w nim) telefon przyjmuje metadane sejfu od wtyczki zamiast je wydawać.

## 6. Urządzenia i odwoływanie

- Ekran „Urządzenia” na telefonie: nazwa, data parowania, ostatnia synchronizacja, przycisk „Usuń”.
  Usunięcie kasuje klucz z listy, więc kolejne Noise KK się nie uda.
- **Odwołanie nie wymazuje danych.** Odwołana wtyczka zachowuje swoją zaszyfrowaną kopię, chronioną
  tylko hasłem głównym. To samo dotyczy zgubionego telefonu.
- Pełne odcięcie (zmiana hasła głównego + nowy vaultKey + przeszyfrowanie wpisów) pozostaje poza
  zakresem, jak w sekcji 9 `SPEC.md`. To naturalny następny krok po tym projekcie.

## 7. Co zyskujemy, co tracimy

| | Dziś (Pi) | Po zmianie |
|---|---|---|
| Sprzęt do utrzymania | Pi, karta SD, CA, certyfikat z SAN | brak |
| Synchronizacja poza domem | VPN do Pi | telefon jest zawsze przy Tobie; w drugim mieszkaniu działa LAN |
| Miejsca z pełną kopią | Pi + urządzenia | tylko urządzenia (W2) |
| Rozjechane zegary | może wygrać starsza zmiana | HLC rozwiązuje zmiany zależne |
| Zależność od jednego urządzenia | Pi (zwykle wyłączone) | telefon (odtwarzalny z wtyczki) |
| Wtyczka bez telefonu w pobliżu | synchronizuje, jeśli Pi działa | nie synchronizuje (świadomy kompromis W3) |
| Zaufanie do certyfikatu w Chrome | trzeba dodać CA | niepotrzebne |

## 8. Plan zmian w repo (do rozpisania w planie implementacji)

0. **Spike (do wyrzucenia):** wtyczka MV3 wysyła `fetch` pod `http://<IP telefonu>:<port>` do prostego
   serwera na Androidzie. Wynik decyduje, czy reszta planu ma sens.
1. `core/`: moduły `hlc.ts`, `cpace.ts`, `noise.ts` (na `@noble/curves`, `@noble/hashes`), zmiana treści
   wpisu z `modifiedAt` na `hlc`, nowe wektory w `core/test-vectors/` (wersja v2).
2. Android `core`: odpowiedniki w Kotlinie, sprawdzane tymi samymi wektorami; logika dzisiejszego
   `server/` (przyjmowanie zmian, `revision`) przeniesiona do Kotlina.
3. Android `app`: tryb „Synchronizacja”, ekran parowania z kodem, ekran „Urządzenia”, „Odtwórz z wtyczki”.
4. Wtyczka: nowy transport w `api.ts`, parowanie zamiast łączenia z serwerem, nauka adresów.
5. Usunięcie `server/`, `deploy/` i części `INSTALACJA.md` o Pi. PIN we wtyczce owija wtedy tylko
   vaultKey (`authKey` przestaje istnieć).

## 9. Testy

- Wektory testowe CPace z draftu i Noise z projektu Cacophony, przechodzące w TypeScript i Kotlinie.
- HLC: porządek przy rozjechanych zegarach, przesunięcie po odbiorze, brak remisów.
- Synchronizacja: istniejące testy z `core/test/` przeniesione na HLC; nowe przypadki: edycja kontra
  usunięcie, nowa epoka, `baseRevision = 0` dla znanego wpisu.
- Parowanie: zły kod (jedna próba i koniec), wygasły kod, uzgadnianie od nieznanego klucza.
- Integracja: wtyczka w Chrome i aplikacja w emulatorze w tej samej sieci.

## 10. Słabe punkty i ryzyka

- **Nadal LWW dla zmian równoległych.** Gdy wtyczka i telefon zmienią ten sam wpis bez kontaktu, jedna
  wersja przepada. HLC wybiera ją tylko deterministycznie. Możliwe rozszerzenie: kopia konfliktu.
- **Własna implementacja CPace i Noise** w dwóch językach to ryzyko subtelnych błędów. Łagodzą je
  wspólne wektory testowe, ale to nie audyt.
- **Private Network Access w Chrome** (sekcja 2) potwierdzone 2026-11-04 dla adresu w tej samej sieci
  LAN (Chrome 156.0.8078.79, MV3, `"http://*/*"`). Niesprawdzone: adres Tailscale, strona wtyczki
  zamiast service workera (T4, T7 w `P2P_TELEFON.md` §11.2) i przyszłe wersje Chrome, które mogą zaostrzyć
  te reguły.
- **Bez telefonu nie ma synchronizacji** między dwoma komputerami.
- **Android może ubić serwer w tle**; dlatego tryb synchronizacji działa tylko z aplikacją na wierzchu.

## 11. Wariant produkcyjny (gdyby celem nie była nauka)

Ten projekt świadomie wybiera rozwiązania ciekawe do nauki. Gdyby celem była wyłącznie jak najlepiej
działająca i bezpieczna aplikacja, zmieniłoby się to:

| Obszar | W tym projekcie | W wariancie produkcyjnym | Dlaczego |
|---|---|---|---|
| Parowanie | CPace pisany ręcznie, 8-cyfrowy kod | Noise XX z gotowej biblioteki + porównanie 6 cyfr wyprowadzonych z uzgadniania (jak w Signal i Bluetooth) | nie trzeba własnej implementacji PAKE; atak pośrodku daje inne cyfry |
| Transport | Noise KK pisany w TS i Kotlinie | dojrzała implementacja Noise (np. z libp2p) | mniej miejsc na subtelny błąd kryptograficzny |
| Konflikty | LWW z HLC, przegrana wersja przepada | historia wpisu lub kopia konfliktu | zgubione nowe hasło to poważny błąd w menedżerze haseł |
| Odwołanie urządzenia | tylko usunięcie klucza | w zakresie: zmiana hasła głównego, nowy vaultKey, przeszyfrowanie | bez tego odwołanie nie odcina dostępu do skopiowanych danych |
| Kopia awaryjna | eksport CSV ręcznie | wydrukowany klucz awaryjny + automatyczny, zaszyfrowany eksport | ochrona przed utratą telefonu i komputera jednocześnie |
| Ochrona lokalna | sejf chroniony hasłem głównym | klucze zawinięte w Android Keystore/StrongBox | zgubionego telefonu nie da się łamać offline samym hasłem |
| Weryfikacja | testy i wektory | model zagrożeń, testy fuzz, zewnętrzny przegląd | testy nie zastępują audytu |

**Kwestia samej architektury.** Dla „najlepiej działa” synchronizacja P2P przegrywa z prostym magazynem
zaszyfrowanych blobów (WebDAV, dysk w chmurze): jest zawsze dostępny i nie wymaga, żeby telefon był
włączony w tej samej sieci. Najbezpieczniejsza w praktyce byłaby gotowa, audytowana aplikacja (np.
Bitwarden z własnym Vaultwarden albo KeePassXC). Własny menedżer haseł ma sens przede wszystkim jako
projekt do nauki.
