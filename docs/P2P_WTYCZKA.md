# Wtyczka paruje się z telefonem (część B planu 3)

Dokument opisuje to, co w planie 3 (projekt w `SYNCHRONIZACJA_P2P.md`) robi wtyczka Chrome: parowanie kodem
z telefonem, synchronizację przez Noise KK i adresy telefonu. Stronę telefonu (serwer, `PairingHost`,
ekrany) opisuje [`P2P_TELEFON.md`](P2P_TELEFON.md), a protokół [`P2P_RDZEN.md`](P2P_RDZEN.md); tu ich nie
powtarzamy. Kod: `extension/src/` i `core/src/p2p/pair-client.ts`. Gałąź: `p2p-3b`.

Od tej wersji wtyczka nie łączy się z Pi. Sejf jest na telefonie, a wtyczka trzyma zaszyfrowaną kopię.

## 0. Zanim zaktualizujesz: CSV

**Wyeksportuj hasła do CSV w starej wtyczce (v1, z Pi), zanim ją zaktualizujesz.** Nowa wtyczka nie czyta
kluczy v1 (`account`, `vault` w `chrome.storage.local`) i nie ma migracji. Po aktualizacji stare dane leżą
tam nadal, nieczytane (także po planie 4; usuwa je dopiero usunięcie wtyczki); z nowej wtyczki nie da się
ich już wyeksportować.

Przeniesienie haseł: eksport CSV w starej wtyczce → aktualizacja → „Nowy sejf” na telefonie → parowanie
wtyczki (punkt 2) → „CSV” → import we wtyczce → „Synchronizuj”. Zaimportowane wpisy są zmianami lokalnymi,
więc pierwsza synchronizacja wysyła je na telefon.

## 1. Pliki i odpowiedzialności

| Plik | Co robi |
|---|---|
| `core/src/p2p/pair-client.ts` | Klient parowania po HTTP: `pingPhone`, `phoneHello`, `pairWithPhone`. Wtyczka jest inicjatorem CPace. Kod musi mieć 8 cyfr (spacje są usuwane), inaczej błąd przed `/pair/start`, więc literówka nie spala kodu. |
| `core/src/p2p/transport.ts` (zmiana) | Prywatne `call` stało się eksportowanym `callP2pHost(post, url, body, messages)`; `messages[status]` podmienia komunikat błędu. |
| `extension/src/phone-client.ts` | `PhoneClient`: JSON `POST`, limit 30 s na całą wymianę (`POST_TIMEOUT_MS`), błąd sieci i przekroczenie czasu to „Telefon nie odpowiada…”. `phoneErrorInPolish` tłumaczy angielskie błędy rdzenia. |
| `extension/src/phone-urls.ts` (do planu 4 `server-urls.ts`) | `normalizePhoneUrl`: tylko `http://<IPv4>:<port>` albo `localhost` (domyślny port 8787, bez zer wiodących w oktetach). `learnedPhoneUrls` po cichu pomija adresy, których wtyczka nie użyje. `pickPhone` (do planu 4 `pickServer`) próbuje adresy po kolei (ping 4 s, `PROBE_TIMEOUT_MS`). |
| `extension/src/vault-store.ts` | Cały sejf wtyczki na `LocalVaultV2`: `pairStart`, `pairFinish`, `repair`, `sync`, `disconnect`, blokada, PIN. |
| `extension/src/storage.ts` | Klucze w pamięci (punkt 4). |
| `extension/src/pin-lock.ts` | PIN owija tylko `{vaultKey}`. |
| `extension/src/views/connect.ts` | „Sparuj z telefonem”: krok 1 (adresy, kod, nazwa), krok 2 (hasło główne). |
| `extension/src/views/addresses.ts` | „Adresy telefonu”: lista adresów i „Sparuj z innym telefonem / odtwórz telefon”. |
| `extension/src/ui/phone-url-fields.ts` (do planu 4 `server-url-fields.ts`) | Pola adresów, wzorzec zgody `http://<ip>:<port>/*`, prośby o zgodę Chrome. |
| `extension/src/views/list.ts`, `locked.ts` | „Zsynchronizowano z telefonem HH:MM”, „Adresy telefonu”, „Odłącz” z ostrzeżeniem. |
| `extension/static/manifest.json` | `optional_host_permissions: ["http://*/*"]`, opis „…synchronizowany z telefonem”. |

`extension/src/api.ts` (klient Pi) jest usunięty. Resztę v1 (`core/src/sync.ts`, `server/`) usunął plan 4
([`P2P_USUNIECIE_SERWERA.md`](P2P_USUNIECIE_SERWERA.md)).

## 2. Parowanie nowej przeglądarki

Okienko wtyczki przenosi parowanie do karty `?setup`, bo Chrome zamyka okienko, gdy pokazuje prośbę o zgodę.

1. Telefon: Synchronizacja → „Dodaj wtyczkę” (kod 8 cyfr, 2 min, jedna próba).
2. Wtyczka, krok 1: adresy z ekranu telefonu, kod i nazwa przeglądarki (domyślnie `Chrome (<platforma>)`,
   1..64 znaki). „Sparuj” najpierw prosi Chrome o zgodę na `http://<ip>:8787/*` dla każdego adresu (na
   kliknięciu, przed jakimkolwiek `await`), potem `pairStart`:
   - odmawia, gdy przeglądarka jest już sparowana („Użyj „Sparuj z innym telefonem””),
   - przy kilku adresach `pickPhone` pinguje je i paruje z pierwszym, który odpowie,
   - `/pair/hello`: gdy telefon czeka na odtworzenie (`mode = "restore"`), błąd `PHONE_WAITS_FOR_RESTORE`
     bez spalenia kodu,
   - nowe `deviceId` (UUID) i klucz X25519, `pairWithPhone`, wynik jako `pendingPairing` w
     `chrome.storage.session` z `createdAt`.
3. Po `/pair/finish` telefon już zna przeglądarkę („Urządzenia”). Wtyczka, krok 2: hasło główne sejfu
   telefonu. `pairFinish` odwija nim `wrappedVaultKey` z `vaultInfo`. Ten sam klik prosi (raz na ekran, bez
   wymagania zgody) o zgodę na adresy, które telefon podał poza wpisanymi.
   - **Złe hasło**: „Złe hasło główne”, parowanie zostaje; można próbować dalej bez nowego kodu, także po
     zamknięciu karty.
   - **10 min** (`PAIRING_PENDING_MS`): starsze parowanie (albo z przyszłości, gdy zegar się cofnął) jest
     usuwane: „Parowanie wygasło. Poproś telefon o nowy kod. Na telefonie usuń „X” z „Urządzenia”.”
   - „Anuluj parowanie”: to samo zdanie o usunięciu urządzenia na telefonie.
4. Dobre hasło: wyłącza stary PIN, zapisuje konto, `applyVaultInfo`, sesja, usuwa `pendingPairing`, pierwsza
   synchronizacja. Gdy ta się nie uda, konto i tak jest zapisane: `PairedButSyncFailed` („Sparowano z
   telefonem, ale pierwsza synchronizacja się nie udała: …”), lista działa.

Błędy telefonu po polsku: 404 → „Telefon nie czeka na parowanie albo kod wygasł.”, 403 w `/pair/finish` →
„Zły kod parowania. Poproś telefon o nowy kod.”, zła odpowiedź albo Noise → „Telefon odpowiedział
niepoprawnie.”, inne → „Telefon odpowiedział błędem N (x).”

## 3. Synchronizacja i adresy

`sync()`:

1. Dzieli `phoneUrls` na dozwolone i bez zgody Chrome (`chrome.permissions.contains`). Bez żadnej
   dozwolonej: „Brak zgody Chrome…”, bez kontaktu z telefonem.
2. `pickPhone` (najpierw `lastPhoneUrl`; przy jednym adresie bez pingu), odpieczętowanie klucza
   statycznego, `noiseTransport` i `syncVaultV2` z zegarem HLC sesji.
3. Zapis sejfu. Potem konto czytane jest ponownie: jeśli w międzyczasie inna strona sparowała inny telefon
   (inny `staticPublicKey`) albo odłączyła przeglądarkę, konto nie jest nadpisywane. Inaczej dopisuje nowe
   adresy IPv4 z `vault.addresses` do bieżącej listy i ustawia `lastPhoneUrl`.
4. Zwraca `skipped`: adresy bez zgody, także świeżo poznane. Lista dopisuje „Pominięto adresy bez zgody
   Chrome: … Zgodę dasz w „Adresy telefonu” (Zapisz).”

„Adresy telefonu” (karta `?addresses`) pokazuje wszystkie adresy z polami do edycji; „Zapisz” prosi o zgodę
dla wszystkich i woła `setPhoneUrls`. Zmiana adresu nie wymaga parowania: Noise sprawdza klucz telefonu
przy każdej synchronizacji.

Telefon, który usunął przeglądarkę z „Urządzenia”, odpowiada 403 `device not paired`, a wtyczka pokazuje
„Telefon nie zna tej przeglądarki. Sparuj ją ponownie w „Adresy telefonu” → „Sparuj z innym telefonem /
odtwórz telefon”.”

## 4. Klucze w pamięci

| Klucz | Gdzie | Co |
|---|---|---|
| `accountV2` | `local` | `Account`: `phoneUrls`, `lastPhoneUrl`, `deviceId`, `deviceName`, `phone` (tożsamość telefonu z kluczem publicznym), `kdf`, `wrappedVaultKey`, `sealedStaticKey` (prywatny klucz X25519 zapieczętowany kluczem sejfu, AAD `passholder/v2/ext-static-key`), `staticPublicKey`. |
| `vaultV2` | `local` | `LocalVaultV2` (epoka, `lastSyncRevision`, adresy, wpisy) zapieczętowany kluczem sejfu, AAD `passholder/v2/local-vault`. |
| `pendingPairing` | `session` | Parowanie czekające na hasło, z prywatnym kluczem w Base64 (tylko pamięć, jak klucze sesji). |
| `keys` | `session` | `{vaultKey, unlockedUntil}` odblokowanej sesji (15 min jak dotąd). |
| `pinLock`, `generator` | bez zmian | PIN (punkt 5) i ustawienia generatora. |

Stare `account` i `vault` (v1) nie są czytane ani usuwane (punkt 0). „Odłącz” usuwa tylko klucze v2.

## 5. PIN tylko z kluczem sejfu

`UnlockKeys = { vaultKey }`: `authKey` zniknął, bo wtyczka nie loguje się już do serwera. Format i AAD blokady
PIN (`passholder/v1/pin-lock`) się nie zmieniły. `pairFinish` wyłącza PIN (mógł być PIN-em sejfu z Pi);
`repair` go zostawia, bo klucz sejfu jest ten sam.

## 6. Inny telefon i odtwarzanie (`repair`)

„Adresy telefonu” → „Sparuj z innym telefonem / odtwórz telefon”: adresy, kod i hasło główne.

1. Hasło jest sprawdzane na koncie przed siecią: literówka nie spala kodu.
2. Parowanie z tym samym `deviceId`, nazwą i kluczem statycznym. Wtyczka zawsze przygotowuje `restore`
   (`kdf` i `wrappedVaultKey` konta); `pairWithPhone` wysyła je tylko, gdy telefon jest w trybie `restore`.
3. Telefon z sejfem (`pair`): jego `wrappedVaultKey` musi się odwinąć tym hasłem do **tego samego** klucza
   sejfu. Inaczej nic się nie zmienia i błąd „To inny sejf. Wtyczka zostaje połączona z poprzednim
   telefonem. Na nowym telefonie usuń „X” z „Urządzenia”.” Przy zgodnym kluczu konto bierze `kdf` i
   `wrappedVaultKey` telefonu.
4. Pusty telefon (`restore`, „Odtwórz z wtyczki”): telefon zapisuje sejf wtyczki, nowa epoka resetuje
   wpisy do `revision = 0` i `dirty`, a pierwsza synchronizacja wysyła wszystkie. Na telefonie trzeba
   potem wpisać hasło główne.
5. `phoneUrls` = adres, który odpowiedział, pozostałe wpisane i poznane; stare adresy znikają. Wynik:
   `{mode: "paired" | "restored", skipped}`.

Przy tej samej epoce (ten sam telefon, który zapomniał przeglądarkę) niezsynchronizowane wpisy zostają
`dirty` i idą na telefon w pierwszej synchronizacji.

## 7. Odłączanie

„Odłącz tę przeglądarkę” jest tylko na ekranie blokady. Pierwsze kliknięcie zmienia napis na
„Niezsynchronizowane zmiany mogą przepaść. Kliknij ponownie”, drugie usuwa konto, sejf, PIN i `pendingPairing`.
Przy zablokowanym sejfie zmian nie da się policzyć, stąd ostrzeżenie. `disconnect()` przy odblokowanym
sejfie ze zmianami odmawia (`UnsyncedChanges`: „Niezsynchronizowane zmiany: N…”), chyba że `force`.
Telefon zachowuje to, co już dostał; przeglądarkę usuwa się tam w „Urządzenia”.

## 8. Testy i komendy

```bash
npm test && npm run typecheck && npm run build -w extension     # z katalogu głównego
cd android && PASSHOLDER_INTEROP_TEST=1 ./gradlew :core:test --tests "*Interop*" --console=plain
```

| Test | Co sprawdza |
|---|---|
| `core/test/p2p/pair-client.test.ts` | protokół z tabeli `P2P_TELEFON.md` §2 na udawanym telefonie z prawdziwym CPace: role, `ad`, tryb `restore`, błędy 403/404, zły format odpowiedzi, kod 8 cyfr. |
| `android/core/.../PhoneInteropTest.kt` (z `PASSHOLDER_INTEROP_TEST=1`) | skrypt `phone-interop.ts` (prawdziwy `fetch`) przeciw prawdziwemu `PhoneVaultStore` i `SyncHttpServer` w Kotlinie: parowanie z wpisami w obie strony i odtworzenie 50 wpisów. |
| `extension/test/vault-store.test.ts`, `pairing-flow.test.ts` | parowanie, złe hasło po zamknięciu okienka, wygaśnięcie po 10 min, inny sejf bez zmian, odtwarzanie, kilka adresów, brak zgody, `PairedButSyncFailed`, `disconnect` ze zmianami, równoległa zmiana konta. |
| `edge-cases.test.ts`, `phone-urls.test.ts` | konflikty HLC, limit 30 s, telefon, który zapomniał przeglądarkę, adresy (IPv4, zera wiodące, porty), `pickPhone` z 4 s. |
| `pin.test.ts`, `csv-transfer.test.ts`, `auto-lock.test.ts` | PIN z samym `vaultKey`, import CSV trafia na telefon, auto-blokada. |

Testy wtyczki używają `extension/test/fake-phone.ts`: tabela parowania z prawdziwym CPace przed
referencyjnym `P2pHost`. Testy ręczne z prawdziwym Chrome i telefonem: `P2P_TELEFON.md` §11.

## 9. Znane ograniczenia

- **Lista adresów tylko rośnie.** `phoneUrls` nie ma limitu ani wygasania; martwy adres kosztuje do 4 s
  pingu przy synchronizacji. Usuwa się go ręcznie w „Adresy telefonu”.
- **Osierocone urządzenia na telefonie.** Po „Anuluj parowanie”, wygaśnięciu, złym telefonie w `repair`
  („To inny sejf”) przeglądarka zostaje w „Urządzenia” telefonu. Trzeba ją tam usunąć ręcznie (komunikat
  podaje nazwę).
- **Poznane adresy wymagają „Zapisz”.** Adresy, które telefon podał przy synchronizacji, nie mają zgody
  Chrome (brak kliknięcia, na którym można zapytać). Są pomijane, dopóki nie zapiszesz ich w „Adresy
  telefonu”.
- **Tylko IPv4.** Strażnik `Host` telefonu odrzuca nazwy MagicDNS i IPv6 (403), więc wtyczka przyjmuje
  tylko adres IPv4 (albo `localhost`) i pomija inne poznane adresy.
- **Private Network Access / prośba o zgodę** w prawdziwym Chrome nie są pokryte testami automatycznymi;
  sprawdza je test ręczny T7 (`P2P_TELEFON.md` §11).
- **Brak testów widoków** (DOM): kroki parowania i „zapytaj raz” po złym haśle sprawdzono tylko czytaniem
  kodu i testem dymnym poza repozytorium.
- **Dane v1** zostają w `chrome.storage.local` (punkt 0), także po planie 4. `@passholder/server` w
  `devDependencies` usunął plan 4.
- Wtyczka nie sprawdza, że `ad` w wiadomości CPace telefonu to jego `deviceId`; klucz i tak wiąże transkrypt.
