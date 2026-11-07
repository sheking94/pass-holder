# Synchronizacja P2P, plan 3 z 4: telefon jako host i wtyczka jako klient — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Telefon z Androidem staje się kotwicą sejfu (zakłada sejf, trzyma bazę hosta, w trybie
„Synchronizacja” słucha na porcie 8787), a wtyczka Chrome paruje się z nim 8-cyfrowym kodem i
synchronizuje przez Noise KK zamiast przez Raspberry Pi.

**Architecture:** Dwie części, dwa PR-y z tego samego planu. **Część A (PR 3a, Task 1–8)**: w `android/core`
(czysty Kotlin/JVM, szybkie testy JUnit) powstają: minimalny serwer HTTP/1.1 na `ServerSocket`, trwały
`SyncStore` w pliku, stan hosta, protokół parowania po HTTP (`PairingHost`), router ścieżek i fasada
`PhoneVaultStore`; w `android/app` ekrany v1 (łączenie z Pi, adresy serwera) są zastępowane ekranami
P2P (nowy sejf, odtwórz z wtyczki, synchronizacja, urządzenia). **Część B (PR 3b, Task 9–12)**: w `core/`
klient parowania w TS, we wtyczce `VaultStore` przechodzi na `LocalVaultV2` i `noiseTransport`, ekrany
łączenia z serwerem zamieniają się w parowanie z telefonem; test współpracy uruchamia prawdziwy kod
TS przeciw prawdziwemu serwerowi HTTP z Kotlina. Pliki v1 w `core/src`, `android/core` i `server/` zostają
(usuwa je plan 4), ale aplikacja i wtyczka przestają ich używać.

**Tech Stack:** Kotlin 2.2.21 / JVM 17, kotlinx.serialization, `java.net.ServerSocket`, Android Keystore,
Jetpack Compose, Robolectric + Roborazzi; TypeScript, Chrome MV3, vitest, `@noble/*` (już w `core/`).

**Spec:** `docs/SYNCHRONIZACJA_P2P.md` (sekcje 3–6, 8 kroki 3–4) oraz zachowanie rdzenia w
`docs/P2P_RDZEN.md` i `docs/P2P_ANDROID_RDZEN.md` (§7 „Co dalej”). Wzorzec kontraktu `handshake`/`sync`:
`core/src/p2p/host.ts`.

## Decyzje właściciela (2026-11-06)

1. Ekrany v1 (Pi) w aplikacji i wtyczce zastępujemy P2P już teraz; pliki v1 usuwa plan 4. Dane z Pi
   przenosi się eksportem CSV **przed** aktualizacją wtyczki (W8). Nowa wersja używa nowych kluczy
   w pamięci (`accountV2`, `vaultV2` we wtyczce, katalog `p2p/` na telefonie) i nie czyta starych.
2. Serwer HTTP na telefonie: własny minimalny HTTP/1.1 na `ServerSocket`, bez bibliotek.
3. Dwa PR-y: 3a (Task 1–8) i 3b (Task 9–12), po kolei w tym samym wątku. 3b startuje z gałęzi po merge 3a.

## Global Constraints

- Port hosta: `8787` (stała `PhoneSync.PORT`); adresy telefonu mają postać `http://<IPv4>:8787`.
- Tryb „Synchronizacja” gaśnie po **5 min** bez żądania (`SYNC_IDLE_MS = 300_000`), po wyjściu z aplikacji
  (`MainActivity.onStop`, nie przy obrocie) i przy blokadzie sejfu. Ekran nie gaśnie, póki tryb działa.
- Kod parowania: 8 cyfr z `Pairing.generateCode()`, ważny **2 min** (`PAIRING_CODE_TTL_MS = 120_000`),
  **jedna próba** (pierwsze `/pair/start` zużywa kod bez względu na wynik).
- Kontrakt `/p2p/v1/handshake` i `/p2p/v1/sync` bez zmian (`P2P_RDZEN.md` §4); limit ciała 1 MiB
  (`1024 * 1024`) egzekwuje już serwer HTTP przed czytaniem ciała.
- CPace: wtyczka `INITIATOR`, telefon `RESPONDER`, `CI = PAIRING_CI`, `sid` 16 B losowane przez telefon,
  `ad` = bajty UTF-8 własnego `deviceId` strony.
- Bez nowych zależności w `android/gradle/libs.versions.toml` i `package.json` (testowe też nie).
- Stan telefonu wyłączony z kopii zapasowej: `allowBackup="false"` i `data_extraction_rules.xml` już to
  robią; nie zmieniać, test w Task 6 tego pilnuje (zalecenie z `P2P_RDZEN.md` §6).
- Nie zmieniać `~/.android/debug.keystore` ani konfiguracji podpisu.
- Komentarze i nazwy w kodzie po angielsku, teksty UI i dokumentacja po polsku.
- Komendy (kontener Linux): `cd android && ./gradlew :core:test` (~1 min) i `./gradlew :app:testDebugUnitTest`
  (~5 min, Robolectric, jeden `@Test` na klasę); w katalogu głównym `npm test && npm run typecheck && npm run build -w extension`.
  npm: `NO_PROXY=localhost npm ci --cafile=/root/.ccr/ca-bundle.crt`. Android SDK: jeśli brak, cmdline-tools do
  `/opt/android-sdk` + `sdk.dir` w `android/local.properties` (nie commitować).
- Skróty ścieżek w tym planie: `KC/` = `android/core/src/main/kotlin/io/github/sheking94/passholder/core/p2p/`,
  `KT/` = `android/core/src/test/kotlin/io/github/sheking94/passholder/core/p2p/`,
  `APP/` = `android/app/src/main/kotlin/io/github/sheking94/passholder/app/`,
  `APPT/` = `android/app/src/test/kotlin/io/github/sheking94/passholder/app/`.

## Protokół parowania po HTTP (nowy, wspólny dla Task 4 i Task 9)

Wszystkie żądania `POST`, ciała JSON, binaria w Base64 z dopełnieniem. Telefon ma najwyżej jedną aktywną
„ofertę parowania” `{code, sid, mode, expiresAt}`, gdzie `mode` to `"pair"` (zwykły sejf) albo `"restore"`
(„Odtwórz z wtyczki”, telefon nie ma jeszcze `kdf` i `wrappedVaultKey`).

| Ścieżka | Żądanie | Odpowiedź 200 | Błędy |
|---|---|---|---|
| `/p2p/v1/ping` | `{}` | `{"ok":true}` | — |
| `/p2p/v1/pair/hello` | `{}` | `{sid, mode}` | 404 `no pairing` (brak oferty / wygasła) |
| `/p2p/v1/pair/start` | `{sid, message}` (`lv_cat(Ya, adA)`) | `{message}` (`lv_cat(Yb, adB)`) | 404 `no pairing` (też: oferta już zużyta, inne `sid`), 400 `malformed request` / `pairing failed` (zły element CPace) |
| `/p2p/v1/pair/finish` | `{sid, identity, vaultInfo?}` (zapieczętowane rolą `initiator`; `vaultInfo` wymagane wtedy i tylko wtedy, gdy `mode = "restore"`) | `{identity, vaultInfo}` (rolą `responder`) | 404 `no pairing`, 403 `pairing failed` (nie otwiera się → zły kod), 400 `malformed request` |

- `/pair/start` zużywa ofertę natychmiast; klucz parowania czeka na `/pair/finish` najwyżej 30 s
  (`PAIRING_FINISH_TTL_MS = 30_000`), potem przepada. `/pair/finish` jest jednorazowe bez względu na wynik.
- Udane `/pair/finish`: telefon dopisuje `PairedDevice` (to samo `deviceId` zastępuje poprzedni wpis), a w
  trybie `restore` zapisuje `kdf` i `wrappedVaultKey` z `vaultInfo` wtyczki (jej `epoch` i `addresses` są
  ignorowane; `Kdf.assertAcceptable` musi przejść, inaczej 400). Odpowiedź `vaultInfo` zawsze niesie
  epokę telefonu, jego `kdf`, `wrappedVaultKey` i bieżące adresy.
- Kolejność sprawdzeń w routerze: 413 (serwer HTTP) → 405 (nie `POST`, serwer HTTP) → 404 nieznana ścieżka →
  400 ciało nie jest obiektem JSON → reszta.

## Review Focus

1. **Złe hasło główne zaraz po parowaniu we wtyczce:** wynik parowania zostaje w `chrome.storage.session`,
   można wpisać hasło jeszcze raz bez nowego kodu. Test w Task 10.
2. **Wtyczka z istniejącym sejfem paruje się (tryb `pair`) z telefonem z innym sejfem:** odmowa „To inny sejf”,
   lokalne dane i konto bez zmian. Test w Task 10.
3. **Aplikacja ubita w trakcie zapisu bazy (urwana ostatnia linia pliku rekordów):** baza się otwiera, urwana
   linia jest pomijana, rewizje dalej rosną bez powtórzeń. Test w Task 2.
4. **Drugie podejście tym samym kodem / zgadywanie kodu:** po pierwszym `/pair/start` każde kolejne dostaje
   404, także z dobrym kodem. Test w Task 4.
5. **Jeden z adresów telefonu nie odpowiada (drugie mieszkanie, Tailscale wyłączony):** wtyczka po 4 s próbuje
   następnego i zapamiętuje działający. Test w Task 10.

---

## Część A — PR 3a: telefon jako host

### Task 1: Minimalny serwer HTTP/1.1

**Files:**
- Create: `KC/SyncHttpServer.kt`
- Test: `KT/SyncHttpServerTest.kt`

**Interfaces:**
- Produces:
  - `class SyncHttpServer(private val port: Int, private val handler: (path: String, body: ByteArray) -> HostReply, private val threads: Int = 4, private val readTimeoutMs: Int = 10_000) { fun start(): Int /* zwraca faktyczny port (0 = losowy, dla testów) */; fun stop(); val isRunning: Boolean }`
  - Każde połączenie: jedno żądanie, odpowiedź z `Connection: close`, `Content-Type: application/json; charset=utf-8`, `Content-Length`.

Zasady parsowania: linia żądania `METODA ŚCIEŻKA HTTP/1.x`; nagłówki do pustej linii, razem najwyżej 16 KiB
(więcej → 431); nazwy nagłówków bez rozróżniania wielkości liter; tylko `POST` (inne → 405
`{"error":"method not allowed"}`); `Content-Length` wymagany (brak/niepoprawny → 411/400); `Transfer-Encoding`
→ 501; `Content-Length > P2pHost.MAX_BODY_BYTES` → 413 `{"error":"body too large"}` **bez czytania ciała**;
ścieżka bez części `?…`. Wyjątek z `handler` → 500 `{"error":"internal error"}` (to pokrywa wyjątki z
`devices()`, `P2P_ANDROID_RDZEN.md` §2). Przekroczenie `readTimeoutMs` zamyka połączenie. Pula wątków
`Executors.newFixedThreadPool(threads)`; `stop()` zamyka gniazdo i pulę, kolejne `start()` działa.

- [ ] **Step 1: Napisz testy** (`HttpURLConnection` albo surowy `Socket` na `127.0.0.1`, port z `start()` przy `port = 0`): `POST /x` z ciałem `{"a":1}` → handler dostaje ścieżkę `/x` i te bajty, klient dostaje status i ciało z `HostReply`; `GET` → 405; `Content-Length: 1048577` bez ciała → 413 w czasie < 1 s; brak `Content-Length` → 411; handler rzuca → 500; klient wysyła pół nagłówka i milknie → serwer zamyka po `readTimeoutMs` (ustaw 200 ms w teście); 8 równoległych żądań z 8 wątków → wszystkie 200; `stop()` potem `start()` → działa.
- [ ] **Step 2: Uruchom** `./gradlew :core:test --tests "*SyncHttpServerTest*"` — Expected: FAIL (brak klasy).
- [ ] **Step 3: Zaimplementuj** `SyncHttpServer.kt` (czytanie bajtami z `BufferedInputStream`, nagłówki jako ISO-8859-1).
- [ ] **Step 4: Uruchom** `./gradlew :core:test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "p2p(android): minimal HTTP/1.1 server"`

---

### Task 2: Trwały `SyncStore` w pliku

**Files:**
- Create: `KC/FileSyncStore.kt`
- Test: `KT/FileSyncStoreTest.kt`

**Interfaces:**
- Consumes: `SyncStore`, `RemoteRecord`, `P2pJson.json`.
- Produces: `class FileSyncStore(private val file: File) : SyncStore` (+ `fun close()` niepotrzebne — każdy `put` dopisuje i robi `flush` + `FileDescriptor.sync()`).

Format: JSON Lines, jedna linia = jeden `RemoteRecord` (`{"id","revision","deleted","blob"}`). Przy otwarciu:
odtworzenie mapy (późniejsza linia z tym samym `id` wygrywa), `currentRevision` = największa `revision`;
linia, której nie da się sparsować, jest pomijana **tylko jeśli jest ostatnia** (urwany zapis), w środku pliku
→ `IllegalStateException("Corrupt sync store")`. Gdy linii jest ponad `2 × liczba rekordów + 100`, przy
otwarciu plik jest kompaktowany (zapis do `file.tmp`, `sync`, `renameTo`). Umowa blokady jak w
`P2P_ANDROID_RDZEN.md` §2: klasa sama nie blokuje, wołający trzyma `synchronized(store)`.

- [ ] **Step 1: Napisz testy**: zapis 3 rekordów, nowy obiekt na tym samym pliku widzi je i `currentRevision`; nadpisanie `id` daje nowszą wersję po ponownym otwarciu; **plik z urwaną ostatnią linią (`{"id":"a","rev`) otwiera się, a następny `put` z `revision = current + 1` po ponownym otwarciu jest widoczny** (Review Focus 3); śmieci w środkowej linii → `IllegalStateException`; 300 nadpisań jednego `id` → po ponownym otwarciu plik ma 1 linię; `HostSync.process` z `MemorySyncStore` i `FileSyncStore` daje te same odpowiedzi dla tej samej sekwencji żądań (użyj przypadków z `HostSyncTest`).
- [ ] **Step 2: Uruchom** — Expected: FAIL. **Step 3: Zaimplementuj.** **Step 4: Uruchom** `./gradlew :core:test` — PASS.
- [ ] **Step 5: Commit** `git commit -m "p2p(android): file-backed sync store"`

---

### Task 3: Stan hosta na dysku

**Files:**
- Create: `KC/HostState.kt`
- Test: `KT/HostStateTest.kt`

**Interfaces:**
- Consumes: `KdfParams`, `KeyPair`, `NoiseKeys.generate/fromPrivateKey`, `PairedDevice`, `Encoding`.
- Produces:
  - `interface SecretWrapper { fun wrap(secret: ByteArray): String; fun unwrap(wrapped: String): ByteArray }` — w aplikacji Android Keystore (Task 6), w testach `object PlainSecretWrapper` (Base64, w `KT/`).
  - `@Serializable data class StoredDevice(val deviceId: String, val name: String, val staticPublicKey: String, val pairedAt: Long, val lastSyncAt: Long? = null)`
  - `@Serializable data class HostState(val deviceId: String, val epoch: String, val wrappedStaticKey: String, val kdf: KdfParams? = null, val wrappedVaultKey: String? = null, val keyCheck: String? = null, val devices: List<StoredDevice> = emptyList())` — `kdf == null` znaczy „odtwarzanie w toku”; `keyCheck` = Base64 `HMAC-SHA256(vaultKey, "passholder/v2/key-check")`, ustawiane przy `createVault` i `finishRestore`, służy do sprawdzenia kluczy z odcisku palca.
  - `class HostStateStore(private val file: File, private val wrapper: SecretWrapper) { fun load(): HostState?; fun save(state: HostState) /* tmp + sync + rename */; fun staticKey(state: HostState): KeyPair; fun newState(kdf: KdfParams?, wrappedVaultKey: String?): HostState /* nowe deviceId (UUID), epoch 16 B Base64, nowy klucz statyczny */; fun delete() }`
  - `fun StoredDevice.toPairedDevice(): PairedDevice`

- [ ] **Step 1: Napisz testy**: `newState` → `save` → `load` daje równy stan; `staticKey` po ponownym wczytaniu daje ten sam klucz publiczny; dwa `newState` mają różne `epoch` i `deviceId`; `load` nieistniejącego pliku → `null`; plik z obcym JSON → `IllegalStateException`; `wrappedStaticKey` nie zawiera klucza prywatnego w Base64 przy wrapperze testowym, który XOR-uje bajty (sprawdza, że wrapper jest używany).
- [ ] **Step 2–4:** FAIL → implementacja → `./gradlew :core:test` PASS.
- [ ] **Step 5: Commit** `git commit -m "p2p(android): persistent host state"`

---

### Task 4: Parowanie po HTTP (`PairingHost`)

**Files:**
- Create: `KC/PairingHost.kt`
- Test: `KT/PairingHostTest.kt`, rozszerz `KT/TestP2pClient.kt` o `fun pair(code: String, mode: …): PairResult` (strona wtyczki w Kotlinie, tylko do testów)

**Interfaces:**
- Consumes: `Cpace`, `Pairing`, `DeviceIdentity`, `VaultInfo`, `HostReply`, `P2pJson`.
- Produces:
  - `enum class PairingMode(val wire: String) { PAIR("pair"), RESTORE("restore") }`
  - `data class PairingOffer(val code: String, val sid: String, val mode: PairingMode, val expiresAt: Long)`
  - `class PairingHost(private val identity: () -> DeviceIdentity, private val vaultInfo: (restored: VaultInfo?) -> VaultInfo, private val onPaired: (device: StoredDevice, restored: VaultInfo?) -> Unit, private val now: () -> Long = System::currentTimeMillis) { fun offer(mode: PairingMode): PairingOffer; fun cancel(); fun current(): PairingOffer?; fun handle(path: String, body: JsonObject): HostReply? /* null = nie moja ścieżka */ }`
  - stałe `PAIRING_CODE_TTL_MS = 120_000L`, `PAIRING_FINISH_TTL_MS = 30_000L`.
  - `vaultInfo(restored)` dostaje w trybie `restore` otwarte `vaultInfo` wtyczki **po** `onPaired`, więc zwraca już zapisane `kdf`/`wrappedVaultKey`.

Zachowanie dokładnie według tabeli „Protokół parowania po HTTP”. Metody `@Synchronized` (parowanie jest rzadkie).
`onPaired` wywoływane przed zbudowaniem odpowiedzi `/finish`; jego wyjątek → 500 i oferta przepada.

- [ ] **Step 1: Napisz testy**: pełne parowanie dobrym kodem (`TestP2pClient.pair`) → obie strony mają klucz publiczny partnera, `onPaired` dostał `deviceId`/`name`; **zły kod → `/finish` 403, a potem dobry kod z tym samym `sid` → `/start` 404** (Review Focus 4); drugie `/start` po udanym → 404; oferta po 120 001 ms → `/hello` 404; `/finish` po 30 001 ms od `/start` → 404; `mode = RESTORE` bez `vaultInfo` → 400 i `onPaired` nie wołane; `RESTORE` z `vaultInfo` o słabym KDF → 400; `RESTORE` poprawne → `onPaired(…, restored)` z `kdf` wtyczki, a odpowiedź ma epokę telefonu; `PAIR` z dodatkowym `vaultInfo` → 400; `cancel()` → `/hello` 404; śmieci w `message` → 400 `pairing failed`.
- [ ] **Step 2–4:** FAIL → implementacja → `./gradlew :core:test` PASS.
- [ ] **Step 5: Commit** `git commit -m "p2p(android): pairing over HTTP"`

---

### Task 5: Router, adresy i fasada `PhoneVaultStore`

**Files:**
- Create: `KC/PhoneRouter.kt`, `KC/LocalAddresses.kt`, `KC/PhoneVaultStore.kt`
- Modify: `KC/P2pHost.kt` (parametr `onSynced: (deviceId: String) -> Unit = {}` wołany po udanej odpowiedzi 200 na `/sync`)
- Test: `KT/PhoneRouterTest.kt`, `KT/LocalAddressesTest.kt`, `KT/PhoneVaultStoreTest.kt`, `KT/P2pHostTest.kt` (jeden test `onSynced`)

**Interfaces:**
- Consumes: Task 1–4, `P2pHost`, `PhoneVault`, `Kdf`, `VaultCrypto.newVaultKey/wrapVaultKey/unwrapVaultKey`.
- Produces:
  - `object LocalAddresses { fun list(port: Int, interfaces: () -> List<NetworkInterface> = { NetworkInterface.getNetworkInterfaces().toList() }): List<String> }` — interfejsy `isUp && !isLoopback`, tylko IPv4, bez `169.254.*`, posortowane: `100.64.0.0/10` (Tailscale) na końcu, najwyżej `Pairing.MAX_ADDRESSES`; format `http://a.b.c.d:port`. Testowalne przez wydzieloną `fun format(addresses: List<InetAddress>, port: Int): List<String>`.
  - `class PhoneRouter(private val pairing: PairingHost, private val host: () -> P2pHost?, private val onRequest: () -> Unit) { fun handle(path: String, body: ByteArray): HostReply }` — `onRequest` przy każdym żądaniu (licznik bezczynności); `/p2p/v1/ping`; `/p2p/v1/pair/*` → `pairing`; `handshake`/`sync` → `host()` albo 503 `{"error":"vault not ready"}` gdy `null`; reszta 404.
  - `object PhoneSync { const val PORT = 8787; const val SYNC_IDLE_MS = 300_000L }`
  - `class PhoneVaultStore(dir: File, wrapper: SecretWrapper, now: () -> Long = System::currentTimeMillis, autoLockMs: Long = AUTO_LOCK_MS)` z:
    - stan: `val hasVault: Boolean` (jest `HostState` z `kdf`), `val restoreInProgress: Boolean` (jest `HostState` bez `kdf`), `val isUnlocked: Boolean`;
    - zakładanie: `fun createVault(masterPassword: String)` (nowy `HostState`, `Kdf.newParams`, nowy vaultKey, odblokowuje), `fun startRestore()` (nowy `HostState` bez `kdf`, kasuje stary `records.jsonl`), `fun finishRestore(masterPassword: String)` (rzuca „Złe hasło główne” albo „Wtyczka jeszcze nie przesłała sejfu”, gdy brak `kdf` lub rekordów);
    - blokada jak v1 `VaultStore`: `unlock(masterPassword)`, `exportUnlockKeys(): ByteArray` (32 B, sam vaultKey), `unlockWithKeys(keys)` (sprawdza klucz porównaniem z `HostState.keyCheck` w stałym czasie, `MessageDigest.isEqual`), `lock()`, `touch()`, `lockIfIdle(): Boolean`, `disconnect()` (kasuje katalog `p2p/`);
    - wpisy: `entries(): List<PhoneEntry>`, `entry(id)`, `upsert(id, credentials)`, `delete(id)`, `unreadableIds()` — przez `PhoneVault`;
    - urządzenia: `devices(): List<StoredDevice>`, `removeDevice(deviceId)`;
    - synchronizacja: `fun router(onRequest: () -> Unit, addresses: () -> List<String>): PhoneRouter` — buduje `PairingHost` i `P2pHost` na `FileSyncStore` (`dir/p2p/records.jsonl`), `devices` z bieżącego `HostState`, `onSynced` zapisuje `lastSyncAt`, `onPaired` dopisuje urządzenie (i w trybie restore `kdf`/`wrappedVaultKey`); `fun offerPairing(): PairingOffer` (tryb wynika z `restoreInProgress`), `fun cancelPairing()`.
    - W trybie odtwarzania `P2pHost` **działa** bez vaultKey (bloby są nieprzezroczyste), więc wtyczka może od razu wysłać wszystko; `host()` zwraca `null` tylko przed pierwszym `createVault`/`startRestore`.
  - Pliki w `dir/p2p/`: `host.json` (`HostStateStore`), `records.jsonl` (`FileSyncStore`).

- [ ] **Step 1: Napisz testy**: `PhoneRouterTest` — ping 200, nieznana ścieżka 404, ciało-tablica 400, `handshake` przy `host() == null` 503, każde żądanie woła `onRequest`. `LocalAddressesTest` — `format` dla `[192.168.1.5, 100.101.102.103, 10.0.0.2, 169.254.1.1, fe80::1]` → `["http://192.168.1.5:8787","http://10.0.0.2:8787","http://100.101.102.103:8787"]`. `PhoneVaultStoreTest` (JVM, `PlainSecretWrapper`, `SyncHttpServer` na porcie 0 z `router(...)`, klient `TestP2pClient` po HTTP): `createVault` → wpis na telefonie → parowanie → sync wtyczki widzi wpis; po nowym `PhoneVaultStore` na tym samym katalogu `unlock` i wpisy są; `lastSyncAt` ustawione; `removeDevice` → następny handshake 403; `startRestore` → parowanie RESTORE z `vaultInfo` → sync z 3 zmianami `baseRevision = 0` → `finishRestore(dobre hasło)` → `entries()` ma 3 wpisy; `finishRestore(złe)` → wyjątek „Złe hasło główne”, stan bez zmian; `unlockWithKeys` z `exportUnlockKeys()` działa, z losowymi 32 B rzuca (przy pustym i niepustym sklepie); auto-blokada po `autoLockMs`.
- [ ] **Step 2–4:** FAIL → implementacja → `./gradlew :core:test` PASS (cały moduł, v1 też).
- [ ] **Step 5: Commit** `git commit -m "p2p(android): phone vault store, router and local addresses"`

---

### Task 6: Aplikacja na nowym magazynie (bez Pi)

**Files:**
- Create: `APP/KeystoreSecretWrapper.kt`, `APP/ui/StartScreen.kt`
- Modify: `APP/PassHolderApp.kt`, `APP/AppViewModel.kt`, `APP/LockController.kt`, `APP/LeaveLock.kt`, `APP/BiometricController.kt` (32 B kluczy), `APP/ui/PassHolderUi.kt`, `APP/ui/ListScreen.kt`, `APP/ui/EditScreen.kt`, `APP/ui/LockedScreen.kt`, `android/app/src/main/res/values/strings.xml`
- Delete: `APP/ui/ConnectScreen.kt`, `APP/ui/AddressesScreen.kt`
- Test: `APPT/ScreenTests.kt` (przepisane), `APPT/BiometricScreenTests.kt`, nowy `APPT/BackupRulesTest.kt`

**Interfaces:**
- Consumes: `PhoneVaultStore`, `SecretWrapper`, `PhoneEntry` (Task 5).
- Produces:
  - `class KeystoreSecretWrapper(alias: String = "passholder-p2p-wrap") : SecretWrapper` — AES-256-GCM w Android Keystore, **bez** wymogu uwierzytelnienia użytkownika (host musi działać bez odcisku). Format `iv.base64 + ":" + ct.base64`.
  - `PassHolderApp`: `lateinit var phoneStore: PhoneVaultStore` (`PhoneVaultStore(filesDir, secretWrapper)`), `var secretWrapper: SecretWrapper` podmienialny w testach (Robolectric nie ma Keystore), `var syncPort: Int = PhoneSync.PORT` (testy ustawiają 0). `vaultStore` v1 znika z aplikacji.
  - `Screen`: `Start`, `Locked`, `List`, `Edit(id)`, `Sync`, `Devices`, `Restore` (ostatnie trzy w Task 7, tu tylko obiekty). `UiState.entries: List<PhoneEntry>`; `pending` znika.
  - `AppViewModel`: `createVault(password, repeat)` (min. 12 znaków, jak wtyczka), `startRestore()`; `save`/`delete` z komunikatami „Zapisano na telefonie. Wtyczka dostanie zmianę przy następnej synchronizacji.” Przycisk „Synchronizuj” na liście otwiera `Screen.Sync` (Task 7). `disconnect` → „Usuń sejf z telefonu” z potwierdzeniem w UI.

`StartScreen`: dwie zakładki „Nowy sejf” (hasło główne ×2, przycisk „Załóż sejf”) i „Odtwórz z wtyczki”
(opis kroków 5.3 i przycisk „Rozpocznij odtwarzanie”). `LockController`/`LeaveLock` zmieniają tylko typ
magazynu. Ekran listy pokazuje ostrzeżenie, gdy `unreadableIds()` niepuste.

- [ ] **Step 1: Napisz testy** (Robolectric, wzorzec `ScreenTestBase`, `secretWrapper` = wrapper testowy): `FullFlowScreensTest` — Start → załóż sejf → dodaj wpis → kopiuj hasło → zablokuj → odblokuj → wpis jest (zrzuty `01`…); `WrongPasswordTest` — złe hasło na ekranie blokady pokazuje błąd; `BiometricScreenTests` jak dotąd, ale z 32-bajtowymi kluczami; `BackupRulesTest` — `PackageManager`/manifest: `allowBackup == false`, a `data_extraction_rules.xml` wyklucza `file` w `cloud-backup` i `device-transfer`.
- [ ] **Step 2: Uruchom** `./gradlew :app:testDebugUnitTest` — Expected: FAIL (kompilacja).
- [ ] **Step 3: Zaimplementuj** zmiany z listy plików; usuń ekrany v1.
- [ ] **Step 4: Uruchom** `./gradlew :core:test :app:testDebugUnitTest` — Expected: PASS; zrzuty w `android/app/screenshots/`.
- [ ] **Step 5: Commit** `git commit -m "app: phone owns the vault (no Pi screens)"`

---

### Task 7: Tryb „Synchronizacja”, „Urządzenia”, „Odtwórz z wtyczki”

**Files:**
- Create: `APP/SyncController.kt`, `APP/ui/SyncScreen.kt`, `APP/ui/DevicesScreen.kt`, `APP/ui/RestoreScreen.kt`
- Modify: `APP/AppViewModel.kt`, `APP/MainActivity.kt` (stop przy `onStop`, `FLAG_KEEP_SCREEN_ON` gdy `SyncController.running`), `APP/ui/PassHolderUi.kt`, `APP/ui/ListScreen.kt` (przyciski „Synchronizacja” i „Urządzenia”)
- Test: `APPT/SyncScreenTests.kt`

**Interfaces:**
- Consumes: `PhoneVaultStore.router/offerPairing/cancelPairing/devices/removeDevice/finishRestore`, `SyncHttpServer`, `LocalAddresses`, `PhoneSync`.
- Produces:
  - `data class SyncUiState(val running: Boolean, val addresses: List<String>, val offer: PairingOffer?, val lastEvent: String?, val stoppedReason: String?)`
  - `class SyncController(private val store: PhoneVaultStore, private val port: Int, private val now: () -> Long = System::currentTimeMillis, private val addresses: () -> List<String> = { LocalAddresses.list(port) }) { val state: StateFlow<SyncUiState>; fun start(); fun stop(reason: String?); fun offerPairing(); fun checkIdle() /* stop po SYNC_IDLE_MS bez żądania */ }` — `start` uruchamia `SyncHttpServer(port, store.router(...))`; zdarzenia „Sparowano: <nazwa>”, „Zsynchronizowano z: <nazwa>” do `lastEvent`; `ViewModel` woła `checkIdle()` w istniejącej pętli co 15 s.
  - `AppViewModel`: `openSync()`, `closeSync()`, `addExtension()` (oferta parowania), `openDevices()`, `removeDevice(id)`, `finishRestore(password)`. Blokada sejfu i `onLeftApp()` wołają `stop(...)`.

`SyncScreen`: stan („Czekam na wtyczkę…”), lista adresów (monospace, do przepisania), przycisk „Dodaj
wtyczkę” → duży kod `1234 5678` z odliczaniem 2 min, ostatnie zdarzenie, „Zakończ”. Po zatrzymaniu przez
bezczynność: „Tryb synchronizacji wyłączony po 5 min bez połączeń.” `DevicesScreen`: nazwa, data parowania,
ostatnia synchronizacja (albo „jeszcze nie”), „Usuń” z potwierdzeniem. `RestoreScreen` (gdy
`restoreInProgress`): kroki, adresy i kod (serwer włączony od razu), po pierwszej synchronizacji pole hasła
głównego i „Zakończ odtwarzanie” → lista.

- [ ] **Step 1: Napisz testy** (Robolectric, `syncPort = 0`, prawdziwy `SyncHttpServer` w procesie testu, klient `TestP2pClient` z `testFixtures`/kopii testowej po HTTP): `SyncAndPairTest` — lista → Synchronizacja → widać adres i „Dodaj wtyczkę” → kod na ekranie → klient paruje się tym kodem i synchronizuje → ekran pokazuje „Zsynchronizowano z: test-ext” → Urządzenia pokazuje `test-ext` → Usuń → handshake 403; `IdleStopTest` — `now` przesunięte o 300 001 ms → `checkIdle()` zatrzymuje serwer i pokazuje komunikat; `LeaveAppStopsSyncTest` — `onLeftApp()` zatrzymuje serwer (port przestaje odpowiadać); `RestoreFlowTest` — Start → Odtwórz → klient paruje RESTORE i wysyła 2 wpisy → hasło → lista ma 2 wpisy. (Jeżeli `TestP2pClient` nie jest dostępny z `app`, przenieś go do `android/core/src/testFixtures/` — `testFixtures(project(":core"))` już jest zależnością).
- [ ] **Step 2–4:** FAIL → implementacja → `./gradlew :core:test :app:testDebugUnitTest` PASS.
- [ ] **Step 5: Commit** `git commit -m "app: sync mode, devices and restore screens"`

---

### Task 8: Dokumentacja części A i PR 3a

**Files:**
- Create: `docs/P2P_TELEFON.md` (sekcje: pliki i odpowiedzialności, protokół parowania po HTTP — tabela z tego planu, serwer HTTP i jego limity, trwała baza i odporność na urwany zapis, Keystore i kopie zapasowe, ekrany i cykl życia trybu synchronizacji, testy i komendy, znane ograniczenia, ręczne testy na telefonie)
- Modify: `docs/SYNCHRONIZACJA_P2P.md` (linia „Status”), `docs/P2P_ANDROID_RDZEN.md` §7 (odnośnik), `docs/ARCHITEKTURA.md` (akapit o telefonie jako hoście)

- [ ] **Step 1:** Napisz dokumenty (po polsku, krótko; fakty z kodu, nie z planu).
- [ ] **Step 2:** `./gradlew :core:test :app:testDebugUnitTest` i `npm test && npm run typecheck` — PASS.
- [ ] **Step 3: Commit** `git commit -m "docs: phone as P2P host"`, push, PR 3a.

---

## Część B — PR 3b: wtyczka paruje się z telefonem

### Task 9: Klient parowania w TS + test współpracy z telefonem

**Files:**
- Create: `core/src/p2p/pair-client.ts`, `core/test/p2p/pair-client.test.ts`, `android/core/src/test/resources/phone-interop.ts`, `KT/PhoneInteropTest.kt`
- Modify: `core/src/p2p/index.ts` (eksport)

**Interfaces:**
- Consumes: `cpaceStart/cpaceFinish`, `pairingKey`, `sealPairingMessage/openPairingMessage`, `FetchJson` (`transport.ts`).
- Produces:
  - `export type PhoneMode = "pair" | "restore"`
  - `export async function phoneHello(baseUrl: string, post: FetchJson): Promise<{ sid: string; mode: PhoneMode }>`
  - `export async function pairWithPhone(o: { baseUrl: string; code: string; identity: DeviceIdentity; post: FetchJson; restore?: VaultInfo }): Promise<{ mode: PhoneMode; phone: DeviceIdentity; vaultInfo: VaultInfo }>` — `hello` → `start` → `finish`; gdy `mode === "restore"` i brak `restore` → `Error("Telefon czeka na odtworzenie sejfu z wtyczki")` **przed** `/start` (kod nie przepada); 403 na `/finish` → `Error("Zły kod parowania. Poproś telefon o nowy kod.")`; 404 → `Error("Telefon nie czeka na parowanie albo kod wygasł.")`.
  - `export async function pingPhone(baseUrl: string, post: FetchJson): Promise<void>`

- [ ] **Step 1: Napisz testy** `pair-client.test.ts` z fałszywym hostem w teście (CPace + `sealPairingMessage` rolą `responder`, wg tabeli protokołu): dobry kod → `phone.staticPublicKey` i `vaultInfo` jak u hosta; zły kod → komunikat o złym kodzie; `restore` → host dostaje `vaultInfo` od `initiator`; tryb restore bez `restore` → błąd i host nie dostał `/start`. `PhoneInteropTest` (opcjonalny, `PASSHOLDER_INTEROP_TEST=1`, wzorzec `P2pInteropTest`): Kotlin uruchamia `PhoneVaultStore` + `SyncHttpServer` na porcie 0, skrypt Node wykonuje `pairWithPhone` + `syncVaultV2`/`noiseTransport` z `fetch`; przypadki: parowanie i wymiana wpisów w obie strony; odtwarzanie (RESTORE, 50 wpisów, `finishRestore` w Kotlinie odczytuje je).
- [ ] **Step 2–4:** FAIL → implementacja → `npx vitest run test/p2p` w `core/`, `npm run typecheck`, `PASSHOLDER_INTEROP_TEST=1 ./gradlew :core:test --tests "*PhoneInteropTest*"` — PASS.
- [ ] **Step 5: Commit** `git commit -m "p2p: pairing client and phone interop test"`

---

### Task 10: `VaultStore` wtyczki na v2

**Files:**
- Create: `extension/src/phone-client.ts`
- Modify: `extension/src/vault-store.ts`, `extension/src/storage.ts`, `extension/src/server-urls.ts` (`pickServer` uogólnione na `{ status(timeoutMs) }`), `extension/src/pin-lock.ts`, `extension/src/pin-store.ts` (`UnlockKeys = { vaultKey }`), `extension/src/csv-transfer.ts` (jeśli używa typów v1), `extension/src/api.ts` (usunąć; przenieść `ApiError` do `phone-client.ts`)
- Test: `extension/test/vault-store.test.ts` (przepisany), `extension/test/pin.test.ts`, `extension/test/server-urls.test.ts`, `extension/test/edge-cases.test.ts`, `extension/test/csv-transfer.test.ts`

**Interfaces:**
- Consumes: `pairWithPhone`, `pingPhone`, `phoneHello` (Task 9), `noiseTransport`, `syncVaultV2`, `applyVaultInfo`, `clockForVault`, `upsertEntryV2`, `deleteEntryV2`, `emptyVaultV2`, `generateKeyPair`, `seal/open`.
- Produces:
  - `phone-client.ts`: `class PhoneClient { constructor(baseUrl: string, fetchFn?: typeof fetch); status(timeoutMs?: number): Promise<void> /* ping */; post: FetchJson }`; błąd sieci → `ApiError(0, "Telefon nie odpowiada. Czy tryb Synchronizacja jest włączony?")`.
  - `STORAGE_KEYS`: `account: "accountV2"`, `vault: "vaultV2"`, `pendingPairing: "pendingPairing"` (session).
  - `interface Account { phoneUrls: string[]; lastPhoneUrl?: string; deviceId: string; deviceName: string; phone: DeviceIdentity; kdf: KdfParams; wrappedVaultKey: string; sealedStaticKey: string /* seal(vaultKey, privateKey, "passholder/v2/ext-static-key") */; staticPublicKey: string }`
  - `VaultStore`: `pairStart(url: string, code: string, deviceName: string): Promise<{ needsPassword: true }>` (nowe konto: generuje `deviceId` i klucz statyczny, zapisuje wynik parowania + klucz prywatny w `pendingPairing`); `pairFinish(masterPassword: string): Promise<void>` (unwrap; przy złym haśle „Złe hasło główne” i `pendingPairing` zostaje; przy sukcesie zapis konta, `applyVaultInfo`, pierwsza synchronizacja); `repair(url: string, code: string, masterPassword: string): Promise<"paired" | "restored">` (istniejące konto: ten sam `deviceId` i klucz; tryb `restore` wysyła własne `vaultInfo`; tryb `pair` porównuje vaultKey odwinięty z `vaultInfo` telefonu z bieżącym i przy różnicy rzuca „To inny sejf. Wtyczka zostaje połączona z poprzednim telefonem.” bez zmian w koncie); `unlock`, `unlockWithPin`, `upsert`, `delete`, `importEntries`, `entries`, `pendingCount`, `lock`, `disconnect`, `setPhoneUrls`, `sync()` — `sync` wybiera adres przez `pickServer(account.phoneUrls, makeClient, account.lastPhoneUrl)` (ping, `PROBE_TIMEOUT_MS = 4000`), potem `syncVaultV2(vault, vaultKey, clock, noiseTransport(...))`, zapisuje sejf i nowe adresy z `vault.addresses` do `phoneUrls` (bez duplikatów, ręcznie wpisane zostają).
  - Serializacja `LocalVaultV2` (z `epoch`, `addresses`) pod AAD `passholder/v2/local-vault`.

- [ ] **Step 1: Napisz testy** (fałszywy telefon w teście: `P2pHost` z `core/src/p2p/host.ts` + fałszywy host parowania z Task 9 za `fetchFn`): parowanie nowego konta → hasło → wpis z telefonu widoczny; **złe hasło w `pairFinish` → błąd, drugie `pairFinish` z dobrym hasłem działa bez nowego kodu** (Review Focus 1); **`repair` w trybie `pair` z telefonem o innym vaultKey → błąd „To inny sejf…”, konto i wpisy bez zmian** (Review Focus 2); `repair` w trybie `restore` → telefon dostaje wszystkie wpisy z `baseRevision = 0`; **dwa adresy, pierwszy nie odpowiada (fetch wisi) → sync po ~4 s udaje się na drugim i `lastPhoneUrl` = drugi** (Review Focus 5, fałszywe timery); adres z odpowiedzi telefonu dopisuje się do `phoneUrls`; PIN odblokowuje (klucze tylko `vaultKey`); import CSV dodaje wpisy `dirty`; blokada po 15 min jak dotąd.
- [ ] **Step 2–4:** FAIL → implementacja → `npm test -w extension && npm run typecheck` PASS.
- [ ] **Step 5: Commit** `git commit -m "extension: vault store syncs with the phone"`

---

### Task 11: Ekrany wtyczki i manifest

**Files:**
- Modify: `extension/src/views/connect.ts` (→ „Sparuj z telefonem”: adres + kod, potem hasło główne), `extension/src/views/addresses.ts` (adresy telefonu + „Sparuj z innym telefonem / odtwórz telefon”), `extension/src/views/list.ts` (komunikaty sync), `extension/src/ui/server-url-fields.ts` (origin `http://<host>:8787/*`), `extension/src/views/locked.ts` (teksty), `extension/static/manifest.json` (`optional_host_permissions` + `"http://*/*"`, opis „Prywatny menedżer haseł synchronizowany z telefonem.”)
- Test: istniejące testy + `npm run build -w extension`; smoke Playwright (`/opt/node22/lib/node_modules/playwright/index.mjs`, `launchPersistentContext(..., { channel: "chromium", args: ["--load-extension=dist"] })`) z fałszywym telefonem w Node (Kotlinowego nie ma w Chrome) — zrzuty do `/mnt/project-files/wtyczka-p2p/`.

**Interfaces:**
- Consumes: `VaultStore.pairStart/pairFinish/repair/setPhoneUrls/sync` (Task 10), `requestHostPermission`.

Nazwa urządzenia domyślnie `Chrome (<platforma z navigator.userAgentData?.platform ?? "komputer">)`, do zmiany w polu.
Teksty błędów z Task 9/10 bez zmian. Parowanie odbywa się w karcie (`showInTab`), jak dziś łączenie.

- [ ] **Step 1:** Zmień widoki i manifest.
- [ ] **Step 2: Uruchom** `npm test && npm run typecheck && npm run build -w extension` — PASS.
- [ ] **Step 3:** Smoke Playwright: parowanie z fałszywym telefonem, wpis, synchronizacja; zrzuty ekranów.
- [ ] **Step 4: Commit** `git commit -m "extension: pair with the phone instead of the Pi"`

---

### Task 12: Dokumentacja części B, testy ręczne (w tym Tailscale) i PR 3b

**Files:**
- Create: `docs/P2P_WTYCZKA.md` (pliki, przebieg parowania i synchronizacji we wtyczce, nowe klucze w pamięci, PIN tylko z vaultKey, migracja przez CSV, ograniczenia) i sekcja „Testy ręczne” w `docs/P2P_TELEFON.md`: (1) LAN: nowy sejf na telefonie → Synchronizacja → parowanie wtyczki → wpis w obie strony; (2) zły kod i wygasły kod; (3) zmiana sieci: drugi adres; (4) **Tailscale**: wtyczka z adresem `http://100.x.y.z:8787` telefonu przy włączonym Tailscale na obu urządzeniach — wynik wpisać do `SYNCHRONIZACJA_P2P.md` §2 i §10; (5) odtworzenie: „Usuń sejf z telefonu” → „Odtwórz z wtyczki” → hasło → wpisy wróciły; (6) wyjście z aplikacji gasi tryb.
- Modify: `docs/SYNCHRONIZACJA_P2P.md` (status: plan 3 zrobiony), `docs/INSTALACJA.md` (krótki akapit: Pi niepotrzebne od tej wersji, szczegóły w planie 4), `README.md` (jeśli opisuje Pi jako wymagane).

- [ ] **Step 1:** Napisz dokumenty.
- [ ] **Step 2:** Pełna weryfikacja: `npm test && npm run typecheck && npm run build -w extension`, `./gradlew :core:test :app:testDebugUnitTest`, `PASSHOLDER_INTEROP_TEST=1 ./gradlew :core:test --tests "*Interop*"` — PASS.
- [ ] **Step 3: Commit** `git commit -m "docs: extension pairs with the phone"`, push, PR 3b.
