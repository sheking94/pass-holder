# Testy PassHolder

Co jest testowane, jak to uruchomić i co trzeba sprawdzić ręcznie.

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
$env:JAVA_HOME="$HOME\.jdks\jbr-21.0.11"    # JDK 21; JBR 25 nie działa z Gradle 8.14.3
.\gradlew.bat :core:test :app:testDebugUnitTest --console=plain
.\gradlew.bat :core:test --tests "*P2pHostTest*" --console=plain        # jeden plik
git checkout app/screenshots                                              # testy nadpisują zrzuty
```

**Testy współpracy** (`P2pInteropTest`, `PhoneInteropTest`) uruchamiają w Node prawdziwy kod wtyczki z
`core/src/p2p` przeciw hostowi w Kotlinie. Bez zmiennej są pomijane; potrzebują `npm ci` i Node ≥ 22.18 na
PATH:

```powershell
$env:PASSHOLDER_INTEROP_TEST="1"
.\gradlew.bat :core:test --tests "*Interop*" --console=plain
Remove-Item Env:PASSHOLDER_INTEROP_TEST
```

Gdy `node` się zawiesi, test czeka do przerwania Gradle.

### Linux (chmura, CI)

```sh
npm ci && npm test && npm run typecheck && npm run build
cd android
./gradlew :core:test :app:testDebugUnitTest --console=plain
PASSHOLDER_INTEROP_TEST=1 ./gradlew :core:test --tests "*Interop*" --console=plain
```

Testy ekranów (`:app:testDebugUnitTest`, Robolectric + Roborazzi, ok. 5 min) zapisują zrzuty w
`android/app/screenshots/`; kody i hasła na nich są losowe. Wyniki Gradle: `android/*/build/reports/tests/`.

Pokrycie TypeScript (opcjonalnie): `npm i --no-save @vitest/coverage-v8 && npx vitest run --coverage` w
katalogu pakietu.

## Liczby (2026-11-07)

| Pakiet | Pliki | Testy | Uwagi |
|---|---|---|---|
| `core` | 14 | 145 | w tym `core/test/p2p/` |
| `extension` | 8 | 86 | widoki i service worker bez testów |
| `android/core` | 25 | 298 | 4 pomijane bez `PASSHOLDER_INTEROP_TEST=1` |
| `android/app` | 6 | 31 | Robolectric, zrzuty ekranów |

## Co testują pliki

### `core/test/`

| Plik | Co sprawdza |
|---|---|
| `edge-cases.test.ts` | NFC, Base64/hex, AES-GCM (zły klucz i nonce, ucięty blob), złe hasło, granice KDF, generator |
| `cipher.test.ts`, `generator.test.ts`, `vectors.test.ts` | szyfrowanie, generator, wektory `v1.json` |
| `sync-edge.test.ts` | `processSync`: duplikaty, nieznana rewizja, rosnące rewizje |
| `p2p/*.test.ts` | HLC, ristretto255 (RFC 9496), CPace (draft, dodatek B.3), Noise KK (Cacophony), parowanie, klient parowania, host, transport, synchronizacja, wektory `v2.json` |

`v2.json` zawiera sekcje `hlcCompare`, `entryPayload`, `pairingKey`, `pairingMessage`, `frames`, `paging`
oraz odnośniki do `cpace-ristretto255.json` i `noise-kk.json`. Odtwarza je `npm run gen-vectors-v2 -w core`;
wartości losowe mają stałe klucze i nonce.

### `extension/test/`

| Plik | Co sprawdza |
|---|---|
| `vault-store.test.ts`, `pairing-flow.test.ts` | parowanie, złe hasło po zamknięciu okienka, wygaśnięcie po 10 min, inny sejf, odtwarzanie, kilka adresów, brak zgody Chrome, odłączanie |
| `edge-cases.test.ts` | konflikty HLC, zablokowany sejf, słaby KDF od telefonu, telefon, który zapomniał przeglądarkę, limit 30 s |
| `phone-urls.test.ts` | adresy IPv4, zera wiodące, porty, `pickPhone` (4 s) |
| `pin.test.ts` | PIN: kształt, 5 prób, licznik przed sprawdzeniem, długi PIN na dysku |
| `csv-transfer.test.ts` | parser i eksport CSV, duplikaty, import trafia na telefon |
| `open-in-tab.test.ts` | tryby strony, przełączanie na otwartą kartę |
| `auto-lock.test.ts` | blokada po 15 min na stronie i alarm service workera |

Testy wtyczki używają `extension/test/fake-phone.ts`: parowanie z prawdziwym CPace przed referencyjnym
`P2pHost`.

### `android/core` i `android/app`

| Plik | Co sprawdza |
|---|---|
| `CryptoTest`, `GeneratorTest`, `VectorsTest`, `KdfBoundsTest` | szyfrowanie, generator, `v1.json`, granice KDF i NFC |
| `p2p/P2pVectorsTest`, `Ristretto255Test`, `CpaceTest`, `NoiseTest`, `PairingTest`, `HlcTest`, `P2pJsonTest`, `EntryV2Test`, `FramesTest` | te same wektory bit w bit, `safeLong`, ramki |
| `HostSyncTest`, `P2pHostTest`, `PhoneVaultTest` | rewizje, stronicowanie, cofnięty telefon, kody HTTP, sesje (60 s, 32), wiele wątków |
| `SyncHttpServerTest`, `FileSyncStoreTest`, `HostStateTest`, `PairingHostTest`, `PhoneRouterTest`, `LocalAddressesTest`, `PhoneVaultStoreTest` | serwer HTTP i limity, `Host`, trwała baza, parowanie po HTTP, sejf telefonu |
| `P2pInteropTest`, `PhoneInteropTest` (opcjonalne) | prawdziwy klient wtyczki w Node przeciw hostowi w Kotlinie: wpisy w obie strony, 1300/1200 wpisów, odtworzenie |
| `ScreenTests`, `SyncScreenTests`, `SyncControllerTest`, `CorruptHostStateTest` (app) | ekrany, tryb Synchronizacja, odświeżenie po synchronizacji, uszkodzony stan |
| `BiometricScreenTests` (app) | odcisk palca, blokada po wyjściu, opóźnienie 60 s (zegar Robolectric) |
| `BackupRulesTest`, `ClearClipboardWorkerTest` (app) | brak kopii zapasowych, czyszczenie schowka |

## Znaleziony błąd: walidacja KDF

`assertKdfParamsAcceptable` sprawdzała tylko `memoryKiB < minimum`, więc `NaN` i napisy przechodziły, a
górnej granicy nie było (druga strona mogła kazać zaalokować gigabajty). Poprawka: każdy parametr to liczba
całkowita w zakresie, `MAX_KDF` (`memoryKiB ≤ 1048576`, `iterations ≤ 100`, `parallelism ≤ 64`), te same
granice w `Kdf.kt` ([SPEC.md](SPEC.md) §2).

## Testy ręczne

Testy automatyczne nie obejmują prawdziwego Chrome (prośba o zgodę, Private Network Access), prawdziwego
Keystore i `BiometricPrompt` ani serwera na prawdziwym telefonie. Przygotowanie: telefon z aplikacją
(`.\gradlew.bat :app:installDebug`), wtyczka z `extension\dist` w Chrome, oba urządzenia w tej samej sieci
Wi-Fi. Zapisz wynik każdego testu.

### Sam telefon

1. Start → „Nowy sejf” (hasło ≥ 12 znaków), „+ Dodaj” z generatorem, zapisz.
2. „Synchronizacja”: adres `http://<IPv4>:8787`, po „Dodaj wtyczkę” kod z odliczaniem; ekran nie gaśnie.
3. Z komputera: `curl -X POST -H "Content-Type: application/json" -d "{}" http://<IP>:8787/p2p/v1/ping` →
   `{"ok":true}`.
4. Home i powrót: tryb wyłączony, „Włącz ponownie” go uruchamia.
5. Zablokuj, odblokuj hasłem i odciskiem; „Usuń sejf z telefonu” wraca na start.
6. Odcisk palca: Home i powrót przed i po 60 s, to samo bez opóźnienia, wyłączenie ekranu, obrót (bez
   blokady), dodanie nowego odcisku w ustawieniach (aplikacja prosi o hasło główne).

### Telefon z wtyczką

**T7. Zgoda Chrome i LAN (najpierw).** Okienko z paska → „Sparuj z telefonem” → adres
`http://192.168.x.x:8787`, kod → „Sparuj”. Chrome **musi** zapytać o zgodę na `http://<ip>:8787/*`. Hasło
główne → „Sparowano z telefonem.”; potem „Synchronizuj” w okienku. Przy „Telefon nie odpowiada” mimo
włączonego trybu: DevTools → Network, szukaj żądania `OPTIONS` (405) i zapisz wersję Chrome.

**T1. Wpis w obie strony.** Wpis A z telefonu jest we wtyczce. Wpis B we wtyczce (•) → „Synchronizuj” →
jest na telefonie. Zmiana A na telefonie dochodzi do wtyczki. „Urządzenia” pokazuje wtyczkę z datami.

**T2. Zły i wygasły kod.** Zły kod: „Zły kod parowania…”. Po 2 min: „Telefon nie czeka na parowanie albo kod
wygasł.” 7 cyfr: „Kod parowania to 8 cyfr.” (kod nie przepada).

**T3. Zmiana sieci.** Inne IP telefonu: stary adres „Telefon nie odpowiada…”; nowy adres w „Adresy telefonu”
→ „Zapisz” → „Synchronizuj” działa bez parowania.

**T4. Tailscale.** Adres `http://100.x.y.z:8787` w „Adresy telefonu” → „Zapisz”; wyłącz Wi-Fi komputera albo
usuń adres LAN i „Synchronizuj”. Zapisz wynik i wersję Chrome.

**T5. Odtworzenie.** Telefon: „Usuń sejf” → „Odtwórz z wtyczki”. Wtyczka: „Sparuj z innym telefonem /
odtwórz telefon” → „Telefon odtworzony…”. Telefon: hasło główne → wszystkie wpisy wróciły.

**T6. Wyjście z aplikacji.** Home na telefonie → „Synchronizuj”: „Telefon nie odpowiada…”; po „Włącz
ponownie” działa.

**T8. Telefon zapomniał przeglądarkę.** Wpis C bez synchronizacji, usuń wtyczkę w „Urządzenia” →
„Synchronizuj”: „Telefon nie zna tej przeglądarki…”. Ponowne parowanie z kodem: wpis C trafia na telefon.

**T9. Odłączanie.** Wpis bez synchronizacji, zablokuj → „Odłącz tę przeglądarkę”: pierwsze kliknięcie
ostrzega, drugie odłącza.

**T10. Złe hasło przy parowaniu.** Złe hasło → „Złe hasło główne”; po zamknięciu karty „Dokończ parowanie”
wraca do hasła. Po 10 min: „Parowanie wygasło…”.

**PIN i karta.** PIN `4821` → Zablokuj → zły PIN „Pozostało prób: 4”, dobry otwiera; restart Chrome prosi o
hasło główne. „Otwórz w karcie ↗” dwa razy: drugi raz przełącza na istniejącą kartę.

## Czego brakuje

- Testów widoków wtyczki (`views/`, `ui/`), `offscreen.ts` i `clipboard.ts` (DOM, API Chrome). Następny krok:
  test w Chromium (Playwright).
- Testów automatycznych prośby o zgodę Chrome, Private Network Access i Tailscale (T4, T7 ręcznie).
- Testów na prawdziwym telefonie (Keystore, `BiometricPrompt`, port 8787) i wydajności Argon2id.
- Na telefonie: zajętego portu, obrotu ekranu przy działającym serwerze, wygasania kodu przez zegar.
