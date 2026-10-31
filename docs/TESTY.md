# Testy PassHolder

Przegląd testów całego monorepo (październik 2026): co jest testowane, jak to uruchomić, jakie luki
znalazły nowe testy i co zostało poprawione.

## Jak uruchomić

```sh
npm install
npm test                 # core, server, extension (Vitest)
npm run typecheck

cd android
./gradlew :core:test                              # Kotlin: krypto, sync, klient HTTP, VaultStore
PASSHOLDER_SERVER_TEST=1 ./gradlew :core:test     # + prawdziwy serwer Node.js przez HTTPS
./gradlew :app:testDebugUnitTest                  # ekrany (Robolectric + Roborazzi)
```

Pokrycie dla TypeScript (opcjonalnie, bez dopisywania zależności do projektu):
`npm i --no-save @vitest/coverage-v8 && npx vitest run --coverage` w katalogu pakietu.

## Liczby

| Pakiet | Przed | Po | Pokrycie linii (`src/`) |
|---|---|---|---|
| `core` | 19 | 64 | 100% |
| `server` | 9 | 23 | `app.ts` 98,5%, `db.ts` 100% (`main.ts` to tylko start procesu) |
| `extension` | 4 | 12 | `vault-store.ts` 91% (popup i service worker bez testów, patrz niżej) |
| `android/core` | 33 | 45 | nie mierzone |
| `android/app` | 6 | 6 | bez zmian |

## Znalezione błędy i poprawki

### 1. Po restarcie Raspberry Pi synchronizacja przestawała działać na 15 minut

Serwer trzyma tokeny sesji tylko w pamięci (`server/src/app.ts`, mapa `sessions`). Wtyczka
(`extension/src/vault-store.ts`) i telefon (`android/core/.../VaultStore.kt`) pamiętały token razem z
czasem wygaśnięcia i logowały się ponownie dopiero, gdy ten czas minął. Pi włącza się ręcznie, więc
scenariusz „zsynchronizuj, wyłącz Pi, włącz, zsynchronizuj znowu” jest typowy: serwer odpowiadał
401 „Log in first”, a klient pokazywał błąd, dopóki token nie wygasł albo użytkownik nie zablokował sejfu.

Poprawka (taka sama w TS i Kotlinie): gdy `/api/v1/sync` zwróci 401, klient loguje się raz od nowa
(ma `authKey` w pamięci) i powtarza synchronizację. Powtórzenie jest bezpieczne, bo po każdej rundzie
lokalny sejf jest spójny, a serwer i tak rozpoznaje już zapisane zmiany jako konflikt z samym sobą.

Testy: `extension/test/edge-cases.test.ts` („logs in again when the server was restarted…”, prawdziwy
serwer zamykany i uruchamiany na tym samym porcie i bazie) oraz `EdgeCaseTest.kt` (`FakeServer.forgetSessions()`).
Oba testy nie przechodziły przed poprawką.

### 2. Walidacja parametrów KDF we wtyczce przepuszczała `NaN`, napisy i ogromną pamięć

`assertKdfParamsAcceptable` w `core/src/kdf.ts` sprawdzała tylko `memoryKiB < minimum`. Porównanie
z `NaN` albo z napisem `"lots"` daje `false`, więc taka wartość przechodziła. Nie było też górnej
granicy, którą Android już miał (1 GiB), więc złośliwy serwer mógł kazać wtyczce zaalokować gigabajty.

Poprawka: każdy parametr musi być liczbą całkowitą w zakresie. Nowa stała `MAX_KDF`
(`memoryKiB ≤ 1048576`, `iterations ≤ 100`, `parallelism ≤ 64`), te same granice w `Kdf.kt`
(`MAX_ITERATIONS`, `MAX_PARALLELISM` doszły) i opis w `docs/SPEC.md` §2. Granice iteracji i równoległości są
takie same jak w schemacie serwera; pamięć serwer dopuszcza do 4 GiB, ale nasi klienci zakładają sejf
z 64 MiB, więc niższa granica po stronie klienta niczego nie psuje.

5 z 10 nowych przypadków w `core/test/edge-cases.test.ts` nie przechodziło przed poprawką.

## Co testują nowe pliki

- `core/test/edge-cases.test.ts`: normalizacja NFC („ą” jako jeden znak i jako „a” + ogonek), Base64/hex
  dla wszystkich bajtów i złe dane wejściowe, AES-GCM: zły rozmiar klucza i nonce, ucięty blob, nieznana
  wersja, zmieniony nonce, pusty tekst; złe hasło główne nie rozpakowuje klucza sejfu, encKey ≠ authKey,
  inny salt daje inne klucze; granice KDF; generator: tylko wybrane grupy, długość 4 i 128, powtórzona grupa,
  niecałkowita długość, brak powtórzeń, `randomIndex` dla złych zakresów; walidacja odszyfrowanych wpisów.
- `core/test/sync-edge.test.ts`: zgubiona odpowiedź serwera (Pi wyłączone w trakcie) i ponowienie bez
  duplikatu; nowsze usunięcie wygrywa ze starszą edycją i odwrotnie; remis `modifiedAt` (wygrywa serwer na
  obu urządzeniach); trzy urządzenia; ponowne utworzenie wpisu po usunięciu; pusta synchronizacja;
  serwer podmienia blob jednego wpisu na blob innego (klient odmawia dzięki AAD z id) albo podaje dane
  z innym kluczem; limit rund; `processSync`: duplikaty, nieznana rewizja, rosnące rewizje, `sinceRevision`.
- `server/test/security.test.ts`: zakładanie sejfu bez tokenu po restarcie, zły `authKey` i KDF, nieznane
  pola (Fastify je usuwa, nie zapisuje), serwer nie zwraca ani nie przechowuje `authKey`; zły format
  `authKey` liczy się jako nieudana próba, udane logowanie zeruje licznik, każdy token inny, 404 przed
  założeniem sejfu; nagłówek `Authorization` (bez „Bearer”, zmieniony token, „Basic”), utrata sesji po
  restarcie, walidacja treści `/sync` (9 złych żądań, nic nie zapisane), konflikt zamiast błędu;
  `loadConfig`: wymagane TLS i zły port.
- `extension/test/edge-cases.test.ts`: restart serwera (błąd 1), konflikt dwóch przeglądarek przez
  prawdziwy serwer, niezsynchronizowane zmiany po blokadzie, operacje na zablokowanym sejfie, odrzucenie
  słabego KDF od fałszywego serwera (konto nie zapisane), odrzucony setup nie zapisuje konta; `ServerClient`:
  końcowe ukośniki, nagłówki, błąd JSON, błąd HTML 502, brak sieci.
- `android/core/.../EdgeCaseTest.kt`: odpowiedniki powyższych w Kotlinie (restart serwera, zgubiona
  odpowiedź, usunięcie kontra edycja, podmiana blobu, limit rund, granice KDF, NFC, adres https bez odcisku).

## Zachowania sprawdzone, ale nie zmienione (do decyzji)

- **Nieznane pola w JSON są usuwane, a nie odrzucane.** Schematy mają `additionalProperties: false`, ale
  Fastify domyślnie ma `removeAdditional`, więc `{"admin": true}` znika przed handlerem. Bezpieczne
  (nic nie trafia do bazy), test to opisuje.
- **Odtworzenie bazy serwera z kopii.** Jeśli `passholder.db` wróci do starszego stanu, klient z
  `lastSyncRevision` większym niż na serwerze nie pobierze zmian o niższych numerach, a zmiana z
  `baseRevision` nieznanym serwerowi kończy się 400 dla całej synchronizacji. Na razie nie ma kopii
  zapasowych w instrukcji, więc tylko odnotowuję.
- **Usunięty lokalnie wpis, którego odpowiedź z serwera zginęła**, może wrócić przy następnej
  synchronizacji (klient myśli, że wpis nigdy nie dotarł na serwer). Dane nie giną, wpis trzeba usunąć
  drugi raz.
- **Mapa sesji i licznik prób logowania na serwerze nie są czyszczone** poza użyciem. Przy jednym
  użytkowniku to kilkadziesiąt wpisów, bez znaczenia.

## Czego dalej brakuje

- `extension/src/popup.ts`, `background.ts`, `offscreen.ts`, `clipboard.ts` nie mają testów (to kod
  zależny od API Chrome). Sensowny następny krok to test w Playwright z załadowaną wtyczką.
- Aplikacja Android nie była testowana na prawdziwym telefonie ani emulatorze, tylko na JVM (Robolectric).
- Brak testu wydajności Argon2id na Raspberry Pi i na telefonie (domyślne 64 MiB, 3 iteracje).
