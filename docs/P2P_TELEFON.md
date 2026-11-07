# Telefon jako host synchronizacji (część A planu 3)

Dokument opisuje to, co w planie 3 (projekt w `SYNCHRONIZACJA_P2P.md`) robi telefon: własny sejf w
aplikacji, serwer HTTP, parowanie kodem i ekrany trybu synchronizacji. Część B (wtyczka paruje się z
telefonem) dochodzi w PR 3b. Rdzeń protokołu (`P2pHost`, CPace, Noise) opisuje `P2P_ANDROID_RDZEN.md`, więc
tu go nie powtarzamy. Kod: `android/core/src/main/kotlin/io/github/sheking94/passholder/core/p2p/` (czysty
Kotlin/JVM) i `android/app/src/main/kotlin/io/github/sheking94/passholder/app/` (Compose). Gałąź: `claude/project-thread-0590i1`.

Sejf jest na telefonie, a wtyczka ma synchronizować się z nim bezpośrednio po Wi-Fi albo Tailscale (bez Pi).

## 1. Pliki i odpowiedzialności

`core/.../core/p2p/`:

| Plik | Co robi |
|---|---|
| `SyncHttpServer.kt` | Minimalny serwer HTTP/1.1 na gniazdach: jedno `POST` na połączenie, `Connection: close`, ścisły parser, limity (punkt 3). |
| `PhoneRouter.kt` | Jedyny handler serwera: `ping`, parowanie i Noise (`handshake`, `sync`). Stałe `PhoneSync.PORT = 8787` i `SYNC_IDLE_MS = 300_000`. |
| `PairingHost.kt` | Strona telefonu w parowaniu po HTTP (`hello`, `start`, `finish`): jedna oferta, jedna próba (punkt 2). |
| `PhoneVaultStore.kt` | Wszystko, co aplikacja robi z sejfem telefonu: tworzenie, odtwarzanie, blokada, wpisy, urządzenia, `router()` dla serwera. Własna baza pod `filesDir/p2p/`. |
| `FileSyncStore.kt` | Trwały `SyncStore`: JSON Lines (`records.jsonl`), punkt 4. |
| `HostState.kt` | `HostState` / `HostStateStore` (`host.json`), `SecretWrapper`, `StoredDevice`. |
| `LocalAddresses.kt` | Adresy telefonu dla wtyczki: tylko IPv4, bez loopback i link-local, zakres Tailscale (`100.64.0.0/10`) na końcu, najwyżej `Pairing.MAX_ADDRESSES`. |
| `P2pHost.kt` (zmiana) | Dwa nowe parametry: `onSynced(deviceId)` po każdej udanej synchronizacji (zapis czasu w `host.json`) i `onError`. |

`app/.../app/`:

| Plik | Co robi |
|---|---|
| `SyncController.kt` | Tryb synchronizacji: start i stop serwera, kod parowania, zdarzenia („Sparowano”, „Zsynchronizowano”), zatrzymanie po 5 min bez połączeń. |
| `AppViewModel.kt` | Ekrany `Start`, `Locked`, `List`, `Edit`, `Sync`, `Devices`, `Restore`; woła `PhoneVaultStore` i `SyncController` poza głównym wątkiem. |
| `KeystoreSecretWrapper.kt` | Zawija prywatny klucz tożsamości telefonu kluczem AES-256-GCM z Android Keystore (punkt 5). |
| `MainActivity.kt` | `FLAG_KEEP_SCREEN_ON` na czas trybu synchronizacji, `onStop` zatrzymuje go. |
| `ui/SyncScreen.kt`, `DevicesScreen.kt`, `RestoreScreen.kt`, `StartScreen.kt` | Ekrany z punktu 7. |

Sejf telefonu to osobny byt od v1 (`VaultStore`): ma własną tożsamość, epokę i klucz. `PhoneVaultStore` używa
`PhoneVault` i `FileSyncStore` jako jednego sklepu, więc zmiany z telefonu i z wtyczki idą tą samą drogą.

## 2. Protokół parowania po HTTP

Wszystkie żądania to `POST` z ciałem JSON; dane binarne w Base64 z dopełnieniem. Telefon ma najwyżej jedną
aktywną ofertę `{code, sid, mode, expiresAt}`: kod to 8 cyfr, ważny 2 min (`PAIRING_CODE_TTL_MS`), `sid` to
16 losowych bajtów, `mode` to `"pair"` (zwykły sejf) albo `"restore"` („Odtwórz z wtyczki”).

| Ścieżka | Żądanie | Odpowiedź 200 | Błędy |
|---|---|---|---|
| `/p2p/v1/ping` | `{}` | `{"ok":true}` | |
| `/p2p/v1/pair/hello` | `{}` | `{sid, mode}` | 404 `no pairing` (brak oferty, wygasła albo już zużyta) |
| `/p2p/v1/pair/start` | `{sid, message}` (`lv_cat(Ya, adA)`) | `{message}` (`lv_cat(Yb, adB)`) | 400 `malformed request` (brak pól, nie Base64), 404 `no pairing` (inny `sid`, oferta zużyta), 400 `pairing failed` (zły element CPace) |
| `/p2p/v1/pair/finish` | `{sid, identity, vaultInfo?}` | `{identity, vaultInfo}` | 400 `malformed request`, 404 `no pairing`, 403 `pairing failed` |
| `/p2p/v1/handshake`, `/p2p/v1/sync` | Noise KK, jak w `P2P_ANDROID_RDZEN.md` | | 503 `vault not ready`, kody z `P2pHost` |

Zasady:

- `/pair/start` zużywa ofertę od razu, także gdy zakończy się błędem: jedna próba na kod. Klucz parowania
  czeka na `/pair/finish` najwyżej 30 s (`PAIRING_FINISH_TTL_MS`); `/pair/finish` jest jednorazowe bez
  względu na wynik.
- `identity` i `vaultInfo` w `finish` są zapieczętowane kluczem z CPace (rola `initiator`; odpowiedź rolą
  `responder`). `vaultInfo` w żądaniu jest wymagane wtedy i tylko wtedy, gdy `mode = "restore"`, w
  przeciwnym razie 400. 403 oznacza, że blob się nie otwiera, czyli wtyczka użyła innego kodu.
- Udane `finish` dopisuje `StoredDevice` (to samo `deviceId` zastępuje stary wpis). W trybie `restore`
  telefon zapisuje też `kdf` i `wrappedVaultKey` z `vaultInfo` wtyczki (`Kdf.assertAcceptable` musi przejść,
  inaczej 400); jej `epoch` i adresy są ignorowane. Odpowiedź niesie epokę telefonu, jego `kdf`,
  `wrappedVaultKey` i bieżące adresy.
- Gdy po `/pair/start` stan telefonu się zmienił (tryb oferty już nie pasuje do sejfu), albo zapis się nie
  udał: 500 `internal error`, a przyczyna idzie do `onError` (logcat).
- Kolejność sprawdzeń: serwer HTTP (nagłówki i `Host`, punkt 3, potem 413) → nieznana ścieżka 404 →
  `onRequest` (licznik bezczynności) → ciało nie jest obiektem JSON 400 → handler ścieżki. Tylko znane
  ścieżki liczą się jako aktywność, więc skaner w sieci nie utrzyma trybu synchronizacji przy życiu.
- `handshake` i `sync` odpowiadają 503 `vault not ready`, dopóki telefon nie ma sejfu ani odtwarzania w toku.
  Działają przy zablokowanym sejfie: host przenosi tylko zaszyfrowane bloby.

## 3. Serwer HTTP i jego limity

`SyncHttpServer` słucha na porcie 8787 na wszystkich interfejsach. Każdy w sieci może się połączyć, zanim
się uwierzytelni, więc:

| Limit | Wartość | Efekt przekroczenia |
|---|---|---|
| Ciało żądania | 1 MiB (`P2pHost.MAX_BODY_BYTES`), liczone z `Content-Length` przed czytaniem | 413 |
| Nagłówki (linia żądania i nagłówki razem) | 16 KiB | 431 |
| Czas na całe żądanie (nagłówki i ciało) | 15 s łącznie; pojedynczy odczyt najwyżej 10 s | połączenie zrywane bez odpowiedzi |
| Równoległe połączenia | 4 wątki robocze i kolejka 16 oczekujących | dalsze: 503 `busy`, wysyłane od razu z wątku akceptującego |
| Błędy `accept()` | 20 pod rząd (przerwa 50 ms) | serwer zamyka gniazdo i kończy |

- Parser jest ścisły: wymagany `Content-Length` (411), brak `Transfer-Encoding` (501), tylko `POST` (405), cyfry
  w długości, jednakowe powtórzone `Host` i `Content-Length`. Błąd to JSON `{"error":"…"}`.
- **Nagłówek `Host`** musi być literałem IPv4 (każda część 0..255) albo `localhost`, z opcjonalnym portem.
  Brak nagłówka to 400, inna wartość 403 `forbidden host`. To ochrona przed DNS rebinding: strona w
  przeglądarce użytkownika, która przemapuje swoją nazwę na adres telefonu, wysłałaby własną nazwę w `Host`.
  Skutek uboczny: **adres telefonu we wtyczce musi być adresem IP**; nazwy MagicDNS z Tailscale (np.
  `telefon.tailnet.ts.net`) i adresy IPv6 dostają 403. Używaj adresu IPv4 z ekranu „Synchronizacja”.
- Kolejność w serwerze: 400 (zła linia żądania, nagłówek bez `:`, brak `Host`) → 403 (`Host`) → 405 → 501 → 411 →
  400 (zła długość) → 413 → czytanie ciała.
- Wyjątek z handlera zamienia się w 500 `internal error`.
- Serwer żyje tylko w trybie synchronizacji (punkt 7). `stop()` zamyka gniazdo nasłuchujące i przerywa wątki
  robocze (`shutdownNow`), ale nie zamyka połączeń już przyjętych ani czekających w kolejce.

## 4. Trwała baza i `host.json`

Pod `filesDir/p2p/` leżą dwa pliki.

**`records.jsonl`** (`FileSyncStore`): jeden `RemoteRecord` (zaszyfrowany wpis albo nagrobek) w linii. Każdy
`put` dopisuje linię i robi `fsync`. Przy otwarciu mapa jest odbudowywana (późniejsza linia z tym samym `id`
wygrywa), a `revision` to największa wartość w pliku.

- **Urwana ostatnia linia** (zasilanie padło w trakcie zapisu) jest odrzucana, a plik przepisany. Nieczytelna
  linia gdziekolwiek indziej to `IllegalStateException("Corrupt sync store")`, bo oznacza uszkodzenie, a nie
  przerwany zapis. Nieudany zapis może zostawić ułamek na końcu pliku; następny `put` obcina plik do ostatniej
  znanej długości, więc ułamek nigdy nie staje się linią w środku.
- **Kompaktowanie**: plik jest przepisywany (do `.tmp`, `fsync`, atomowa zamiana), gdy ma więcej niż
  `2 * rekordy + 100` linii albo po wykryciu urwanej linii.
- Nie jest bezpieczny wątkowo: wołający trzymają `synchronized(store)` (ta sama umowa co `MemorySyncStore`).
  `PhoneVaultStore` owija go w `ResettableStore`, zamykany przy resecie, żeby żądanie działające na starym
  hoście nie odtworzyło właśnie usuniętego pliku.

**`host.json`** (`HostStateStore`): `deviceId`, `epoch` (16 losowych bajtów), `wrappedStaticKey` (prywatny klucz
Noise zawinięty Keystore), `kdf`, `wrappedVaultKey` (klucz sejfu zawinięty hasłem głównym), `keyCheck`
(HMAC-SHA256 klucza sejfu, pozwala sprawdzić hasło bez żadnego wpisu) i lista `devices` (`deviceId`, nazwa,
klucz publiczny, `pairedAt`, `lastSyncAt`). Zapis: `host.json.tmp`, `fsync`, atomowa zamiana.

- `kdf == null` oznacza odtwarzanie z wtyczki w toku; `keyCheck` ustawia dopiero `createVault` albo
  `finishRestore` (po sprawdzeniu hasła głównego).
- Klucz sejfu jest w pamięci tylko przy odblokowanym sejfie. Zmiany z telefonu (`PhoneVault`) i z wtyczki trafiają
  do tego samego `records.jsonl`; wtyczka dostaje zmianę z telefonu przy następnej synchronizacji.
- Nowa tożsamość (`createVault`, `startRestore`) to nowe `deviceId`, nowa epoka i nowy klucz statyczny, a stare
  rekordy są kasowane. „Usuń sejf z telefonu” (`disconnect`) kasuje cały katalog `p2p/`.

## 5. Keystore i kopie zapasowe

- **Klucz statyczny Noise** jest zawijany w `KeystoreSecretWrapper`: AES-256-GCM, klucz o aliasie
  `passholder-p2p-wrap` powstaje przy pierwszym użyciu i nigdy nie opuszcza Keystore. Format w pliku:
  `iv.base64:ciphertext.base64`. W przeciwieństwie do klucza odcisku palca ten **nie wymaga uwierzytelnienia
  użytkownika**: telefon musi odpowiadać wtyczce także przy zablokowanym sejfie. Klucz sejfu nie jest przez
  Keystore chroniony, tylko hasłem głównym (Argon2id).
- Brak klucza w Keystore przy odczycie (np. dane aplikacji przeniesione na inny telefon) to błąd, a nie nowy
  klucz: to, co zawinął, jest nie do odzyskania. Skutek: 500 przy `handshake`, przyczyna w logcat
  (`Log.w`, tag `PassHolder`).
- **Kopie zapasowe wyłączone**: `android:allowBackup="false"`, `android:fullBackupContent="false"` i
  `res/xml/data_extraction_rules.xml`, które wyklucza `root`, `file`, `database` i `sharedpref` zarówno z
  kopii w chmurze, jak i z transferu między urządzeniami. Powód: odtworzony z kopii `host.json` miałby ten
  sam `epoch` i stare numery rewizji, a klucz Keystore i tak nie przeżyłby przeniesienia. Test
  `BackupRulesTest` pilnuje obu plików.
- Kopią zapasową sejfu jest wtyczka: „Odtwórz z wtyczki” (punkt 8).

## 6. Uszkodzony stan

Gdy `host.json` nie da się odczytać, `PhoneVaultStore` nie rzuca z konstruktora, tylko ustawia
`corruptState`. Wtedy:

- `hasVault` i `restoreInProgress` są fałszywe, `handshake` i `sync` dają 503, a `ping` działa,
- `createVault` i `startRestore` odmawiają („Nie mogę odczytać danych sejfu na telefonie. Najpierw je
  usuń.”), żeby nic po cichu nie nadpisało uszkodzonych danych,
- `StartScreen` pokazuje tylko komunikat i przycisk „Usuń sejf z telefonu” (zrzut `29-uszkodzony-sejf.png`);
  `disconnect` czyści flagę i katalog,
- przyczyna idzie do `onError` (logcat). Uwaga: komunikat wyjątku parsera może zawierać fragment
  `host.json`, który trafia do logcat; plik nie zawiera jawnych sekretów (klucze są zawinięte).

Uszkodzony `records.jsonl` (nieczytelna linia w środku) rzuca przy otwarciu sklepu (punkt 4); aplikacja nie ma
dla niego osobnego ekranu.

## 7. Ekrany i cykl życia trybu synchronizacji

Ekrany (zrzuty w `android/app/screenshots/`):

| Ekran | Co robi | Zrzut |
|---|---|---|
| Start | „Nowy sejf” albo „Odtwórz z wtyczki” | `01-start-nowy-sejf.png`, `10-start-odtworz-z-wtyczki.png` |
| Lista | przyciski „Synchronizacja” i „Urządzenia” | `05-lista.png` |
| Synchronizacja | włącza serwer; pokazuje adresy (`http://<IPv4>:8787`), „Dodaj wtyczkę” daje 8-cyfrowy kod z odliczaniem 2 min; ostatnie zdarzenie; „Zakończ” | `20-synchronizacja.png`, `21-kod-parowania.png`, `22-zsynchronizowano.png` |
| Urządzenia | sparowane wtyczki z datą parowania i ostatniej synchronizacji; „Usuń” (po potwierdzeniu wtyczka dostaje 403 przy następnym uzgadnianiu) | `23-urzadzenia.png`, `24-usuwanie-urzadzenia.png` |
| Odtwarzanie z wtyczki | serwer od razu z kodem; po sparowaniu i przesłaniu sejfu prosi o hasło główne | `26-odtwarzanie-kod.png`, `27-odtwarzanie-haslo.png`, `28-odtworzony-sejf.png` |
| Usuń sejf z telefonu | na ekranie blokady, z potwierdzeniem | `11-usuwanie-sejfu.png` |

Cykl życia (`SyncController`, `AppViewModel`, `MainActivity`):

- **Start**: „Synchronizacja” na liście włącza serwer w tle. Bez adresów (brak Wi-Fi) ekran mówi, żeby
  połączyć telefon z siecią. Gdy port jest zajęty: „Nie mogę uruchomić synchronizacji: port 8787 jest zajęty.”
- **5 minut bez połączeń** wyłącza tryb („Tryb synchronizacji wyłączony po 5 min bez połączeń.”). Sprawdza to
  `checkAutoLock` co 15 s, więc faktyczny czas to 5 min do 5 min 15 s. Liczą się tylko żądania na znane ścieżki.
- **Wyjście z aplikacji** (`onStop`, poza obrotem ekranu) wyłącza tryb od razu („…po wyjściu z aplikacji.”),
  także przy blokadzie opóźnionej o 60 s. Przycisk „Włącz ponownie” startuje go na nowo.
- **Blokada** sejfu (przycisk, auto-blokada po 15 min, wyjście) zatrzymuje tryb synchronizacji. Ekrany
  „Synchronizacja” i „Urządzenia” są dostępne tylko przy odblokowanym sejfie.
- **Ekran nie gaśnie** (`FLAG_KEEP_SCREEN_ON`), dopóki serwer działa, bo wygaszenie ekranu to wyjście z
  aplikacji. Okno ma też `FLAG_SECURE` (bez zrzutów ekranu), co jest powodem, że zrzuty w repozytorium
  powstają z testów, a nie z urządzenia.
- Każdy start trybu zgłasza własny kod: `router()` odrzuca ofertę z poprzedniego startu. „Zakończ” i
  „Wstecz” zatrzymują serwer i odświeżają listę wpisów; lista odświeża się też po każdej synchronizacji
  (inaczej edycja mogłaby nadpisać świeższą zmianę z wtyczki).
- Zdarzenia na ekranie: „Sparowano: <nazwa>” i „Zsynchronizowano z: <nazwa>”.
- Jeśli kod wygasł albo został zużyty (także cudzą, nieudaną próbą), ekran każe ponownie dotknąć „Dodaj
  wtyczkę”.

## 8. Odtwarzanie z wtyczki

Dla telefonu bez sejfu (nowy, po „Usuń sejf”): Start → „Odtwórz z wtyczki” → „Rozpocznij odtwarzanie”.

1. Telefon tworzy nową tożsamość bez sejfu (`kdf == null`), uruchamia serwer i pokazuje adres z kodem.
   Oferta ma `mode = "restore"`.
2. Wtyczka paruje się i w `finish` przesyła `vaultInfo` (`kdf`, `wrappedVaultKey`), a potem synchronizuje
   wszystkie wpisy do telefonu.
3. Gdy telefon ma sparowane urządzenie z `lastSyncAt` i jakieś rekordy, prosi o hasło główne tego sejfu.
   `finishRestore` odwija klucz, zapisuje `keyCheck` i odblokowuje sejf. Złe hasło niczego nie zmienia.
4. „Przerwij odtwarzanie” kasuje wszystko i wraca na ekran startowy.

Po zapisaniu `vaultInfo` pierwszej wtyczki tylko ta sama wtyczka może sparować się ponownie w tym
odtwarzaniu; druga dostaje 500 (patrz ograniczenia).

## 9. Testy i komendy

Linux:

```bash
cd android
./gradlew :core:test --console=plain                  # rdzeń: protokół, serwer, baza, sejf telefonu
./gradlew :app:testDebugUnitTest --console=plain      # ekrany (Robolectric) i SyncController, ok. 5 min
./gradlew :core:test :app:testDebugUnitTest --console=plain   # oba naraz
cd .. && npm test && npm run typecheck                 # strona TypeScript (bez zmian)
```

Windows (PowerShell, JDK 21 jak w `P2P_ANDROID_RDZEN.md`):

```powershell
cd android
$env:JAVA_HOME="$HOME\.jdks\jbr-21.0.11"
.\gradlew.bat :core:test --console=plain
.\gradlew.bat :app:testDebugUnitTest --console=plain
.\gradlew.bat :core:test --tests "*SyncHttpServerTest*" --console=plain    # jeden plik
cd ..; npm test; npm run typecheck
```

Co sprawdzają nowe testy:

| Test | Co sprawdza |
|---|---|
| `SyncHttpServerTest` (core) | parser i kody błędów, limity ciała i nagłówków, całkowity termin żądania (też powolne bajty), kolejka i 503, `Host` (IPv4, `localhost`, obce nazwy, `[::1]`), przeżycie przejściowych błędów `accept()`, zamknięcie gniazda po nieudanym `bind`. |
| `FileSyncStoreTest` | odbudowa po restarcie, urwana ostatnia linia, uszkodzenie w środku, kompaktowanie, obcięcie ułamka po nieudanym zapisie. |
| `HostStateTest`, `PlainSecretWrapper` | zapis i odczyt `host.json`, uszkodzona zawartość; zawijanie w testach to zwykłe Base64. |
| `PairingHostTest` | tabela z punktu 2: jedna próba, TTL klucza, tryb `restore`, błędy 400/403/404/500. |
| `PhoneRouterTest`, `LocalAddressesTest` | kolejność sprawdzeń i licznik bezczynności; filtrowanie i kolejność adresów. |
| `PhoneVaultStoreTest` | tworzenie, odblokowanie, odtwarzanie, usuwanie urządzeń, uszkodzony `host.json`, odrzucenie starej oferty, `onError`. |
| `SyncControllerTest`, `SyncScreenTests`, `CorruptHostStateTest`, `BackupRulesTest` (app) | cykl życia trybu, ekrany ze zrzutami, odświeżenie listy po synchronizacji (prawdziwy klient `TestP2pClient`), uszkodzony stan, reguły kopii zapasowych. |

Zrzuty ekranów powstają przy uruchomieniu testów aplikacji; kod i hasła na nich są losowe, więc zmieniają się
przy każdym uruchomieniu.

## 10. Znane ograniczenia

- **Tylko adres IPv4.** Nazwy (MagicDNS) i IPv6 dostają 403 `forbidden host` (punkt 3). Część B musi wymagać
  adresu IP albo wytłumaczyć ten błąd.
- **Kod parowania można spalić z sieci.** Każdy w LAN zna `sid` (z `/pair/hello`) i jedną błędną próbą zużywa
  kod i klucz; to nieusuwalne przy jednej próbie na kod, więc ekran każe wziąć nowy kod.
- **Klucz parowania nie jest zerowany**, a wygasły oczekujący klucz zostaje w pamięci do następnej oferty,
  `finish` albo `cancel`.
- **Serwer HTTP**: `stop()` nie zamyka przyjętych połączeń (kończą się na terminie 15 s). Odpowiedź 413 jest
  wysyłana bez czytania ciała, więc klient może dostać reset zamiast odpowiedzi; 503 `busy` może zginąć w
  resecie, mimo opróżniania nadesłanych bajtów. Gdy wątek akceptujący padnie po 20 błędach, serwer się zamyka,
  ale ekran tego nie widzi (pokazuje „działa”, dopóki ktoś nie wyjdzie z trybu).
- **Brak `fsync` katalogu po zamianie pliku** (`host.json`, kompaktowanie): po utracie zasilania zamiana może
  się nie utrwalić. Błąd `fsync` po pełnym zapisie linii może wskrzesić rekord po restarcie.
- **Niektóre błędy to 500 zamiast kodu 4xx**: wyjątek z `identity()` w `/pair/start` (inny niż
  `IllegalArgumentException`) i nieudane `onPaired` (np. druga wtyczka w odtwarzaniu, które już dostało sejf)
  dają 500, a przyczyna jest tylko w logcat.
- **Usunięcie jedynego urządzenia w trakcie odtwarzania** (po zapisaniu `vaultInfo`) wymaga przerwania i
  rozpoczęcia odtwarzania od nowa: nikt już nie może się sparować w tym stanie.
- **Wiele wywołań `router()`** (każdy start trybu) nadpisuje wspólne adresy i hosta; stara oferta jest
  odrzucana, ale oferta w trybie `restore` może po zmianie stanu dać 500.
- **Komunikat wyjątku parsera w logcat** (punkt 6).
- **Pozostałości v1**: `filesDir/vault` starego sejfu v1 zostaje na dysku, w `network_security_config.xml`
  jest komentarz o certyfikacie Pi, a w testach aplikacji została zależność `okhttp.tls`. Znikną w planie 4.
- **Testy**: brak testów zajętego portu, obrotu ekranu przy działającym serwerze, wygasania kodu przez zegar
  i „Anuluj”/„jeszcze nie”; brak testu, że „Synchronizacja” i „Urządzenia” znikają po blokadzie.
  `SyncController.stop` bywa wołane z głównego wątku (ryzyko ANR przy zablokowanym kontrolerze), a `start`
  trzyma jego blokadę podczas `bind`.
- Ograniczenia samego protokołu: `P2P_RDZEN.md` §6 i `P2P_ANDROID_RDZEN.md` §6.

## 11. Testy ręczne na telefonie

Po PR 3b (pełny przepływ z wtyczką dojdzie w części B; na razie bez niej):

1. Zainstaluj aplikację (z katalogu `android/`: `./gradlew :app:installDebug`).
2. Start → „Nowy sejf”, hasło główne co najmniej 12 znaków. Pojawia się pusty sejf.
3. „+ Dodaj” (z generatorem hasła) i zapisz. Wpis jest na liście.
4. „Synchronizacja”: ekran pokazuje adres `http://<IPv4>:8787` (Wi-Fi) i po „Dodaj wtyczkę” 8-cyfrowy kod z
   odliczaniem. Ekran nie gaśnie.
5. Z komputera w tej samej sieci Wi-Fi:

   ```bash
   curl -X POST -H "Content-Type: application/json" -d "{}" http://<IP>:8787/p2p/v1/ping
   ```

   Oczekiwana odpowiedź: `{"ok":true}`. Z nazwą zamiast IP w adresie (jeśli się rozwiąże) powinno być 403 `forbidden host`.
6. Wyjdź z aplikacji (Home) i wróć: tryb jest wyłączony („…po wyjściu z aplikacji”), „Włącz ponownie” go
   uruchamia; `curl` w międzyczasie nie dostaje odpowiedzi.
7. „Urządzenia”: na razie pusto („Brak sparowanych wtyczek”).
8. Zablokuj sejf i odblokuj go hasłem (i odciskiem, jeśli włączony).
9. Zablokuj i „Usuń sejf z telefonu” (z potwierdzeniem): wraca ekran startowy.
10. Start → „Odtwórz z wtyczki” → „Rozpocznij odtwarzanie”: ekran pokazuje adres i kod; „Przerwij odtwarzanie” wraca
    na start.
