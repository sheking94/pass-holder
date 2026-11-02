# PassHolder – przegląd czystości kodu (Clean Code)

Data: 2026-10-31 · Stan: `main` @ `978814a` (PR #1–#5 zmergowane) · Narzędzie: skill `clean-code-reviewer`

> Stan punktów (2026-11-02): 1, 4–7, 9–14 zrobione w PR #6 (opis na końcu); 3 (podział `popup.ts`) zrobiony
> w PR #16; 18 (sprzątanie map na serwerze) w PR #18 (N3). Otwarte: 2 (podział `buildApp`), 8 (`ConnectScreen`,
> `EditScreen`), 15, 16 (częściowo: `TOKEN_REFRESH_MARGIN_MS` jest od PR #6) i 17. Numery linii w raporcie odnoszą się do `978814a`.

## Podsumowanie

Pliki źródłowe: 37 (core/, server/, extension/, android/core, android/app). Testy, skrypty i konfiguracja pominięte, zgodnie z zasadami skilla.

| Waga (wg skilla) | Liczba |
|---|---|
| Krytyczna | 3 |
| Wysoka | 6 |
| Średnia | 7 |
| Niska | 4 |

**Co wiem na pewno:** długości funkcji, numery linii i duplikaty poniżej sprawdziłem w kodzie.
**Co oceniam:** wagi. Skill liczy je mechanicznie (np. ponad 50 linii daje „krytyczną”). W projekcie do nauki, z jednym użytkownikiem, żadna z tych rzeczy nie jest pilna. Kod działa i ma testy. Najwięcej warte są pozycje 1, 4, 5 i 9, bo dotyczą logiki, a nie tylko wyglądu kodu.

PR #5 (testy i 2 poprawki) jest już zmergowany, więc jego kod jest częścią tego przeglądu.

---

## Naruszenia, od najważniejszych

### 1. [Wysoka] DRY: granice KDF są w trzech miejscach, a serwer ma inne wartości
`server/src/app.ts:28-30`
```ts
memoryKiB: { type: "integer", minimum: 1, maximum: 4_194_304 },
iterations: { type: "integer", minimum: 1, maximum: 100 },
```
Problem: `core/src/kdf.ts:20-23` (`MIN_KDF`/`MAX_KDF`) i `android/.../Kdf.kt:36-43` mówią: pamięć od 19456 do 1 048 576 KiB, iteracje od 2. Schemat serwera wpuszcza `memoryKiB: 1`, a potem i tak odrzuca to `assertKdfParamsAcceptable`. Schemat obiecuje więc coś innego niż kod. Kto zmieni granice w core, nie zauważy tej kopii.
Poprawka: budować `kdfSchema` z `MIN_KDF`/`MAX_KDF` importowanych z `@passholder/core`. Kotlin musi zostać osobną kopią (inny język), ale wtedy zostaje tylko jedna kopia, pilnowana przez testy wektorów.

### 2. [Krytyczna] Funkcja robi wiele rzeczy: `buildApp` ma 133 linie
`server/src/app.ts:57-190`
Problem: jedna funkcja trzyma sesje (mapa tokenów), limit prób logowania, konfigurację Fastify i cztery trasy ze schematami. Żeby zrozumieć `/sync`, trzeba przeczytać całość.
Poprawka: wydzielić `SessionStore` (create/isValid), `LoginLimiter` (recentFailures/recordFailure/reset), schematy do `schemas.ts`, a każdą trasę do osobnej funkcji `registerSetup(app, deps)` itd. `buildApp` zostaje kilkunastoliniowym „sklejaczem”.

### 3. [Krytyczna] Długie widoki w `popup.ts`
`extension/src/popup.ts:246-343` `editView` (97 linii), `180-238` `listView` (58), `81-132` `connectView` (51)
Problem: każdy widok miesza budowanie DOM, walidację, zapis ustawień generatora i nawigację. W `listView` wiersz listy jest zagnieżdżony na 5 poziomów `h(...)`.
Poprawka: wydzielić `entryRow(entry, status)`, `generatorFieldset(options)`, `validateNewVault(password, repeat)`. Docelowo podzielić plik na `views/connect.ts`, `views/list.ts`, `views/edit.ts` i `dom.ts` (helper `h`).

### 4. [Wysoka] Błąd rozpoznawany po treści angielskiego komunikatu
`extension/src/popup.ts:274`
```ts
setStatus(status, (error as Error).message === "Choose at least one character group" ? "Wybierz co najmniej jedną grupę znaków" : ...
```
Problem: zmiana jednego słowa w `core/src/generator.ts:37` po cichu psuje tłumaczenie.
Poprawka: sprawdzić `groups.length === 0` w popupie przed wywołaniem generatora (Android robi to w `require` z polskim tekstem). Inna opcja: osobna klasa błędu w core.

### 5. [Wysoka] Przeciekające API `VaultStore` we wtyczce: trzeba pamiętać o kolejności wywołań
`extension/src/vault-store.ts:106-114, 187`, użycie w `popup.ts:282-287, 301-302`
```ts
upsertEntry(store.vaultForEdit(), id, {...});
await store.save(); // „Call after each change made through vaultForEdit()”
```
Problem: popup modyfikuje wewnętrzny obiekt magazynu i musi pamiętać o `save()`. To tzw. temporal coupling. Do tego `entries()` zwraca całą mapę razem z tombstone'ami, więc `popup.ts:188-190` sam filtruje usunięte wpisy i rzutuje `e.data as EntryData`, powtarzając `liveEntries` z core. Testy też to widać: `liveEntries({ lastSyncRevision: 0, entries: store.entries() })`.
Poprawka: zrobić tak jak w Androidzie (`VaultStore.upsert/delete` same zapisują, `entries()` zwraca tylko żywe wpisy). Usunąć `vaultForEdit()`.

### 6. [Wysoka] Nazwy różniące się wielkością jednej litery: `logIn` i `login`
`android/core/.../VaultStore.kt:215` `logIn(client, s)` i `:221` `login(client, authKey)`
Problem: dwie prywatne funkcje o prawie tej samej nazwie robią różne rzeczy (jedna tłumaczy błędy, druga zapisuje token w sesji). Łatwo wywołać nie tę.
Poprawka: `requestSession(client, authKey)` (tłumaczy błędy) i `refreshToken(client, session)`.

### 7. [Wysoka] `AppViewModel.run` zasłania `run` z biblioteki standardowej Kotlina
`android/app/.../AppViewModel.kt:178`
Problem: w Kotlinie `run { }` to powszechna funkcja zakresu. Kto czyta `fun unlock(...) = run("Odblokowuję…") { ... }`, musi sprawdzić, która to wersja. Nazwa nie mówi też, że operacja idzie w tle i blokuje przyciski.
Poprawka: `launchVaultOperation(progress) { ... }` albo `runBusy(...)`.

### 8. [Krytyczna] `ConnectScreen` ma 67 linii i 6 poziomów zagnieżdżenia; `EditScreen` ma 74 linie
`android/app/.../ui/ConnectScreen.kt:41-108`, `ui/EditScreen.kt:45-119`
Problem: karta z odciskiem certyfikatu (`ConnectScreen.kt:64-88`) i karta generatora (`EditScreen.kt:66-98`) są wpisane w ekran. Walidacja hasła głównego (`ConnectScreen.kt:96-99`) siedzi w UI, a ta sama reguła i stała `MIN_MASTER_PASSWORD = 12` są osobno w `popup.ts:20, 97-100`.
Poprawka: wydzielić `@Composable FingerprintCard(...)` i `GeneratorCard(...)`. Walidację przenieść do `AppViewModel.connect`. `MIN_MASTER_PASSWORD` przenieść do core (TS) i do `Kdf`/osobnego obiektu w Kotlinie.

### 9. [Średnia] Zduplikowany blok „zaloguj ponownie po 401” w obu klientach
`extension/src/vault-store.ts:201-209`, `android/core/.../VaultStore.kt:203-211`
Problem: to samo wywołanie `syncVault(...)` jest dwa razy w jednej funkcji, w `try` i w `catch`. Przy zmianie jednego łatwo zapomnieć o drugim.
Poprawka: helper `withRelogin(client) { syncOnce() }` albo pętla z najwyżej dwiema próbami. To, że logika jest w TS i w Kotlinie, jest naturalne (dwa języki).

### 10. [Średnia] `connectExisting` powtarza zapis tokenu z `logIn`
`extension/src/vault-store.ts:142-143` i `:215-216`; `VaultStore.kt:132-135` i `:217-218`
Poprawka: jedna prywatna metoda `rememberToken(session)` wywoływana w obu miejscach.

### 11. [Średnia] SHA-256 i kodowanie hex napisane kilka razy
- `extension/src/clipboard.ts:16-17` ręcznie zamienia bajty na hex, choć `toHex` jest w core.
- `android/app/.../SecureClipboard.kt:42-43` robi to samo, choć jest `Encoding.toHex`.
- `server/src/app.ts:53-55` ma własne `sha256`, a core eksportuje `authHash` (to właśnie jego używa spec).
Poprawka: używać `toHex`/`Encoding.toHex`, a na serwerze `authHash` z core. Wtedy serwer i klienci na pewno liczą hash tak samo.

### 12. [Średnia] `credentials!!` w kilku miejscach
`android/core/.../VaultStore.kt:90`, `ui/ListScreen.kt:35, 49`
Problem: `LocalEntry.credentials` jest nullowalne (null oznacza tombstone), więc każdy, kto dostaje „żywe” wpisy, i tak musi pisać `!!`. Typ nie mówi tego, co wiemy.
Poprawka: `entries()` zwraca `List<LiveEntry>` (id, dirty, credentials bez nulla) albo `Pair<LocalEntry, Credentials>`. Wtedy `!!` znika.

### 13. [Średnia] Argument-flaga w `copy`
`extension/src/popup.ts:172` `copy(text, status, what, clearLater = false)`; `AppViewModel.kt:155` `copy(text, what, sensitive: Boolean)`
Problem: flaga oznacza dwie różne funkcje w jednej (kopiuj zwykły tekst, albo kopiuj i zaplanuj czyszczenie).
Poprawka: `copyLogin(...)` i `copyPassword(...)`.

### 14. [Średnia] Komunikaty w dwóch językach i rozrzucone klucze magazynu we wtyczce
- `vault-store.ts:107, 112, 150, 189, 197`: angielskie „Vault is locked”, „No account” trafiają przez `busy()` prosto na ekran, obok polskich komunikatów.
- Klucze `"account"`, `"vault"`, `"keys"` (`vault-store.ts`) i `"generator"` (`popup.ts:243, 271`) to literały rozsiane po plikach. W Androidzie są stałymi w `companion object`.
Poprawka: polskie komunikaty dla tego, co widzi użytkownik, i stałe `ACCOUNT_KEY` itd. w jednym miejscu.

### 15. [Średnia] Ekrany Compose dostają cały `AppViewModel`
`ui/*.kt`: `fun ListScreen(state: UiState, vm: AppViewModel)`
Problem: ekran zależy od całej klasy, choć używa 3–4 funkcji. Trudniej zrobić podgląd (`@Preview`) i test bez prawdziwej aplikacji.
Poprawka: przekazywać lambdy (`onSync`, `onLock`, `onOpen`) albo mały interfejs akcji na ekran. To zmiana z niską korzyścią w tym projekcie, więc opcjonalna.

### 16. [Niska] Liczby i teksty „z powietrza”
- `vault-store.ts:199` i `VaultStore.kt:202` `10_000` (zapas przed wygaśnięciem tokenu) → `TOKEN_REFRESH_MARGIN_MS`.
- `AppViewModel.kt:60` `delay(15_000)` i tekst „po 15 minutach” (`:80`) są wpisane na sztywno, choć istnieje `AUTO_LOCK_MS`.
- `32`/`16` (długość klucza, znacznika GCM, soli) w `cipher.ts`, `Cipher.kt`, `kdf.ts`, `Kdf.kt` → `KEY_LENGTH`, `TAG_LENGTH`, `SALT_LENGTH`.

### 17. [Niska] Drobne rzeczy, przez które kod czyta się trudniej
- `core/src/protocol.ts:49-53`: `if (existing) push; else throw; continue` w odwróconej kolejności. Czytelniej najpierw `if (!existing) throw`.
- `server/src/app.ts:80` `requireSession` zwraca `boolean`. „require” sugeruje wyjątek, więc lepiej `hasValidSession`.
- `Generator.kt:31-32` `for (i in chars.indices.reversed()) { if (i == 0) break` → `for (i in chars.lastIndex downTo 1)`.
- `Vault.kt:31-32` `wrapVaultKey` z `if (nonce == null)` → `nonce: ByteArray = Encoding.randomBytes(12)` jak w `Aead.seal`.

### 18. [Niska] Mapy `sessions` i `loginFailures` na serwerze nie są czyszczone
`server/src/app.ts:65-66`: wygasłe tokeny znikają tylko przy ponownym użyciu. Pi jest często restartowany, więc w praktyce nie ma to znaczenia. Wychodzi samo przy wydzieleniu `SessionStore` (pkt 2).

---

## Dobre praktyki (warto je zachować)

- **Małe, czyste moduły w core**: `cipher`, `kdf`, `vault`, `sync`, `protocol` mają po 40–110 linii, a funkcje najczęściej po kilka linii i jedną odpowiedzialność.
- **Wstrzykiwanie zależności**: `now`, `fetchFn`, `makeClient`, `KeyValueStore`, `SyncStore`. Dzięki temu testy działają bez zegara, sieci i Chrome'a.
- **Komentarze mówią „dlaczego”, a nie „co”**: np. WAL + FULL sync na Pi, brak sprawdzania nazwy hosta przy pinie, offscreen document w Chrome.
- **Typy, które wykluczają błędy**: unia `LocalEntry` w TS, `sealed interface Screen` w Kotlinie, `satisfies ClipboardMessage`.
- **Wyjątki z kontekstem**: `ApiError`/`ApiException` niosą status HTTP. `Database.transaction` cofa zmiany przy błędzie.
- **Spójność TS i Kotlina**: te same nazwy i ta sama struktura, z odsyłaczami „same as core/src/…”. Łatwo porównać obie wersje.
- **Higiena kluczy na Androidzie**: `fill(0)` na kluczach i haśle po użyciu.

## Proponowana kolejność poprawek (osobny PR)

1. Pkt 1, 4, 11: małe zmiany, które usuwają realne ryzyko rozjazdu.
2. Pkt 5, 6, 7, 9, 10, 12, 13, 14: zmiany nazw i API magazynu, bez zmiany zachowania.
3. Pkt 2, 3, 8: podział długich funkcji i ekranów. To największy diff. Testy (Vitest, JUnit, Roborazzi) powinny przejść bez zmian, zrzuty ekranów też.
4. Pkt 15–18: opcjonalnie.

---

## Co zmieniono (poprawki z grup 1–2)

Zachowanie aplikacji się nie zmienia, z jednym wyjątkiem: komunikaty błędów, które wtyczka pokazywała po angielsku, są teraz po polsku. Pozycje 2, 3, 8 i 15–18 zostały bez zmian.

### Serwer (`server/src/app.ts`)
- **Pkt 1.** Granice `memoryKiB`, `iterations` i `parallelism` w schemacie `/setup` biorą się teraz z `MIN_KDF`/`MAX_KDF` z core. Zmiana granic w `core/src/kdf.ts` zmienia je jednocześnie u klientów i na serwerze.
- **Pkt 11.** Serwer nie ma już własnej funkcji `sha256`. Hash klucza logowania liczy `authHash` z core, ta sama funkcja, którą opisuje spec.

### Wtyczka Chrome
- **Pkt 5.** `VaultStore` ma teraz metody `upsert(id, data)` i `delete(id)`, które same zapisują sejf na dysk. `save()` jest prywatne, a `vaultForEdit()` usunięte, więc nie da się już zapomnieć o zapisie. `entries()` zwraca tylko nieusunięte wpisy (`LiveEntry[]`), `entry(id)` jeden wpis, a `pendingCount()` liczbę niezsynchronizowanych zmian. Popup nie filtruje już tombstone'ów i nie rzutuje typów.
- **Pkt 9 i 10.** Ponowne logowanie po 401 jest w jednym miejscu: `withFreshToken(client, action)` wykonuje akcję z ważnym tokenem, a po 401 loguje się raz i ponawia. Zapis tokenu (`rememberToken`) jest wspólny dla `connectExisting` i `logIn`. Stała `TOKEN_REFRESH_MARGIN_MS` zastąpiła liczbę `10_000`.
- **Pkt 4.** Popup sprawdza, czy wybrano grupę znaków, *zanim* wywoła generator. Nie porównuje już tekstu angielskiego wyjątku.
- **Pkt 13.** Zamiast `copy(..., clearLater)` są dwie funkcje: `copyLogin` i `copyPassword`.
- **Pkt 14.** Klucze magazynu są w jednym miejscu, w `STORAGE_KEYS` (`account`, `vault`, `sessionKeys`, `generator`). Komunikaty „Sejf jest zablokowany” i „Ta przeglądarka nie jest połączona z serwerem” zastąpiły angielskie „Vault is locked” i „No account”.
- **Pkt 11.** `sha256Hex` w `clipboard.ts` używa `toHex` z core.

### Android
- **Pkt 6.** `logIn`/`login` w `VaultStore.kt` nazywają się teraz `refreshToken` (nowy token zapisany w sesji) i `requestSession` (POST /session z polskimi komunikatami błędów).
- **Pkt 9 i 10.** To samo co we wtyczce: `withFreshToken` i `Session.remember(login)`. Stała `TOKEN_REFRESH_MARGIN_MS`.
- **Pkt 12.** Nowy typ `LiveEntry(id, dirty, credentials)` z `credentials`, które nie mogą być null. Zwracają go `LocalVault.liveEntries()`, `liveEntry(id)` oraz `VaultStore.entries()`/`entry(id)`. Wszystkie `credentials!!` zniknęły.
- **Pkt 7.** `AppViewModel.run` nazywa się teraz `launchVaultOperation`.
- **Pkt 13.** `AppViewModel.copyLogin/copyPassword` i `SecureClipboard.copyText/copyPassword`. Tylko `copyPassword` oznacza tekst jako wrażliwy i planuje wyczyszczenie schowka.
- **Pkt 11.** `SecureClipboard.sha256` używa `Encoding.toHex`.

### Testy
Testy dostosowano do nowego API (`upsert`/`delete`/`entry` zamiast `upsertEntry(vaultForEdit())` + `save()`). Test konfliktu dwóch przeglądarek używa teraz wspólnego zegara wstrzykniętego do `VaultStore`, zamiast podawać czas ręcznie. Wyniki:
- `npm test`: 99/99 (core 64, server 23, extension 12), `npm run typecheck` i `npm run build` bez błędów.
- `./gradlew :core:test` z `PASSHOLDER_SERVER_TEST=1`: 45/45, w tym test z prawdziwym serwerem Node i kodem wtyczki (`interop.ts`).
- `./gradlew :app:testDebugUnitTest`: 6/6 (Robolectric + Roborazzi). Zrzuty ekranów nie zostały zmienione.
