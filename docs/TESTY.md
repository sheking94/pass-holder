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

## Liczby (2026-11-12)

| Pakiet | Pliki | Testy | Uwagi |
|---|---|---|---|
| `core` | 28 | 489 | w tym `core/test/p2p/`, `core/test/autofill/` i `core/test/save/` |
| `extension` | 29 | 291 | w tym widoki w happy-dom (`extension/test/ui/`), `extension/test/autofill/` i `extension/test/save/`; `background.ts` bez testów (logika w `fill-tab.ts` i `save/candidates.ts`) |
| `android/core` | 41 | 637 | 4 pomijane bez `PASSHOLDER_INTEROP_TEST=1`; w tym `autofill/` (wektory `core/test-vectors/autofill/`) i `save/` (wektory `core/test-vectors/save/`) |
| `android/app` | 32 | 162 | Robolectric, zrzuty ekranów; w tym `autofill/`, ekrany autouzupełniania i zapis po odblokowaniu |

## Co testują pliki

### `core/test/`

| Plik | Co sprawdza |
|---|---|
| `edge-cases.test.ts` | NFC, Base64/hex, AES-GCM (zły klucz i nonce, ucięty blob), złe hasło, granice KDF, generator |
| `cipher.test.ts`, `generator.test.ts`, `vectors.test.ts` | szyfrowanie, generator, wektory `v1.json` |
| `sync-edge.test.ts` | `processSync`: duplikaty, nieznana rewizja, rosnące rewizje |
| `p2p/*.test.ts` | HLC, ristretto255 (RFC 9496), CPace (draft, dodatek B.3), Noise KK (Cacophony), parowanie, klient parowania, host, transport (ścieżki v2, 410/404), synchronizacja (stronicowanie po bajtach, rundy `more`), wpis v3 (`entry-v3.test.ts`), wektory `v2.json` i `v3.json` |

`core/test/transfer/*.test.ts` (6 plików): `csv` (cudzysłowy, CRLF, BOM, niezamknięty cudzysłów), `common` (klucz duplikatu,
sortowanie), `passholder-json` (zły typ i nieznany klucz pomijane z numerem), `bitwarden-json` (typy 1–4, dokument,
plik zaszyfrowany, własne pola), `nordpass-csv` (typ po kolumnie `type` i po kolumnach, wiersz krótszy niż nagłówek),
`detect` (rozpoznanie z treści, pusty i uszkodzony plik). Pliki przykładowe z fałszywymi danymi:
`core/test-vectors/transfer/` (`passholder.json`, `bitwarden.json`, `nordpass.csv`, `nordpass-typed.csv` i
`*.expected.json`), a do eksportu i sortowania `export.passholder.json`, `export.bitwarden.json`,
`export.nordpass.csv` (wpisy w tej samej kolejności co po `sortForExport`) i `sort.json` (nazwy z polskimi
znakami, spacją, cyframi, „résumé”/„resume”); generuje je `core/scripts/transfer-vectors.ts`, sprawdza
`vectors.test.ts`, a w Kotlinie `android/core/.../transfer/*Test` (te same pliki, wynik 1:1). `.gitattributes`
wymusza `eol=lf` dla `core/test-vectors/transfer/*.json` i `-text` dla wszystkich `core/test-vectors/transfer/*.csv` (CRLF w plikach),
żeby Windows (`autocrlf`) nie zmieniał bajtów.

`core/test/autofill/*.test.ts` (3 pliki) odtwarzają wektory `core/test-vectors/autofill/`: `match.json` (host, subdomena,
`www.`, schemat, port, IP, `evilgoogle.com`), `fields.json` (opis pola → rodzaj) i `values.json` (karta: formaty
ważności, `<select>`; kontakt, data urodzenia); w Kotlinie te same pliki dojdą w kroku Android.

`v3.json` (sekcje `limits`, `entries`, `rejected`, `oldPaths`) trzyma po jednym wpisie każdego typu, stary wpis v2,
nagrobek, 22 przykłady odrzucane i odpowiedzi na stare ścieżki; odtwarza go `npm run gen-vectors-v3 -w core`,
a w Kotlinie sprawdza `P2pVectorsV3Test`.

`v2.json` zawiera sekcje `hlcCompare`, `entryPayload`, `pairingKey`, `pairingMessage`, `frames`, `paging`
oraz odnośniki do `cpace-ristretto255.json` i `noise-kk.json`. Odtwarza je `npm run gen-vectors-v2 -w core`;
wartości losowe mają stałe klucze i nonce.

### `extension/test/`

| Plik | Co sprawdza |
|---|---|
| `vault-store.test.ts`, `pairing-flow.test.ts` | wpisy v3 (zachowanie pól loginu, odmowa nadpisania innego typu, stary sejf v2, za duży wpis), parowanie, złe hasło po zamknięciu okienka, wygaśnięcie po 10 min, inny sejf, odtwarzanie, kilka adresów, brak zgody Chrome, odłączanie |
| `edge-cases.test.ts` | konflikty HLC, zablokowany sejf, słaby KDF od telefonu, telefon, który zapomniał przeglądarkę, limit 30 s |
| `phone-urls.test.ts` | adresy IPv4, zera wiodące, porty, `pickPhone` (4 s) |
| `pin.test.ts` | PIN: kształt, 5 prób, licznik przed sprawdzeniem, długi PIN na dysku |
| `import.test.ts` | `importContents` (wszystkie typy, duplikaty w sejfie i w pliku, ponowny import, wpis za duży, jeden zapis), `allContents`, podsumowanie importu |
| `plural.test.ts` | odmiana „wpis/wpisy/wpisów” |
| `open-in-tab.test.ts` | tryby strony, przełączanie na otwartą kartę |
| `auto-lock.test.ts` | blokada po 15 min na stronie i alarm service workera |
| `entry-types.test.ts`, `vault-store-types.test.ts` | opis wiersza, wyszukiwanie, sprzątanie, formaty i nazwa pakietu (tylko zmienione pola); `listEntries`/`getEntry`/`putEntry`, odmowa innego typu, za duży wpis, synchronizacja kart i kontaktów |
| `ui/list-view.test.ts` | zakładki, opis wiersza, wyszukiwanie w obrębie zakładki, powrót na zakładkę typu |
| `ui/edit-login.test.ts`, `ui/edit-types.test.ts` | formularze: zapis każdego pola, puste elementy list pomijane, data w innym zapisie oraz e-mail i adres strony ze spacjami zapisują się bez zmian, etykiety pól list, błędy formatów, zachowanie pól spoza formularza, ukryte własne pole, generator, „Usuń” |
| `ui/transfer-view.test.ts` | ekran „Import i eksport”: formaty, zgoda przed eksportem, import pliku, błąd uszkodzonego pliku |
| `autofill/fill-page.test.ts` | `fillPage` w happy-dom: logowanie, dwuetapowe, rejestracja (`new-password` pomijane), karta z jednym i dwoma polami ważności, `<select>`, adres; pola ukryte, wyłączone i tylko do odczytu, pusta wartość, obcy origin i inny origin niż sprawdzony |
| `autofill/fill-tab.test.ts` | `fillTab` i `onFillCommand` z atrapą `TabApi`: zablokowany sejf, strona niepasująca, karta na http, brak pól, błąd wstrzyknięcia; skrót przy jednym, kilku i zerze loginów |
| `ui/autofill-view.test.ts` | sekcja „Pasujące do tej strony”, „Wypełnij” przy karcie i kontakcie (nie w karcie PassHolder), komunikaty błędów, zamknięcie okienka po powodzeniu |
| `save/*.test.ts`, `ui/save-*.test.ts` | pytanie o zapis: odczyt formularza (hasło, login, podpis), `startSaveWatch` (submit, Enter, klik, bez `<form>`, obcy origin), `SaveCandidates` (adres z `sender.url`, „Nigdy”, 2 min, zamknięcie karty, zły formularz, ten sam login zgłoszony kilka razy, `save-hide` po wygaśnięciu), logowanie SPA od skryptu do tła (`flow.test.ts`), `syncSaveWatch` (też wywołania naraz), `promptView`, strona panelu (`startPromptPage`: brak kandydata, blokada po załadowaniu), `save-watch.ts` po przeładowaniu wtyczki, widoki „Zapis haseł” i pytanie w okienku |
| `ui/widgets.test.ts` | `secretField` (zakrycie, „Pokaż”, kopia czyści schowek, puste pole się nie kopiuje), `listEditor`, przyciski kopiowania w wierszu |

Testy wtyczki używają `extension/test/fake-phone.ts`: parowanie z prawdziwym CPace przed referencyjnym
`P2pHost`. Testy widoków (`// @vitest-environment happy-dom`) biorą z `extension/test/ui/fake-chrome.ts`
atrapę `chrome.*` i sparowany sejf (`setupPopup`, `teardownPopup`, `click`, `settle`, `byText`).

### Zrzuty ekranów wtyczki

`node extension/scripts/screenshots.mjs <katalog>` (poza `npm test`; potrzebny Playwright z Chromium) pakuje
`extension/test/screens/harness.ts` (te same atrapy co testy widoków, fałszywe wpisy każdego typu), otwiera
stronę z `popup.css` w Chromium (360 px, skala 2) i zapisuje `01-loginy.png` … `05-dokumenty.png` (zakładki),
`06`–`09` (formularze loginu, kontaktu, karty, dokumentu) i `10-pole-ukryte-pokazane.png`. Kończy się błędem,
gdy strona ma poziomy pasek przewijania, zakładki nie mieszczą się w jednym rzędzie albo ich podpis jest
ucięty, albo pole wrażliwe jest odkryte (poza zrzutem 10). Zrzutów nie ma w repozytorium.
Playwright z Chromium nie jest zależnością repozytorium: w kontenerze w chmurze jest zainstalowany, gdzie indziej `npx playwright install chromium`.

### `android/core` i `android/app`

| Plik | Co sprawdza |
|---|---|
| `CryptoTest`, `GeneratorTest`, `VectorsTest`, `KdfBoundsTest` | szyfrowanie, generator, `v1.json`, granice KDF i NFC |
| `p2p/P2pVectorsTest`, `P2pVectorsV3Test`, `Ristretto255Test`, `CpaceTest`, `NoiseTest`, `PairingTest`, `HlcTest`, `P2pJsonTest`, `EntryV3Test`, `FramesTest` | te same wektory bit w bit, `safeLong`, ramki |
| `HostSyncTest`, `P2pHostTest`, `PhoneVaultTest` | rewizje, stronicowanie (500 zmian i 512 KiB), cięcie konfliktów, 410 dla starych ścieżek, odmowa nadpisania wpisu innego typu, cofnięty telefon, kody HTTP, sesje (60 s, 32), wiele wątków |
| `SyncHttpServerTest`, `FileSyncStoreTest`, `HostStateTest`, `PairingHostTest`, `PhoneRouterTest`, `LocalAddressesTest`, `PhoneVaultStoreTest` | serwer HTTP i limity, `Host`, trwała baza, parowanie po HTTP, sejf telefonu |
| `P2pInteropTest`, `PhoneInteropTest` (opcjonalne) | prawdziwy klient wtyczki w Node przeciw hostowi w Kotlinie: wpisy w obie strony, 1300/1200 wpisów, odtworzenie |
| `ScreenTests`, `SyncScreenTests`, `SyncControllerTest`, `CorruptHostStateTest` (app) | ekrany, tryb Synchronizacja, odświeżenie po synchronizacji, uszkodzony stan |
| `BiometricScreenTests` (app) | odcisk palca, blokada po wyjściu, opóźnienie 60 s (zegar Robolectric) |
| `EntryTypesTest` (app) | opisy wierszy, wyszukiwanie, `tidy`, walidacja (te same reguły co `entry-types.ts`) |
| `ListTabsScreenTest`, `SettingsScreenTests` (app) | pięć zakładek, wyszukiwanie czyszczone przy zmianie zakładki, „+ Dodaj” typu zakładki, górny pasek i Ustawienia |
| `EditLoginScreenTest`, `EditNoteScreenTest`, `EditContactScreenTest`, `EditCardScreenTest`, `EditDocumentScreenTest` (app) | formularze: pola wrażliwe i kopiowanie, listy, własne pola, formaty tylko zmienionych pól, „Ten wpis ma inny typ” |
| `AppPickerScreenTest`, `InstalledAppsTest` (app) | wybór aplikacji, ręczny pakiet, lista tylko aplikacji z launchera |
| `CommonTest`, `CsvTest`, `JsonTextTest`, `SortVectorTest`, `PassHolderJsonTest`, `BitwardenJsonTest`, `NordPassCsvTest`, `TransferTest` | pakiet `transfer`: wektory z `core/test-vectors/transfer/`, przypadki z testów TS, kolejność sortowania, brzegi JSON/CSV |
| `FileSyncStoreTest`, `PhoneVaultTest`, `PhoneVaultStoreTest` (dodatki) | `putAll` (jeden dopis, obcięty fragment), `importContents` (duplikaty, za duży wpis, rewizje, HLC), atomowość |
| `ImportSummaryTest`, `TransferFilesTest`, `TransferScreenTest`, `FilePickerLockTest` (app) | podsumowanie, limit 10 MiB i UTF-8, ekran importu i eksportu (zgoda, ponowny import), okno wyboru pliku 60 s |
| `BackupRulesTest`, `ClearClipboardWorkerTest` (app) | brak kopii zapasowych, czyszczenie schowka |
| `autofill/FieldsVectorsTest`, `ValuesVectorsTest`, `MatchVectorsTest` | port autouzupełniania: te same wektory `{fields,values,match}.json` co TypeScript, `app.json` (`matchApp`: pakiet, zaufana przeglądarka, WebView obcej aplikacji z domeną banku) |
| `autofill/PlannerTest` | grupa formularza, samo pole e-mail → loginy, rejestracja → nic, pomijanie wpisów bez wartości, karta tylko na `https`, indeks opcji listy, limit 10, opisy |
| `autofill/NodeDescriptorTest`, `ResponseBuilderTest`, `FillLogicTest`, `ManifestTest` (app) | opis pola z `inputType`/HTML/podpowiedzi, `FillResponse` i pasek klawiatury (≤ `maxSuggestionCount`, styl bez wersji UI → bez paska), odpowiedzi usługi (własny pakiet, brak sejfu, zablokowany, tylko pasujące loginy), rejestracja usługi z `BIND_AUTOFILL_SERVICE` |
| `AutofillUnlockTest`, `AutofillUnlockScreenTest`, `AutofillSettingTest` (app) | odblokowanie z podpowiedzi (złe i dobre hasło, odcisk, Wstecz, Anuluj, brak pasujących, brak żądania, ponowna blokada, powrót do aplikacji → lista), wiersz „Autouzupełnianie” w Ustawieniach (stan, „Włącz” → systemowy wybór, odświeżenie po powrocie) |
| `save/SaveVectorsTest`, `SaveFieldsTest`, `SaveTargetTest` | port pytania o zapis: te same wektory `{url,decide}.json` co TypeScript (adres, nazwa, decyzja; `www.` → brak adresu), wybór pól hasła i loginu (nowe hasło przed hasłem, e-mail przed hasłem), cel zapisu (domena tylko od zaufanej przeglądarki, inaczej pakiet), `newLogin`, `withPassword` |
| `autofill/SaveStateTest`, `SaveLoginTest`, `PendingSaveTest` (app) | `clientState` (id pól i aplikacja; tylko poniżej API 33, `SaveInfo` testuje `FillLogicTest`), zapis nowego loginu pod domeną i pod pakietem, obca aplikacja z domeną banku, zmiana hasła, to samo hasło → nic, zablokowany → `LOCKED`, komunikaty; kandydat tylko w pamięci, 2 minuty, jeden naraz |
| `AutofillSaveTest` (app) | ekran zapisu: odblokowanie tylko przy zablokowanym sejfie, podgląd i edycja (nazwa, login, hasło), zmiana hasła, „Ten login jest już zapisany”, sejf zablokowany w trakcie podglądu (ten sam szkic), wyjście w tło (D1; z opóźnieniem: powrót kasuje termin, zamknięcie go nie przesuwa), Anuluj, Wstecz, kandydat starszy niż 2 minuty z komunikatem, brak kandydata, stary termin 60 s; `SaveReviewTest` (logika: `SaveReview`, `saveReviewed`, ponowny odczyt sejfu), `SaveReviewScreenTest` (zrzut podglądu); `FillLogicTest` (`SaveInfo` dla każdego ekranu z polem hasła: kontakt, samo „nowe hasło”, odpowiedź z samym `SaveInfo` bez pasujących wpisów, brak `SaveInfo` przy wyłączonym przełączniku), `SettingsScreenTests` (przełącznik „Pytaj o zapis haseł”), `BackgroundSaveRefreshTest` (powrót do aplikacji odświeża listę po zapisie w tle) |

Zrzuty ekranów telefonu (`android/app/screenshots/`, przepisywane przy każdym przebiegu testów): 30 Ustawienia,
31-35 zakładki (Loginy, Karty, Kontakty, Notatki, Dokumenty), 36 formularz loginu, 37 pole ukryte pokazane,
38-41 formularze notatki, kontaktu, karty i dokumentu, 42 wybór aplikacji, 50 Import i eksport (`50-import-eksport.png`), 51 odblokowanie z autouzupełniania,
52 wiersz „Autouzupełnianie” w Ustawieniach, 62 przełącznik „Pytaj o zapis haseł” (`62-ustawienia-zapis.png`), 63 podgląd zapisu (`63-podglad-zapisu.png`). Zmieniły się też 03-08, 12-14, 18, 19 i 28.

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

**T11. Synchronizacja po aktualizacji obu aplikacji.** Zainstaluj nową aplikację (`.\gradlew.bat :app:installDebug`) i przeładuj wtyczkę z nowego `extension\dist` (`chrome://extensions` → odśwież). Sejf z wpisami sprzed aktualizacji: telefon i wtyczka odblokowują się bez parowania, lista pokazuje wszystkie dawne wpisy. Wpis A zmień na telefonie, wpis B we wtyczce (•) → „Synchronizuj”: zmiany są po obu stronach, a niezmienione dawne wpisy są bez zmian. Opcjonalnie: wpis z bardzo długim hasłem (ponad ok. 48 KB) → „Wpis jest za duży”.

**T12. Stara wtyczka → błąd.** Zostaw w Chrome starą wersję wtyczki (sprzed aktualizacji), telefon z nową aplikacją w trybie „Synchronizacja” → „Synchronizuj”: ogólny błąd synchronizacji (stara wtyczka dostaje 410 i nie zna lepszego komunikatu). Wpisy na telefonie bez zmian. Po aktualizacji wtyczki synchronizacja działa.

**T13. Nowa wtyczka + stary telefon.** Nowa wtyczka, na telefonie stara aplikacja (sparowany sejf) → „Synchronizuj”: „Zaktualizuj aplikację na telefonie”. Po aktualizacji aplikacji synchronizacja działa bez ponownego parowania.

**T14. Typy wpisów we wtyczce.** Dodaj we wtyczce po jednym wpisie każdego typu (login, kontakt, karta,
notatka, dokument) → „Synchronizuj” → przeładuj wtyczkę (`chrome://extensions` → odśwież) i odblokuj: wpisy są
na swoich zakładkach, pola wrażliwe zakryte. Na telefonie zmień dowolny login → „Synchronizuj”: wpisy innych
typów we wtyczce zostają bez zmian.

**T15. Typy wpisów na telefonie.** Na telefonie dodaj po jednym wpisie każdego typu na jego zakładce (login z
aplikacją wybraną z „Wybierz aplikację”, kontakt, karta z numerem i PIN-em, notatka, dokument): pola wrażliwe
zakryte, „Pokaż” odkrywa, „Kopiuj” PIN-u daje „Skopiowano PIN. Schowek zostanie wyczyszczony za 1 min.” i po minucie
schowek jest pusty. Wyszukiwanie działa na zakładce i znika po zmianie zakładki. „Synchronizuj”: wpisy są we
wtyczce na swoich zakładkach. We wtyczce zmień po jednym wpisie każdego typu → „Synchronizuj”: zmiany są na
telefonie. W „Wybierz aplikację” są aplikacje z ikoną w launcherze (np. Chrome); „+ Wpisz pakiet” przyjmuje
`com.example.app` i odrzuca `zlyPakiet`.

**T16. Import i eksport wszystkich typów.** We wtyczce wpisy każdego typu (z własnym polem) → **Plik** (nowa karta) →
PassHolder JSON → zaznacz zgodę → **Pobierz plik**. Nowy sejf (albo inna przeglądarka z własnym sejfem) → **Plik** →
wybierz ten plik → **Importuj**: „Dodano N wpisów…”, wszystkie wpisy na swoich zakładkach z tymi samymi polami.
Ten sam plik drugi raz: „Dodano 0 wpisów”, wszystkie jako pominięte duplikaty. Potem import pliku Bitwarden JSON
(login, notatka, karta, tożsamość; bez szyfrowania) i pliku NordPass CSV: wpisy trafiają na właściwe zakładki, a
pola bez odpowiednika są własnymi polami. Bitwarden z zaszyfrowanym eksportem: czytelny błąd, nic nie dodano.
Eksport Bitwarden JSON i NordPass CSV wczytaj w Bitwardenie albo NordPass i sprawdź, że wpisy się pojawiły.

**T17. Import i eksport na telefonie.** Na telefonie wpisy każdego typu (z własnym polem) → ⋮ → **Import i eksport**
→ eksport w każdym z trzech formatów (zgoda → **Zapisz plik**). Każdy plik wczytaj we wtyczce (**Plik** →
**Importuj**; nowy sejf): wpisy na swoich zakładkach z tymi samymi polami. Odwrotnie: plik PassHolder JSON ze
wtyczki zaimportuj na telefonie: „Dodano N wpisów…”, wpisy na zakładkach; ten sam plik drugi raz: „Dodano 0 wpisów”,
duplikaty. Plik Bitwarden z zaszyfrowanym eksportem i plik w Windows-1250: czytelny błąd, nic nie dodano. Po
zapisie pliku i powrocie z wyboru przed 60 s sejf jest otwarty; po ponad 60 s zablokowany.

**T18. Autouzupełnianie w Chrome.** Wtyczka z `extension\dist` przeładowana (`chrome://extensions` → odśwież), sejf
odblokowany. (1) **Login:** wpis z adresem strony logowania (np. `https://github.com/login`) → otwórz tę stronę →
okienko: u góry „Pasujące do tej strony” → **Wypełnij**: login i hasło wpisane, okienko się zamyka; strona
przyjmuje je jak wpisane ręcznie (przycisk „Zaloguj” aktywny). Na stronie z innej domeny sekcji nie ma.
(2) **Skrót przy jednym loginie:** `Ctrl+Shift+L` na tej stronie wypełnia bez okienka. (3) **Dwa loginy** na ten sam
adres: skrót otwiera okienko z oboma w sekcji; **Wypełnij** wpisuje wybrany. Po zablokowaniu sejfu skrót też
otwiera okienko. Skrót zmieniony w `chrome://extensions/shortcuts` działa. (4) **Karta:** wpis karty → sklep ze
sklepowym formularzem na `https` → okienko, zakładka Karty → **Wypełnij**: numer, ważność, CVC, imię i nazwisko.
Ramka płatności z innego origin (np. Stripe) zostaje pusta: „Nie znaleziono pól karty (mogą być w ramce operatora
płatności), skopiuj dane ręcznie”. (5) **Adres:** wpis kontaktu z adresem → formularz zamówienia → zakładka
Kontakty → **Wypełnij**; na stronie bez pól adresu „Nie znaleziono pól adresu”. (6) **Strona `http` z kartą:**
`http://` (nie `localhost`) z polem karty → **Wypełnij**: „Kartę wypełniam tylko na stronach https”, pola puste.
Na `chrome://extensions` „Na tej stronie nie można wypełniać”. Strony testowe: własny plik HTML z formularzami.

**T19. Autouzupełnianie na telefonie.** Aplikacja zainstalowana (`.\gradlew.bat :app:installDebug`), sejf z
wpisami. (1) **Włączenie:** ⋮ → **Ustawienia** → „Autouzupełnianie: Wyłączone” → **Włącz** → wybierz PassHolder
→ po powrocie „Włączone” (przycisk znika). (2) **Aplikacja:** login z aplikacją wybraną w „Wybierz aplikację”
(np. aplikacja sklepu albo banku z polem loginu) → otwórz ją, stuknij pole loginu: pod polem (i w pasku Gboard na
Androidzie 11+) podpowiedź z nazwą i loginem → wybór wpisuje login i hasło. Kilka loginów tej aplikacji: po nazwie.
(3) **Chrome:** Ustawienia Chrome → Autouzupełnianie → „Autouzupełnianie przez inną usługę”, restart Chrome →
strona z zapisanym adresem (np. `https://github.com/login`): podpowiedź loginu; na stronie innej domeny jej nie ma.
(4) **Zablokowany sejf:** ⋮ → **Zablokuj**, w aplikacji z (2) stuknij pole: „Odblokuj PassHolder” → okno odcisku
otwiera się samo (albo hasło główne; złe hasło → komunikat, ekran zostaje) → od razu podpowiedzi loginu. Zrzut
ekranu odblokowania jest zablokowany. Z „Blokuj dopiero po 60 s” sejf blokuje się po 60 s, bez – od razu;
otwarcie PassHoldera w tym czasie pokazuje listę. **Anuluj** (albo Wstecz): nic nie wpisane, sejf zablokowany.
(5) **Karta:** formularz karty w aplikacji albo w Chrome na `https`: podpowiedź `•••• 1234` → numer, ważność
(także lista miesiąca i roku), CVC, imię i nazwisko; ta sama strona po `http` (nie `localhost`): brak podpowiedzi
karty. (6) **Adres:** formularz zamówienia: podpowiedź kontaktu (imię i nazwisko) → imię, nazwisko, e-mail, telefon, ulica,
kod, miasto, kraj. Samo pole e-mail (np. pierwszy krok logowania Google) podpowiada loginy, nie kontakty.
(7) **Obca aplikacja:** aplikacja z WebView pokazującym stronę zapisanego loginu (np. przeglądarka spoza listy
zaufanych albo aplikacja z wbudowaną stroną logowania): podpowiedzi loginu tej strony **nie ma**. (8) W samym
PassHolderze (np. pole „Hasło główne”) usługa nic nie podpowiada; formularz rejestracji z samym polem
`new-password` nie dostaje nic, a z e-mailem i `new-password` – loginy tylko w polu e-mail (nowe hasło puste). Zapisz wynik, model telefonu, wersję Androida, klawiatury i Chrome.

**T20. Pytanie o zapis w Chrome.** Wtyczka z `extension\dist` przeładowana, sejf z kilkoma wpisami. (1) **Włączenie:**
lista → **Zapis** → „Pytaj o zapis haseł”: Chrome pyta o dostęp do wszystkich stron (odmowa: przełącznik zostaje
wyłączony); zezwól, przeładuj kartę testową. Po zablokowaniu uprawnienia w `chrome://extensions` przełącznik jest
wyłączony. (2) **Nowy login:** strona z formularzem logowania (własny HTML albo prawdziwa strona) → zaloguj się
nowym loginem: panel „Zapisać login w PassHolder?” z hostem i loginem → **Zapisz**: „Zapisano”, panel znika po 2 s,
wpis ma adres samej domeny. Ponowne logowanie tym samym hasłem: bez panelu. (3) **Zmiana hasła:** ten sam login z
innym hasłem → „Zaktualizować hasło…?” → **Aktualizuj**: zmieniło się tylko hasło. Rejestracja z polem „nowe
hasło” pyta o to hasło. (4) **Bez przeładowania i przekierowania:** logowanie przez fetch/SPA (panel od razu) i
przez przekierowanie na inną stronę tej samej domeny (panel po załadowaniu, do 2 min). Złe hasło z przeładowaniem
tego samego formularza: bez panelu. Panel zostawiony bez odpowiedzi znika sam po 2 min. (5) **Odmowy:** **Nie teraz** i × zamykają panel; po przeładowaniu go nie ma.
**Nigdy dla tej strony**: host na liście w **Zapis**, kolejne logowanie bez pytania, **Usuń** przywraca pytanie.
(6) **Zablokowany sejf:** wyślij formularz, zablokuj sejf (albo poczekaj 15 min): panel „Odblokuj i zapisz” →
okienko → hasło albo PIN → najpierw pytanie o zapis, potem lista. (7) **Wyłączenie:** przełącznik wyłączony →
Chrome cofa uprawnienie, formularze nie pytają (połączenie z telefonem po `http` nadal działa). Zapisz wersję Chrome.

**PIN i karta.** PIN `4821` → Zablokuj → zły PIN „Pozostało prób: 4”, dobry otwiera; restart Chrome prosi o
hasło główne. „Otwórz w karcie ↗” dwa razy: drugi raz przełącza na istniejącą kartę.

**T21. Pytanie o zapis na telefonie.** Aplikacja zainstalowana, usługa autouzupełniania włączona, w Chrome „inna usługa
autouzupełniania”, sejf z kilkoma wpisami, w Ustawieniach „Pytaj o zapis haseł” włączone. (1) **Aplikacja, nowy
login:** aplikacja z ekranem logowania (własna testowa albo prawdziwa) → zaloguj się nowym loginem:
okno systemu z pytaniem o zapis w PassHolder → **Zapisz**: „Zapisano w PassHolder”, na liście loginów nowy wpis z nazwą aplikacji i jej
pakietem. (2) **Chrome, nowy login:** strona logowania (własny HTML albo prawdziwa) → nowy login: okno systemu →
zapis; wpis ma nazwę i adres samej domeny. Ponowne logowanie tym samym hasłem: bez okna. (3) **Chrome, zmiana
hasła:** ten sam login z innym hasłem → okno → „Zaktualizowano hasło w PassHolder”, zmieniło się tylko hasło
(login w innej wielkości liter: aktualizacja, nie duplikat). (4) **Zablokowany sejf:** zablokuj sejf, zaloguj się
nowym loginem: okno systemu → ekran odblokowania; hasło główne (potem to samo z odciskiem palca: okno odcisku
otwiera się samo) → „Zapisano w PassHolder”, sejf znów zablokowany (po 60 s albo od razu, zależnie od „Blokuj
dopiero po 60 s”). Wstecz i **Anuluj** przed odblokowaniem: nic nie zapisane, sejf zablokowany, kolejne logowanie pyta od nowa; na
podglądzie: nic nie zapisane, sejf blokuje się jak po zapisie (po 60 s albo od razu); po 2
minutach bez odblokowania nic się nie zapisuje. (5) **Przełącznik wyłączony:** „Pytaj o zapis haseł” wyłączony,
ponowne wypełnienie ekranu logowania (stuknięcie w pole) → logowanie nie pokazuje okna. (6) **Brak pasujących
wpisów:** logowanie na stronie bez wpisu w sejfie też pyta o zapis. (7) **Rejestracja i kontakt:** formularz rejestracji (e-mail i „nowe hasło”)
oraz formularz kontaktowy z polem hasła też pokazują okno systemu; po „Zapisz” otwiera się podgląd. (8) **Podgląd i edycja:**
w podglądzie zmień Nazwę, Login i Hasło (Pokaż): nagłówek zmienia się na bieżąco („Nowy login” / „Zmiana hasła: …”),
„Zapisz” jest nieaktywny przy pustym haśle, we wpisie ląduje to, co wpisano; istniejący login z tym samym hasłem →
„Ten login jest już zapisany w PassHolder”. **Blokada w trakcie podglądu:** zablokuj sejf (albo poczekaj), „Zapisz” →
odblokowanie → ten sam podgląd z wpisanymi danymi; wyjście z aplikacji z podglądu blokuje sejf. (9) **Logowanie dwuetapowe:** e-mail na jednym ekranie, hasło
na następnym: wpis ma pusty login, który można uzupełnić w podglądzie (od API 28). (10) **Zapis w tle:** po zapisie przy otwartej
aplikacji (np. po powrocie do niej) lista pokazuje nowy wpis albo nowe hasło. Zapisz wynik, model telefonu, wersję
Androida i Chrome.

## Czego brakuje

- Testów `offscreen.ts` i `clipboard.ts` (API Chrome). Widoki są testowane w happy-dom, w prawdziwym Chromium
  tylko zrzutami ekranów (bez asercji na wyglądzie poza szerokością i zakryciem pól).
- Testów automatycznych prośby o zgodę Chrome, Private Network Access i Tailscale (T4, T7 ręcznie).
- Testów na prawdziwym telefonie (Keystore, `BiometricPrompt`, port 8787) i wydajności Argon2id.
- Pytania o zapis w prawdziwym Chrome: zgoda na dostęp do stron, `openPopup`, rejestracja skryptu, panel w prawdziwych stronach (T20 ręcznie).
- Autouzupełniania z prawdziwym systemem: `readRequest` (prawdziwy `AssistStructure`), wpisanie wartości przez
  system, Chrome z „inną usługą”, pasek klawiatury Gboard (T19 ręcznie).
- Pytania o zapis z prawdziwym systemem: okno systemu z pytaniem o zapis w PassHolder, `onSaveRequest` z prawdziwym `SaveRequest`,
  Chrome z „inną usługą” (T21 ręcznie).
- Na telefonie: zajętego portu, obrotu ekranu przy działającym serwerze, wygasania kodu przez zegar.
