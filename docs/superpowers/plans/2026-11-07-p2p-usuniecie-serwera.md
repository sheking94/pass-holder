# P2P plan 4: usunięcie serwera Pi – plan wykonania

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development lub superpowers:executing-plans. Kroki w formacie `- [ ]`.

**Cel:** usunąć z repozytorium kod i dokumentację synchronizacji v1 (Raspberry Pi), tak żeby zostały tylko telefon (kotwica) i wtyczka.

**Podejście:** najpierw szukamy, co z v1 jest jeszcze używane przez P2P (kompilator i testy to potwierdzają), resztę kasujemy. Format kryptograficzny (Argon2id, podział klucza głównego, AES-256-GCM, `wrapVaultKey`) **zostaje bez zmian**, bo istniejące sejfy na telefonie i we wtyczce z niego korzystają.

**Spec:** `docs/SYNCHRONIZACJA_P2P.md`, sekcja 8 punkt 5 („Usunięcie `server/`, `deploy/` i części `INSTALACJA.md` o Pi”).

## Ograniczenia globalne

- Bez zmiany formatu danych: `deriveKeys` nadal dzieli klucz na `encKey` + `authKey` (authKey nieużywany, zerowany). Zmiana podziału = nieczytelne sejfy.
- `core/test-vectors/v1.json` zostaje (KDF + seal to nadal używane prymitywy); usuwamy tylko sprawdzanie pola `authHash`.
- `MemorySyncStore` i `processSync` zostają (telefon i testy P2P ich używają).
- Instrukcje dla użytkownika: Windows 11, PowerShell, `$env:JAVA_HOME="$HOME\.jdks\jbr-21.0.11"`, port 8787.
- Po każdym zadaniu: `npm test`, `npm run typecheck`, `npm run build`; po zadaniach Androida `./gradlew :core:test :app:testDebugUnitTest`.

## Na co uważać przy przeglądzie

1. Wtyczka zbudowana po zmianie otwiera istniejący sejf (te same klucze w `chrome.storage`) – test `vault-store.test.ts` musi dalej przechodzić bez zmian w danych testowych.
2. Telefon otwiera istniejący sejf po aktualizacji (`PhoneVaultStoreTest` bez zmian w danych).
3. Brak zależności `okhttp` w `android/core` (main) nie łamie `SyncHttpServer` ani testów współpracy (`P2pInteropTest`, `PhoneInteropTest`).
4. `package-lock.json` po usunięciu workspace `server` instaluje się czysto (`npm ci`).
5. Żaden dokument nie odsyła do usuniętych plików (`grep -rn "server/\|deploy/\|Raspberry"` w `docs/` i `README.md` daje tylko notki historyczne).

---

### Zadanie 1: TypeScript – usunięcie `server/`, `deploy/` i klienta v1 w `core/`

**Pliki:**
- Usuń: `server/`, `deploy/`, `core/src/sync.ts`, `core/test/sync.test.ts` (część dotycząca klienta v1), `core/test/malicious-server.test.ts` (jeśli testuje tylko `applySyncResponse`).
- Zmień: `package.json` (workspaces bez `server`), `package-lock.json` (przez `npm install`), `extension/package.json` (bez `@passholder/server`), `core/src/index.ts`, `core/src/vault.ts` (zostają `VAULT_KEY_AAD`, `newVaultKey`, `wrapVaultKey`, `unwrapVaultKey`; znikają `entryAad`, `encryptPayload`, `decryptPayload`, `parseEntryData`, `parseTombstoneData`, `EntryData`, `TombstoneData`), `core/src/kdf.ts` (bez `authHash`), `core/src/protocol.ts` (komentarz: to logika hosta, nie serwera), `core/test/vectors.test.ts` (bez asercji `authHash`), `core/scripts/gen-vectors.ts`, `.gitignore`.
- Zostają: testy `processSync` (`sync-edge.test.ts`; przypadki klienta v1 z niego wycinamy).

- [ ] Usuń pliki, popraw importy; `npm run typecheck` pokazuje, co jeszcze odwołuje się do usuniętych nazw.
- [ ] `NO_PROXY=localhost npm install --cafile=/root/.ccr/ca-bundle.crt`, potem `npm ci` przechodzi.
- [ ] `npm test && npm run typecheck && npm run build` – wszystko zielone.
- [ ] Commit `core, server: remove v1 Pi sync`.

### Zadanie 2: wtyczka – nazwy „server” → „phone”

**Pliki:** `extension/src/server-urls.ts` → `phone-urls.ts` (`pickServer` → `pickPhone`), `extension/src/ui/server-url-fields.ts` → `phone-url-fields.ts` (`serverUrlFields` → `phoneUrlFields`), `extension/test/server-urls.test.ts` → `phone-urls.test.ts`, importy w `vault-store.ts`, `views/connect.ts`, `views/addresses.ts`.

- [ ] Zmiana nazw bez zmiany zachowania (`git mv`, żeby historia została).
- [ ] `npm test -w extension && npm run typecheck && npm run build` – zielone.
- [ ] Commit `extension: name phone addresses after the phone`.

### Zadanie 3: Android – usunięcie klienta v1

**Pliki:**
- Usuń: `core/.../ServerClient.kt`, `ServerPicker.kt`, `CertificatePin.kt`, `Sync.kt`, `VaultStore.kt`; testy `CertificatePinTest`, `ServerPickerTest`, `RealServerTest`, `SyncTest`, `VaultStoreTest`, część v1 w `EdgeCaseTest`; `testFixtures/.../FakeServer.kt`; `test/resources/interop.ts`.
- Zmień: `PhoneVaultStore.kt` (`AUTO_LOCK_MS = 60_000` wprost, bez `VaultStore`), `Vault.kt` (zostają `Credentials`, `VaultCrypto.newVaultKey/wrapVaultKey/unwrapVaultKey`; znikają `entryAad`, `encryptEntry`, `decryptRecord`, `EntryPayload`, `TombstonePayload`), `Protocol.kt` (bez `SyncRequest`, jeśli nieużywany), `Kdf.kt` (bez `authHash`), `VectorsTest.kt` (bez `authHash`), `core/build.gradle.kts` (`okhttp` z `api` do `testImplementation`/`testFixturesApi` tylko jeśli testy P2P go potrzebują; bez `PASSHOLDER_SERVER_TEST`), `app/build.gradle.kts` (bez `okhttp.tls`, jeśli nieużywany), komentarz w `app/src/main/res/xml/network_security_config.xml`.

- [ ] Usuń pliki, kompilator pokazuje resztę odwołań.
- [ ] `./gradlew :core:test :app:testDebugUnitTest` – zielone (zrzuty ekranów cofnąć: `git checkout android/app/screenshots`).
- [ ] Commit `android: remove v1 server client`.

### Zadanie 4: dokumentacja

**Pliki:**
- Przepisz: `docs/INSTALACJA.md` (bez Pi; części: 1. narzędzia na Windows, 2. telefon – instalacja i założenie sejfu, 3. wtyczka – budowa, załadowanie, parowanie kodem, 4. opcjonalnie Tailscale na telefonie i komputerze, aktualizacje, kopia zapasowa = wtyczka/„Odtwórz z wtyczki” + eksport CSV, problemy, ograniczenia).
- Przepisz: `docs/DEZINSTALACJA.md` (tylko wtyczka, telefon, Tailscale i narzędzia na Windows; **bez żadnej części o Pi** – decyzja właściciela).
- Zmień: `docs/ARCHITEKTURA.md` (bez sekcji `server/`, nowy diagram telefon–wtyczka), `docs/TESTY.md` (bez testów serwera i `PASSHOLDER_SERVER_TEST`, aktualne liczby testów), `docs/SPEC.md` (sekcje 5–7 zastąpione odesłaniem do `SYNCHRONIZACJA_P2P.md`), `README.md`.
- Przenieś (`git mv`) do `docs/archive/` dokumenty historyczne (decyzja właściciela), z notką „dokument historyczny, dotyczy wersji z Pi” na górze: `WIELE_ADRESOW_SERWERA.md`, `PRZEGLAD_BEZPIECZENSTWA.md`, `POPRAWKI_BEZPIECZENSTWA.md`, `PRZEGLAD_CZYSTOSCI_KODU.md`, `ZMIANY_DOKUMENTACJI_2026-11-02.md`, `PRZENIESIENIE_NA_INNY_KOMPUTER.md` oraz każdy inny dokument kroku, który opisuje głównie mechanizm v1 (sprawdzić `WTYCZKA_*.md`, `ANDROID_ODCISK_PALCA.md`). `docs/archive/README.md` – jedno zdanie, co tu jest. Linki do przeniesionych plików poprawione.
- Utwórz: `docs/P2P_USUNIECIE_SERWERA.md` – opis zmian (reguła projektu).

- [ ] Sprawdzenie: `grep -rn "server/\|deploy/\|Raspberry\|PASSHOLDER_SERVER" docs README.md` – tylko notki historyczne i spec P2P.
- [ ] Kopie w folderze projektu (`instalacja/`, `dokumentacja/`, `testy/`) zaktualizowane; stare kopie przeglądów przeniesione do `archive/`.
- [ ] Commit `docs: install and uninstall without the Pi`.

### Zadanie 5: przegląd i PR

- [ ] Przegląd całej gałęzi (jeden recenzent).
- [ ] PR do `main`, opis z sekcjami: co usunięto, co zostało i dlaczego, jak sprawdzić na Windows.
