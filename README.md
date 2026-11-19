# pass-holder

Prywatny menedżer haseł: aplikacja na Androida przechowuje sejf, a wtyczka do Chrome synchronizuje się z nią
bezpośrednio w sieci domowej albo przez Tailscale (parowanie 8-cyfrowym kodem, szyfrowanie Noise). Serwer nie jest
potrzebny. Instalacja: [docs/INSTALACJA.md](docs/INSTALACJA.md).

| Katalog | Zawartość |
|---|---|
| `core/` | Wspólny rdzeń w TypeScript: szyfrowanie, generator haseł, format wpisów, parowanie i synchronizacja P2P, pliki, import/eksport, dopasowanie adresów, wektory testowe |
| `extension/` | Wtyczka Chrome (Manifest V3) |
| `android/` | Aplikacja Android (Kotlin, Jetpack Compose): sejf, host synchronizacji na porcie 8787, autouzupełnianie |
| `docs/` | Dokumentacja (spis niżej) |
| `.github/workflows/ci.yml` | CI: lint, formatowanie, testy TS i Androida |

## Funkcje

- **Wpisy pięciu typów:** loginy, kontakty, karty, notatki, dokumenty; generator haseł; załączniki (pliki
  szyfrowane kawałkami, synchronizowane z telefonem).
- **Synchronizacja offline-first** telefon–wtyczka: kilka adresów telefonu (LAN + Tailscale), konflikty
  rozstrzygane zegarem HLC, odtwarzanie telefonu z wtyczki.
- **Autouzupełnianie i pytanie o zapis** w Chrome i na Androidzie (lista sufiksów publicznych).
- **Import i eksport:** PassHolder JSON i ZIP (z plikami), Bitwarden JSON, NordPass CSV.
- **Ochrona:** automatyczna blokada, PIN we wtyczce, odcisk palca i blokada po wyjściu na Androidzie,
  zmiana hasła głównego, czyszczenie schowka.

Szczegóły: [docs/FUNKCJE.md](docs/FUNKCJE.md).

## Dokumentacja

| Dokument | Treść |
|---|---|
| [docs/INSTALACJA.md](docs/INSTALACJA.md) | Instalacja na Windows krok po kroku, aktualizacje, kopia zapasowa, problemy, dezinstalacja |
| [docs/ARCHITEKTURA.md](docs/ARCHITEKTURA.md) | Mapa kodu: który plik za co odpowiada, przepływy, konwencje, stan przeglądów |
| [docs/SPEC.md](docs/SPEC.md) | Kryptografia i format danych (wpisy, pliki, import/eksport) |
| [docs/SYNCHRONIZACJA.md](docs/SYNCHRONIZACJA.md) | Synchronizacja telefon–wtyczka: parowanie, Noise, konflikty, pliki, telefon, wtyczka, ograniczenia |
| [docs/FUNKCJE.md](docs/FUNKCJE.md) | Funkcje urządzeń: typy wpisów, blokada, PIN, import/eksport, odcisk palca, autouzupełnianie, pytanie o zapis |
| [docs/TESTY.md](docs/TESTY.md) | Testy automatyczne i ręczne, lint, zależności |
| [docs/archive/](docs/archive/README.md) | Dokumenty historyczne: przeglądy bezpieczeństwa i czystości kodu, wykonane plany i specyfikacje, wersja z Raspberry Pi |

## Testy i budowanie (TypeScript)

Wymaga Node.js 22.18 lub nowszego (na Windows przez `fnm`: `fnm env --shell powershell | Out-String | Invoke-Expression`).

```sh
npm ci
npm test                 # core i extension (Vitest)
npm run typecheck
npm run lint             # ESLint
npm run format:check     # Prettier (npm run format poprawia)
npm run build            # wtyczka do extension/dist
```

Co testujemy i jakie luki znalazły testy: [docs/TESTY.md](docs/TESTY.md).

Wektory testowe (`core/test-vectors/`) odtwarzają skrypty z `core/scripts/`: `npm run gen-vectors -w core`
(`v1.json`: KDF i klucz sejfu), `gen-vectors-v2` (`v2.json`: parowanie, Noise), `gen-vectors-v3` (`v3.json`: wpisy
v3), `gen-vectors-files` (`files/files.json`), `gen-psl` (lista sufiksów publicznych dla TS i Kotlina). Wektory
importu i eksportu: `node --experimental-strip-types core/scripts/transfer-vectors.ts`. Implementacja w Kotlinie musi
odtworzyć je dokładnie.

## Wtyczka do Chrome

W Chrome: `chrome://extensions` → włącz „Tryb dewelopera” → „Załaduj rozpakowane” → wskaż `extension/dist`.
Parowanie z telefonem otwiera formularz w karcie i prosi o zgodę na dostęp do adresu telefonu
(`http://<IPv4>:8787`), patrz [docs/SYNCHRONIZACJA.md](docs/SYNCHRONIZACJA.md#7-wtyczka).

## Aplikacja na Androida

Wymaga Android SDK (najprościej: Android Studio) i JDK 21 do Gradle. W PowerShellu, w katalogu `android/`:

```powershell
$env:JAVA_HOME="$HOME\.jdks\jbr-21.0.11"     # JBR 25 z Android Studio nie działa z Gradle 8.14.3
.\gradlew.bat ktlintCheck                    # styl Kotlina (ktlintFormat poprawia)
.\gradlew.bat :core:test                     # krypto, wektory, rdzeń P2P, serwer telefonu (zwykła JVM)
.\gradlew.bat :app:testDebugUnitTest         # ekrany aplikacji na JVM (Robolectric), zrzuty do app/screenshots/
.\gradlew.bat :app:installDebug              # instalacja na telefonie podłączonym przez USB (debugowanie USB)
```

Na Linuksie to samo przez `./gradlew`. Testy ekranów uruchamiają prawdziwą aplikację (aktywność, ViewModel,
Compose) bez emulatora i klikają ją jak użytkownik. Nadpisują zrzuty w
[`android/app/screenshots/`](android/app/screenshots/), więc po nich `git checkout android/app/screenshots`, jeśli
nie zmieniałeś ekranów.

Test współpracy z kodem wtyczki (Node.js na PATH, wcześniej `npm ci` w katalogu głównym):
`PASSHOLDER_INTEROP_TEST=1 ./gradlew :core:test --tests "*Interop*"` (PowerShell: [docs/TESTY.md](docs/TESTY.md)).
