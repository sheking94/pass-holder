# Testy PassHolder

Przegląd testów całego monorepo: co jest testowane, jak to uruchomić, jakie luki znalazły testy. Pierwsza
wersja powstała 2026-10-31 (PR #5); stan opisany niżej to wersja po planie 4 (2026-11-07, bez serwera Pi).

## Jak uruchomić

### Windows (PowerShell)

```powershell
cd C:\Users\krzys\Projekty\PassHolder
fnm env --shell powershell | Out-String | Invoke-Expression
npm ci
npm test                 # core i extension (Vitest)
npm run typecheck
npm run build            # wtyczka do extension\dist

cd android
$env:JAVA_HOME="$HOME\.jdks\jbr-21.0.11"    # JDK 21; JBR 25 z Android Studio nie działa z Gradle 8.14.3
.\gradlew.bat :core:test :app:testDebugUnitTest --console=plain
.\gradlew.bat :core:test --tests "io.github.sheking94.passholder.core.p2p.*" --console=plain   # tylko P2P
```

Testy współpracy (`P2pInteropTest`, `PhoneInteropTest`) uruchamiają w Node prawdziwy kod wtyczki z
`core/src/p2p` przeciw hostowi w Kotlinie. Bez `PASSHOLDER_INTEROP_TEST=1` są pomijane. Potrzebują
`npm ci` w katalogu głównym i Node na PATH:

```powershell
fnm env --shell powershell | Out-String | Invoke-Expression
$env:PASSHOLDER_INTEROP_TEST="1"
.\gradlew.bat :core:test --tests "*Interop*" --console=plain
Remove-Item Env:PASSHOLDER_INTEROP_TEST
```

Gdy `node` się zawiesi, test współpracy czeka do przerwania Gradle (czytanie wyjścia procesu blokuje, limit
5 minut nie zadziała).

### Linux (chmura, CI)

```sh
npm ci && npm test && npm run typecheck && npm run build
cd android
./gradlew :core:test :app:testDebugUnitTest --console=plain
PASSHOLDER_INTEROP_TEST=1 ./gradlew :core:test --tests "*Interop*" --console=plain
```

Testy ekranów (`:app:testDebugUnitTest`, Robolectric + Roborazzi, ok. 5 min) zapisują zrzuty w
`android/app/screenshots/`; kody i hasła na nich są losowe, więc zrzuty zmieniają się przy każdym uruchomieniu.

Pokrycie dla TypeScript (opcjonalnie, bez dopisywania zależności do projektu):
`npm i --no-save @vitest/coverage-v8 && npx vitest run --coverage` w katalogu pakietu.

## Liczby

| Pakiet | Pliki | Testy (po planie 4) | Uwagi |
|---|---|---|---|
| `core` | 14 | 145 | w tym `core/test/p2p/` (rdzeń P2P) |
| `extension` | 8 | 86 | widoki i service worker bez testów (patrz niżej) |
| `android/core` | 25 | 298 | 4 pomijane bez `PASSHOLDER_INTEROP_TEST=1` |
| `android/app` | 6 | 31 | Robolectric, zrzuty ekranów |

Liczby TypeScript to wynik `npm test`; liczby Androida to wynik Gradle z planu 4. Zmiana względem planu 3:
[P2P_USUNIECIE_SERWERA.md](P2P_USUNIECIE_SERWERA.md) §5.

## Co testują pliki

### `core/test/`

| Plik | Co sprawdza |
|---|---|
| `edge-cases.test.ts` | NFC („ą” na dwa sposoby), Base64/hex dla wszystkich bajtów i złe dane, AES-GCM (zły klucz i nonce, ucięty blob, nieznana wersja, zmieniony nonce, pusty tekst), złe hasło nie odwija klucza sejfu, `encKey ≠ authKey`, inna sól daje inne klucze, granice KDF, generator |
| `cipher.test.ts`, `generator.test.ts`, `vectors.test.ts` | szyfrowanie i zawijanie klucza sejfu, generator, wektory `test-vectors/v1.json` (KDF, klucz sejfu) |
| `sync-edge.test.ts` | `processSync` (logika hosta): duplikaty w żądaniu, nieznana rewizja, rosnące rewizje, `sinceRevision` |
| `p2p/*.test.ts` | HLC, ristretto255 (RFC 9496), CPace, Noise KK, parowanie, klient parowania, host i transport, synchronizacja wtyczki, wektory `v2.json` ([P2P_RDZEN.md](P2P_RDZEN.md)) |

### `extension/test/`

| Plik | Co sprawdza | Opis funkcji |
|---|---|---|
| `vault-store.test.ts`, `pairing-flow.test.ts` | parowanie, złe hasło po zamknięciu okienka, wygaśnięcie po 10 min, inny sejf, odtwarzanie, kilka adresów, brak zgody Chrome, odłączanie | [P2P_WTYCZKA.md](P2P_WTYCZKA.md) |
| `edge-cases.test.ts` | konflikt telefon–wtyczka po HLC, zmiany po blokadzie, zablokowany sejf, słaby KDF od telefonu, zły kod, telefon, który zapomniał przeglądarkę, `PhoneClient` (limit 30 s) | [P2P_WTYCZKA.md](P2P_WTYCZKA.md) |
| `phone-urls.test.ts` | adresy IPv4, zera wiodące, porty, `pickPhone` z limitem 4 s | [P2P_WTYCZKA.md](P2P_WTYCZKA.md) |
| `pin.test.ts` | PIN: kształt, limit 5 prób, licznik zapisywany przed sprawdzeniem, długi PIN na dysku | [WTYCZKA_PIN.md](WTYCZKA_PIN.md) |
| `csv-transfer.test.ts` | parser i generator CSV NordPass, duplikaty, import trafia na telefon | [WTYCZKA_IMPORT_EKSPORT_CSV.md](WTYCZKA_IMPORT_EKSPORT_CSV.md) |
| `open-in-tab.test.ts` | tryby strony, przełączanie na otwartą kartę | [WTYCZKA_OTWIERANIE_W_KARCIE.md](WTYCZKA_OTWIERANIE_W_KARCIE.md) |
| `auto-lock.test.ts` | blokada po 15 minutach przy otwartej stronie i alarm service workera | |

Testy wtyczki używają `extension/test/fake-phone.ts`: parowanie z prawdziwym CPace przed referencyjnym `P2pHost`.

### `android/core` i `android/app`

| Plik | Co sprawdza | Opis |
|---|---|---|
| `CryptoTest`, `GeneratorTest`, `VectorsTest`, `KdfBoundsTest` | szyfrowanie, generator, wektory `v1.json`, granice KDF i NFC | [SPEC.md](SPEC.md) |
| `p2p/*Test.kt` (rdzeń) | te same wektory P2P bit w bit, CPace, Noise, `HostSync`, `P2pHost`, `PhoneVault`, wiele wątków | [P2P_ANDROID_RDZEN.md](P2P_ANDROID_RDZEN.md) §5 |
| `SyncHttpServerTest`, `FileSyncStoreTest`, `HostStateTest`, `PairingHostTest`, `PhoneRouterTest`, `LocalAddressesTest`, `PhoneVaultStoreTest` | serwer HTTP i limity, trwała baza, parowanie po HTTP, sejf telefonu | [P2P_TELEFON.md](P2P_TELEFON.md) §9 |
| `P2pInteropTest`, `PhoneInteropTest` (opcjonalne) | prawdziwy klient wtyczki w Node przeciw hostowi w Kotlinie | [P2P_WTYCZKA.md](P2P_WTYCZKA.md) §8 |
| `ScreenTests`, `SyncScreenTests`, `SyncControllerTest` (app) | ekrany, tryb Synchronizacja, odświeżenie listy po synchronizacji | [P2P_TELEFON.md](P2P_TELEFON.md) |
| `BiometricScreenTests` (app) | odcisk palca, blokada po wyjściu z aplikacji i opóźnienie 60 s | [ANDROID_ODCISK_PALCA.md](ANDROID_ODCISK_PALCA.md) |
| `BackupRulesTest`, `ClearClipboardWorkerTest` (app) | brak kopii zapasowych w chmurze, czyszczenie schowka | |

## Znalezione błędy i poprawki

### 1. (historyczne, wersja z Pi) Po restarcie Raspberry Pi synchronizacja przestawała działać na 15 minut

Serwer trzymał tokeny sesji tylko w pamięci, a klienci logowali się ponownie dopiero po wygaśnięciu
zapamiętanego tokenu. Poprawka: po 401 przy synchronizacji klient logował się raz od nowa i powtarzał
synchronizację. Serwer, logowanie i te testy usunął plan 4; opis zostaje dla historii.

### 2. Walidacja parametrów KDF przepuszczała `NaN`, napisy i ogromną pamięć

`assertKdfParamsAcceptable` w `core/src/kdf.ts` sprawdzała tylko `memoryKiB < minimum`. Porównanie
z `NaN` albo z napisem `"lots"` daje `false`, więc taka wartość przechodziła. Nie było też górnej
granicy, którą Android już miał (1 GiB), więc złośliwa druga strona (wtedy serwer, dziś telefon albo
wtyczka przy parowaniu) mogła kazać zaalokować gigabajty.

Poprawka: każdy parametr musi być liczbą całkowitą w zakresie. Stała `MAX_KDF`
(`memoryKiB ≤ 1048576`, `iterations ≤ 100`, `parallelism ≤ 64`), te same granice w `Kdf.kt` i opis w
[SPEC.md](SPEC.md) §2. Testy: `core/test/edge-cases.test.ts` („KDF parameters from another device”),
`KdfBoundsTest.kt`, `extension/test/edge-cases.test.ts` (słaby KDF od telefonu).

## Czego dalej brakuje

- Widoki wtyczki (`extension/src/views/`, `extension/src/ui/`), `offscreen.ts` i `clipboard.ts` nie mają
  testów jednostkowych (kod zależny od DOM i API Chrome). Sensowny następny krok: stały test w Chromium
  (Playwright).
- Prośba o zgodę Chrome i Private Network Access do adresu w LAN oraz Tailscale nie są pokryte testami
  automatycznymi; sprawdzają je testy ręczne T4 i T7 w [P2P_TELEFON.md](P2P_TELEFON.md) §11.2.
- Aplikacja Android jest testowana na JVM (Robolectric); prawdziwy Keystore, `BiometricPrompt` i serwer na
  porcie 8787 tylko ręcznie na telefonie.
- Brak testu wydajności Argon2id na telefonie (domyślne 64 MiB, 3 iteracje).
