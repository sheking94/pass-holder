# PassHolder: przegląd bezpieczeństwa

> Dokument historyczny: dotyczy wersji z serwerem na Raspberry Pi (przed planem 4).

> Stan poprawek (2026-11-01): S1–S4 i N3 poprawione, opis w [POPRAWKI_BEZPIECZENSTWA.md](POPRAWKI_BEZPIECZENSTWA.md).

- Data: 2026-11-01
- Stan kodu: `main` @ `f5e69e4` (po merge'u PR #16, czyli z refaktorem z przeglądu kodu nr 2)
- Metoda: skill `/secure-reviewer` (tylko czytanie kodu i wyszukiwanie wzorców). **Nie uruchamiałem** testów,
  `npm audit` ani narzędzi skanujących zależności; nie testowałem ataków na działającym systemie.
- Zakres: `core/` (krypto i synchronizacja), `server/` + `deploy/` (Raspberry Pi), `extension/` (Chrome),
  `android/` (aplikacja i `android/core`). Szczególna uwaga: PIN we wtyczce, odcisk palca i blokada po 60 s,
  wiele adresów serwera i TLS, import/eksport CSV.

## Model zagrożeń, przyjęty w tym przeglądzie

To jest moje założenie (z `docs/SPEC.md` §1 i §7 oraz ustaleń projektu), nie coś, co sprawdziłem:

1. Jeden użytkownik, sprzęt domowy. Serwer w LAN, opcjonalnie przez Tailscale.
2. Obietnica „zero-knowledge”: serwer (albo ktoś, kto go przejmie) nie pozna haseł.
3. Napastnicy, których biorę pod uwagę: ktoś w tej samej sieci (LAN/Wi-Fi), ktoś z kopią dysku lub profilu
   Chrome, ktoś z chwilowym dostępem do odblokowanego komputera lub telefonu, przejęty Raspberry Pi.

## Podsumowanie

| Waga | Liczba |
|---|---|
| Krytyczna | 0 |
| Wysoka | 0 |
| Średnia | 4 |
| Niska | 7 |
| Informacyjna | 5 |

Nie znalazłem niczego, co pozwalałoby komuś z sieci lub z serwera odczytać hasła. Rdzeń kryptograficzny
(Argon2id, HKDF, AES-256-GCM z AAD, granice KDF po obu stronach) jest zrobiony poprawnie. Najważniejsze
problemy dotyczą **integralności synchronizacji** (serwer może kasować i cofać wpisy) oraz **czasu, przez
jaki sejf jest otwarty** (wtyczka nie blokuje się sama, gdy jej strona jest otwarta).

| # | Waga | Obszar | Problem |
|---|---|---|---|
| S1 | Średnia | Wtyczka | Automatyczna blokada po 15 min nie działa, gdy popup lub karta są otwarte |
| S2 | Średnia | Core / sync | Serwer może usuwać wpisy (flaga `deleted`) i podsuwać stare wersje |
| S3 | Średnia | Deploy / Chrome | Prywatne CA bez ograniczenia nazw, a `ca.key` domyślnie powstaje na Pi |
| S4 | Średnia | Wtyczka / PIN | PIN zapamiętany po restarcie da się zgadnąć offline (minuty–godziny) |
| N1 | Niska | Android | Blokada po 60 s może się spóźnić we śnie telefonu; ekran wyłączony nie blokuje od razu |
| N2 | Niska | Wtyczka / CSV | Eksport CSV bez ochrony przed formułami (CSV injection) |
| N3 | Niska | Serwer | Limit logowań tylko per IP, mapy w pamięci bez sprzątania |
| N4 | Niska | Serwer | Token instalacyjny w dzienniku systemowym |
| N5 | Niska | Android | Wydanie podpisane kluczem debug |
| N6 | Niska | Android | Skrót SHA-256 skopiowanego hasła zapisany na dysku (WorkManager) |
| N7 | Niska | Wtyczka / serwer | Zablokowanie nie unieważnia tokenu sesji na serwerze |
| I1 | Info | Całość | Brak zmiany hasła głównego / rotacji kluczy |
| I2 | Info | Android | Klucz w Keystore bez `setUnlockedDeviceRequired` i StrongBox |
| I3 | Info | Całość | Hasła jako `String` w pamięci (JS, Kotlin), nie da się ich wyzerować |
| I4 | Info | Hasło główne | Tylko minimalna długość 12 znaków, bez oceny siły |
| I5 | Info | Zależności | Nie sprawdzałem znanych podatności w paczkach npm i Gradle |

---

## Średnie

### S1. Wtyczka nie blokuje się sama, dopóki jej strona jest otwarta

- **Typ (OWASP):** A07 Identification and Authentication Failures (zarządzanie sesją)
- **Miejsce:** `extension/src/vault-store.ts:267-277` (`resume`), `:338-346` (`requireVault`, `requireKeys`),
  `:360-364` (`touch`); brak jakiegokolwiek timera w `extension/src/views/` i `ui/`.
- **Opis:** termin `unlockedUntil` (15 min) jest sprawdzany **tylko w `resume()`**, czyli przy otwarciu
  `popup.html`. Gdy strona jest już otwarta, `VaultStore` trzyma odszyfrowany sejf w polu `vault` i nic go nie
  zamyka: `requireVault()` nie patrzy na termin, a każde `save()` wywołuje `touch()` i przedłuża go. Dotyczy to
  zwłaszcza karty z „Otwórz w karcie” (PR #9) i kart `?transfer`/`?addresses`: karta zostawiona na noc pokazuje
  listę, pozwala kopiować hasła i przycisk „Pokaż” odsłania je. Klucze (`vaultKey`, `authKey`) leżą też w
  `chrome.storage.session` po upływie 15 min, aż ktoś otworzy popup albo zamknie przeglądarkę.
- **Ryzyko:** ktoś z chwilowym dostępem do odblokowanego komputera widzi wszystkie hasła, choć użytkownik
  zakłada, że sejf zamknął się po 15 minutach. Android ma tę samą funkcję zrobioną dobrze
  (`LockController.checkIdle` co 15 s).
- **Naprawa:**
  1. W `ui/` timer (np. co 15 s) i zdarzenie `visibilitychange`: gdy `unlockedUntil <= now`, wywołać
     `store.lock()` i `showLocked()`.
  2. `requireVault()`/`requireKeys()` mają rzucać „Sejf jest zablokowany”, gdy termin minął.
  3. W `background.ts` alarm `chrome.alarms` na `unlockedUntil`, który usuwa `keys` z `storage.session`, także
     gdy żadna strona nie jest otwarta.
  4. `touch()` wywoływać przy działaniu użytkownika (klik, klawisz), a nie tylko przy zapisie.

### S2. Przejęty serwer może kasować wpisy na wszystkich urządzeniach i cofać je do starych wersji

- **Typ (OWASP):** A08 Software and Data Integrity Failures
- **Miejsce:** `core/src/sync.ts:58-63` (`decodeRemote`), `core/src/vault.ts:6-8` (`entryAad`),
  `core/src/vault.ts:64-70` (`parseTombstoneData`); Android `android/core/.../Vault.kt:51-60` (`decryptRecord`).
- **Opis:** AAD szyfrogramu wiąże go tylko z `id`. Flaga `deleted` i `revision` są jawne i pochodzą od serwera.
  - Klient wybiera parser na podstawie `record.deleted`. Szyfrogram zwykłego wpisu zawiera `modifiedAt`, więc
    `parseTombstoneData` przyjmie go bez błędu. Serwer, który ustawi `deleted: true` przy zwykłym wpisie,
    sprawi, że każdy klient zastąpi u siebie wpis nagrobkiem, czyli **usunie hasło także z lokalnej kopii**.
  - Serwer może też odesłać **starszy szyfrogram** tego samego wpisu z nowym numerem rewizji (np. sprzed zmiany
    hasła). Klient go przyjmie, bo tag GCM się zgadza; ochrona przed tym przez `modifiedAt` działa tylko, gdy
    klient ma akurat lokalną, niezsynchronizowaną zmianę.
- **Ryzyko:** poufność jest zachowana, ale przejęty Pi (albo ktoś, kto podmieni bazę SQLite na karcie SD) może
  zniszczyć lub cofnąć dane na wszystkich urządzeniach przy następnej synchronizacji. Lokalna kopia, która miała
  być zapasem na wypadek awarii serwera, też zostaje nadpisana.
- **Naprawa:**
  1. W zaszyfrowanym ładunku zapisać rodzaj: `{"kind":"entry",…}` / `{"kind":"tombstone",…}` i odrzucać rekord,
     gdy `kind` nie zgadza się z `deleted`. Albo dopisać `deleted` do AAD (`passholder/v1/entry/<id>/<0|1>`).
  2. Przed przyjęciem zdalnej wersji sprawdzać, że jej `modifiedAt` nie jest starszy niż lokalny
     (`remote.modifiedAt >= local.modifiedAt`), inaczej traktować to jako błąd lub konflikt.
  3. To zmiana formatu (wersja 2 szyfrogramu lub ładunku): nowe wektory w `core/test-vectors/` i ta sama zmiana
     w Kotlinie.

### S3. Prywatne CA bez ograniczenia nazw, a jego klucz powstaje na Raspberry Pi

- **Typ (OWASP):** A05 Security Misconfiguration / A02 Cryptographic Failures
- **Miejsce:** `deploy/make-certs.sh:18-24`; `docs/INSTALACJA.md` część 1.5 i 2.2.
- **Opis:** skrypt robi CA z `basicConstraints=CA:TRUE,pathlen:0`, ale **bez `nameConstraints`**. Ten `ca.crt`
  jest importowany do Chrome jako zaufany urząd. Domyślnie `ca.key` powstaje w `/etc/passholder/tls/` na Pi.
  Instrukcja każe go przenieść i zniszczyć (`shred`), ale to krok ręczny, a przy odnawianiu certyfikatu klucz
  ma wrócić na Pi.
- **Ryzyko:** kto zdobędzie `ca.key` (przejęty Pi, kopia karty SD, kopia zapasowa), może wystawić certyfikat dla
  **dowolnej domeny** (bank, poczta), któremu Chrome na Ubuntu zaufa. Wychodzi to daleko poza PassHolder.
- **Naprawa:**
  1. Dodać do CA ograniczenie nazw, np.
     `-addext "nameConstraints=critical,permitted;DNS:passholder.local,permitted;IP:192.168.0.0/255.255.0.0,permitted;IP:100.64.0.0/255.192.0.0"`
     (lista do dopasowania do własnych adresów). Chrome respektuje `nameConstraints`.
  2. Tworzyć CA na komputerze z Ubuntu, a na Pi kopiować tylko `server.crt` i `server.key`.
  3. Alternatywa bez CA: certyfikat samopodpisany importowany w Chrome tylko jako certyfikat serwera.

### S4. PIN zapamiętany po restarcie przeglądarki da się zgadnąć offline

- **Typ (OWASP):** A07 Identification and Authentication Failures (słaby sekret)
- **Miejsce:** `extension/src/pin-lock.ts:45-51`, `extension/src/pin-store.ts:37-41`, `core/src/kdf.ts:17`.
- **Opis:** PIN ma 4–6 cyfr (najwyżej 10⁶ wartości) i jest wzmacniany tym samym Argon2id co hasło główne
  (64 MiB, t = 3). Przy opcji „Pamiętaj PIN po zamknięciu przeglądarki” `PinLock` trafia do
  `chrome.storage.local`, czyli na dysk w profilu Chrome. Licznik prób jest w tym samym miejscu, więc kopia
  profilu go omija. To jest opisane w kodzie i w `docs/WTYCZKA_PIN.md` oraz w ostrzeżeniu w UI. Zgłaszam,
  bo skutek jest poważny: odgadnięty PIN daje `vaultKey` **i** `authKey`, czyli cały sejf i logowanie do serwera.
- **Ryzyko:** kradzież laptopa lub kopii katalogu domowego (bez szyfrowania dysku) = cały sejf w czasie od
  minut (4 cyfry) do godzin (6 cyfr).
- **Naprawa (od najprostszej):**
  1. Dla trybu „na dysku” wymagać dłuższego PIN-u (np. 8+ znaków, także litery) albo w ogóle tylko hasła.
  2. Dla `PinLock` osobne, cięższe parametry Argon2id (np. 256 MiB, t = 4). Odblokowanie potrwa dłużej, ale
     zgadywanie offline też.
  3. W dokumentacji instalacji zalecić szyfrowanie dysku (LUKS) na Ubuntu, jeśli ta opcja ma być używana.

## Niskie

### N1. Android: blokada po 60 s może się spóźnić, a wyłączenie ekranu nie blokuje od razu

- **Typ:** A07 (zarządzanie sesją)
- **Miejsce:** `android/app/.../LeaveLock.kt:28-35`, `LockController.kt:57-62`.
- **Opis:** `Handler.postDelayed` liczy czas w `uptimeMillis`, który stoi, gdy telefon śpi. Po wyłączeniu ekranu
  klucze mogą zostać w pamięci długo po 60 s. Interfejs jest chroniony, bo `cancel()` przy powrocie porównuje
  `elapsedRealtime` z terminem i blokuje (to działa dobrze). Ponadto wyłączenie ekranu też uruchamia tylko
  opóźnienie 60 s.
- **Ryzyko:** dłużej żyjące klucze w RAM (atak na pamięć wymaga roota lub sprzętu, więc ryzyko niskie).
- **Naprawa:** przy `ACTION_SCREEN_OFF` blokować od razu niezależnie od przełącznika; dla 60 s użyć
  `AlarmManager` z `ELAPSED_REALTIME` albo zaakceptować i opisać.

### N2. Eksport CSV bez ochrony przed formułami

- **Typ:** A03 Injection (CSV/formula injection)
- **Miejsce:** `extension/src/csv-transfer.ts:98-100` (`csvField`).
- **Opis:** pola zaczynające się od `=`, `+`, `-`, `@` są zapisywane bez zmian. Otwarcie eksportu w LibreOffice
  lub Excelu wykona formułę. Wpisy tworzy sam użytkownik (albo przychodzą z importu z NordPass), więc trudno o
  złośliwą treść.
- **Naprawa:** nie zmieniać hasła (import musi je odtworzyć bit w bit), ale w dokumentacji ostrzec, żeby nie
  otwierać pliku w arkuszu; ewentualnie prefiks `'` tylko dla `name` i `username`.

### N3. Limit logowań tylko per IP, mapy w pamięci bez sprzątania

- **Typ:** A07 / A04 Insecure Design
- **Miejsce:** `server/src/app.ts:71-84`, `:146-152`.
- **Opis:** 5 błędnych prób na minutę na adres IP; z wieloma adresami (np. IPv6 w LAN) limit nie działa.
  `loginFailures` i `sessions` rosną bez sprzątania (wygasłe tokeny są usuwane tylko przy użyciu).
- **Ryzyko:** niskie, bo każde zgadywanie wymaga po stronie napastnika Argon2id, a `authKey` ma 256 bitów.
  Zasypanie pamięci Pi wymaga dostępu do LAN.
- **Naprawa:** dodatkowy globalny limit (np. 20/min na cały serwer) i okresowe usuwanie wygasłych wpisów z obu map.

### N4. Token instalacyjny w dzienniku systemowym

- **Miejsce:** `server/src/main.ts:19-21`.
- **Opis:** token do założenia sejfu trafia do `journalctl`, który czytają też członkowie grupy `adm`.
  Do chwili założenia sejfu każdy, kto zna token i ma dostęp do portu, może założyć sejf jako pierwszy.
- **Naprawa:** po założeniu sejfu nic nie trzeba (token przestaje działać); wystarczy w instrukcji zakładać sejf
  od razu po pierwszym uruchomieniu. Ewentualnie zapisywać token do pliku `0600` zamiast logu.

### N5. Wydanie aplikacji podpisane kluczem debug

- **Miejsce:** `android/app/build.gradle.kts` (`signingConfig = signingConfigs.getByName("debug")`).
- **Opis:** świadoma decyzja (komentarz w kodzie). Kto ma `~/.android/debug.keystore` z komputera, na którym
  budowano, może wydać „aktualizację”, którą Android zainstaluje na miejscu PassHoldera i która dostanie jego dane.
- **Naprawa:** własny klucz wydania poza repo (np. `keystore.properties` w `.gitignore`).

### N6. Android: skrót skopiowanego hasła na dysku

- **Miejsce:** `android/app/.../SecureClipboard.kt:43-47`.
- **Opis:** SHA-256 hasła (bez soli) trafia do bazy WorkManagera w katalogu aplikacji na około minutę. Dla
  wygenerowanych haseł bez znaczenia; dla słabych haseł z importu skrót da się odwrócić słownikiem. Dostęp do
  tego pliku wymaga roota. Wtyczka trzyma swój skrót tylko w `storage.session` (pamięć).
- **Naprawa:** HMAC z losowym kluczem trzymanym w pamięci procesu albo samo czyszczenie bez porównania
  (Android 10+ i tak nie pozwala czytać schowka w tle, więc porównanie i tak zwykle nie zachodzi).

### N7. Zablokowanie nie unieważnia tokenu sesji na serwerze

- **Miejsce:** `extension/src/vault-store.ts:279-283`, `android/core/.../VaultStore.kt:229-235`; serwer nie ma
  endpointu wylogowania.
- **Opis:** token żyje na serwerze do 15 minut po zablokowaniu. Kto go wyciągnie z pamięci, może synchronizować
  (czyli też nadpisywać szyfrogramy, zob. S2). Treści nie odczyta.
- **Naprawa:** `DELETE /api/v1/session` wywoływane przy `lock()` (błąd sieci ignorować).

## Informacyjne

- **I1. Brak zmiany hasła głównego i rotacji kluczy** (świadomie poza zakresem v1, `SPEC.md` §9). Jeśli hasło
  główne, PIN-lock albo `authKey` wyciekną, nie da się ich unieważnić bez założenia sejfu od nowa.
- **I2. Keystore na Androidzie** (`BiometricUnlock.kt:103-120`): jest dobrze (silna biometria, `CryptoObject`,
  unieważnienie po dodaniu odcisku, zero okna czasowego). Można dodać `setUnlockedDeviceRequired(true)`
  (API 28+) i `setIsStrongBoxBacked(true)` tam, gdzie telefon ma StrongBox.
- **I3. Hasła jako `String`** w Compose i w JS nie dają się wyzerować; klucze na Androidzie są zerowane
  (`fill(0)`), we wtyczce nie (trzymane jako Base64 w `storage.session`). Ograniczenie platform.
- **I4. Hasło główne:** tylko „co najmniej 12 znaków” (`ConnectScreen.kt:33`, `views/connect.ts:7`). Można
  dodać prostą ocenę siły lub listę najpopularniejszych haseł.
- **I5. Zależności:** nie uruchamiałem `npm audit` ani skanu Gradle. Warto to zrobić przed każdą aktualizacją.

## Co jest zrobione dobrze

- **Krypto:** Argon2id 64 MiB / t = 3 / p = 4; HKDF rozdziela klucz szyfrujący od uwierzytelniającego; serwer
  trzyma tylko `SHA-256(authKey)`; AES-256-GCM z losowym 96-bitowym nonce; AAD wiąże wpis z `id` i klucz sejfu
  z kontekstem; generator z odrzucaniem (bez przewagi znaków) i Fisherem-Yatesem.
- **Obrona przed złośliwym serwerem po stronie KDF:** dolne i górne granice parametrów sprawdzane jako liczby
  całkowite i po stronie klienta, i w schemacie serwera.
- **Serwer:** schematy JSON z `additionalProperties: false`, limity długości, zapytania SQL tylko z parametrami
  (brak wstrzyknięć), porównania w stałym czasie (`timingSafeEqual`), token sesji 256 bitów, HTTPS wymagany
  (HTTP tylko z jawnym `PASSHOLDER_INSECURE_HTTP=1`), transakcje SQLite, systemd z `ProtectSystem=strict` itd.,
  w instrukcji `ufw` tylko dla LAN i `tailscale0`.
- **Wtyczka:** brak `innerHTML` i `eval` (wszystko przez `createElement`/`textContent`), domyślne CSP MV3,
  uprawnienia do hostów tylko opcjonalne i tylko HTTPS (HTTP wyłącznie `localhost`), klucze w
  `storage.session`, czyszczenie schowka tylko gdy nadal jest w nim to hasło, licznik złych PIN-ów zapisywany
  **przed** sprawdzeniem (zamknięcie popupu nie daje darmowej próby), PIN domyślnie tylko w pamięci, eksport CSV
  za wyraźnym potwierdzeniem.
- **Android:** przypięcie certyfikatu serwera z porównaniem odcisku przy parowaniu (wszystkie adresy muszą pokazać
  ten sam certyfikat), cleartext wyłączony w wydaniu, `FLAG_SECURE`, wyłączone kopie zapasowe, schowek oznaczony
  jako wrażliwy i czyszczony po minucie, blokada przy powrocie sprawdzana zegarem `elapsedRealtime`, zerowanie
  kluczy po użyciu.

## Proponowana kolejność poprawek

1. **S1** (mała zmiana, duży zysk, dotyczy codziennego użycia).
2. **S3** (zmiana skryptu i instrukcji; wymaga ponownego wystawienia CA i importu w Chrome).
3. **S4** (decyzja: dłuższy PIN dla trybu „na dysku” albo cięższy Argon2id).
4. **S2** (zmiana formatu, dwie implementacje i wektory testowe; największa praca).
5. Niskie według uznania; N7 i N3 są krótkie.

Poprawki nie są częścią tego kroku. Każda grupa może być osobnym wątkiem i PR.
