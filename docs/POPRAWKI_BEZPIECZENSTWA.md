# Poprawki z przeglądu bezpieczeństwa

- Data: 2026-11-01
- Podstawa: [PRZEGLAD_BEZPIECZENSTWA.md](PRZEGLAD_BEZPIECZENSTWA.md) (`main` @ `f5e69e4`)
- Gałąź: `claude/project-thread-6l2990`, start z `main` @ `4cbf7c5`
- Zakres: wszystkie cztery problemy średnie (S1–S4) w kolejności z przeglądu, plus jeden tani niski (N3).

| # | Problem | Co zrobiłem | Commit |
|---|---|---|---|
| S1 | Wtyczka nie blokuje się, gdy jej strona jest otwarta | Każda strona sprawdza termin co 15 s, a service worker ma alarm na termin | `197f7bd` |
| S3 | CA bez ograniczenia nazw, `ca.key` na Pi | CA z `nameConstraints`, tworzone na Ubuntu; skrypt odmawia pracy na Pi | `837b084` |
| S4 | PIN „na dysku” zgadywalny offline | PIN pamiętany po restarcie musi być długi; stare krótkie przenoszone do pamięci | `cd0080b` |
| S2 | Serwer może kasować i cofać wpisy | Treść musi zgadzać się z flagą `deleted`; starsza wersja z serwera jest odrzucana | `62d01c7` |
| N3 | Limit logowań tylko per IP, mapy bez sprzątania | Globalny limit 20 błędów/min i sprzątanie map | `4a3a287` |

---

## S1. Automatyczna blokada wtyczki po 15 minutach

**Pliki:** `extension/src/auto-lock.ts` (nowy), `extension/src/vault-store.ts`, `extension/src/background.ts`,
`extension/src/popup.ts`, `extension/src/views/locked.ts`.

Przedtem termin `unlockedUntil` był sprawdzany tylko przy otwarciu popupu. Teraz są dwa niezależne strażniki,
więc sejf zamyka się niezależnie od tego, czy jakaś strona PassHoldera jest otwarta.

1. **Otwarta strona** (popup albo karta) uruchamia `watchIdle()`:
   - co 15 s (`IDLE_CHECK_INTERVAL_MS`, tyle samo co `LockController` na Androidzie) oraz przy
     `visibilitychange` i `focus` wywołuje `VaultStore.lockIfIdle()`. Zdarzenie widoczności jest potrzebne,
     bo Chrome spowalnia timery w kartach w tle;
   - kliknięcie i klawisz (`pointerdown`, `keydown`, faza przechwytywania) wywołują `noteActivity()`, czyli
     przesuwają termin o 15 minut. Zapis do `storage.session` jest najwyżej co 30 s
     (`ACTIVITY_WRITE_INTERVAL_MS`), żeby pisanie nie zapisywało niczego przy każdym klawiszu;
   - gdy `lockIfIdle()` zablokuje sejf, strona pokazuje ekran blokady z komunikatem.
2. **`VaultStore`:**
   - `requireVault()` i `requireKeys()` rzucają „Sejf jest zablokowany”, gdy termin minął, nawet zanim strona
     zdąży się zablokować. Żadna akcja (kopiowanie, zapis, synchronizacja) nie zadziała po terminie;
   - `lockIfIdle()` czyta termin z `storage.session`, bo popup i karty dzielą klucze. Jeśli inna strona
     przesunęła termin, ta strona go przyjmuje; jeśli inna strona zablokowała sejf (albo zrobił to service
     worker), ta też się blokuje;
   - `noteActivity()` nic nie robi po terminie, więc aktywność nie „wskrzesi” sejfu, który powinien być zamknięty.
3. **Service worker** (`background.ts`) słucha `chrome.storage.session.onChanged` dla klucza `keys` i ustawia
   alarm `auto-lock` na termin (`scheduleAutoLock`). Gdy alarm zadziała, `onAutoLockAlarm` sprawdza termin
   jeszcze raz (mógł się przesunąć) i usuwa klucze z `storage.session` albo ustawia alarm na nowy termin.

**Zachowanie dla użytkownika:** karta zostawiona na noc pokaże ekran blokady najpóźniej ok. 15 s po upływie
15 minut bez kliknięcia (a od razu po przełączeniu na nią). Edytowany, niezapisany wpis przepada przy blokadzie,
tak samo jak na Androidzie.

## S3. CA z ograniczeniem nazw, klucz urzędu poza Pi

**Pliki:** `deploy/make-certs.sh`, `docs/INSTALACJA.md` (1.5, 2.2, „Szyfrowanie dysku”, rozwiązywanie problemów),
`android/core/.../RealServerTest.kt` (nowe wywołanie skryptu).

- **Nowe wywołanie:** `deploy/make-certs.sh <katalog-CA> <katalog-wyjściowy> <nazwy i adresy>…`, uruchamiane
  **na Ubuntu**. `ca.key` zostaje w katalogu CA (`700`/`600`), do katalogu wyjściowego trafiają tylko
  `server.crt`, `server.key` i kopia `ca.crt`, które kopiuje się na Pi. Skrypt odmawia pracy, gdy wykryje
  Raspberry Pi (`/proc/device-tree/model`) albo gdy oba katalogi są tym samym.
- **`nameConstraints`** w CA (krytyczne): nazwy DNS `local` (czyli `*.local`) i `localhost` oraz adresy
  `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10` (Tailscale), `127.0.0.0/8`, `fc00::/7`
  (IPv6 ULA, w tym Tailscale). Inne nazwy DNS można dodać zmienną `PASSHOLDER_CA_DNS` przed utworzeniem CA.
- Po wystawieniu certyfikatu skrypt wykonuje `openssl verify`. Jeśli nazwa wykracza poza ograniczenie, usuwa
  certyfikat i kończy błędem, zamiast zostawić certyfikat, którego Chrome nie przyjmie.
- Stare CA (bez ograniczeń) jest wykrywane i skrypt odmawia jego użycia; INSTALACJA.md ma sekcję „Przejście na
  nowe CA” (nowe CA, usunięcie starego `ca.key` z Pi, wymiana urzędu w Chrome, ponowne parowanie telefonu).

**Sprawdziłem w Chromium (Playwright, wbudowany weryfikator Chrome, CA dodane do NSS jako zaufane):**
certyfikat `passholder.local` z ograniczonego CA działa, certyfikat `bank.pl` z tego samego CA kończy się
`net::ERR_CERT_INVALID`. Dla porównania certyfikat `bank.pl` z CA **bez** ograniczenia został przyjęty. Nie
sprawdzałem tego w Chrome na Ubuntu użytkownika (ten sam silnik weryfikacji, więc zakładam to samo zachowanie).

**Co musisz zrobić:** jednorazowo przejść na nowe CA według INSTALACJA.md 1.5 „Przejście na nowe CA”.
Wymaga to ponownego parowania telefonu, bo zmienia się certyfikat serwera.

## S4. PIN pamiętany po restarcie przeglądarki

**Pliki:** `extension/src/pin-lock.ts`, `pin-store.ts`, `vault-store.ts`, `ui/dom.ts`, `views/pin-settings.ts`,
`views/locked.ts`; `docs/WTYCZKA_PIN.md` (uwaga na górze), INSTALACJA.md („Szyfrowanie dysku”).

Z trzech propozycji przeglądu wybrałem 1 i 3, bez 2:

1. **Długi PIN dla trybu „na dysku”.** Przy „Pamiętaj PIN po zamknięciu przeglądarki” PIN musi mieć 8–64 znaki
   i co najmniej jeden znak, który nie jest cyfrą (`isLongPin`). Krótki PIN 4–6 cyfr działa dalej, ale tylko w
   trybie „w pamięci”. Długi PIN wolno też ustawić w trybie „w pamięci”. Pole PIN zmienia etykietę, klawiaturę
   (`inputmode`) i limit długości po zaznaczeniu opcji.
2. **Migracja:** krótki PIN zapisany na dysku przez starszą wersję nadal otwiera sejf, ale po pierwszym udanym
   odblokowaniu `PinStore.unlock` przenosi go do `storage.session` i usuwa z dysku (`movedToMemory`). Użytkownik
   widzi komunikat, że PIN działa do zamknięcia przeglądarki, a do zapamiętania potrzebny jest dłuższy.
3. **Szyfrowanie dysku:** nowa sekcja w INSTALACJA.md zaleca LUKS (tam leży też `ca.key` z S3).

**Dlaczego nie cięższy Argon2id (propozycja 2):** zmierzyłem `@noble/hashes` (czysty JS, ten sam co we wtyczce)
w Node 22 w kontenerze: 64 MiB/t=3 to 1,3 s, 128 MiB 2,6 s, 256 MiB 5,2 s na jedno odblokowanie. Napastnik z
natywną implementacją płaci tylko 2–4 razy więcej, a użytkownik czeka 2–4 razy dłużej przy każdym odblokowaniu.
Wymaganie długiego PIN-u zwiększa koszt zgadywania o wiele rzędów wielkości (8 znaków z literami i cyframi to
ok. 2,8·10¹² możliwości zamiast 10⁶) bez spowalniania odblokowania.

## S2. Integralność synchronizacji

**Pliki:** `core/src/vault.ts`, `core/src/sync.ts`, `android/core/.../Vault.kt`, `android/core/.../Sync.kt`,
`docs/SPEC.md` §4–5.

Przegląd proponował zmianę formatu (pole `kind` albo `deleted` w AAD) z migracją. Wybrałem rozwiązanie **bez
zmiany formatu**, bo daje tę samą ochronę i nie wymaga migracji danych na Pi ani na klientach:

1. **Treść musi zgadzać się z flagą `deleted`.** Nagrobek od początku szyfruje wyłącznie `{"modifiedAt":…}`,
   a żywy wpis zawsze ma `name`, `username`, `password`. Te dwa kształty się wykluczają, więc odszyfrowana treść
   sama mówi, czym jest rekord. `parseTombstoneData` (TS) i `decryptRecord` (Kotlin) przyjmują nagrobek tylko,
   gdy treść ma **jedynie** pole `modifiedAt`. Dla żywego wpisu wymagane są pola wpisu (tak było już wcześniej).
   Serwer, który ustawi `deleted: true` przy zwykłym wpisie (albo odwrotnie), dostaje błąd `INCONSISTENT_RECORD`
   i synchronizacja zostaje przerwana.
2. **Wszystko jest sprawdzane przed zmianą czegokolwiek.** `applySyncResponse`/`applyResponse` najpierw
   odszyfrowuje i sprawdza wszystkie rekordy z odpowiedzi, a dopiero potem zmienia lokalny sejf. Zły rekord
   zostawia sejf dokładnie takim, jaki był (wcześniej część zmian mogła już zostać naniesiona w pamięci).
3. **Ochrona przed cofaniem.** Reguła „ostatni zapis wygrywa” dotyczy teraz każdego rekordu, nie tylko lokalnych
   zmian: jeśli lokalny wpis ma nowszy `modifiedAt` niż wersja z serwera, wygrywa lokalny, staje się `dirty` i
   wraca na serwer. Serwer nie podsunie więc starego szyfrogramu (np. sprzed zmiany hasła) pod nowym numerem
   rewizji urządzeniu, które ma nowszą wersję, a uczciwy serwer zostaje przy okazji naprawiony.

**Zgodność:** format szyfrogramów i protokół są bez zmian, więc dane na Pi i na urządzeniach działają dalej, a
klient jeszcze nieaktualizowany (np. telefon) synchronizuje się z zaktualizowanym. Nowe wektory testowe nie były
potrzebne; test w Kotlinie sprawdza, że nagrobek i wpis w dokładnie takim JSON-ie jak z rdzenia TS są czytane poprawnie.

**Ograniczenia, które zostają:**

- Urządzenie **bez** lokalnej kopii wpisu (nowe urządzenie, pierwsza synchronizacja) przyjmie starszy szyfrogram,
  bo nie ma z czym porównać. Wymagałoby to podpisanego stanu całego sejfu, czyli większej zmiany protokołu.
- Serwer może **pominąć** rekord (nie wysłać zmiany). Tego klient nie wykryje.
- Reguła opiera się na zegarach urządzeń, jak dotąd (SPEC §5). Edycja z urządzenia z zegarem cofniętym o więcej
  niż czas od poprzedniej edycji przegra z wersją lokalną innego urządzenia. Przy zegarach z NTP (Ubuntu, Android)
  to ułamki sekundy.

## N3. Limit logowań i sprzątanie map na serwerze

**Pliki:** `server/src/app.ts`, `server/test/api.test.ts`.

- Oprócz 5 błędów na minutę na adres IP jest globalny limit 20 błędów na minutę ze wszystkich adresów razem
  (`maxGlobalLoginFailures`). Kilka adresów IPv6 z LAN nie obejdzie już limitu.
- Przy każdym logowaniu `prune()` usuwa wygasłe sesje i adresy bez świeżych błędów, więc mapy nie rosną bez końca.
- Skutek uboczny (świadomy): gdy ktoś w LAN celowo zrobi 20 błędnych prób, prawdziwe logowanie poczeka do minuty.

## Czego nie zrobiłem z niskich i informacyjnych

Zrobiony jest tylko N3, bo był tani i ograniczony do serwera. Pozostałe wymagają decyzji albo większej pracy:
N1 (blokada przy wyłączeniu ekranu Androida), N2 (CSV injection: ostrzeżenie w dokumentacji lub prefiks),
N4 (token w logu), N5 (własny klucz wydania Androida), N6 (skrót hasła w WorkManagerze), N7 (endpoint
wylogowania, zmiana w serwerze i obu klientach), I1–I5. Mogą być osobnym krokiem.

## Testy

| Co | Przed | Po |
|---|---|---|
| `core` (vitest) | 64 | 68 (+4: `malicious-server.test.ts`) |
| `server` (vitest) | 23 | 24 (+1: globalny limit) |
| `extension` (vitest) | 45 | 53 (+6: `auto-lock.test.ts`, +2 w `pin.test.ts`) |
| `android :core:test` | 54 (+1 pominięty) | 58 (+4: `MaliciousServerTest`), także z `PASSHOLDER_SERVER_TEST=1` (prawdziwy serwer Node) |
| `android :app:testDebugUnitTest` | – | patrz opis PR |
| `npm run typecheck` | OK | OK |

Nowe testy S1 i S2 sprawdziłem też „na odwrót”: na kodzie sprzed poprawek padają (4 z 6 testów `auto-lock`,
2 z 4 testów `malicious-server`; pozostałe dotyczą nowych funkcji, których wcześniej nie było).

**Wtyczka w prawdziwym Chromium** (Playwright, zbudowane `extension/dist`):

1. Odblokowanie hasłem, lista wpisów.
2. Termin przesunięty w przeszłość: otwarta karta sama pokazała ekran blokady po ok. 14 s z komunikatem
   „Sejf został zablokowany: 15 minut bez działania albo blokada w innym oknie PassHoldera.”
3. Bez otwartej strony, termin za 2 s: alarm service workera usunął klucze po ok. 2 s.
4. PIN z opcją „Pamiętaj…”: etykieta „PIN (co najmniej 8 znaków, nie same cyfry)”, PIN `1234` odrzucony
   z komunikatem, `kot-1234` przyjęty i zapisany w `storage.local`.

**Skrypt certyfikatów:** nowe CA i certyfikat, odnowienie z tym samym CA (ten sam odcisk CA), odmowa dla
`bank.pl` i `8.8.8.8`, odmowa dla starego CA bez ograniczeń, odmowa dla tego samego katalogu, `PASSHOLDER_CA_DNS`.
