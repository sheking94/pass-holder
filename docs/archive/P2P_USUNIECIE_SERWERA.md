# Usunięcie serwera Pi (plan 4)

> Dokument historyczny: opisuje jednorazową zmianę z 2026-11-07 (PR #26).

Dokument opisuje ostatni krok synchronizacji bez Pi (projekt w [../SYNCHRONIZACJA.md](../SYNCHRONIZACJA.md)): z repozytorium zniknął serwer na Raspberry Pi i kod klientów v1, który z nim rozmawiał.
Zostały tylko telefon (kotwica sejfu) i wtyczka. Plan wykonania:
[plany/2026-11-07-p2p-usuniecie-serwera.md](plany/2026-11-07-p2p-usuniecie-serwera.md).

Po planie 3 wtyczka i telefon już nie korzystały z Pi, ale kod v1 nadal się kompilował i był testowany.
Plan 4 go usuwa, żeby nie utrzymywać dwóch dróg synchronizacji i żeby dokumentacja opisywała jedną.

## 1. Co usunięto i dlaczego

| Gdzie | Co | Dlaczego |
|---|---|---|
| `server/` | serwer Node.js (Fastify, SQLite): `/api/v1/status`, `setup`, `prelogin`, `session`, `sync`, testy `api.test.ts`, `security.test.ts` | rolę hosta przejął telefon |
| `deploy/` | `make-certs.sh` (CA i certyfikat), `passholder.service` (systemd), `passholder.env.example`, `vpn.sh` | dotyczyły tylko Pi; telefon nie używa TLS (poufność daje Noise) |
| `core/src/sync.ts` | klient synchronizacji v1 (`modifiedAt`, logowanie `authKey`) | wtyczka używa `core/src/p2p/sync.ts` (HLC) |
| `core/src/vault.ts` | `entryAad`, `encryptPayload`, `decryptPayload`, `parseEntryData`, `parseTombstoneData`, `EntryData`, `TombstoneData` | wpisy v1; wpisy v2 są w `core/src/p2p/entry.ts` |
| `core/src/kdf.ts` | `authHash` | sprawdzał go tylko serwer |
| `core/test/` | `sync.test.ts`, `malicious-server.test.ts`, przypadki klienta v1 w `sync-edge.test.ts` i `edge-cases.test.ts` | testowały usunięty kod |
| `android/core` | `ServerClient.kt`, `ServerPicker.kt`, `CertificatePin.kt`, `Sync.kt`, `VaultStore.kt`; w `Vault.kt` wpisy v1 (`entryAad`, `encryptEntry`, `decryptRecord`, `EntryPayload`, `TombstonePayload`); `SyncRequest` w `Protocol.kt`; `Kdf.authHash` | klient v1 telefonu; sejf telefonu to `p2p/PhoneVaultStore.kt` |
| testy Androida | `CertificatePinTest`, `ServerPickerTest`, `RealServerTest`, `SyncTest`, `VaultStoreTest`, `MaliciousServerTest`, `EdgeCaseTest`; `testFixtures/.../FakeServer.kt`; `test/resources/interop.ts` | testowały usunięty kod; z `EdgeCaseTest` granice KDF i NFC przeszły do nowego `KdfBoundsTest` |
| konfiguracja | workspace `server` w `package.json`, `@passholder/server` w `extension/package.json`, wpisy `*.db*` w `.gitignore`, `PASSHOLDER_SERVER_TEST` w `android/core/build.gradle.kts` | nic już z nich nie korzysta |

## 2. Co zostało i dlaczego

- **`processSync` i `MemorySyncStore`** (`core/src/protocol.ts`, `HostSync.kt`). To logika hosta: przyjmuje
  zmiany z `baseRevision`, nadaje rosnące `revision`, zwraca konflikty. Telefon korzysta z niej w
  `processP2pSync` / `HostSync.process`, a testy P2P z `MemorySyncStore`. Zmieniły się tylko komentarze
  („host”, nie „serwer”).
- **Podział klucza głównego** (`deriveKeys`: `encKey` + `authKey`). `authKey` jest nadal liczony, choć
  nikt go nie używa (telefon go zeruje). Podział to część formatu danych: inny podział dałby inny
  `encKey`, a istniejące sejfy na telefonie i we wtyczce przestałyby się otwierać.
- **`core/test-vectors/v1.json`** bez zmian. KDF, HKDF, zawijanie klucza sejfu i AES-GCM to nadal używane
  prymitywy. Plik ma jeszcze pole `authHash` w wektorach KDF; nikt go już nie sprawdza (komentarz w
  `core/scripts/gen-vectors.ts`), a wektor szyfrowania nadal używa AAD wpisu v1, zdefiniowanego lokalnie w
  skrypcie.
- **`VaultCrypto` / `vault.ts`**: `newVaultKey`, `wrapVaultKey`, `unwrapVaultKey` i `VAULT_KEY_AAD`, bo
  `wrappedVaultKey` z hasła głównego przechodzi przy parowaniu i odtwarzaniu. `Credentials` w `Vault.kt`
  zostaje (używa go `PhoneVault`).
- **Blokady bez zmian.** `PhoneVaultStore.AUTO_LOCK_MS` to nadal 15 minut, teraz zapisane wprost
  (`15 * 60_000L`) zamiast odwołania do `VaultStore.AUTO_LOCK_MS`. Blokada 60 s po wyjściu z aplikacji
  (`LeaveLock`) się nie zmieniła.
- **Stare dane v1** na urządzeniach (klucze `account` i `vault` w `chrome.storage.local`, `filesDir/vault` na
  telefonie) nie są czytane ani kasowane; znikają przy usunięciu wtyczki albo aplikacji.

## 3. Zmiany nazw

| Było | Jest |
|---|---|
| `extension/src/server-urls.ts`, `pickServer` | `extension/src/phone-urls.ts`, `pickPhone` |
| `extension/src/ui/server-url-fields.ts`, `serverUrlFields` | `extension/src/ui/phone-url-fields.ts`, `phoneUrlFields` |
| `extension/test/server-urls.test.ts` | `extension/test/phone-urls.test.ts` |

Zmiana bez zmiany zachowania (`git mv`, historia plików zostaje). Importy w `vault-store.ts`,
`views/connect.ts`, `views/addresses.ts` i `ui/state.ts` poprawione.

## 4. Zależności

- **npm:** bez workspace `server`; `package-lock.json` stracił Fastify i jego zależności. `npm ci` instaluje
  tylko `core` i `extension`.
- **Android `core`:** `okhttp` nie jest już zależnością (`api`). Zostaje tylko `okhttp.mockwebserver` jako
  `testImplementation` dla `P2pInteropTest` (host w Kotlinie za MockWebServer, klient wtyczki w Node).
  `testFixtures` nie ma już MockWebServer (zniknął `FakeServer`).
- **Android `app`:** bez `okhttp.tls` w testach. W `libs.versions.toml` usunięte `okhttp` i `okhttp-tls`.
- **`proguard-rules.pro`:** usunięte trzy linie `-dontwarn` dla OkHttp (`okhttp3.internal.platform`,
  `org.conscrypt`, `org.openjsse`); zostaje `-dontwarn org.bouncycastle.**`.
- **`network_security_config.xml`** (main i debug): komentarze mówią teraz, że aplikacja nie łączy się sama z
  niczym, a telefon jest hostem synchronizacji. Ustawienia (`cleartextTrafficPermitted`) bez zmian.

## 5. Liczby testów

| Pakiet | Przed planem 4 | Po planie 4 |
|---|---|---|
| `core` | 16 plików, ok. 169 testów (24 mniej: klient v1 i złośliwy serwer) | 14 plików, 145 |
| `server` | 2 pliki, 24 testy | usunięty |
| `extension` | 8 plików, 86 | 8 plików, 86 (bez zmian) |
| `android/core` | 42 adnotacje `@Test` więcej (44 usunięte, 2 nowe w `KdfBoundsTest`) | 298, 4 pomijane bez `PASSHOLDER_INTEROP_TEST=1` |
| `android/app` | 31 | 31 (bez zmian) |

Liczby „przed” dla `core` i `android/core` są policzone z różnicy w kodzie testów (`it(` i `@Test`), nie z
uruchomienia. Pełny opis testów: [../TESTY.md](../TESTY.md).

## 6. Jak sprawdzić na Windows

W PowerShellu, w `<repo>`:

```powershell
git pull
fnm env --shell powershell | Out-String | Invoke-Expression
npm ci
npm test; npm run typecheck; npm run build

cd android
$env:JAVA_HOME="$HOME\.jdks\jbr-21.0.11"
.\gradlew.bat :core:test :app:testDebugUnitTest --console=plain
git checkout app/screenshots        # testy ekranów nadpisują zrzuty losowymi danymi
```

Na urządzeniach:

1. `chrome://extensions` → odśwież PassHolder. Wtyczka otwiera istniejący sejf tym samym hasłem
   (format w `chrome.storage` bez zmian), **Synchronizuj** działa z telefonem w trybie Synchronizacja.
2. Telefon przez USB: `.\gradlew.bat :app:installDebug`. Aplikacja instaluje się jako aktualizacja i otwiera
   istniejący sejf.
3. `git grep -n "server/\|deploy/\|PASSHOLDER_SERVER" -- . ":!docs"` nic nie znajduje: kod nie odwołuje się do usuniętych plików.

Instalacja od zera bez Pi: [../INSTALACJA.md](../INSTALACJA.md); dokumenty z wersji z Pi: [archiwum](README.md).
