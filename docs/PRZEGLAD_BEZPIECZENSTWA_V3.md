# Przegląd bezpieczeństwa PassHolder po V3

## 1. Nagłówek

- **Data:** 2026-11-15
- **Stan kodu:** `main` @ `8a5b19328d6378d9d2644bb6f7712eb7b45e68fb` (od `b515ca5` z planu doszedł tylko sam plan, PR #49; kod
  bez zmian).
- **Plan i model zagrożeń:** [superpowers/plans/2026-11-15-przeglad-bezpieczenstwa.md](superpowers/plans/2026-11-15-przeglad-bezpieczenstwa.md)
  (napastnicy A1–A9, skala K/W/S/N/I, tropy T1–T17). Punkty zamknięte z sekcji 3 planu (m.in. N2, N5, I3) nie są tu
  zgłaszane ponownie.
- **Metoda:** czytanie kodu etapami 1–10 planu (`core/src`, `extension/src`, `extension/static`, `android/core`,
  `android/app`), przeszukanie wzorców, PoC w katalogu tymczasowym poza repo.
- **Uruchomione:** `npm ci`, `npm test` (rdzeń 637 testów, wtyczka 389, wszystkie zielone), `npm run typecheck`
  (czysto), `npm audit` i `npm audit --omit=dev` (0 podatności), PoC trop T1 na referencyjnym hoście TypeScript.
- **Nie zrobiono:** testów Androida (`gradlew`), prób na prawdziwym telefonie i w prawdziwym Chrome, sprawdzenia
  podatności Gradle (baza OSV niedostępna z kontenera). Szczegóły w punkcie 6.

## 2. Podsumowanie

| Waga | Liczba |
|---|---|
| Krytyczna (K) | 0 |
| Wysoka (W) | 0 |
| Średnia (S) | 4 |
| Niska (N) | 7 |
| Informacyjna (I) | 5 |

Rdzeń kryptograficzny (AES-GCM, Argon2id, CPace, Noise KK, AAD, ścisłe parsery) jest zgodny ze specyfikacją i nie ma
w nim znalezisk powyżej informacyjnych. Nie znalazłem drogi, którą ktoś z sieci, strona WWW, inna aplikacja albo plik
importu odczyta hasła lub `vaultKey` bez udziału użytkownika. Słabe miejsca są na nowych granicach V3: panel
pytania o zapis osadzony w obcej stronie, dopasowanie adresów bez listy sufiksów publicznych, zaufanie Androida do
samej nazwy pakietu przeglądarki i wypełnianie pól, których użytkownik nie widzi. Serwer telefonu da się z sieci
utrzymać włączony i zablokować, ale nie odczytać. Testy automatyczne nie pokrywają żadnego ze znalezisk S.

| ID | Waga | Pewność | Obszar | Problem |
|---|---|---|---|---|
| V3-S1 | S | z kodu | wtyczka, pytanie o zapis | strona może przykryć panel i podsunąć fałszywy login, więc „Zapisz” nadpisze hasło wpisu |
| V3-S2 | S | z kodu | autouzupełnianie, zapis | wpis domeny pasuje do każdej subdomeny; skrót wypełnia bez pytania, zapis z subdomeny zmienia wpis domeny |
| V3-S3 | S | z kodu (hipoteza na telefonie) | Android, autouzupełnianie | zaufana przeglądarka i aplikacja wpisu rozpoznawane tylko po nazwie pakietu |
| V3-S4 | S | z kodu (hipoteza w Chrome) | autouzupełnianie, kontakt i karta | wypełniane są też pola, których użytkownik nie widzi, na dowolnej stronie |
| V3-N1 | N | potwierdzone | serwer telefonu, Noise | powtórzona pierwsza wiadomość Noise zajmuje wszystkie 32 sesje |
| V3-N2 | N | z kodu | serwer telefonu | nieuwierzytelnione żądania (także ze strony WWW) utrzymują tryb Synchronizacja i zajmują serwer |
| V3-N3 | N | z kodu | wtyczka, pytanie o zapis | strona sprawdza po pojawieniu się panelu, czy dany login i hasło są w sejfie |
| V3-N4 | N | z kodu | wtyczka, PIN | równoległe próby PIN-u liczą się jako jedna |
| V3-N5 | N | z kodu | Android, autouzupełnianie | Android 8.0–8.1: brak schematu strony traktowany jak `https`, zapis bez podglądu |
| V3-N6 | N | z kodu | eksport | eksport całego sejfu jawnym tekstem bez ponownego hasła głównego |
| V3-N7 | N | z kodu | łańcuch dostaw | wrapper Gradle bez sumy kontrolnej, brak CI |
| V3-I1 | I | z kodu | dokumentacja | zdania w SPEC, SYNCHRONIZACJA i FUNKCJE niezgodne z kodem |
| V3-I2 | I | z kodu | synchronizacja | wtyczka przyjmuje od telefonu starszą wersję wpisu niż już znana |
| V3-I3 | I | z kodu | wtyczka | „Odłącz” zostawia listę „Nigdy”; skrót schowka to SHA-256 bez klucza |
| V3-I4 | I | z kodu | wtyczka, komunikaty | `fill` i `password-copied` przyjmowane też od skryptów treści |
| V3-I5 | I | z kodu | KDF | parametry KDF czytane z dysku bez sprawdzenia granic |

## 3. Znaleziska

### V3-S1. Strona może przykryć panel pytania o zapis i podsunąć fałszywy login, więc „Zapisz” nadpisze hasło wpisu

- **Waga / pewność:** Średnia / z kodu
- **Napastnik:** A2 · **Obszar:** wtyczka, pytanie o zapis · **Powiązanie:** trop T5
- **Miejsce:** `extension/src/save/watch.ts:39-50` (nasłuch bez `isTrusted`), `watch.ts:65-72` (`show`),
  `extension/src/save/candidates.ts:284-301` (`doAnswer`), `core/src/save/decide.ts:16-23`
- **Opis:** skrypt `save-watch` słucha `submit`, `click` i `keydown` i nie sprawdza `event.isTrusted`, więc
  skrypt strony wywoła zgłoszenie kandydata syntetycznym zdarzeniem z dowolnym loginem i hasłem w polach. Panel to
  ramka w zamkniętym shadow DOM, ale jej element-gospodarz `div[data-passholder-save]` leży w DOM strony: strona
  może mu nadać `opacity: 0`, przesunąć go albo przykryć własnym elementem (ten sam `z-index`, później w DOM).
  Panel nie ma żadnej ochrony przed takim kliknięciem (opóźnienie, sprawdzenie widoczności). „Zapisz” przy decyzji
  `update` zastępuje hasło istniejącego wpisu (`withPassword`) bez kopii starego.
- **Atak:** 1) strona (złośliwa albo przejęta przez XSS) wpisuje w ukryty formularz login użytkownika i własne
  hasło i wysyła syntetyczne `submit`; 2) ustawia przezroczysty panel nad własnym przyciskiem, np. „Dalej”;
  3) użytkownik klika „Dalej”, a trafia w „Zapisz” przy odblokowanym sejfie.
- **Skutek:** hasło wpisu dla tego hosta (i domen nadrzędnych, V3-S2) zostaje nadpisane wartością napastnika i
  rozchodzi się synchronizacją; prawdziwe hasło przepada, jeśli użytkownik go nie pamięta. Napastnik nie odczyta
  w ten sposób żadnego hasła i nie zmieni wpisów innych witryn. W wariancie produkcyjnym waga byłaby wyższa
  (utrata dostępu do konta).
- **Naprawa:** (a) przyjmować tylko zdarzenia z `isTrusted === true`; (b) panel nie jako ramka w stronie, tylko
  odznaka na ikonie wtyczki albo własne okno (`chrome.windows.create`, `type: "popup"`), albo co najmniej blokada
  przycisków na 500 ms po pokazaniu i po każdej zmianie widoczności (`IntersectionObserver` v2 z
  `trackVisibility`); (c) przy `update` pokazać, że hasło zostanie zastąpione, i zachować stare w polu
  „Poprzednie hasło” wpisu. Koszt: średni. Test: zdarzenie `submit` z `isTrusted = false` nie tworzy kandydata.

### V3-S2. Wpis domeny pasuje do każdej subdomeny; skrót wypełnia bez pytania, a zapis z subdomeny zmienia wpis domeny

- **Waga / pewność:** Średnia / z kodu
- **Napastnik:** A2 (strona na subdomenie, którą kontroluje ktoś inny niż właściciel domeny) · **Obszar:**
  autouzupełnianie i pytanie o zapis, wtyczka i Android · **Powiązanie:** trop T6
- **Miejsce:** `core/src/autofill/match.ts:47-49`, `android/core/.../core/autofill/Match.kt:98-100`,
  `extension/src/autofill/fill-tab.ts:83-94` (`onFillCommand`), `extension/src/save/candidates.ts:136-149`
  (`matching` używa `matchLogins` z subdomenami)
- **Opis:** reguła „subdomena” to `page.host.endsWith("." + saved.host)` bez listy sufiksów publicznych (PSL) i bez
  rozróżnienia, kto kontroluje subdomenę. `www.` jest obcinane, więc wpis `https://www.example.com` też pasuje do
  `*.example.com`. Skrót Ctrl+Shift+L wypełnia od razu, gdy pasuje dokładnie jeden login, także jeśli pasuje tylko
  jako subdomena. Pytanie o zapis szuka istniejących loginów tą samą regułą, więc kandydat z `x.example.com`
  aktualizuje wpis `example.com` (w połączeniu z V3-S1).
- **Atak:** 1) użytkownik ma login do serwisu, w którym klienci dostają subdomenę z własną treścią (np. blog
  `ktos.serwis.pl`, gdy logowanie jest na `serwis.pl`); 2) napastnik zakłada stronę z formularzem logowania na
  swojej subdomenie; 3) użytkownik wciska Ctrl+Shift+L albo „Wypełnij” przy „Pasujące do tej strony”.
- **Skutek:** jedno hasło trafia do strony napastnika. Wymaga serwisu z subdomenami klientów i jednej czynności
  użytkownika. W wariancie produkcyjnym: wysoka.
- **Naprawa:** dopasowanie subdomen tylko w obrębie domeny rejestrowalnej z PSL (np. `@noble`-podobna mała
  biblioteka albo wbudowana kopia listy prywatnych sufiksów), a skrót tylko przy dopasowaniu dokładnym; w pytaniu o
  zapis `update` tylko dla dokładnego hosta. To samo w `Match.kt`. Koszt: średni (lista PSL w obu językach).
  Test: wpis `example.com`, strona `x.example.com`, skrót otwiera okienko zamiast wypełniać.

### V3-S3. Android: zaufana przeglądarka i aplikacja wpisu rozpoznawane tylko po nazwie pakietu

- **Waga / pewność:** Średnia / z kodu (zachowanie na telefonie: hipoteza)
- **Napastnik:** A3 · **Obszar:** Android, autouzupełnianie · **Powiązanie:** trop T7
- **Miejsce:** `android/core/.../core/autofill/Match.kt:15-29` (`TRUSTED_BROWSERS`), `Match.kt:127-138` (`matchApp`)
- **Opis:** domena z `AssistStructure` liczy się, gdy pakiet jest na liście przeglądarek; pakiet sprawdzany jest po
  nazwie, bez certyfikatu podpisu. Na Androidzie nazwę pakietu może zająć dowolna aplikacja, jeśli prawdziwej nie
  ma na telefonie (instalacja spoza sklepu). To samo dotyczy listy „Aplikacje” wpisu (`androidApps`).
- **Atak:** 1) użytkownik instaluje spoza sklepu aplikację z pakietem `com.vivaldi.browser` (Vivaldi nie jest
  zainstalowane); 2) aplikacja pokazuje pole logowania z `webDomain = "bank.pl"`; 3) użytkownik wybiera
  podpowiedź.
- **Skutek:** jedno hasło trafia do aplikacji napastnika; wymaga zainstalowania tej aplikacji i wyboru podpowiedzi.
  Dokumentacja (FUNKCJE, Android) obiecuje, że „obca aplikacja nie dostanie loginu banku”. W wariancie
  produkcyjnym: wysoka.
- **Naprawa:** lista przeglądarek jako pary `pakiet → SHA-256 certyfikatu` (sprawdzane przez
  `PackageManager.getPackageInfo(..., GET_SIGNING_CERTIFICATES)` i `hasSigningCertificate`); dla `androidApps`
  zapamiętywać skrót certyfikatu przy przypisaniu aplikacji. Koszt: średni. Test: Robolectric z pakietem
  przeglądarki o innym podpisie nie dostaje loginów po domenie. Sprawdzenie ręczne: aplikacja testowa z pakietem
  nieobecnej przeglądarki.

### V3-S4. Wypełnianie kontaktu i karty trafia też w pola, których użytkownik nie widzi

- **Waga / pewność:** Średnia / z kodu (zachowanie w Chrome: hipoteza)
- **Napastnik:** A2 · **Obszar:** autouzupełnianie kontaktu i karty (wtyczka; Android podobnie) · **Powiązanie:**
  nowe (krok 5.3)
- **Miejsce:** `extension/src/autofill/fill-page.ts:54-70` (`isVisible`), `fill-page.ts:144-149` (`fillPage` dla
  kontaktu i karty wypełnia wszystkie pasujące pola dokumentu), `android/app/.../autofill/ViewNodeReader.kt`
  (`skipSubtree` patrzy tylko na `visibility`)
- **Opis:** `isVisible` odrzuca `display`, `visibility`, `opacity: 0`, pola mniejsze niż 2 px i leżące w lewo lub w górę
  poza stroną. Przechodzą: `clip-path`/`clip`, pole 2–3 px, pole przykryte innym elementem, pole w prawo lub w dół
  w kontenerze `overflow: hidden`, tekst w kolorze tła. Kontakt i karta nie mają sprawdzenia strony (z założenia),
  więc każda strona `https` może tak schować pola.
- **Atak:** 1) sklep-pułapka pokazuje tylko „E-mail do newslettera”; 2) obok ma ukryte pola `tel`, `bday`,
  `street-address`; 3) użytkownik wypełnia e-mail kontaktem z PassHolder.
- **Skutek:** wyciek danych kontaktowych (telefon, adres, data urodzenia) albo CVC karty, gdy użytkownik chciał podać
  mniej. Nie dotyczy loginów (te tylko na swojej stronie). W wariancie produkcyjnym: bez zmian.
- **Naprawa:** przy kontakcie i karcie wypełniać tylko pola w tym samym formularzu co pole, w którym jest kursor (albo
  pierwsze widoczne), a widoczność sprawdzać też przez `document.elementFromPoint` w środku pola i `clip-path`.
  Koszt: mały–średni. Test: pole z `clip-path: inset(50%)` zostaje puste.

### V3-N1. Powtórzona pierwsza wiadomość Noise zajmuje wszystkie 32 sesje

- **Waga / pewność:** Niska / potwierdzone (PoC na `core/src/p2p/host.ts`)
- **Napastnik:** A1 · **Obszar:** serwer telefonu · **Powiązanie:** trop T1
- **Miejsce:** `core/src/p2p/host.ts:90-121` (`#handshake`), `android/core/.../core/p2p/P2pHost.kt:87-128`
- **Opis:** pierwsza wiadomość Noise KK (`e, es, ss`) nie zawiera nic świeżego od telefonu, więc każda kopia przechodzi
  `readMessage` i tworzy nową sesję. Limit 32 sesji jest wspólny dla wszystkich urządzeń.
- **Atak:** 1) napastnik zdobywa jedną pierwszą wiadomość: podsłuch w sieci albo prościej adres na liście wtyczki,
  który nie jest już telefonem (stary adres z DHCP, wpisany ręcznie); wtyczka wysyła tam `deviceId` i wiadomość, bo
  `pickPhone` wybiera pierwszy adres, który odpowie na `/ping`; 2) wysyła ją 32 razy do telefonu co 60 s.
- **Skutek:** prawdziwa wtyczka dostaje 503 `too many sessions`, dopóki trwa atak; razem z V3-N2 tryb się przy tym
  nie wyłącza. Sesji napastnik nie użyje (nie zna klucza efemerycznego). PoC: 32 powtórzenia → 32 × 200, prawdziwe
  uzgadnianie → 503.
- **Naprawa:** limit sesji na urządzenie (np. 2) i pamięć skrótów `e` z ostatnich 60 s (powtórzenie → 400). Koszt:
  mały, w TS i Kotlinie. Test: ta sama wiadomość drugi raz → 400; 32 sesje jednego urządzenia nie blokują drugiego.
- **Stan (2026-11-15, grupa 4):** poprawione w `host.ts` i `P2pHost.kt`. Limit 4 sesji na urządzenie (2 to za mało,
  gdy wtyczka po zerwanym połączeniu ponawia, a stara sesja żyje jeszcze 60 s). Pamięć `e` dłuższa niż w propozycji:
  do 4096 przyjętych wiadomości przez cały start trybu, bo przy 60 s napastnik mógłby co minutę odnawiać jedną sesję.
  Opis: [SYNCHRONIZACJA.md](SYNCHRONIZACJA.md#51-noise-po-http) punkt 5.1 („Powtórzenia uzgadniania”); test ręczny T27.

### V3-N2. Nieuwierzytelnione żądania utrzymują tryb Synchronizacja i zajmują serwer

- **Waga / pewność:** Niska / z kodu
- **Napastnik:** A1, A2 · **Obszar:** serwer telefonu · **Powiązanie:** tropy T3, T4
- **Miejsce:** `android/core/.../core/p2p/PhoneRouter.kt:38-41` (`onRequest()` przed jakimkolwiek
  uwierzytelnieniem), `SyncHttpServer.kt:64` (`InetSocketAddress(port)`), `SyncHttpServer.kt:196-228` (brak
  sprawdzenia `Content-Type` i `Origin`), `LocalAddresses.kt:15`
- **Opis:** każde żądanie na znaną ścieżkę, także `/p2p/v1/ping` bez uwierzytelnienia, przesuwa licznik
  bezczynności, więc 5-minutowe wyłączenie nie działa, dopóki ktoś pinguje. Serwer obsługuje 4 połączenia naraz i 16 w
  kolejce, każde do 15 s. Strona WWW w przeglądarce użytkownika może wysłać prosty `POST` (`no-cors`,
  `text/plain`) pod `http://<IP>:8787`, a serwer go przyjmie: `Host` jest literałem IP, typ treści i `Origin` nie są
  sprawdzane (ograniczenie tylko po stronie Chrome: Local Network Access, nie testowane). Serwer słucha na
  wszystkich interfejsach, także w sieci komórkowej i publicznym Wi-Fi, i podaje wtyczce adres z interfejsu
  komórkowego.
- **Atak:** ktoś w tym samym Wi-Fi (albo strona, która zgadła IP) wysyła `/p2p/v1/ping` co minutę i 20 wolnych połączeń
  co 15 s.
- **Skutek:** tryb nie gaśnie sam (gaśnie po wyjściu z aplikacji i przyciskiem), synchronizacja nie przechodzi.
  Nic nie wycieka. Dokumentacja (SYNCHRONIZACJA §6.1) twierdzi, że „skaner w sieci nie utrzyma trybu przy życiu”:
  to prawda tylko dla nieznanych ścieżek.
- **Naprawa:** liczyć aktywność dopiero po udanym `/p2p/v2/sync`, `/file` albo `/pair/finish`; odrzucać żądania z
  nagłówkiem `Origin` innym niż `chrome-extension://…` i bez `Content-Type: application/json` (wtyczka je wysyła);
  wiązać gniazdo tylko z adresami Wi-Fi i Tailscale (bez interfejsu komórkowego). Koszt: mały. Test: ping co
  minutę nie zatrzymuje wyłączenia po 5 min.
- **Stan (2026-11-15, grupa 4):** poprawione. Aktywność = 200 na sync, plik, `pair/finish` i „Dodaj wtyczkę”
  (`PhoneRouter`, `SyncController`); 403 dla `Origin` spoza `chrome-extension://`, 415 bez `application/json`
  (`SyncHttpServer`). Decyzja właściciela: tylko Wi-Fi i Tailscale. Zamiast wiązania gniazda z adresami (zmieniają się
  w trakcie) serwer zamyka bez odpowiedzi połączenie przyjęte na niedozwolonym adresie lokalnym i nie podaje go
  wtyczce (`SyncNetworks.kt`, Ethernet też dozwolony). W sieci komórkowej port nadal kończy uzgadnianie TCP. Test ręczny T27.

### V3-N3. Strona sprawdza po pojawieniu się panelu, czy dany login i hasło są w sejfie

- **Waga / pewność:** Niska / z kodu
- **Napastnik:** A2 (strona pasująca do wpisu, także przez subdomenę z V3-S2) · **Obszar:** pytanie o zapis ·
  **Powiązanie:** trop T5 (e)
- **Miejsce:** `extension/src/save/candidates.ts:189` (decyzja `none` → brak panelu), `watch.ts:65-72`
- **Opis:** przy odblokowanym sejfie decyzja `none` (to samo hasło już zapisane) nie pokazuje panelu, `create` i
  `update` pokazują. Element-gospodarz panelu pojawia się w DOM strony, więc strona to widzi (`MutationObserver`).
  Kandydata tworzy syntetyczne zdarzenie (V3-S1) bez wiedzy użytkownika; panel strona może ukryć stylem.
- **Skutek:** strona po cichu sprawdza dowolnie wiele haseł (np. z wycieku) dla loginu i ustala, czy login jest
  zapisany (`update` kontra `create`, oba widoczne tak samo, ale `none` odróżnia trafienie). Nie odczyta hasła
  losowego.
- **Naprawa:** ta sama co V3-S1 (a) (`isTrusted`); dodatkowo jeden kandydat na kartę na minutę. Koszt: mały.

### V3-N4. Równoległe próby PIN-u liczą się jako jedna

- **Waga / pewność:** Niska / z kodu
- **Napastnik:** A6 · **Obszar:** wtyczka, PIN · **Powiązanie:** regresja S4 (krok 4.4)
- **Miejsce:** `extension/src/pin-store.ts:74-86` (`unlock`: odczyt, zapis `failedAttempts + 1`, potem Argon2id)
- **Opis:** licznik jest zapisywany przed sprawdzeniem, ale odczyt i zapis nie są atomowe między stronami. Kilka kart
  `popup.html` czyta ten sam `failedAttempts` i każda zapisuje `n + 1`, więc N równoległych prób zużywa jedną.
- **Skutek:** więcej niż 5 prób PIN-u przez interfejs. Mały zysk: kto ma narzędzia deweloperskie wtyczki, i tak
  odczyta `PinLock` z `storage.session` i sprawdzi krótki PIN offline (zaakceptowane ograniczenie).
- **Naprawa:** próby PIN-u w service workerze, kolejno (jak `SaveCandidates.serial`). Koszt: mały.

### V3-N5. Android 8.0–8.1: brak schematu strony traktowany jak `https`, zapis bez podglądu

- **Waga / pewność:** Niska / z kodu
- **Napastnik:** A1 (strona `http` podmieniona w sieci) · **Obszar:** Android, autouzupełnianie · **Powiązanie:** trop T8
- **Miejsce:** `android/core/.../core/autofill/Match.kt:130` (`webScheme ?: "https"`), `Planner.kt:55-59`
  (`cardAllowed` przy `scheme == null`), `android/app/.../autofill/ViewNodeReader.kt` (schemat czytany od API 28),
  `PassHolderAutofillService.kt:111-120` (8.x zapisuje bez ekranu podglądu)
- **Opis:** na Androidzie 8.0–8.1 (i w przeglądarce, która nie podaje schematu) strona `http://bank.pl` dostaje
  loginy zapisane dla `https://bank.pl` i karty. Tam też zapis aktualizuje hasło istniejącego wpisu po samym
  systemowym „Zapisz”, bez pokazania, co się zmieni.
- **Skutek:** hasło lub karta w formularzu strony `http`, gdy ktoś w sieci podmieni stronę i użytkownik wybierze
  podpowiedź. `minSdk = 26`, ale telefon właściciela ma nowszy Android, więc dziś praktycznie bez znaczenia.
- **Naprawa:** brak schematu = `http` dla dopasowania `https` i dla kart (albo `minSdk = 28`). Koszt: mały.

### V3-N6. Eksport całego sejfu jawnym tekstem bez ponownego hasła głównego

- **Waga / pewność:** Niska / z kodu
- **Napastnik:** A6 przy odblokowanym sejfie · **Obszar:** import i eksport · **Powiązanie:** trop T15
- **Miejsce:** `extension/src/views/transfer.ts:61-73`, `android/app/.../ui/TransferScreen.kt` (pole „Rozumiem”)
- **Opis:** wystarczy zaznaczyć pole i kliknąć „Pobierz plik”.
- **Skutek:** kto ma chwilę przy odblokowanym sejfie, wynosi wszystko jednym plikiem zamiast przepisywać wpisy.
- **Naprawa:** hasło główne (albo odcisk na telefonie) przed eksportem. Koszt: mały. **Decyzja właściciela.**

### V3-N7. Wrapper Gradle bez sumy kontrolnej, brak CI

- **Waga / pewność:** Niska / z kodu
- **Napastnik:** A9 · **Obszar:** budowanie · **Powiązanie:** trop T17
- **Miejsce:** `android/gradle/wrapper/gradle-wrapper.properties` (brak `distributionSha256Sum`),
  `android/gradle/wrapper/gradle-wrapper.jar` w repo, brak `.github/workflows`
- **Opis:** pobrana dystrybucja Gradle nie jest sprawdzana sumą; poprawność `gradle-wrapper.jar` nie jest
  sprawdzana. Testy nie są wymuszane przed scaleniem.
- **Naprawa:** `distributionSha256Sum` dla 8.14.3 (z gradle.org), opcjonalnie workflow z `gradle/actions/wrapper-validation`
  i `npm test`. Koszt: mały.

### V3-I1. Zdania w dokumentacji niezgodne z kodem

- **Waga / pewność:** Informacyjna / z kodu · **Obszar:** dokumentacja · **Powiązanie:** krok 10.1
- `SPEC.md` §8 wymienia autouzupełnianie jako poza zakresem, a jest w obu aplikacjach.
- `SYNCHRONIZACJA.md` §6.1: „skaner w sieci nie utrzyma trybu przy życiu” (zob. V3-N2).
- `FUNKCJE.md`, Autouzupełnianie, Android: „obca aplikacja nie dostanie loginu banku” (zob. V3-S3); Chrome: „Pomija
  też pola niewidoczne” (częściowo, zob. V3-S4).
- `FUNKCJE.md`, PIN: „PIN to 4-6 cyfr”, a w pamięci działa też długi PIN.
- Plan przeglądu (krok 1.5) mówi o „HMAC schowka” we wtyczce; wtyczka liczy SHA-256 (HMAC jest tylko na Androidzie,
  zob. V3-I3).
- **Naprawa:** poprawić zdania razem z poprawkami odpowiednich punktów.

### V3-I2. Wtyczka przyjmuje od telefonu starszą wersję wpisu niż już znana

- **Waga / pewność:** Informacyjna / z kodu · **Napastnik:** A8 · **Powiązanie:** krok 3.3
- **Miejsce:** `core/src/p2p/sync.ts:171-217` (`applyResponse`: niezmieniony lokalnie wpis jest zastępowany bez
  porównania HLC)
- **Opis:** host może podać pod nową rewizją stary szyfrogram tego samego `id` (stare hasło, usunięty wpis znowu
  żywy), a wtyczka go przyjmie. Wymaga kontroli nad danymi telefonu (root albo kopia), więc poza modelem;
  zaakceptowane ograniczenie „cofnięcie wykrywane częściowo” obejmuje tylko cały magazyn.
- **Naprawa (utwardzenie):** odrzucić rekord z HLC mniejszym niż znany dla tego `id` (przy poprawnym działaniu HLC
  na hoście tylko rośnie). Koszt: mały.

### V3-I3. „Odłącz” zostawia listę „Nigdy”; skrót schowka to SHA-256 bez klucza

- **Waga / pewność:** Informacyjna / z kodu · **Powiązanie:** kroki 4.7, 4.8
- **Miejsce:** `extension/src/vault-store.ts:924-942` (`disconnect`), `extension/src/ui/copy.ts:14`
- **Opis:** po „Odłącz tę przeglądarkę” zostają `saveNever` (lista hostów) w `local` i kandydaci zapisu (do 2 min) w
  `session`. Wtyczka trzyma w `session` (pamięć) zwykły SHA-256 skopiowanego hasła; Android po N6 używa HMAC z
  kluczem procesu.
- **Naprawa:** kasować `saveNever` i `saveCandidates` przy odłączeniu (albo zapytać); HMAC jak na Androidzie. Koszt: mały.

### V3-I4. Komunikaty `fill` i `password-copied` przyjmowane też od skryptów treści

- **Waga / pewność:** Informacyjna / z kodu · **Powiązanie:** trop T9
- **Miejsce:** `extension/src/background.ts:13-33`, `extension/src/autofill/fill-tab.ts:57` (`resume()` przedłuża sesję)
- **Opis:** `fill` sprawdza tylko `sender.id`, `password-copied` nic. Wysłać je może tylko kod wtyczki (strona WWW
  nie ma dostępu do `chrome.runtime`), więc skutek ma tylko przejęty proces strony (poza modelem): wypełnienie
  wpisu o znanym `id` i przedłużenie odblokowania (`resume` z `touch`).
- **Naprawa (utwardzenie):** przyjmować `fill` tylko, gdy `sender.url` jest stroną wtyczki; `password-copied` tak samo.
  Koszt: mały.

### V3-I5. Parametry KDF czytane z dysku bez sprawdzenia granic

- **Waga / pewność:** Informacyjna / z kodu · **Powiązanie:** krok 1.4
- **Miejsce:** `extension/src/vault-store.ts:831` (`unlock` z `account.kdf`), `extension/src/pin-lock.ts:75`
  (`openPinLock` z `lock.kdf`), `android/core/.../p2p/HostState.kt` (`host.json`)
- **Opis:** granice `MIN_KDF`/`MAX_KDF` są sprawdzane przy danych z sieci, ale nie przy odczycie z dysku. Ktoś z prawem
  zapisu do profilu może osłabić KDF albo zawiesić odblokowanie (1 GiB × 100), tylko że z takim prawem ma też
  prostsze ataki.
- **Naprawa:** `assertKdfParamsAcceptable` także przy odczycie. Koszt: mały.

## 4. Tropy odrzucone

| T# | Dlaczego nie jest problemem |
|---|---|
| T2 | Każda jawna odpowiedź inna niż 200 kończy się tylko komunikatem (`phone-client.ts:31-46`, `callP2pHost`); zmiana epoki, adresy i rewizje przychodzą wyłącznie w zaszyfrowanych ramkach (`sync.ts:259-266`). Podrobione 403 pokazuje „Sparuj ponownie”, ale ponowne parowanie wymaga kodu z ekranu telefonu. |
| T9 | Opisane jako utwardzenie V3-I4: nadawcą może być tylko kod wtyczki, a strona WWW nie dosięga `chrome.runtime` (brak `externally_connectable`). |
| T10 | Logi zawierają wyjątki z parsowania danych już uwierzytelnionych AES-GCM i serializowanych przez same aplikacje; parsery wpisów rzucają stałe komunikaty (`Invalid entry payload`). Nie znalazłem ścieżki, na której tekst wyjątku zawiera odszyfrowaną treść. |
| T11 | `unlockPendingIntent` ma jawny komponent, a aktywność `exported="false"`; intencję wypełnia tylko system (`AssistStructure`), który sam ją dostarcza. Inna aplikacja nie uruchomi tej aktywności ani nie zmieni celu. |
| T12 | `Dialog`, `AlertDialog` i `DropdownMenu` w Compose mają domyślnie `SecureFlagPolicy.Inherit`, czyli dziedziczą `FLAG_SECURE` okna; w kodzie nie ma `SecureOff`. |
| T13 | Limit prób w interfejsie nic nie daje: `kdf` i `wrappedVaultKey` są na dysku obu urządzeń, więc zgadywanie i tak odbywa się offline; chroni koszt Argon2id i reguły hasła (`MasterPasswordRules`). |
| T14 | `downloadFile` tworzy `<a download>`, więc Chrome pobiera plik, a nie otwiera go; adres `blob:` jest nieznany innym stronom i żyje 60 s. Nazwa pliku nie zawiera `/`, `\` ani znaków sterujących (`isAttachmentName`), a Chrome i tak ją oczyszcza. |
| T16 | Różna interpretacja tego samego ZIP (katalog centralny kontra nagłówki lokalne) nie przekracza żadnej granicy zaufania: import trafia do własnego sejfu, a obie strony sprawdzają CRC, rozmiary i limity. Najwyżej inny zestaw wpisów po imporcie na różnych urządzeniach. |

T1 → V3-N1, T3 i T4 → V3-N2, T5 → V3-S1 i V3-N3, T6 → V3-S2, T7 → V3-S3, T8 → V3-N5, T15 → V3-N6, T17 → V3-N7.

## 5. Sprawdzone i w porządku

**Etap 1, kryptografia:**
- Wszędzie CSPRNG (`crypto.getRandomValues`, `SecureRandom`); brak `Math.random` i `java.util.Random`. Parametry `nonce`,
  `ya`, `fixed` używane tylko w wektorach.
- AES-GCM: losowy nonce 96 bitów, bajt wersji i długość sprawdzane przed odszyfrowaniem, Web Crypto i JCA zwracają
  treść dopiero po sprawdzeniu tagu. Liczba szyfrowań pod jednym kluczem daleko od 2³².
- Każdy kontekst z SPEC §3 ma własne AAD (wpis z `id`, kawałek z `id/i/n`, parowanie z rodzajem i rolą), `keyCheck`
  to HMAC z własnym `info`; `keyCheck` nie ułatwia zgadywania hasła (wymaga `vaultKey`). Porównania w stałym
  czasie (`MessageDigest.isEqual`).
- Ścisłe parsery: dokładny zbiór kluczy (`__proto__` z `JSON.parse` jest zwykłym własnym kluczem i odpada), typy,
  `v = 3`; jedyna znana różnica TS/Kotlin (`3.0`) opisana w SPEC. `safeLong` w Kotlinie chroni przed ogromnymi
  wykładnikami.
- Pliki: AAD kawałka, liczba kawałków, `size` przed złożeniem i `sha256` całości; klucz pliku zawsze nowy
  (`encryptFile`). Generator: odrzucanie przy losowaniu, Fisher–Yates, co najmniej jeden znak z grupy.

**Etap 2, parowanie i Noise:**
- CPace zgodny z draft-21: `generator_string` z dopełnieniem, odrzucenie elementu neutralnego i nieudanego
  dekodowania, `lvSplit` bez nadmiarowych bajtów, transkrypt z rolami; Kotlin to samo.
- Kod: 8 cyfr bez przewagi (bajty ≥ 250 odrzucane), jedna próba (`consumed` przed CPace), 2 min, `finish` jednorazowy
  i 30 s; `/start` z innym `sid` nie zużywa kodu, a wszystkie metody `PairingHost` są `@Synchronized`.
- `vaultInfo` wychodzi z telefonu dopiero po otwarciu `identity` kluczem z CPace, czyli po dowodzie znajomości kodu.
- Noise KK: kolejność tokenów, prolog, `split`, licznik nonce z granicą; Kotlin odrzuca zerowy wynik X25519.
- Sesja jednorazowa, 60 s, ponowne sprawdzenie urządzenia i klucza przy `/sync` i `/file` (zmiana hasła i „Usuń”
  odcinają otwarte sesje). Serwer HTTP: ścisły parser, limity, `Host` tylko IPv4 (DNS rebinding), `stop()` zamyka
  gniazdo nasłuchujące.

**Etap 3, synchronizacja i pliki:**
- Walidacja żądania przed zapisem, limity `id`, bloba, liczby zmian; `id` pliku to UUID v4, `index` liczba, więc
  `DiskFileStore` nie wyjdzie poza katalog. Zapisy atomowe (`.tmp`, `fsync`, `ATOMIC_MOVE`).
- Epoka i cofnięcie rewizji resetują wtyczkę; zmiana epoki przychodzi tylko w zaszyfrowanej odpowiedzi.
- HLC: wartość z dalekiej przyszłości nie psuje porządku (kolejne zmiany ją obserwują), granice do 2⁵³−1 sprawdzane.
- Sparowane urządzenie (A7) może zapełnić dysk do progu 50 MB albo zatruć kawałek pliku, ale i tak może usunąć
  każdy wpis: nie ma tu nic ponad założenie.

**Etap 4, wtyczka:**
- Mapa sekretów: `keys` (`vaultKey`, termin) i `pendingPairing` (prywatny klucz statyczny, `vaultInfo`) tylko w
  `session` (bez `setAccessLevel`, skrypty treści nie mają dostępu); `accountV2` w `local` jawnie bez sekretów poza
  `wrappedVaultKey` i `sealedStaticKey` (zapieczętowany `vaultKey`); sejf zaszyfrowany (`passholder/v2/local-vault`).
- Auto-blokada: `fillTab`, `SaveCandidates` i odczyty z tła używają `resume`, które sprawdza termin; ścieżki
  wywoływane przez stronę WWW (`save-candidate`, `save-info`, `save-preview`) mają `touch: false`.
- `repair`: hasło znane wtyczce sprawdzane przed siecią, sejf telefonu przyjmowany tylko przy tym samym `vaultKey`
  albo po otwarciu `sealedStaticKey`; nic nie jest zapisywane przed weryfikacją; PIN wyłączany przy zmianie
  `wrappedVaultKey`.
- DOM: wszystko przez `h()` z `textContent`/`append`, brak `innerHTML`; jedyny `href` to adres `blob:` pobierania.

**Etap 5, wtyczka a strony:**
- Manifest: bez `externally_connectable`, domyślne CSP MV3, `web_accessible_resources` tylko panel z
  `use_dynamic_url`; zgoda na telefon to pojedynczy origin `http://<IP>:8787/*`.
- Autouzupełnianie: adres karty z `tabs.get`, origin przypięty przy wstrzyknięciu, tylko ramki z tym samym origin co
  góra, karta tylko `https`, do strony trafia tylko `FillPlan` jednego wpisu.
- Pytanie o zapis: komunikaty panelu (`save-info`, `save-answer`, `save-preview`) tylko od stron wtyczki;
  kandydat z ramki o innym origin niż karta odrzucany; host w panelu jako punycode (`URL.hostname`).

**Etap 6, Android:**
- `allowBackup=false` i reguły ekstrakcji, `cleartextTrafficPermitted=false`, eksportowane tylko `MainActivity` i usługa
  z `BIND_AUTOFILL_SERVICE`; `FLAG_SECURE` w obu aktywnościach (okna Compose dziedziczą).
- Odcisk: klucz z `setUserAuthenticationRequired(true)`, `setInvalidatedByBiometricEnrollment(true)`,
  `BIOMETRIC_STRONG`, `CryptoObject` naprawdę odszyfrowuje `vaultKey`, wynik sprawdzany `keyCheck`.
- Zmiana hasła: stare hasło sprawdzane ponownie, zapis `host.json` atomowy, urządzenia usunięte, oferta parowania
  anulowana, odcisk wyłączony; `MasterPasswordRules` przy nowym sejfie i zmianie hasła (wtyczka hasła nie tworzy).
- Hasła w ekranach przez `remember`, nie `rememberSaveable`; `lock()` zeruje `vaultKey` i czyści stan ekranów.

**Etap 7, Android autouzupełnianie:**
- Usługa nie trzyma wpisów między żądaniami; ten sam pakiet PassHolder nie dostaje podpowiedzi; blokada D1
  (`leaveLock.expired()`) przed każdą odpowiedzią i po każdej ścieżce wyjścia z ekranu odblokowania.
- Zapis od Androida 9 zawsze przez ekran podglądu; kandydat tylko w pamięci, nie w intencji (`FLAG_IMMUTABLE`).

**Etap 8, import i eksport:**
- ZIP: ZIP64, szyfrowanie, metody, liczba pozycji, CRC i rozmiar odrzucane; licznik podczas inflate (zip-bomb); ścieżka
  z archiwum nigdy nie trafia do systemu plików. Import nie nadpisuje ani nie usuwa (duplikaty pomijane).
- Załączniki: rozmiar sprawdzany przed wczytaniem (Android czyta najwyżej limit + 1 bajt i zeruje bufory).

**Etap 9, zależności i repo:**
- `npm audit`: 0; produkcyjne zależności tylko `@noble/curves` i `@noble/hashes`; `package-lock.json` tylko z
  `registry.npmjs.org` z sumami `integrity`; paczka wtyczki nie ładuje zdalnego kodu.
- Repozytoria Gradle tylko `google()`, `mavenCentral()` (i `gradlePluginPortal()` dla wtyczek); `FAIL_ON_PROJECT_REPOS`.
- Historia git: bez kluczy i haseł (tylko hasła testowe), `.gitignore` obejmuje `keystore.properties`, `*.jks`, `.env`.
  Wydanie: R8 włączony, bez `debuggable`.

## 6. Nie sprawdzono

- **Prawdziwy telefon:** V3-S3 i V3-N5 (zachowanie systemu autouzupełniania), czy serwer faktycznie odpowiada w sieci
  komórkowej (V3-N2), testy Androida z `gradlew` (niepotrzebne do znalezisk, kod czytany).
- **Prawdziwy Chrome:** V3-S1 i V3-S4 (przykrycie panelu, widoczność pól), czy Local Network Access blokuje proste
  `POST` ze strony do telefonu (V3-N2, trop T4).
- **Podatności Gradle:** baza OSV niedostępna z kontenera (403). Do uruchomienia na Windows, jak w
  [TESTY.md](TESTY.md#zależności-przegląd-bezpieczeństwa-i5), dla wersji z `android/gradle/libs.versions.toml`
  (m.in. Bouncy Castle 1.82, kotlinx-serialization 1.9.0, biometric 1.1.0).
- **Testy ręczne** T4, T7, T15, T17–T25 z TESTY.md nadal niepotwierdzone (T27 doszedł z poprawkami grupy 4).
- Formalny audyt CPace i Noise (poza zakresem, jak w planie).

## 7. Proponowane grupy poprawek

Każda grupa to jeden wątek i jeden PR, w tej kolejności:

1. **Pytanie o zapis i wypełnianie we wtyczce:** V3-S1, V3-N3, V3-S4, V3-I4 (`isTrusted`, ochrona panelu, widoczność
   pól, nadawca `fill`). **Zrobione** (2026-11-15), zob. „Stan poprawek” niżej.
2. **Dopasowanie adresów:** V3-S2 i V3-N5 (lista sufiksów publicznych w TS i Kotlinie, skrót tylko przy dokładnym
   dopasowaniu, brak schematu = `http`).
3. **Zaufane przeglądarki na Androidzie:** V3-S3 (certyfikaty podpisu).
4. **Serwer telefonu:** V3-N1, V3-N2 (limit sesji na urządzenie, odrzucenie powtórzeń, aktywność po uwierzytelnieniu,
   `Origin`/`Content-Type`, interfejsy).
5. **Drobne:** V3-N4, V3-N6, V3-N7, V3-I1, V3-I2, V3-I3, V3-I5.

**Decyzje właściciela** (naprawa zmienia zachowanie):

- V3-S1: panel w stronie z ochroną przed kliknięciem albo zamiana na odznakę i okienko wtyczki. **Decyzja
  (2026-11-15): osobne okno wtyczki i odznaka.**
- V3-S2: subdomeny tylko w domenie rejestrowalnej i skrót tylko dla dokładnego hosta (mniej podpowiedzi niż dziś).
  **Decyzja: tak (lista sufiksów publicznych, skrót tylko dla dokładnego hosta).**
- V3-N2: czy telefon ma odpowiadać w sieci komórkowej (dziś tak). **Decyzja: nie, tylko Wi-Fi i Tailscale.**
- V3-N6: hasło główne przed eksportem. **Decyzja: zawsze hasło główne (wtyczka i telefon, bez odcisku).**

### Stan poprawek

- **Grupa 1 (V3-S1, V3-N3, V3-S4, V3-I4), 2026-11-15:**
  - V3-S1: skrypt liczy tylko zdarzenia użytkownika (`isTrusted`; `submit` dodatkowo z aktywacją użytkownika, bo
    Chrome oznacza jako zaufany także `submit` z `form.requestSubmit()` skryptu, sprawdzone w Chromium); pytanie
    w osobnym oknie wtyczki (`chrome.windows.create`, `type: "popup"`) z odznaką „?” zamiast ramki w stronie;
    `save-prompt.html` usunięte z `web_accessible_resources`; przy zmianie hasła stare trafia do ukrytego pola
    własnego „Poprzednie hasło” (TS i Kotlin, tylko ostatnie), a okno o tym mówi. Zostaje: strona może wysłać
    formularz skryptem w ciągu kilku sekund po dowolnym kliknięciu użytkownika; zapis i tak wymaga **Zapisz**
    w osobnym oknie.
  - V3-N3: skrypt strony nie tworzy kandydata, a okna nie widać w DOM. Zostaje: otwarcie okna zabiera stronie
    fokus (`blur`), ale każda próba wymaga prawdziwego wysłania formularza przez użytkownika. Limitu „jeden
    kandydat na minutę” nie dodałem: blokowałby poprawkę literówki w haśle zaraz po złym logowaniu.
  - V3-S4: kontakt i karta tylko w formularzu pola z kursorem (bez kursora: pierwszego pasującego pola) i tylko w
    polach bez `clip-path`/`clip`, co najmniej 10 × 10 px, nieuciętych przez `overflow` rodzica i
    nieprzykrytych (`elementFromPoint`; etykieta pola nad nim się nie liczy). Sprawdzone w Chromium. Android
    (`ViewNodeReader`, wspomniany w raporcie jako „podobnie”) bez zmian: poza grupą 1, do osobnego wątku.
  - V3-I4: `fill` i `password-copied` tylko ze stron wtyczki (`sender.url` `chrome-extension://<id>/`).

