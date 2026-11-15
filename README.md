# pass-holder

Prywatny menedżer haseł: aplikacja na Androida przechowuje sejf, a wtyczka do Chrome synchronizuje się z nią
bezpośrednio w sieci domowej albo przez Tailscale (parowanie kodem, szyfrowanie Noise). Serwer nie jest
potrzebny. Instalacja: [docs/INSTALACJA.md](docs/INSTALACJA.md).

| Katalog | Zawartość |
|---|---|
| `core/` | Wspólny rdzeń w TypeScript: szyfrowanie, generator haseł, parowanie i synchronizacja P2P, wektory testowe |
| `extension/` | Wtyczka Chrome (Manifest V3) |
| `android/` | Aplikacja Android (Kotlin, Jetpack Compose): sejf i host synchronizacji na porcie 8787 |
| `docs/` | Dokumentacja (spis niżej) |

Poza podstawą (wpisy, generator, synchronizacja offline-first) są: kilka adresów telefonu (LAN + Tailscale),
odtwarzanie telefonu z wtyczki, automatyczna blokada, PIN i import/eksport CSV we wtyczce, odcisk palca na
Androidzie.

## Dokumentacja

| Dokument | Treść |
|---|---|
| [docs/INSTALACJA.md](docs/INSTALACJA.md) | Instalacja na Windows krok po kroku, aktualizacje, kopia zapasowa, problemy, dezinstalacja |
| [docs/ARCHITEKTURA.md](docs/ARCHITEKTURA.md) | Mapa kodu: który plik za co odpowiada, przepływ synchronizacji |
| [docs/SPEC.md](docs/SPEC.md) | Kryptografia i format danych |
| [docs/SYNCHRONIZACJA.md](docs/SYNCHRONIZACJA.md) | Synchronizacja telefon–wtyczka: parowanie, Noise, konflikty, telefon, wtyczka, ograniczenia |
| [docs/FUNKCJE.md](docs/FUNKCJE.md) | Funkcje urządzeń: blokada, PIN, CSV, karta, odcisk palca, schowek |
| [docs/TESTY.md](docs/TESTY.md) | Testy automatyczne i ręczne |
| [docs/PRZEGLAD_BEZPIECZENSTWA_V3.md](docs/PRZEGLAD_BEZPIECZENSTWA_V3.md) | Przegląd bezpieczeństwa po V3: znaleziska, naprawy, grupy poprawek |
| [docs/archive/](docs/archive/README.md) | Dokumenty historyczne (wersja z Raspberry Pi, wykonane plany) |

## Testy i budowanie (TypeScript)

Wymaga Node.js 22.18 lub nowszego (na Windows przez `fnm`: `fnm env --shell powershell | Out-String | Invoke-Expression`).

```sh
npm ci
npm test
npm run typecheck
npm run build            # wtyczka do extension/dist
```

Co testujemy i jakie luki znalazły testy: [docs/TESTY.md](docs/TESTY.md).

Wektory testowe generują `npm run gen-vectors -w core` (`core/test-vectors/v1.json`: KDF i klucz sejfu) i
`npm run gen-vectors-v2 -w core` (`v2.json`: wpisy, parowanie, Noise). Implementacja w Kotlinie musi
odtworzyć je dokładnie.

## Wtyczka do Chrome

W Chrome: `chrome://extensions` → włącz „Tryb dewelopera” → „Załaduj rozpakowane” → wskaż `extension/dist`.
Parowanie z telefonem otwiera formularz w karcie i prosi o zgodę na dostęp do adresu telefonu
(`http://<IPv4>:8787`), patrz [docs/SYNCHRONIZACJA.md](docs/SYNCHRONIZACJA.md#7-wtyczka).

## Aplikacja na Androida

Wymaga Android SDK (najprościej: Android Studio) i JDK 21 do Gradle. W PowerShellu, w katalogu `android/`:

```powershell
$env:JAVA_HOME="$HOME\.jdks\jbr-21.0.11"     # JBR 25 z Android Studio nie działa z Gradle 8.14.3
.\gradlew.bat :core:test                     # krypto, wektory, rdzeń P2P, serwer telefonu (zwykła JVM)
.\gradlew.bat :app:testDebugUnitTest         # ekrany aplikacji na JVM (Robolectric), zrzuty do app/screenshots/
.\gradlew.bat :app:installDebug              # instalacja na telefonie podłączonym przez USB (debugowanie USB)
```

Na Linuksie to samo przez `./gradlew`. Testy ekranów uruchamiają prawdziwą aplikację (aktywność, ViewModel,
Compose) bez emulatora i klikają ją jak użytkownik: nowy sejf, generator, tryb Synchronizacja, parowanie,
urządzenia, odtwarzanie z wtyczki, blokada. Zrzuty ekranów: [`android/app/screenshots/`](android/app/screenshots/).

Test współpracy z kodem wtyczki (Node.js na PATH, wcześniej `npm ci` w katalogu głównym):
`PASSHOLDER_INTEROP_TEST=1 ./gradlew :core:test --tests "*Interop*"` (PowerShell: [docs/TESTY.md](docs/TESTY.md)).
