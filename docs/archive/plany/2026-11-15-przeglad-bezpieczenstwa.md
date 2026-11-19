# Plan: pełny przegląd bezpieczeństwa PassHolder (po V3)

> **Dla wykonawcy (osobny wątek, Opus 5.5 medium):** to jest plan **przeglądu**, nie implementacji. Wykonuj go sam,
> etap po etapie (bez subagentów, chyba że właściciel poprosi). Po każdym etapie dopisz wyniki do raportu i zrób commit:
> kontekst może zostać streszczony, a raport nie. Kroki mają pola `- [ ]`.

**Cel:** znaleźć słabości bezpieczeństwa w całym repo po zmianach V3 i opisać je w jednym raporcie z ważnością i naprawą.

**Wynik:** `docs/PRZEGLAD_BEZPIECZENSTWA_V3.md` + wiersz w tabeli „Stan przeglądu bezpieczeństwa” w
`docs/ARCHITEKTURA.md` + PR z samą dokumentacją. **Bez poprawek kodu** (każda grupa poprawek to osobny wątek i PR).

**Stan kodu:** `main` @ `b515ca5` (po PR #48). Na starcie zapisz w raporcie `git rev-parse origin/main`; jeśli jest
inny, przejrzyj `git log b515ca5..origin/main` i dolicz zmiany.

**Rozmiar:** ok. 21 600 linii kodu produkcyjnego: `core/src` 4,3 tys., `extension/src` 5,3 tys., `android/core` 6,3 tys.,
`android/app` 5,7 tys. Pliki z tabel etapów czytaj **w całości**; formularze UI (`views/forms/*`, `ui/forms/*`)
wystarczy przejrzeć pod kątem pól wrażliwych.

Skróty ścieżek: `AC/` = `android/core/src/main/kotlin/io/github/sheking94/passholder/core/`,
`AA/` = `android/app/src/main/kotlin/io/github/sheking94/passholder/app/`.

## 1. Zasady

- Projekt do nauki, jeden użytkownik, sprzęt domowy. Oceniaj realne ryzyko dla tego użycia, a przy każdym punkcie
  zaznacz, czy w wariancie produkcyjnym waga byłaby wyższa.
- Każde znalezisko ma **pewność**: `potwierdzone` (test albo PoC uruchomiony), `z kodu` (wynika z przeczytanego kodu,
  wskazane linie), `hipoteza` (wymaga prawdziwego telefonu albo Chrome; opisz, jak sprawdzić ręcznie).
- PoC i testy pomocnicze pisz w katalogu scratchpad, **nie w repo**. W raporcie zostaje opis kroków.
- Niczego nie wysyłaj do usług zewnętrznych (kod, dane); `npm audit` jest dozwolony.
- Znalezisko **krytyczne lub wysokie** zgłoś właścicielowi w wątku od razu, nie czekaj na koniec.
- Nie powtarzaj punktów zamkniętych i decyzji z sekcji 3. Stary punkt wraca tylko, gdy zmiany V3 pogorszyły skutek
  albo poprawka ma lukę; wtedy podaj nowy identyfikator i odwołanie do starego.
- Poza zakresem: `docs/archive/`, `.claude/skills/`, testy (czytaj tylko, żeby ocenić pokrycie), wygląd ekranów.

## 2. Model zagrożeń

**Chronimy:** hasło główne, `vaultKey`, treść wpisów i plików, klucze statyczne Noise, kod parowania, PIN,
kandydatów zapisu (login + hasło), integralność i dostępność sejfu, metadane (jakie serwisy, kiedy).

**Granice zaufania:** telefon ↔ sieć (port 8787, zwykłe HTTP) · wtyczka ↔ strona WWW (skrypty treści, panel w ramce)
· aplikacja ↔ inne aplikacje i system (autouzupełnianie, schowek, intenty) · urządzenie ↔ plik importu · pamięć ↔ dysk.

| # | Napastnik | Co umie |
|---|---|---|
| A1 | ktoś w tej samej sieci (LAN, Wi-Fi, Tailscale, sieć komórkowa) | podsłuch i zmiana zwykłego HTTP, własne żądania do `:8787`, podszywanie się pod adres telefonu |
| A2 | złośliwa albo przejęta strona WWW w Chrome | własny DOM, ramki, formularze-pułapki, nakładki, żądania do sieci lokalnej z przeglądarki użytkownika |
| A3 | inna aplikacja na telefonie (bez roota) | fałszywy formularz dla autouzupełniania, własna nazwa pakietu, schowek, nakładka, intenty |
| A4 | podsunięty plik importu (ZIP, JSON, CSV) | dowolna treść pliku |
| A5 | kopia danych w spoczynku | profil Chrome (`storage.local`, IndexedDB), pliki aplikacji, skradzione zablokowane urządzenie |
| A6 | chwilowy dostęp do odblokowanego urządzenia | sejf zablokowany albo otwarty; interfejs, narzędzia deweloperskie Chrome |
| A7 | sparowana wtyczka, która wyszła spod kontroli | ważny klucz Noise do chwili usunięcia z „Urządzenia”; stare hasło i stara kopia klucza |
| A8 | cofnięty albo podmieniony host | stare rekordy, pominięte zmiany, inna epoka |
| A9 | łańcuch dostaw | zależności npm i Gradle, wrapper Gradle, proces budowania |

**Poza modelem:** root, złośliwe oprogramowanie z pełnym dostępem, przejęty system albo Chrome, ataki sprzętowe,
przymus. Własne CPace i Noise: sprawdzamy zgodność ze specyfikacją i typowe błędy, nie robimy formalnego audytu.

## 3. Co już zamknięte albo zaakceptowane (nie zgłaszać ponownie)

Źródła: `docs/archive/PRZEGLAD_BEZPIECZENSTWA.md`, `docs/archive/POPRAWKI_BEZPIECZENSTWA.md`, PR #18, #29, #47, #48,
tabela w `docs/ARCHITEKTURA.md`, `docs/SYNCHRONIZACJA.md` §9.

| Stary punkt | Stan | Co zrobić teraz |
|---|---|---|
| S1 auto-blokada wtyczki | poprawione (PR #18) | tylko regresja w nowych ścieżkach V3 (krok 4.2) |
| S2 integralność synchronizacji | poprawione, ścisłe nagrobki (PR #29) | host to teraz telefon: kroki 3.3–3.4 |
| S3 CA, N3 limit logowań, N4 token, N7 sesja | nieaktualne (serwer Pi usunięty) | pominąć |
| S4 PIN na dysku | poprawione (PR #18) | regresja (krok 4.4) |
| N1 ekran wyłączony, N6 skrót w WorkManagerze, I2 Keystore, I4 reguły hasła | poprawione (PR #47) | krótka regresja (kroki 6.3, 6.4, 6.6, 6.8) |
| N2 formuły w CSV | zaakceptowane, ostrzeżenie w UI | nie zgłaszać |
| N5 klucz debug Androida | **decyzja właściciela: zostaje domyślny** | nie zgłaszać |
| I1 zmiana hasła głównego | zrobione (PR #48), nowy kod | pełny przegląd (kroki 4.5, 6.5) |
| I3 hasła jako `String` | ograniczenie platform | nie zgłaszać |
| I5 zależności | npm sprawdzone, Gradle nie | etap 9 |

Zaakceptowane ograniczenia (opisane w dokumentacji): wersja debug i `adb run-as` (INSTALACJA), `vaultKey` nie jest
rotowany przy zmianie hasła, odwołanie wtyczki nie wymazuje jej kopii, LWW gubi przegraną zmianę, kod parowania da się
spalić z sieci, `Ristretto255.kt` nie działa w stałym czasie (tylko jednorazowe CPace), klucz statyczny Noise telefonu
bez wymogu uwierzytelnienia, lista „Nigdy” jawna, krótki PIN tylko w pamięci, okienko zamiast karty (nie proponować zmiany).

## 4. Skala ważności i identyfikatory

| Waga | Litera | Kiedy |
|---|---|---|
| Krytyczna | K | A1–A4 bez udziału użytkownika odczytuje hasła albo `vaultKey`, albo trwale niszczy sejf na wszystkich urządzeniach |
| Wysoka | W | to samo po jednej zwykłej czynności użytkownika (klik, wejście na stronę, otwarcie pliku) albo pojedyncze hasło; obejście blokady zablokowanego sejfu przy dostępie fizycznym |
| Średnia | S | wymaga rzadkich warunków (napastnik w sieci w chwili parowania, kopia profilu i słaby sekret); utrata integralności lub trwała niedostępność danych; wyciek wrażliwych metadanych |
| Niska | N | krótki DoS, mało wrażliwe metadane, utwardzenie o małym zysku |
| Informacyjna | I | brak ataku: rozbieżność dokumentacji z kodem, dobra praktyka, ograniczenie platformy |

Identyfikator: `V3-<litera><numer>`, np. `V3-W1`, `V3-S3` (stare punkty zostają bez przedrostka). Numeracja w obrębie
litery, od najważniejszego.

## 5. Tropy z rozpoznania (niezweryfikowane)

Zauważone przy planowaniu, **nie są ustaleniami**. Każdy potwierdź albo odrzuć z uzasadnieniem w raporcie.

| # | Trop | Gdzie | Etap |
|---|---|---|---|
| T1 | Pierwsza wiadomość Noise KK da się powtórzyć: podsłuchana i wysłana 32 razy może zapełnić `MAX_SESSIONS` na 60 s (503 dla prawdziwej wtyczki) | `core/src/p2p/host.ts` `#handshake`, `AC/p2p/P2pHost.kt` | 2 |
| T2 | Odpowiedzi inne niż 200 są jawne i nieuwierzytelnione; A1 może podrobić 403 „device not paired” albo 404. Czy któraś zmienia stan wtyczki albo skłania do ponownego parowania? | `core/src/p2p/transport.ts`, `extension/src/phone-client.ts`, `vault-store.ts` | 2 |
| T3 | Serwer telefonu słucha na wszystkich interfejsach (`InetSocketAddress(port)`), także w sieci komórkowej i publicznym Wi-Fi; `/ping` i `/pair/hello` odpowiadają każdemu | `AC/p2p/SyncHttpServer.kt:64` | 2 |
| T4 | Strona WWW może wysłać `POST` do `http://<IP>:8787` z przeglądarki użytkownika (prosty `no-cors`). Sprawdzenie `Host` nie zatrzymuje żądania pod literał IP; czy serwer wymaga `Content-Type: application/json` albo patrzy na `Origin`? Skutek: spalenie kodu, sesje | `AC/p2p/SyncHttpServer.kt`, `PhoneRouter.kt` | 2 |
| T5 | `save-prompt.html` jest `web_accessible` dla wszystkich stron: czy strona może poznać adres panelu i `candidateId`, osadzić go sama i nałożyć warstwę (clickjacking „Zapisz”)? „Zapisz” przy decyzji `update` nadpisuje hasło istniejącego wpisu | `extension/static/manifest.json`, `src/save/watch.ts`, `prompt-page.ts`, `candidates.ts` | 5 |
| T6 | Dopasowanie subdomen bez listy sufiksów publicznych: wpis `example.com` pasuje do `x.example.com`; skrót Ctrl+Shift+L wypełnia bez pytania przy jednym dopasowaniu | `core/src/autofill/match.ts`, `AC/autofill/Match.kt`, `extension/src/autofill/fill-tab.ts` | 5, 7 |
| T7 | `TRUSTED_BROWSERS` ufa samej nazwie pakietu, bez podpisu: aplikacja z nazwą pakietu nieobecnej przeglądarki zgłasza dowolne `webDomain` | `AC/autofill/Match.kt:15-29` | 7 |
| T8 | Brak `webScheme` jest traktowany jak `https` (decyzja D3), a na Androidzie 8.0–8.1 `webScheme` w ogóle nie jest czytany: wpis `https` pasuje wtedy do strony `http`, karta też jest dozwolona | `AC/autofill/Planner.kt:56`, `Match.kt:130`, `AA/autofill/ViewNodeReader.kt:90` | 7 |
| T9 | Komunikat `fill` sprawdza tylko `sender.id` (przechodzą też skrypty treści), `password-copied` nie sprawdza nadawcy | `extension/src/background.ts:13-33` | 5 |
| T10 | Logi z wyjątkami (`console.warn(…, error)`, `Log.w(…, e)`): komunikaty `JSON.parse` i `kotlinx.serialization` potrafią zawierać fragment wejścia, czyli odszyfrowanej treści | `background.ts:59`, `AA/autofill/*.kt`, `AA/KeystoreSecretWrapper.kt` | 5, 6, 7 |
| T11 | `unlockPendingIntent` ma `FLAG_MUTABLE`: co wypełniający może dopisać i czemu aktywność ufa z dodatków intencji | `AA/autofill/PassHolderAutofillService.kt:60`, `AutofillAuthActivity.kt` | 7 |
| T12 | Okna dialogowe Compose (`AlertDialog`, `DropdownMenu`, wybór aplikacji) to osobne okna: czy mają blokadę zrzutów jak aktywność (`FLAG_SECURE`)? | `AA/ui/*.kt` | 6 |
| T13 | Brak limitu prób hasła głównego (telefon, wtyczka); chroni tylko koszt Argon2id | `AC/p2p/PhoneVaultStore.kt`, `extension/src/vault-store.ts` | 4, 6 |
| T14 | `downloadFile` tworzy `Blob` z typem MIME załącznika w origin wtyczki (adres żyje 60 s); nazwa pliku pochodzi z wpisu albo archiwum | `extension/src/ui/download.ts` | 8 |
| T15 | Eksport całego sejfu jawnym tekstem nie wymaga ponownego podania hasła (A6 przy otwartym sejfie) | `extension/src/views/transfer.ts`, `AA/ui/TransferScreen.kt` | 8 |
| T16 | ZIP: wtyczka czyta katalog centralny, telefon nagłówki lokalne strumieniowo. To samo archiwum może znaczyć co innego po obu stronach | `core/src/transfer/zip.ts`, `AC/transfer/ArchiveReader.kt` | 8 |
| T17 | Wrapper Gradle bez `distributionSha256Sum`; brak CI, więc testy nie są wymuszane przed scaleniem | `android/gradle/wrapper/gradle-wrapper.properties` | 9 |

## 6. Etapy

Kolejność według ryzyka. W każdym etapie: przeczytaj pliki, przejdź listę, zapisz znaleziska **i** to, co sprawdzone
i w porządku (krótko, żeby następny przegląd tego nie powtarzał).

### Etap 0. Przygotowanie

- [ ] Gałąź robocza od `origin/main`; zapisz hash. Przeczytaj: ten plan, `docs/SPEC.md`, `docs/SYNCHRONIZACJA.md`,
      `docs/FUNKCJE.md`, `docs/ARCHITEKTURA.md` (mapa plików i tabela stanu), `docs/TESTY.md` (testy ręczne T1–T25, żaden
      z T4, T7, T15, T17–T25 nie jest potwierdzony).
- [ ] Punkt wyjścia: `NO_PROXY=localhost npm ci --cafile=/root/.ccr/ca-bundle.crt`, `npm test`, `npm run typecheck`.
      Testy Androida (`./gradlew :core:test` w `android/`, JDK 21, konfiguracja w pamięci projektu) tylko, gdy
      potrzebne do PoC.
- [ ] Utwórz `docs/PRZEGLAD_BEZPIECZENSTWA_V3.md` ze szkieletem z sekcji 7 i commit.
- [ ] Przeszukanie wzorców (wynik do raportu): `innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function`,
      `Math.random|java.util.Random`, `console\.|Log\.[dwie]|println`, `setAccessLevel|onMessageExternal|externally_connectable`,
      `postMessage`, `href|src =` z danych, `exported=`, `PendingIntent`, `MODE_WORLD|getExternalFilesDir|cacheDir`,
      `TODO|FIXME|HACK`. W rozpoznaniu pierwsze trzy grupy były czyste poza logami z T10.

### Etap 1. Kryptografia i format danych

Pliki: `core/src/{encoding,kdf,cipher,vault,generator}.ts`, `core/src/p2p/entry.ts`, `core/src/files/{attachment,chunks}.ts`;
`AC/{Encoding,Kdf,Cipher,Vault,Generator}.kt`, `AC/p2p/{EntryV3,P2pJson}.kt`, `AC/files/{Attachment,FileChunks}.kt`.

- [ ] 1.1 Losowość: wszędzie CSPRNG. Parametr `nonce?` (wektory testowe) nieosiągalny z kodu produkcyjnego.
- [ ] 1.2 AES-GCM: nonce 96 bitów losowy; liczba szyfrowań pod jednym kluczem (`vaultKey`, klucz pliku, klucz parowania,
      `pinKey`) daleko od granicy; bajt wersji `0x01` sprawdzany; tag sprawdzany przed użyciem treści.
- [ ] 1.3 AAD: każdy kontekst z tabeli SPEC §3 ma własny; szyfrogram z jednego kontekstu nie otworzy się w innym
      (klucz sejfu, wpis, lokalny sejf, klucz statyczny wtyczki, PIN, plik, parowanie).
- [ ] 1.4 KDF: granice `MIN_KDF`/`MAX_KDF` sprawdzane wszędzie, gdzie parametry przychodzą z zewnątrz albo z dysku
      (`vaultInfo` z parowania, tryb `restore`, `accountV2`, `PinLock`, `host.json`); liczby całkowite; NFC hasła.
- [ ] 1.5 Porównania sekretów w stałym czasie (`keyCheck`, HMAC schowka); co dokładnie liczy `keyCheck` i czy nie jest
      słabszą wyrocznią niż `wrappedVaultKey`.
- [ ] 1.6 Ścisłe parsery (wpis v3, v2, nagrobek, załączniki): klucze `__proto__`/`constructor`, powtórzone klucze JSON,
      liczby `3.0`/`1e400`, głębokie zagnieżdżenie. Szukaj wejścia, które TS i Kotlin czytają **różnie**.
- [ ] 1.7 Pliki: AAD kawałka (`id/i/n`), `size` i `sha256` sprawdzone przed oddaniem treści; klucz pliku zawsze nowy
      (także przy imporcie ZIP).
- [ ] 1.8 Generator: brak przewagi znaków, zachowanie przy długości 4 i jednej grupie.

### Etap 2. Parowanie, Noise i serwer HTTP telefonu

Pliki: `core/src/p2p/{cpace,pairing,pair-client,noise,frames,transport,host}.ts`;
`AC/p2p/{Ristretto255,Cpace,Pairing,PairingHost,Noise,Frames,P2pHost,SyncHttpServer,PhoneRouter,LocalAddresses}.kt`;
`AA/SyncController.kt`; `extension/src/{phone-client,phone-urls}.ts`; w `extension/src/vault-store.ts`: `pairStart`,
`pairFinish`, `repair`, `sync`.

- [ ] 2.1 CPace względem draft-irtf-cfrg-cpace-21: generator, dekodowanie i odrzucenie elementu neutralnego, transkrypt
      z rolami, odbicie własnej wiadomości, `sid` podany przez nieuwierzytelnioną stronę, `lv_cat` z długością poza
      zakresem. To samo w Kotlinie.
- [ ] 2.2 Kod: 8 cyfr bez przewagi, jedna próba, 2 min, zużycie przy `/start` także po błędzie; wyścigi (dwa
      równoległe `/start`, `/finish` po 30 s, drugi `/finish`); czy jakakolwiek ścieżka daje drugą próbę tego samego kodu.
- [ ] 2.3 Co telefon wysyła, zanim ma dowód, że druga strona zna kod. `vaultInfo` (`kdf` + `wrappedVaultKey`) to
      materiał do zgadywania hasła głównego offline: kto może go dostać i po ilu próbach.
- [ ] 2.4 Tryb `restore`: telefon przyjmuje metadane sejfu od wtyczki. Co się dzieje, gdy A1 sparuje się pierwszy
      (obcy sejf); czy użytkownik to zauważy, zanim wpisze hasło główne; granice KDF po stronie telefonu.
- [ ] 2.5 Noise KK względem rev. 34: kolejność tokenów, prolog, licznik nonce i jego granica, `split`, zerowy wynik
      X25519 (klucze niskiego rzędu), zgodność TS i Kotlina poza wektorami.
- [ ] 2.6 Sesje: jednorazowe, 60 s, limit 32, związane z urządzeniem i kluczem, odcięcie po usunięciu urządzenia. **T1.**
      Co sparowana wtyczka może zrobić przy zablokowanym telefonie i czy zablokowana wtyczka w ogóle zsynchronizuje
      (klucz statyczny zapieczętowany `vaultKey`).
- [ ] 2.7 Ramki: limity liczby i rozmiaru przed odszyfrowaniem, ucięcie, przestawienie, powtórzenie.
- [ ] 2.8 **T2:** wypisz każdą jawną odpowiedź i jej skutek po stronie wtyczki (stan, komunikat, zachęta do ponownego
      parowania). Zmiana epoki i reset tylko z uwierzytelnionej treści?
- [ ] 2.9 Serwer HTTP: parser (metoda, `Content-Length`, nagłówki, limity czasu i połączeń), `Host`. **T3, T4.** Co
      widzi i co może zmienić nieuwierzytelniony klient na każdej ścieżce (`/ping`, `/pair/*`, `/p2p/v2/*`, stare ścieżki).
- [ ] 2.10 Tryb Synchronizacja: wyłączenie po 5 min, po wyjściu, po blokadzie; czy serwer na pewno przestaje słuchać.
- [ ] 2.11 Adresy: `normalizePhoneUrl`, adresy dopisywane z telefonu, zgoda Chrome; co wtyczka ujawnia adresowi,
      który nie jest telefonem (jawne `deviceId`, pierwsza wiadomość).
- [ ] 2.12 `Ristretto255.kt` używany wyłącznie w CPace (zaakceptowany brak stałego czasu nie rozszerzył się).

### Etap 3. Synchronizacja, integralność, pliki po sieci

Pliki: `core/src/protocol.ts`, `core/src/p2p/{host-sync,sync,hlc}.ts`, `core/src/files/{host-files,client,merge}.ts`;
`AC/Protocol.kt`, `AC/p2p/{HostSync,Hlc,FileSyncStore,HostState,PhoneVault,PhoneVaultStore}.kt`,
`AC/files/{FileHost,DiskFileStore}.kt`.

- [ ] 3.1 Walidacja żądań hosta: każde pole, limity, liczby. `id` pliku i `index` stają się nazwami na dysku
      (`DiskFileStore`): sprawdzane przed użyciem, brak wyjścia poza katalog.
- [ ] 3.2 A7: co umie sparowane urządzenie poza tym, co z założenia (nadpisanie, usunięcie wpisu): zapełnienie dysku
      (brak limitu łącznego, próg 50 MB), rośnięcie `records.jsonl`, pliki osierocone do 24 h, zatruty kawałek pliku
      dający trwałe „uszkodzony” na innych urządzeniach.
- [ ] 3.3 A8: stary szyfrogram pod nową rewizją, pominięte zmiany, cofnięte `currentRevision`, zmiana epoki. Czy
      zmiana epoki może wskrzesić usunięte wpisy albo zgubić lokalne zmiany.
- [ ] 3.4 Nagrobki i flaga `deleted` względem treści; wpis innego typu pod tym samym `id`; AAD z `id`.
- [ ] 3.5 HLC: zegar zatruty wartością `ms` z dalekiej przyszłości (jedno zepsute urządzenie wygrywa wszystkie przyszłe
      konflikty?), granice `ms` i `c`, `deviceId` w porównaniu.
- [ ] 3.6 Łączenie załączników: limit 40, ten sam `id` z innym kluczem, wskrzeszanie usuniętych plików (znane).
- [ ] 3.7 Sprzątanie plików (`pruneFiles`, `pruneUnusedFiles`, `orphanFileIds`): wyścig, który kasuje plik potrzebny.
- [ ] 3.8 Trwałość: `fsync`, `.tmp` i zamiana, kompaktowanie, równoległy zapis hosta i ekranu, awaria w połowie.
- [ ] 3.9 Wtyczka, A5 z prawem zapisu do profilu: co jawne w `accountV2`; skutek podmiany klucza publicznego telefonu,
      adresów, `kdf`, `wrappedVaultKey`.

### Etap 4. Wtyczka: klucze, blokada, PIN, stan parowania

Pliki: `extension/src/{vault-store,storage,auto-lock,pin-lock,pin-store,popup,page-mode,open-in-tab,clipboard,offscreen}.ts`,
`views/{locked,connect,addresses,pin-settings,list,edit}.ts`, `ui/{state,dom,copy,page}.ts`, `files/idb-file-store.ts`.

- [ ] 4.1 Mapa sekretów: tabela „co, gdzie (`local`, `session`, IndexedDB, pamięć strony), jawne czy zaszyfrowane, kiedy
      kasowane”. `storage.session` bez `setAccessLevel` (skrypty treści nie mają dostępu).
- [ ] 4.2 Auto-blokada (regresja S1): każda nowa ścieżka czytająca sejf w service workerze (`fillTab`,
      `SaveCandidates`, `resume({touch})`) sprawdza termin; strona WWW nie może przedłużać sesji bez czynności użytkownika.
- [ ] 4.3 Odblokowanie hasłem: **T13**, komunikaty, to samo dla ekranu parowania (krok 2 z hasłem).
- [ ] 4.4 PIN (regresja S4): długi PIN na dysku, migracja, licznik zapisany przed sprawdzeniem, równoległe próby z kilku
      kart, kasowanie przy `pairFinish`, odłączeniu i zmianie hasła.
- [ ] 4.5 `repair` po PR #48: potwierdzenie „ten sam sejf” (`opensStaticKey`), nic nie jest nadpisywane przed
      weryfikacją, fałszywy telefon nie dostaje niczego o haśle, PIN wyłączany, stan po przerwaniu w połowie.
- [ ] 4.6 `pendingPairing` (10 min w `session`): co zawiera, kiedy znika.
- [ ] 4.7 „Odłącz tę przeglądarkę”: czy usuwa wszystko (konto, sejf, PIN, IndexedDB, `corruptFiles`, kandydatów, alarmy,
      rejestrację `save-watch`, lista „Nigdy”).
- [ ] 4.8 Schowek: skrót w `session`, dokument offscreen, potrzeba uprawnienia `clipboardRead`.
- [ ] 4.9 DOM: dane z sejfu, importu i telefonu (nazwy, adresy, nazwy plików, nazwy urządzeń) trafiają tylko przez
      `textContent`; żaden adres z wpisu nie staje się `href` (`javascript:`); parametry `?edit&type=&id=` sprawdzane.

### Etap 5. Wtyczka a strony WWW (autouzupełnianie, pytanie o zapis)

Pliki: `extension/static/manifest.json` i `*.html`, `extension/build.mjs`; `extension/src/background.ts`,
`autofill/{fill-tab,fill-page}.ts`, `autofill-content.ts`, `ui/active-tab.ts`, `save/*.ts`, `save-watch.ts`,
`save-prompt.ts`, `views/{save-settings,save-question}.ts`; `core/src/autofill/*`, `core/src/save/*`.

- [ ] 5.1 Manifest: każde uprawnienie potrzebne; skutek przyznania `http://*/*` dla telefonu; domyślne CSP;
      `web_accessible_resources`; brak `externally_connectable`.
- [ ] 5.2 Tabela komunikatów: typ → kto może wysłać (strona wtyczki, skrypt treści, panel w ramce) → którym polom ufa
      tło → co sprawdza (`sender.id`, `url`, `tab`, `frameId`). **T9.** Osobno: co zyskuje napastnik z przejętym
      procesem strony (świat skryptu treści).
- [ ] 5.3 Autouzupełnianie: origin z `tabs.get` i przypięcie przy wstrzyknięciu (nawigacja w trakcie), tylko ramki tego
      samego origin, pola niewidoczne (przezroczystość, `clip-path`, skala, przykrycie, poza ekranem), `http` i `https`,
      **T6**, karta tylko `https`, kontakt na dowolnej stronie, `FillPlan` niesie tylko to, co potrzebne.
- [ ] 5.4 Pytanie o zapis, **T5**: czy strona może (a) poznać adres panelu albo `candidateId`, (b) osadzić panel sama,
      (c) przykryć albo przesunąć prawdziwy, (d) doprowadzić do zapisu lub nadpisania hasła bez świadomej zgody,
      (e) zalać kandydatami, (f) pokazać w panelu mylący host (IDN, znaki kierunku). Panel a blokada sejfu.
- [ ] 5.5 Kandydat (login i hasło) w `session`: czas życia, kto go czyta, co po odebraniu uprawnienia (skrypt w
      otwartych kartach nadal zgłasza; czy tło to odrzuca).
- [ ] 5.6 `saveUrl`, `saveName`, `decideSave`: host z `sender.url`, porty, `http`, porównanie loginu; nadpisanie hasła
      bez kopii starego.
- [ ] 5.7 **T10** po stronie wtyczki: co trafia do konsoli service workera i stron.

### Etap 6. Android: sejf, blokada, odcisk, zmiana hasła

Pliki: `android/app/src/main/AndroidManifest.xml`, `res/xml/*`, `android/app/build.gradle.kts`, `proguard-rules.pro`;
`AA/{PassHolderApp,MainActivity,AppViewModel,LockController,LeaveLock,BiometricController,BiometricUnlock,KeystoreSecretWrapper,MasterPasswordRules,SecureClipboard,SyncController}.kt`,
`AA/ui/{LockedScreen,StartScreen,ChangePasswordScreen,SettingsScreen,RestoreScreen,DevicesScreen,Common}.kt`;
`AC/p2p/{PhoneVaultStore,PhoneVault,HostState}.kt`.

- [ ] 6.1 Manifest: komponenty eksportowane, kopie zapasowe, ruch jawny, brak `debuggable`; `FLAG_SECURE` na każdym
      oknie z sekretem. **T12.**
- [ ] 6.2 Nakładki (tapjacking) na przyciskach krytycznych: odblokowanie, eksport, „Zapisz” w podglądzie.
- [ ] 6.3 Blokada: wszystkie drogi (wyjście, ekran, 15 min, okno wyboru pliku 60 s, aktywności autouzupełniania);
      po `lock()` klucze wyzerowane i odszyfrowane wpisy usunięte ze stanu ekranów; nic wrażliwego w zapisanym stanie
      instancji (`rememberSaveable`).
- [ ] 6.4 Odcisk: parametry klucza Keystore, `CryptoObject` naprawdę użyty do odszyfrowania, unieważnienie po nowym
      odcisku, brak przejścia na PIN telefonu, kasowanie danych i aliasu przy wyłączeniu, zmianie hasła, usunięciu sejfu.
- [ ] 6.5 Zmiana hasła (PR #48): sprawdzenie starego hasła, atomowy zapis `host.json`, usunięcie urządzeń, oferty
      parowania i żywych sesji, wyłączenie odcisku, pozostałości starego `wrappedVaultKey`, awaria w połowie.
- [ ] 6.6 `MasterPasswordRules` we wszystkich miejscach, gdzie powstaje nowe hasło; **T13** na telefonie.
- [ ] 6.7 `KeystoreSecretWrapper`: co chroni i co daje kopia plików bez Keystore (zaakceptowany brak uwierzytelnienia).
- [ ] 6.8 Schowek (regresja N6); **T10** w logcat.

### Etap 7. Android: autouzupełnianie i zapis

Pliki: `AA/autofill/*.kt`, `AA/AutofillStatus.kt`, `AA/ui/{AutofillUnlockScreen,SaveReviewScreen}.kt`,
`res/layout/autofill_item.xml`, `res/xml/autofill_service.xml`; `AC/autofill/*.kt`, `AC/save/*.kt`.

- [ ] 7.1 Zaufanie do `webDomain` i pakietu: **T7, T8, T6**; dopasowanie aplikacji po `androidApps`.
- [ ] 7.2 Co widać przed wyborem podpowiedzi (wiersz, pasek klawiatury) i kto to widzi; wartości dopiero po wyborze.
- [ ] 7.3 `ViewNodeReader` i `planRequest`: pola ukryte i wyłączone; czy aplikacja wyciągnie więcej pól, niż
      użytkownik widzi (np. hasło przy samym polu loginu).
- [ ] 7.4 Zablokowany sejf: **T11**, czemu aktywność ufa z intencji, wynik uwierzytelnienia, blokada D1 po każdej
      ścieżce wyjścia (Wstecz, Anuluj, tło, obrót).
- [ ] 7.5 Zapis: `clientState`, `readSaveData`, `PendingSave` (pamięć, 2 min, jeden slot), podgląd, `saveReviewed`;
      API 26–27 zapisuje bez podglądu (nadpisanie hasła bez potwierdzenia).
- [ ] 7.6 Usługa: brak kluczy i wpisów między żądaniami, `LeaveLock.expired()`, wyjątki, własny pakiet.

### Etap 8. Import, eksport, ZIP, pliki lokalne

Pliki: `core/src/transfer/*`, `AC/transfer/*`; `extension/src/views/transfer.ts`, `import-summary.ts`,
`views/forms/attachments.ts`, `ui/download.ts`, w `vault-store.ts`: `importContents`, `exportArchive`, `importArchive`;
`AA/{TransferFiles,ImportSummary,AttachmentFiles}.kt`, `AA/ui/TransferScreen.kt`, `AA/ui/forms/AttachmentsEditor.kt`;
w `AC/p2p/PhoneVaultStore.kt`: `importArchive`, `addFile`, `readFile`.

- [ ] 8.1 ZIP (A4): limity liczone w trakcie rozpakowywania, ZIP64, szyfrowanie, metody, nakładające się pozycje,
      deskryptory danych, CRC, nazwy (`..`, bezwzględne, NUL, długie). **T16.** Nazwa z archiwum nigdy nie staje się
      ścieżką; sprawdź też nazwę podpowiadaną przy „Pobierz” i eksporcie.
- [ ] 8.2 JSON i CSV (A4): limit rozmiaru po obu stronach, głębokie zagnieżdżenie (stos w Kotlinie), `__proto__`,
      bardzo wiele wpisów (czas wykrywania duplikatów), ogromne pola, znaki sterujące i kierunku w nazwach.
- [ ] 8.3 Import nigdy nie nadpisuje ani nie usuwa; atomowość; sprzątanie po błędzie i po blokadzie w trakcie.
- [ ] 8.4 Eksport: **T15**; treść jawna tylko w pamięci, zerowanie, brak kopii tymczasowych. **T14.**
- [ ] 8.5 Załączniki: limit sprawdzany przed wczytaniem całości, reguły nazwy i MIME, IndexedDB bez limitu.

### Etap 9. Zależności, budowanie, repozytorium

- [ ] 9.1 `npm audit` i `npm audit --omit=dev`; zależności produkcyjne to tylko `@noble/*`; `package-lock.json`
      (wszystko z `registry.npmjs.org`, sumy `integrity`); paczka wtyczki nie ładuje zdalnego kodu.
- [ ] 9.2 Gradle: wersje z `android/gradle/libs.versions.toml` (BouncyCastle 1.82 i reszta) względem znanych podatności;
      jeśli baza OSV jest niedostępna, zapisz „nie sprawdzono” i polecenie do uruchomienia na Windows (jak w TESTY.md).
      Repozytoria tylko `google()` i `mavenCentral()`. **T17.**
- [ ] 9.3 Sekrety w repo i historii: `git log -p --all` pod kątem kluczy, haseł, `keystore`, `.env`; skan sekretów
      GitHuba, jeśli dostępny; `.gitignore`; wektory i zrzuty ekranów bez prawdziwych danych.
- [ ] 9.4 Wydanie Androida: R8, brak ustawień debug w `release` (klucz debug zaakceptowany).

### Etap 10. Dokumentacja i raport

- [ ] 10.1 Każde zdanie z sekcji „Bezpieczeństwo” i „Ograniczenia” w `FUNKCJE.md`, `SYNCHRONIZACJA.md` §9, `SPEC.md`
      §1–3 i `INSTALACJA.md` porównaj z kodem. Rozbieżność to znalezisko (co najmniej I).
- [ ] 10.2 Dokończ raport (sekcja 7), przeczytaj go raz jako całość: brak duplikatów, każda waga zgodna ze skalą.
- [ ] 10.3 `docs/ARCHITEKTURA.md`: w „Stan przeglądu bezpieczeństwa” dopisz wiersz z odnośnikiem do nowego raportu;
      `README.md`: wiersz w tabeli dokumentacji.
- [ ] 10.4 PR z samą dokumentacją. Odpowiedź w wątku: liczby według wagi, trzy najważniejsze punkty, proponowane grupy
      poprawek. Zapisz stan w pamięci projektu.

## 7. Format raportu (`docs/PRZEGLAD_BEZPIECZENSTWA_V3.md`)

1. **Nagłówek:** data, hash, metoda (co czytane, co uruchomione, czego nie zrobiono), model zagrożeń (odnośnik do tego planu).
2. **Podsumowanie:** tabela liczby znalezisk według wagi; 3–5 zdań oceny; tabela wszystkich znalezisk
   (`ID | Waga | Pewność | Obszar | Problem`).
3. **Znaleziska**, od najważniejszych, każde według wzoru:

```markdown
### V3-S1. Tytuł w jednym zdaniu
- **Waga / pewność:** Średnia / z kodu
- **Napastnik:** A2 · **Obszar:** wtyczka, pytanie o zapis · **Powiązanie:** trop T5 (albo stary punkt, albo „nowe”)
- **Miejsce:** `extension/src/save/watch.ts:58-72` (`show`)
- **Opis:** co robi kod i dlaczego to słabość.
- **Atak:** kroki 1–3 z punktu widzenia napastnika.
- **Skutek:** co zyskuje napastnik; czego nie zyskuje.
- **Naprawa:** konkretna zmiana, koszt (mały / średni / duży), test, który by to wykrył.
```

4. **Tropy odrzucone:** tabela `T# | Dlaczego nie jest problemem` (jedno zdanie i miejsce w kodzie).
5. **Sprawdzone i w porządku:** po 2–5 punktów na etap.
6. **Nie sprawdzono:** uczciwa lista (prawdziwy telefon, prawdziwy Chrome, podatności Gradle, testy ręczne).
7. **Proponowane grupy poprawek:** 3–6 grup, każda na jeden wątek i PR, w kolejności wykonania; osobno lista decyzji
   dla właściciela (punkty, gdzie naprawa zmienia zachowanie).

## 8. Gdzie najłatwiej coś przeoczyć

Miejsca, których testy automatyczne nie pokrywają, a które w tej wersji są nowe. Poświęć im najwięcej czasu:

1. Panel pytania o zapis osadzony w obcej stronie (T5) i komunikaty do tła (T9).
2. Nieuwierzytelnione wejście na port 8787 z sieci i ze strony WWW (T1–T4).
3. Zaufanie usługi autouzupełniania Androida do nazwy pakietu i domeny (T6–T8, T11).
4. Różnice między TypeScriptem a Kotlinem dla wejścia spoza wektorów (kroki 1.6, 2.5, T16).
5. Stan po zmianie hasła głównego i ponownym parowaniu (kroki 4.5, 6.5).
6. Treść jawna poza sejfem: logi, pliki tymczasowe, schowek, zapisany stan ekranów (T10, kroki 6.3, 8.4).
