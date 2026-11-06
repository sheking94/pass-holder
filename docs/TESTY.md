# Testy PassHolder

Przegląd testów całego monorepo: co jest testowane, jak to uruchomić, jakie luki znalazły testy i co
zostało poprawione. Pierwsza wersja powstała 2026-10-31 (PR #5); liczby i listy plików zaktualizowane
2026-11-02 na stanie po PR #18.

## Jak uruchomić

```sh
npm install
npm test                 # core, server, extension (Vitest)
npm run typecheck

cd android
./gradlew :core:test                              # Kotlin: krypto, sync, klient HTTP, VaultStore
PASSHOLDER_SERVER_TEST=1 ./gradlew :core:test     # + prawdziwy serwer Node.js przez HTTPS
PASSHOLDER_INTEROP_TEST=1 ./gradlew :core:test    # + klient P2P wtyczki (TypeScript) przeciw hostowi w Kotlinie
./gradlew :app:testDebugUnitTest                  # ekrany (Robolectric + Roborazzi)
```

### Rdzeń P2P w Kotlinie i test współpracy na Windows

Rdzeń P2P telefonu (`android/core`, pakiet `core.p2p`, opis w [P2P_ANDROID_RDZEN.md](P2P_ANDROID_RDZEN.md))
ma testy w `android/core/src/test/kotlin/io/github/sheking94/passholder/core/p2p/`; uruchamia je zwykłe
`:core:test`. W PowerShellu, w katalogu `android/`:

```powershell
$env:JAVA_HOME="$HOME\.jdks\jbr-21.0.11"    # JDK 21; JBR 25 z Android Studio nie działa z Gradle 8.14.3
.\gradlew.bat :core:test :app:testDebugUnitTest --console=plain
.\gradlew.bat :core:test --tests "io.github.sheking94.passholder.core.p2p.*" --console=plain   # tylko P2P
```

Test współpracy `P2pInteropTest` uruchamia w Node prawdziwego klienta wtyczki (`syncVaultV2` i
`noiseTransport` z `core/src/p2p`, skrypt `android/core/src/test/resources/p2p-interop.ts`) przeciw
`P2pHost` w Kotlinie. Bez `PASSHOLDER_INTEROP_TEST=1` jest pomijany. Potrzebuje `npm install` w katalogu
głównym i Node na PATH (na Windows przez `fnm`):

```powershell
fnm env --shell powershell | Out-String | Invoke-Expression
$env:PASSHOLDER_INTEROP_TEST="1"
.\gradlew.bat :core:test --tests "*P2pInteropTest*" --console=plain
Remove-Item Env:PASSHOLDER_INTEROP_TEST
```

Skrypt działa bez `--experimental-transform-types` (Node 26.13 odrzuca ten przełącznik; wystarcza domyślne
usuwanie typów z Node >= 22.18). Uwaga: `RealServerTest` z v1 nadal podaje ten przełącznik, więc z
`PASSHOLDER_SERVER_TEST=1` na Node 26 nie przejdzie; kodu v1 nie zmieniamy, zniknie w planie 4. Drugie
ograniczenie: gdy `node` się zawiesi, `P2pInteropTest` czeka do przerwania Gradle, bo czytanie wyjścia
procesu blokuje i limit 5 minut nie zadziała.

Pokrycie dla TypeScript (opcjonalnie, bez dopisywania zależności do projektu):
`npm i --no-save @vitest/coverage-v8 && npx vitest run --coverage` w katalogu pakietu.

## Liczby

| Pakiet | Przed PR #5 | Po PR #5 | Teraz (po PR #18) | Pokrycie linii (`src/`, pomiar z PR #5) |
|---|---|---|---|---|
| `core` | 19 | 64 | 68 | 100% |
| `server` | 9 | 23 | 24 | `app.ts` 98,5%, `db.ts` 100% (`main.ts` to tylko start procesu) |
| `extension` | 4 | 12 | 53 | `vault-store.ts` 91% (widoki i service worker bez testów, patrz niżej) |
| `android/core` | 33 | 45 | 55 (w tym `RealServerTest`, uruchamiany tylko z `PASSHOLDER_SERVER_TEST=1`) | nie mierzone |
| `android/app` | 6 | 6 | 17 | nie mierzone |

Liczby TypeScript to wynik `npm test` z 2026-11-02 (wszystkie zielone). Liczby Androida to liczba
adnotacji `@Test` w plikach; w tym kontenerze nie uruchamiałem Gradle (wynik z PR #18: wszystkie zielone).

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

## Co testują pliki z PR #5

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

## Testy dodane później (PR #8–#18)

| Plik | Co sprawdza | Opis funkcji |
|---|---|---|
| `extension/test/open-in-tab.test.ts` | tryby strony (`pageMode`), przełączanie na otwartą kartę zamiast otwierania nowej | [WTYCZKA_OTWIERANIE_W_KARCIE.md](WTYCZKA_OTWIERANIE_W_KARCIE.md) |
| `extension/test/csv-transfer.test.ts` | parser i generator CSV NordPass, pomijanie duplikatów, podsumowanie importu | [WTYCZKA_IMPORT_EKSPORT_CSV.md](WTYCZKA_IMPORT_EKSPORT_CSV.md) |
| `extension/test/pin.test.ts` | PIN: kształt, limit 5 prób, licznik zapisywany przed sprawdzeniem, długi PIN na dysku (S4) | [WTYCZKA_PIN.md](WTYCZKA_PIN.md) |
| `extension/test/server-urls.test.ts` | kolejność prób adresów, limit czasu, komunikat, gdy nic nie odpowiada | [WIELE_ADRESOW_SERWERA.md](WIELE_ADRESOW_SERWERA.md) |
| `extension/test/auto-lock.test.ts` | blokada po 15 minutach przy otwartej stronie i alarm service workera (S1) | [POPRAWKI_BEZPIECZENSTWA.md](POPRAWKI_BEZPIECZENSTWA.md) |
| `core/test/malicious-server.test.ts`, `MaliciousServerTest.kt` | serwer nie usunie wpisu flagą `deleted`, nie wskrzesi nagrobka, nie cofnie wpisu do starszej wersji (S2) | [POPRAWKI_BEZPIECZENSTWA.md](POPRAWKI_BEZPIECZENSTWA.md) |
| `server/test/api.test.ts` | dodatkowo globalny limit 20 błędnych logowań na minutę (N3) | [SPEC.md](SPEC.md) §6 |
| `ServerPickerTest.kt` | wybór adresu na Androidzie, `firstThatAnswers` | [WIELE_ADRESOW_SERWERA.md](WIELE_ADRESOW_SERWERA.md) |
| `BiometricScreenTests.kt` | odcisk palca, blokada przy wyjściu z aplikacji i opóźnienie 60 s | [ANDROID_ODCISK_PALCA.md](ANDROID_ODCISK_PALCA.md) |
| `ScreenTests.kt` (`TwoAddressesTest`) | parowanie, gdy odpowiada tylko drugi adres, i edycja adresów | [WIELE_ADRESOW_SERWERA.md](WIELE_ADRESOW_SERWERA.md) |
| `core/test/p2p/*.test.ts` | rdzeń P2P w TypeScripcie: HLC, ristretto255, CPace, Noise KK, parowanie, host i transport, synchronizacja wtyczki, wektory v2 | [P2P_RDZEN.md](P2P_RDZEN.md) |
| `android/core/.../p2p/*Test.kt` | rdzeń P2P w Kotlinie: te same wektory bit w bit, host HTTP, `PhoneVault`, wiele wątków, `P2pInteropTest` (opcjonalny) | [P2P_ANDROID_RDZEN.md](P2P_ANDROID_RDZEN.md) §5 |

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

## Czego dalej brakuje

- Widoki wtyczki (`extension/src/views/`, `extension/src/ui/`), `offscreen.ts` i `clipboard.ts` nie mają
  testów jednostkowych (to kod zależny od DOM i API Chrome). Przy PR #8 i #16 sprawdzałem je skryptem
  Playwright w Chromium bez okna, ale ten skrypt nie jest w repozytorium. Sensowny następny krok to dodać
  taki test na stałe.
- Aplikacja Android nie była testowana na prawdziwym telefonie ani emulatorze, tylko na JVM (Robolectric).
- Brak testu wydajności Argon2id na Raspberry Pi i na telefonie (domyślne 64 MiB, 3 iteracje).
