# pass-holder

Prywatny menedżer haseł z serwerem synchronizacji na Raspberry Pi, wtyczką do Chrome i aplikacją na Androida.

| Katalog | Zawartość | Status |
|---|---|---|
| `docs/SPEC.md` | Kryptografia, model danych, protokół synchronizacji, API | gotowe |
| `core/` | Wspólny rdzeń w TypeScript: szyfrowanie, generator haseł, logika sync, wektory testowe | gotowe |
| `server/` | Serwer na Raspberry Pi (Node.js, Fastify, SQLite) | gotowe |
| `deploy/`, `docs/RASPBERRY_PI.md` | Certyfikaty, usługa systemd, VPN, instrukcja instalacji | gotowe |
| `extension/` | Wtyczka Chrome (Manifest V3) | krok 3 |
| `android/` | Aplikacja Android (Kotlin, Jetpack Compose) | krok 4 |

## Uruchomienie testów

Wymaga Node.js 22.18 lub nowszego.

```sh
npm install
npm test
npm run typecheck
```

Wektory testowe (`core/test-vectors/v1.json`) generuje `npm run gen-vectors -w core`.
Każda implementacja (także Kotlin) musi odtworzyć je dokładnie.

## Serwer lokalnie (bez HTTPS, do testów)

```sh
PASSHOLDER_INSECURE_HTTP=1 PASSHOLDER_PORT=8080 npm start -w server
```

Instalacja na Raspberry Pi: [docs/RASPBERRY_PI.md](docs/RASPBERRY_PI.md).
