# pass-holder

Prywatny menedżer haseł z serwerem synchronizacji na Raspberry Pi, wtyczką do Chrome i aplikacją na Androida.

| Katalog | Zawartość | Status |
|---|---|---|
| `docs/SPEC.md` | Kryptografia, model danych, protokół synchronizacji, API | gotowe |
| `core/` | Wspólny rdzeń w TypeScript: szyfrowanie, generator haseł, logika sync, wektory testowe | gotowe |
| `server/` | Serwer na Raspberry Pi (Node.js, Fastify, SQLite) | gotowe |
| `deploy/` | Certyfikaty, usługa systemd, VPN | gotowe |
| `docs/INSTALACJA.md` | Instalacja krok po kroku: Raspberry Pi, Chrome, Android | gotowe |
| `extension/` | Wtyczka Chrome (Manifest V3) | gotowe |
| `android/` | Aplikacja Android (Kotlin, Jetpack Compose) | gotowe |

## Uruchomienie testów

Wymaga Node.js 22.18 lub nowszego.

```sh
npm install
npm test
npm run typecheck
```

Co testujemy i jakie luki znalazły testy: [docs/TESTY.md](docs/TESTY.md).

Wektory testowe (`core/test-vectors/v1.json`) generuje `npm run gen-vectors -w core`.
Każda implementacja (także Kotlin) musi odtworzyć je dokładnie.

## Serwer lokalnie (bez HTTPS, do testów)

```sh
PASSHOLDER_INSECURE_HTTP=1 PASSHOLDER_PORT=8080 npm start -w server
```

Instalacja na Raspberry Pi: [docs/INSTALACJA.md, część 1](docs/INSTALACJA.md#część-1-serwer-na-raspberry-pi).

## Wtyczka do Chrome

```sh
npm run build -w extension
```

Potem w Chrome: `chrome://extensions` → włącz „Tryb dewelopera” → „Załaduj rozpakowane” → wskaż `extension/dist`.
Wcześniej zainstaluj w Chrome urząd certyfikacji serwera (`ca.crt`, patrz [docs/INSTALACJA.md, część 2](docs/INSTALACJA.md#część-2-wtyczka-do-chrome)).
Przy pierwszym połączeniu wtyczka otworzy formularz w karcie i poprosi o zgodę na dostęp do adresu serwera.

## Aplikacja na Androida

Wymaga JDK 17 lub nowszego i Android SDK (najprościej: zainstaluj Android Studio i otwórz katalog `android/`).

```sh
cd android
./gradlew :core:test            # krypto, wektory testowe, synchronizacja, klient HTTP (zwykła JVM, bez emulatora)
./gradlew :app:testDebugUnitTest  # ekrany aplikacji na JVM (Robolectric), zrzuty do app/screenshots/
./gradlew :app:assembleDebug    # APK: app/build/outputs/apk/debug/app-debug.apk
```

Testy ekranów uruchamiają prawdziwą aplikację (aktywność, ViewModel, Compose) bez emulatora i klikają ją jak
użytkownik: parowanie, nowy sejf, generator, synchronizacja, kopiowanie hasła, usuwanie, blokada.
Przy każdym uruchomieniu Roborazzi zapisuje zrzuty ekranów w [`android/app/screenshots/`](android/app/screenshots/).

Test całego systemu: prawdziwy serwer Node.js przez HTTPS, klient w Kotlinie i kod wtyczki w TypeScripcie
na jednym sejfie (wymaga wcześniejszego `npm install` w katalogu głównym i `openssl`):

```sh
cd android
PASSHOLDER_SERVER_TEST=1 ./gradlew :core:test
```

Instalacja na telefonie: włącz w telefonie debugowanie USB, podłącz go i uruchom `./gradlew :app:installDebug`
(albo przycisk Run w Android Studio). Przy łączeniu aplikacja pokaże odcisk certyfikatu serwera do porównania
z Raspberry Pi, patrz [docs/INSTALACJA.md, część 3](docs/INSTALACJA.md#część-3-aplikacja-na-androida).
