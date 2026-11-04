# Synchronizacja P2P, plan 2 z 4: rdzeń P2P w Kotlinie (`android/core`) — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Przenieść rdzeń P2P z `core/src/p2p/` do Kotlina w `android/core`, tak żeby telefon mógł być
hostem synchronizacji (Noise KK, ramki, epoka, stronicowanie, logika `revision` z dzisiejszego serwera)
i stroną parowania (CPace, wiadomości parowania), sprawdzone bit w bit wektorami v2 i testem
współpracy z prawdziwym klientem TypeScript.

**Architecture:** Nowy pakiet `io.github.sheking94.passholder.core.p2p` obok kodu v1 w `android/core`
(czysty Kotlin/JVM, testy JUnit 5). Port obejmuje to, czego potrzebuje **telefon**: hosta
(`P2pHost`, `HostSync`, `SyncStore`), lokalne zmiany telefonu we własnym sejfie (`PhoneVault`), CPace,
Noise KK w obu rolach (wektor Cacophony ma obie) i wiadomości parowania. Klienta synchronizacji
wtyczki (`syncVaultV2`, `noiseTransport`) **nie portujemy**: telefon nigdy nie synchronizuje się jako
klient, a ten kod sprawdza test współpracy (Task 11), w którym prawdziwy `syncVaultV2` z TypeScriptu
rozmawia z hostem w Kotlinie. ristretto255 piszemy sami na `BigInteger` (Bouncy Castle 1.82 go nie ma),
X25519, HKDF i AES-GCM bierzemy z Bouncy Castle i JCA.

**Tech Stack:** Kotlin 2.2.21 / JVM 17, kotlinx.serialization 1.9 (`JsonElement` do walidacji),
Bouncy Castle 1.82 (`org.bouncycastle.math.ec.rfc7748.X25519`, `HKDFBytesGenerator`), JCA
(`AES/GCM/NoPadding`, `HmacSHA256`, `SHA-512`), JUnit 5, OkHttp MockWebServer (tylko test współpracy).

**Spec:** `docs/SYNCHRONIZACJA_P2P.md` (sekcje 4, 5, 8 krok 2, 9) oraz opis zachowania wersji
referencyjnej `docs/P2P_RDZEN.md` (kontrakt HTTP, kody błędów, ramki, stronicowanie). Kod referencyjny:
`core/src/p2p/*.ts`; w razie wątpliwości **wersja TypeScript jest wzorcem**.

**Pozostałe plany:**
3. Android `app` i wtyczka: tryb „Synchronizacja” (serwer HTTP na telefonie wołający `P2pHost.handle`),
   trwały `SyncStore`, endpointy parowania, ekrany „Urządzenia” i „Odtwórz z wtyczki”, nowy transport we
   wtyczce. Tam też zalecenie z `P2P_RDZEN.md` pkt 6: wyłączyć bazę hosta z Android Auto Backup albo po
   odtworzeniu z kopii zawsze tworzyć nową epokę.
4. Usunięcie `server/`, `deploy/`, kodu v1 i części `INSTALACJA.md` o Pi.

## Global Constraints

- Środowisko (Windows): w `android/` przed Gradle `$env:JAVA_HOME="$HOME\.jdks\jbr-21.0.11"` (JBR 25 z Android Studio nie działa z Gradle 8.14.3); Node przez `fnm env --shell powershell | Out-String | Invoke-Expression`.
- Po każdym tasku `.\gradlew.bat :core:test` w `android/` przechodzi w całości (v1 też). Po Task 3 i na końcu także `npm test` i `npm run typecheck` w katalogu głównym.
- Kod v1 ma działać do końca przebudowy: **nie zmieniać** istniejących plików w `android/core/src/main`, `android/core/src/test`, `android/app/`, `core/src/`, `server/`, `extension/`. Wolno ich **używać** (`Encoding`, `Aead`, `Kdf`, `KdfParams`, `Credentials`, `RemoteRecord`, `ChangeRequest`, `Accepted`, `SyncResponse`). Jedyny zmieniany plik v1: `android/core/build.gradle.kts` (Task 11, przekazanie zmiennej środowiskowej).
- Bez nowych zależności w `libs.versions.toml`.
- Pakiet `io.github.sheking94.passholder.core.p2p`, pliki w `android/core/src/main/kotlin/io/github/sheking94/passholder/core/p2p/`, testy w `android/core/src/test/kotlin/io/github/sheking94/passholder/core/p2p/`.
- Nazwy pól JSON, AAD, etykiety i stałe dokładnie jak w TypeScripcie (`passholder/v2/...`, `MAX_FRAMES = 18`, `MAX_FRAME_PLAINTEXT = 65519`, `MAX_SESSIONS = 32`, `SESSION_TTL_MS = 60_000`, 1 MiB = `1024 * 1024`, 500 zmian na żądanie i na odpowiedź).
- Liczby z sieci (`revision`, `sinceRevision`, `baseRevision`, `ms`, `c`) to `Long` z zakresu `0..9_007_199_254_740_991` (bezpieczna liczba całkowita JS), podane jako liczba JSON, nie tekst.
- Błędne dane z sieci rzucają `IllegalArgumentException` (komunikaty CPace i Noise jak w TS: `"CPace: invalid peer element"`, `"Noise: decryption failed"` itd.); host zamienia je na kody HTTP z tabeli w `P2P_RDZEN.md` §4 z tymi samymi tekstami `error`.
- JSON serializowany jednym obiektem `P2pJson.json` (`Json { encodeDefaults = true }`), bez spacji, kolejność pól jak w TS, żeby szyfrogramy z wektorów wyszły bajt w bajt.
- Wspólny stan (sklep, sesje, zegar) jest bezpieczny wątkowo: każda operacja na `SyncStore` z zapisem idzie pod `synchronized(store)`.
- Komentarze i nazwy w kodzie po angielsku, dokumentacja po polsku.

## Review Focus

1. **Telefon edytuje wpis, gdy host przetwarza żądanie sync z innego wątku**: żaden zapis nie ginie, rewizje są unikalne i ciągłe. Test w Task 10.
2. **Sparowane urządzenie wgrało blob, którego telefon nie odszyfruje**: `PhoneVault` dalej pokazuje pozostałe wpisy i zgłasza ten jeden jako nieczytelny. Test w Task 10.
3. **Liczby w JSON spoza zakresu albo złego typu** (`"5"`, `1.5`, `-1`, `1e20`, `9007199254740992`, `null`): 400, nic nie zapisane, brak wyjątku na zewnątrz. Test w Task 8.
4. **Ciało żądania, które nie jest UTF-8, nie jest JSON-em albo jest tablicą**: 400 `"malformed request"`, nie 500. Test w Task 9.
5. **Polskie znaki i emoji**, także znak wielobajtowy rozcięty granicą ramki: przechodzą bez zmian między TS i Kotlinem. Testy w Task 7 i Task 11.

---

### Task 1: HLC i pomocnicze JSON

**Files:**
- Create: `p2p/Hlc.kt`, `p2p/P2pJson.kt`
- Test: `p2p/HlcTest.kt`, `p2p/P2pVectorsTest.kt` (od tego taska rośnie z każdym modułem)

**Interfaces:**
- Produces:
  - `object P2pJson { val json: Json; const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L; fun safeLong(e: JsonElement?): Long? }` — `safeLong` zwraca wartość tylko dla liczby JSON (nie tekstu) będącej całkowitą z `0..MAX_SAFE_INTEGER`, inaczej `null`.
  - `@Serializable data class Hlc(val ms: Long, val c: Long, val d: String) : Comparable<Hlc>` — porządek `(ms, c, d)`, `d` przez `String.compareTo` (jednostki UTF-16, jak w TS).
  - `fun parseHlc(value: JsonElement?): Hlc` — rzuca `IllegalArgumentException("Invalid HLC")`; `d` niepusty, najwyżej 64 znaki.
  - `class HlcClock(deviceId: String, now: () -> Long = System::currentTimeMillis, last: Hlc? = null) { val last: Hlc?; fun tick(): Hlc; fun observe(remote: Hlc) }` — metody `@Synchronized`, semantyka jak `core/src/p2p/hlc.ts`.

- [ ] **Step 1: Napisz testy** — przenieś każdy `it(...)` z `core/test/p2p/hlc.test.ts` do `HlcTest` (te same wartości), dodaj `parseHlc` odrzucające: `ms` jako tekst `"1"`, `ms = 1.5`, `c = -1`, `ms = 9007199254740992`, `d = ""`, `d` z 65 znaków, `null`. `P2pVectorsTest` czyta `core/test-vectors/v2.json` (ścieżka z `System.getProperty("passholder.repoRoot")`, jak `VectorsTest`) i dla każdej pozycji `hlcCompare` sprawdza `a.compareTo(b).sign == expected`.
- [ ] **Step 2: Uruchom** `.\gradlew.bat :core:test --tests "*p2p*"` — Expected: FAIL (brak klas).
- [ ] **Step 3: Zaimplementuj** `Hlc.kt` i `P2pJson.kt`.
- [ ] **Step 4: Uruchom** `.\gradlew.bat :core:test` — Expected: PASS, w tym 5 wektorów `hlcCompare` (ostatni z emoji).
- [ ] **Step 5: Commit** `git commit -m "p2p(android): hybrid logical clock"`

---

### Task 2: Treść wpisu v2

**Files:**
- Create: `p2p/EntryV2.kt`
- Test: `p2p/EntryV2Test.kt`, `p2p/P2pVectorsTest.kt`

**Interfaces:**
- Consumes: `Hlc`, `parseHlc`, `P2pJson.json` (Task 1); `Aead.seal/open`, `Encoding` (v1).
- Produces:
  - `@Serializable data class EntryDataV2(val name: String, val username: String, val password: String, val hlc: Hlc)`
  - `@Serializable data class TombstoneDataV2(val hlc: Hlc)`
  - `object EntryV2 { fun aad(id: String): String /* "passholder/v2/entry/$id" */; fun encrypt(vaultKey: ByteArray, id: String, data: EntryDataV2, nonce: ByteArray? = null): String; fun encryptTombstone(vaultKey: ByteArray, id: String, data: TombstoneDataV2, nonce: ByteArray? = null): String; fun decrypt(vaultKey: ByteArray, id: String, blob: String): JsonElement; fun parseEntry(value: JsonElement): EntryDataV2; fun parseTombstone(value: JsonElement): TombstoneDataV2 }` — błędy treści: `IllegalArgumentException("Invalid entry payload")` / `("Invalid tombstone payload")`.

- [ ] **Step 1: Napisz testy** — wektor `entryPayload` (obie pozycje): `encrypt…(…, nonce)` daje dokładnie `blob`, `decrypt` + `parse…` daje `data`, `aad(id) == aad`. W `EntryV2Test`: blob innego `id` się nie otwiera; `parseEntry` odrzuca brak `password` i `hlc` z `ms` tekstem; blob z v1 (`passholder/v1/entry/…`) się nie otwiera.
- [ ] **Step 2: Uruchom** — Expected: FAIL.
- [ ] **Step 3: Zaimplementuj** `EntryV2.kt` (JSON przez `P2pJson.json.encodeToString`, bajty przez `Encoding.utf8`).
- [ ] **Step 4: Uruchom** `.\gradlew.bat :core:test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "p2p(android): v2 entry payload"`

---

### Task 3: ristretto255 (RFC 9496)

**Files:**
- Create: `core/test-vectors/ristretto255-rfc9496.json`, `p2p/Ristretto255.kt`
- Test: `core/test/p2p/ristretto-rfc9496.test.ts` (sprawdza sam plik wektorów biblioteką noble), `p2p/Ristretto255Test.kt`

**Interfaces:**
- Produces (wszystko `internal`):
  - `internal class RistrettoPoint` (współrzędne rozszerzone Edwardsa `X, Y, Z, T: BigInteger` mod `p = 2^255 - 19`) z `fun encode(): ByteArray` (32 B), `operator fun plus(o: RistrettoPoint)`, `fun multiply(scalar: BigInteger): RistrettoPoint`, `fun isIdentity(): Boolean` i `companion object { val IDENTITY; val GENERATOR; val L: BigInteger /* 2^252 + 27742317777372353535851937790883648493 */; fun decode(bytes: ByteArray): RistrettoPoint /* IllegalArgumentException dla każdego niekanonicznego kodowania */; fun fromUniformBytes(bytes: ByteArray): RistrettoPoint /* 64 B, RFC 9496 §4.3.4 */ }`.

Plik wektorów: z RFC 9496, Appendix A (https://www.rfc-editor.org/rfc/rfc9496#appendix-A) skopiuj
dokładnie: A.1 (16 kodowań `B·0 … B·15`) jako `multiples`, A.2 (niepoprawne kodowania) jako `invalid`,
A.3 (pary wejście 64 B → wynik) jako `oneWayMap`; plus pole `source` z adresem. Hex małymi literami.

Algorytmy: stałe z RFC 9496 §4.1 (wpisz je dziesiętnie z RFC), `SQRT_RATIO_M1` z §4.2, `decode` §4.3.1,
`encode` §4.3.2, równość §4.3.3 (`isIdentity` = równość z `IDENTITY`), mapa §4.3.4. Dodawanie: wzór
„add-2008-hwcd-3” dla `a = -1` (stała `k = 2d`); mnożenie double-and-add po bitach skalara.
Implementacja **nie jest stałoczasowa** (BigInteger); zapisz to w KDoc klasy i w dokumentacji (Task 12).

- [ ] **Step 1: Pobierz i zapisz plik wektorów, napisz test TS** — `ristretto-rfc9496.test.ts` sprawdza każdą pozycję noble: `ristretto255.Point.BASE.multiply(i)` (dla `i = 0` `Point.ZERO`) koduje się do `multiples[i]`, `Point.fromBytes(hex)` rzuca dla każdego `invalid`, `ristretto255_hasher.deriveToCurve(input).toBytes()` równa się `output`. To łapie pomyłki w przepisywaniu.
- [ ] **Step 2: Uruchom** `npx vitest run test/p2p/ristretto-rfc9496.test.ts` w `core/` — Expected: PASS (plik jest poprawny). Potem `npm test && npm run typecheck` w katalogu głównym — PASS.
- [ ] **Step 3: Napisz testy Kotlin** — `Ristretto255Test`: `GENERATOR.multiply(i).encode()` == `multiples[i]` dla 0..15; `decode(multiples[i]).encode()` == `multiples[i]`; każdy `invalid` rzuca; `fromUniformBytes(input).encode()` == `output`; `GENERATOR.multiply(L).isIdentity()`; `decode` 31 i 33 bajtów rzuca; stałe spełniają definicje (`SQRT_M1^2 == -1`, `d * 121666 == -121665` mod p).
- [ ] **Step 4: Uruchom** — Expected: FAIL. **Step 5: Zaimplementuj** `Ristretto255.kt`. **Step 6: Uruchom** `.\gradlew.bat :core:test` — Expected: PASS.
- [ ] **Step 7: Commit** `git commit -m "p2p(android): ristretto255 group per RFC 9496"`

---

### Task 4: CPace

**Files:**
- Create: `p2p/Cpace.kt`
- Test: `p2p/CpaceTest.kt`

**Interfaces:**
- Consumes: `RistrettoPoint` (Task 3).
- Produces:
  - `enum class CpaceRole(val wire: String) { INITIATOR("initiator"), RESPONDER("responder") }`
  - `class CpaceState internal constructor(...)` (skalar `y`, własne `Y`, `ad`, `sid`; nieprzezroczysty)
  - `data class CpaceStart(val state: CpaceState, val message: ByteArray)`
  - `object Cpace { val PAIRING_CI: ByteArray /* utf8 "passholder/v2/pair" */; fun lvCat(vararg parts: ByteArray): ByteArray; fun start(prs: ByteArray, ci: ByteArray, sid: ByteArray, ad: ByteArray, ya: ByteArray? = null): CpaceStart; fun finish(state: CpaceState, peerMessage: ByteArray, role: CpaceRole): ByteArray /* ISK, 64 B */ }`
  - `internal` do testów: `generatorString(prs, ci, sid)`, `generatorHash(prs, ci, sid)`, `calculateGenerator(prs, ci, sid): ByteArray`, `sharedPoint(y: ByteArray, peer: ByteArray): ByteArray`.

Port 1:1 z `core/src/p2p/cpace.ts` (draft-irtf-cfrg-cpace-21, wpisz w nagłówku pliku): LEB128 w
`prependLen`, `lvSplit` na dokładnie 2 pola z odrzuceniem nadmiarowych bajtów, `zpad`, skrót SHA-512
obcięty do 64 B, `sample_scalar` (32 B z CSPRNG, `bytes[31] &= 0x0f`, little-endian, mod `L`, różny od
zera), `scalar_mult_vfy` odrzuca błąd dekodowania, element neutralny na wejściu i wynik neutralny.
Wiadomość na drucie to `lvCat(Y, ad)`; transkrypt `transcript_ir` dla obu ról.

- [ ] **Step 1: Napisz testy** — z `core/test-vectors/cpace-ristretto255.json`: `generator_string`, `generator_hash`, `g`, `Ya` (`start(PRS, CI, sid, ADa, ya)`), `Yb`, `K` (`sharedPoint`), `ISK_IR` z `finish` po obu stronach (inicjator z `ADa`, odpowiadający z `ADb`); `invalid_Y1` i `invalid_Y2_identity` (jako `Y` w `lvCat(Y, ADb)`) rzucają `"CPace: invalid peer element"`; to samo dla: 31-bajtowego `Y`, trzeciego pola, ucięcia ostatniego bajtu, długości LEB128 większej niż reszta. Różne kody → różne ISK. Pozostałe przypadki z `core/test/p2p/cpace.test.ts`, których tu nie ma, też przenieś.
- [ ] **Step 2: Uruchom** — FAIL. **Step 3: Zaimplementuj** `Cpace.kt`. **Step 4: Uruchom** `.\gradlew.bat :core:test` — PASS.
- [ ] **Step 5: Commit** `git commit -m "p2p(android): CPace over ristretto255"`

---

### Task 5: Noise KK

**Files:**
- Create: `p2p/Noise.kt`
- Test: `p2p/NoiseTest.kt`

**Interfaces:**
- Produces:
  - `class KeyPair(val publicKey: ByteArray, val privateKey: ByteArray)`; `object NoiseKeys { fun generate(): KeyPair; fun fromPrivateKey(privateKey: ByteArray): KeyPair }` (BC `X25519.generatePrivateKey`/`scalarMultBase`).
  - `val P2P_PROLOGUE: ByteArray` (utf8 `"passholder/v2/noise"`).
  - `class CipherState(key: ByteArray?, n: ULong = 0uL) { fun hasKey(): Boolean; fun encrypt(ad: ByteArray, plaintext: ByteArray): ByteArray; fun decrypt(ad: ByteArray, ciphertext: ByteArray): ByteArray }` — `@Synchronized`; nonce: 4 B zer + 8 B big-endian; `n` rośnie tylko po sukcesie; `n == ULong.MAX_VALUE` → `"Noise: nonce exhausted"`.
  - `data class TransportCiphers(val send: CipherState, val recv: CipherState)`
  - `class NoiseKK private constructor(...) { companion object { fun initiator(s: KeyPair, rs: ByteArray, prologue: ByteArray, e: KeyPair? = null): NoiseKK; fun responder(s: KeyPair, rs: ByteArray, prologue: ByteArray, e: KeyPair? = null): NoiseKK }; fun writeMessage(payload: ByteArray): ByteArray; fun readMessage(message: ByteArray): ByteArray; fun split(): TransportCiphers; val handshakeHash: ByteArray }`

Port 1:1 z `core/src/p2p/noise.ts`, łącznie z maszyną stanów (`write1/read1/write2/read2/done/split/failed`,
błąd po sprawdzeniu rozmiaru → `failed`) i limitami 65535 B. DH przez `X25519.calculateAgreement`;
wynik zerowy (punkt niskiego rzędu) → `IllegalArgumentException("Noise: invalid public key")`.
HKDF Noise ręcznie na `HmacSHA256` (§4.3), nie przez HKDF z BC.

- [ ] **Step 1: Napisz testy** — wektor `core/test-vectors/noise-kk.json`: obie strony z kluczami z wektora (`init_static`, `init_ephemeral` itd. to klucze prywatne), wiadomości 0–1 jako uzgadnianie, 2–5 jako transport naprzemiennie (inicjator wysyła parzyste), każdy `ciphertext` i odczytany `payload` się zgadzają, `handshakeHash` równy `handshake_hash`. Oraz: zmieniony bajt / ucięta wiadomość 1 i 2 → wyjątek i dalsze kroki rzucają; zły `rs` → odczyt się nie udaje; zła kolejność kroków; `split()` przed końcem; `CipherState(key, ULong.MAX_VALUE - 1u)` szyfruje raz, potem `nonce exhausted`; klucz publiczny z samych zer → wyjątek. Resztę przypadków z `core/test/p2p/noise.test.ts` przenieś.
- [ ] **Step 2: Uruchom** — FAIL. **Step 3: Zaimplementuj.** **Step 4: Uruchom** `.\gradlew.bat :core:test` — PASS.
- [ ] **Step 5: Commit** `git commit -m "p2p(android): Noise_KK_25519_AESGCM_SHA256"`

---

### Task 6: Parowanie

**Files:**
- Create: `p2p/Pairing.kt`
- Test: `p2p/PairingTest.kt`, `p2p/P2pVectorsTest.kt`

**Interfaces:**
- Consumes: `Cpace`, `CpaceRole` (Task 4); `Aead`, `Encoding`, `KdfParams`, `Kdf.assertAcceptable` (v1).
- Produces:
  - `@Serializable data class DeviceIdentity(val deviceId: String, val name: String, val staticPublicKey: String)`
  - `@Serializable data class VaultInfo(val epoch: String, val kdf: KdfParams, val wrappedVaultKey: String, val addresses: List<String>)`
  - `enum class PairingKind(val wire: String) { IDENTITY("identity"), VAULT_INFO("vault-info") }`
  - `object Pairing { const val MAX_DEVICE_NAME_LENGTH = 64; const val MAX_ADDRESSES = 16; const val MAX_ADDRESS_LENGTH = 256; fun generateCode(): String; fun key(isk: ByteArray): ByteArray; fun aad(kind: PairingKind, from: CpaceRole): String; fun sealIdentity(key: ByteArray, from: CpaceRole, value: DeviceIdentity, nonce: ByteArray? = null): String; fun sealVaultInfo(key: ByteArray, from: CpaceRole, value: VaultInfo, nonce: ByteArray? = null): String; fun openIdentity(key: ByteArray, from: CpaceRole, blob: String): DeviceIdentity; fun openVaultInfo(key: ByteArray, from: CpaceRole, blob: String): VaultInfo }`

Port z `core/src/p2p/pairing.ts`: kod = 8 cyfr, bajty ≥ 250 odrzucane; `key` = HKDF-SHA256 bez soli,
info `"passholder/v2/pair-key"`, 32 B; AAD `passholder/v2/pair/<kind>/<from>`; walidacja przy
otwieraniu dokładnie jak `parseIdentity`/`parseVaultInfo` (kanoniczne Base64: dekoduje się i koduje do
tego samego tekstu; `staticPublicKey` 32 B, `epoch` i `kdf.salt` 16 B, `wrappedVaultKey` niepuste,
`addresses` ≤ 16 tekstów po 1..256 znaków, `deviceId` i `name` 1..64 znaki). Błędy:
`IllegalArgumentException`; zły klucz → `AEADBadTagException` z `Aead.open`.

- [ ] **Step 1: Napisz testy** — wektory `pairingKey` i wszystkie 3 `pairingMessage` (`seal…` z `nonce` daje `blob`, `open…` daje `value`, `aad` się zgadza). `PairingTest`: wiadomość otwarta z rolą nadawcy odwróconą nie otwiera się; odrzucane: `staticPublicKey` 31 B, `epoch` niekanoniczne (`"AAECAwQFBgcICQoLDA0ODw=="` z ostatnim znakiem zmienionym tak, że dekoduje się do tych samych bajtów), 17 adresów, adres pusty, `name` z 65 znaków, `kdf.iterations = 1`; `generateCode()` 1000 razy pasuje do `^[0-9]{8}$`. Pełne parowanie w pamięci: `Cpace.start` po obu stronach z kodem jako `PRS`, wymiana wiadomości, `finish`, `Pairing.key` równe; telefon wysyła `identity` i `vault-info`, wtyczka `identity`; przy innym kodzie pierwsze `open…` rzuca.
- [ ] **Step 2: Uruchom** — FAIL. **Step 3: Zaimplementuj.** **Step 4: Uruchom** `.\gradlew.bat :core:test` — PASS.
- [ ] **Step 5: Commit** `git commit -m "p2p(android): pairing code, key and messages"`

---

### Task 7: Ramki

**Files:**
- Create: `p2p/Frames.kt`
- Test: `p2p/FramesTest.kt`, `p2p/P2pVectorsTest.kt`

**Interfaces:**
- Consumes: `CipherState` (Task 5).
- Produces: `object Frames { const val MAX_FRAME_PLAINTEXT = 65519; const val MAX_FRAMES = 18; fun encrypt(cipher: CipherState, json: String): List<String>; fun decrypt(cipher: CipherState, frames: List<String>): JsonElement }` — dzielenie po **bajtach** UTF-8 (`Encoding.utf8(json)`), AD puste, Base64; `decrypt` skleja bajty, dekoduje ściśle (`Encoding.fromUtf8`) i parsuje; każdy błąd → `IllegalArgumentException`.

- [ ] **Step 1: Napisz testy** — wektor `frames`: z `cipherKey` i JSON-em tekstu z `payloadStringLength` znaków `payloadChar` (`"\"" + "a".repeat(65527) + "\""`) powstają ramki o długości tekstu jawnego `chunkLengths` (długość szyfrogramu − 16), a stałe równe `MAX_FRAME_PLAINTEXT`, `MAX_FRAMES`. `FramesTest`: obiekt JSON z polem `"zażółć 😀"` ustawionym tak, że 4-bajtowe emoji przecina granicę 65519 B, wraca bez zmian; brak ostatniej ramki, zamiana kolejności, pusta lista i zmieniony bajt → wyjątek.
- [ ] **Step 2: Uruchom** — FAIL. **Step 3: Zaimplementuj.** **Step 4: Uruchom** `.\gradlew.bat :core:test` — PASS.
- [ ] **Step 5: Commit** `git commit -m "p2p(android): Noise frames"`

---

### Task 8: Logika synchronizacji hosta

**Files:**
- Create: `p2p/HostSync.kt`
- Test: `p2p/HostSyncTest.kt`, `p2p/P2pVectorsTest.kt`

**Interfaces:**
- Consumes: `P2pJson` (Task 1); `RemoteRecord`, `ChangeRequest`, `Accepted`, `SyncResponse` (v1 `Protocol.kt`).
- Produces:
  - `interface SyncStore { fun get(id: String): RemoteRecord?; fun put(record: RemoteRecord); fun listSince(revision: Long): List<RemoteRecord>; fun currentRevision(): Long }` i `class MemorySyncStore : SyncStore` (jak `MemorySyncStore` w `core/src/protocol.ts`; `listSince` posortowane po `revision`).
  - `@Serializable data class P2pSyncRequest(val epoch: String, val sinceRevision: Long, val changes: List<ChangeRequest>)`
  - `@Serializable data class P2pSyncResponse(val epoch: String, val currentRevision: Long, val accepted: List<Accepted>, val conflicts: List<RemoteRecord>, val changes: List<RemoteRecord>, val addresses: List<String>, val more: Boolean)`
  - `object HostSync { const val MAX_CHANGES_PER_REQUEST = 500; const val MAX_CHANGES_PER_RESPONSE = 500; const val MAX_ENTRY_ID_LENGTH = 128; fun validate(store: SyncStore, epoch: String, request: JsonElement): String?; fun process(store: SyncStore, epoch: String, addresses: List<String>, request: JsonElement): P2pSyncResponse; internal fun processSync(store: SyncStore, sinceRevision: Long, changes: List<ChangeRequest>): SyncResponse }`

`processSync` = port `processSync` z `core/src/protocol.ts` (logika dzisiejszego serwera). `validate` i
`process` = port `validateP2pSyncRequest` i `processP2pSync` z `host-sync.ts`, te same teksty błędów
(`"malformed sync request"`, `"too many changes"`, `"malformed change"`, `"duplicate change"`,
`"unknown base revision"`), liczby przez `P2pJson.safeLong`. `process` waliduje, rzuca
`IllegalArgumentException(błąd)` przed zapisem, a całość (walidacja + zapis) robi pod `synchronized(store)`.

- [ ] **Step 1: Napisz testy** — wektor `paging` (stałe). Przenieś z TS przypadki hosta: z `core/test/p2p/sync.test.ts` „host returns at most MAX_CHANGES_PER_RESPONSE records and continues from the last one”, „host rejects more than MAX_CHANGES_PER_REQUEST changes”, „host ignores changes sent with a stale epoch”; z `core/test/p2p/transport.test.ts` „processP2pSync refuses an invalid request without writing”, „processP2pSync ignores a request whose sinceRevision is ahead of the store…”, a przypadki „rejects malformed or duplicate changes…” i „an unknown base revision…” jako wywołania `process` (sklep bez zmian). Dodaj `processSync`: przyjęta zmiana dostaje `currentRevision + 1`, nieaktualne `baseRevision` daje konflikt z wersją sklepu, `changes` pomija id z `accepted`/`conflicts`. Review Focus 3: `sinceRevision` = `"5"`, `1.5`, `-1`, `1e20`, `9007199254740992`, `null` oraz te same wartości w `baseRevision` → `validate` zwraca `"malformed sync request"`/`"malformed change"`, sklep bez zmian.
- [ ] **Step 2: Uruchom** — FAIL. **Step 3: Zaimplementuj.** **Step 4: Uruchom** `.\gradlew.bat :core:test` — PASS.
- [ ] **Step 5: Commit** `git commit -m "p2p(android): host sync logic with epoch and paging"`

---

### Task 9: Host HTTP (`P2pHost`)

**Files:**
- Create: `p2p/P2pHost.kt`
- Test: `p2p/P2pHostTest.kt`, `p2p/TestP2pClient.kt` (w źródłach testowych)

**Interfaces:**
- Consumes: `NoiseKK`, `KeyPair`, `P2P_PROLOGUE` (Task 5), `Frames` (Task 7), `HostSync`, `SyncStore` (Task 8).
- Produces:
  - `class PairedDevice(val deviceId: String, val name: String, val staticPublicKey: ByteArray)`
  - `data class HostReply(val status: Int, val body: String)` (JSON)
  - `class P2pHost(staticKey: KeyPair, devices: () -> List<PairedDevice>, store: SyncStore, epoch: String, addresses: () -> List<String>, now: () -> Long = System::currentTimeMillis) { fun handle(path: String, body: ByteArray): HostReply; companion object { const val MAX_BODY_BYTES = 1024 * 1024; const val SESSION_TTL_MS = 60_000L; const val MAX_SESSIONS = 32 } }`
  - (test) `class TestP2pClient(deviceId: String, staticKey: KeyPair, phonePublicKey: ByteArray, host: P2pHost) { fun handshake(): Pair<String, TransportCiphers>; fun sync(request: String): HostReply; fun syncResponse(request: P2pSyncRequest): P2pSyncResponse }` — odpowiednik `noiseTransport` wołający `host.handle` bezpośrednio.

Port `core/src/p2p/host.ts`. Kolejność sprawdzeń i kody dokładnie jak w tabeli `P2P_RDZEN.md` §4
(413 jako pierwsze, po rozmiarze `body`; potem usunięcie wygasłych sesji; 404; dalej 400/403/503 dla
uzgadniania i 400/401/403/400/500 dla sync). Ciało, które nie jest ściśle UTF-8, nie jest JSON-em albo
nie jest obiektem → 400 `"malformed request"`. Sesja jednorazowa, usuwana przed jakimkolwiek dalszym
sprawdzeniem; mapa sesji pod blokadą (wywołania `handle` z wielu wątków).

- [ ] **Step 1: Napisz testy** — przenieś z `core/test/p2p/transport.test.ts` każdy przypadek dotyczący hosta: niesparowane/usunięte urządzenie (403), sesja użyta ponownie, wygasła (`now` przesunięte o 60 s) i nieznana (401), zmieniony szyfrogram sync (400), żądanie ponad 200 KiB w wielu ramkach, środkowa ramka zmieniona (400, sklep bez zmian), za duże ciało (413), złe żądania i nieznana ścieżka, sesja otwarta przed usunięciem urządzenia i przed ponownym sparowaniem innym kluczem (403), 32 sesje i 503, „restored phone…” jako para żądań (`sinceRevision` ponad sklep → puste odpowiedzi i `currentRevision` sklepu). Przypadki z dwoma sejfami TS („syncs two vaults…”, „1300 entries… in pages”) sprawdza Task 11. Review Focus 4: ciało `0xff 0xfe`, `"[]"`, `"{"`, `"null"` na obu ścieżkach → 400 `"malformed request"`.
- [ ] **Step 2: Uruchom** — FAIL. **Step 3: Zaimplementuj.** **Step 4: Uruchom** `.\gradlew.bat :core:test` — PASS.
- [ ] **Step 5: Commit** `git commit -m "p2p(android): Noise KK host with one-shot sessions"`

---

### Task 10: Lokalne zmiany telefonu (`PhoneVault`)

**Files:**
- Create: `p2p/PhoneVault.kt`
- Test: `p2p/PhoneVaultTest.kt`

**Interfaces:**
- Consumes: `SyncStore` (Task 8), `EntryV2`, `EntryDataV2`, `TombstoneDataV2` (Task 2), `HlcClock`, `Hlc` (Task 1); `Credentials` (v1).
- Produces:
  - `data class PhoneEntry(val id: String, val revision: Long, val credentials: Credentials, val hlc: Hlc)`
  - `class PhoneVault(store: SyncStore, vaultKey: ByteArray, deviceId: String, now: () -> Long = System::currentTimeMillis) { fun upsert(id: String, credentials: Credentials); fun delete(id: String); fun entries(): List<PhoneEntry>; fun unreadableIds(): List<String> }`

Telefon jest klientem własnego sejfu bez sieci (`SYNCHRONIZACJA_P2P.md` §3): zapis idzie prosto do
sklepu jako `RemoteRecord(id, currentRevision() + 1, deleted, blob)`. Zegar startuje jak
`clockForVault` w TS: `HlcClock(deviceId, now)` po `observe` największego HLC wśród czytelnych rekordów.
`upsert`/`delete` najpierw `observe` HLC nadpisywanej wersji, potem `tick()`. `delete` nieznanego `id`
nic nie robi; nagrobek zostaje w sklepie na stałe. Wszystkie metody pod `synchronized(store)`.
Rekord, którego nie da się odszyfrować albo sparsować, jest pomijany w `entries()` i zgłaszany w
`unreadableIds()`. `entries()` bez nagrobków, posortowane po `credentials.name`.

- [ ] **Step 1: Napisz testy** — `upsert` daje rekord z `revision = 1`, odszyfrowany `EntryDataV2` z `hlc.d == deviceId`; edycja wpisu, którego HLC ma `ms` o rok w przyszłości, dostaje większy HLC; `delete` zapisuje nagrobek z nową rewizją i wpis znika z `entries()`; `delete` nieznanego id nie zmienia `currentRevision`; nowy `PhoneVault` na tym samym sklepie kontynuuje zegar za największym HLC. Integracja z hostem: wpis z `upsert` wraca w `HostSync.process(... sinceRevision = 0)`, a zmiana przyjęta przez `process` od wtyczki (blob zaszyfrowany `EntryV2.encrypt`) pojawia się w `entries()`. Review Focus 1: dwa wątki po 200 `upsert` i trzeci wątek z 50 wywołaniami `HostSync.process` z nowymi wpisami → `currentRevision() == 200 + 200 + liczba przyjętych`, wszystkie rewizje różne. Review Focus 2: rekord ze śmieciowym blobem → pozostałe wpisy widoczne, jego id w `unreadableIds()`.
- [ ] **Step 2: Uruchom** — FAIL. **Step 3: Zaimplementuj.** **Step 4: Uruchom** `.\gradlew.bat :core:test` — PASS.
- [ ] **Step 5: Commit** `git commit -m "p2p(android): phone-side vault edits with HLC"`

---

### Task 11: Test współpracy z klientem TypeScript

**Files:**
- Create: `android/core/src/test/resources/p2p-interop.ts`, `p2p/P2pInteropTest.kt`
- Modify: `android/core/build.gradle.kts` (w `tasks.test` dopisać `environment("PASSHOLDER_INTEROP_TEST", System.getenv("PASSHOLDER_INTEROP_TEST") ?: "")`)

**Interfaces:**
- Consumes: `P2pHost`, `PhoneVault`, `MemorySyncStore`, `NoiseKeys`, `PairedDevice`, `EntryV2`; z TS: `emptyVaultV2`, `applyVaultInfo`, `clockForVault`, `upsertEntryV2`, `liveEntriesV2`, `syncVaultV2`, `noiseTransport`, `keyPairFromPrivateKey` z `${root}/core/src/index.ts` (przestrzeń `p2p`).
- Produces: skrypt `node --disable-warning=ExperimentalWarning --experimental-transform-types android/core/src/test/resources/p2p-interop.ts <repo-root> <base-url> <config.json>`; `config.json`: `{ deviceId, privateKey, phonePublicKey, vaultKey, epoch, count, startPrefix }` (klucze w hex). Skrypt: pusty sejf, `applyVaultInfo({epoch, addresses: []})`, `count` wpisów o nazwach `${startPrefix}-${i}` (pierwszy z hasłem `"zażółć 😀"`), `syncVaultV2` przez `noiseTransport` z `post` na `fetch`, ostatnia linia wyjścia: JSON `{ names: string[] /* posortowane */, epoch, addresses }`.

Test opcjonalny jak `RealServerTest`: `assumeTrue(System.getenv("PASSHOLDER_INTEROP_TEST") == "1")`.
Host na `MockWebServer` z `Dispatcher`, który woła `host.handle(request.path, request.body.readByteArray())`
i zwraca status oraz ciało JSON. Sposób uruchamiania `node` i przekazywania argumentów skopiuj z
`RealServerTest`.

- [ ] **Step 1: Napisz test** z dwoma scenariuszami:
  - **Mały:** telefon `PhoneVault.upsert("z-telefonu.pl")`; skrypt z `count = 1`, `startPrefix = "z-przegladarki"` → wyjście `names == ["z-przegladarki-0", "z-telefonu.pl"]`, `epoch` telefonu, `addresses` hosta; po stronie telefonu `entries()` zawiera `z-przegladarki-0` z hasłem `"zażółć 😀"` i `hlc.d == deviceId` wtyczki.
  - **Stronicowanie:** telefon ma 1300 wpisów, skrypt wysyła 1200 → po synchronizacji wtyczka zna 2500 nazw, telefon ma 2500 wpisów, a `Dispatcher` policzył co najmniej 3 żądania `/p2p/v1/sync` (więcej niż jedna strona w każdą stronę).
- [ ] **Step 2: Uruchom** w PowerShell (z `android/`): `fnm env --shell powershell | Out-String | Invoke-Expression; $env:PASSHOLDER_INTEROP_TEST="1"; .\gradlew.bat :core:test --tests "*P2pInteropTest*"` — Expected: najpierw FAIL (brak skryptu), po Step 3 PASS. Bez zmiennej test jest SKIPPED.
- [ ] **Step 3: Napisz skrypt** `p2p-interop.ts` i popraw do zielonego. Rozbieżność oznacza błąd w porcie Kotlinowym, nie w TS; **nie zmieniaj** `core/src/`.
- [ ] **Step 4: Uruchom** pełne `.\gradlew.bat :core:test` bez zmiennej — PASS (interop SKIPPED).
- [ ] **Step 5: Commit** `git commit -m "p2p(android): interop test against the TypeScript extension client"`

---

### Task 12: Dokumentacja

**Files:**
- Create: `docs/P2P_ANDROID_RDZEN.md`
- Modify: `docs/P2P_RDZEN.md` (pkt 6: odnośnik, że wersja Kotlin jest w planie 2 i zalecenie o Auto Backup przechodzi do planu 3), `docs/SYNCHRONIZACJA_P2P.md` (linia „Status”), `docs/TESTY.md` (jak uruchomić testy P2P w Kotlinie i test współpracy na Windows)

`P2P_ANDROID_RDZEN.md` po polsku, w stylu `P2P_RDZEN.md`: tabela plików Kotlin z odpowiednikami TS;
co **nie** zostało przeniesione i dlaczego (klient `syncVaultV2`, `noiseTransport`); różnice względem TS
(`handle` bierze surowe bajty ciała, błąd JSON → 400; `PhoneVault`; bezpieczeństwo wątków;
ristretto255 na `BigInteger` bez stałego czasu wykonania i co to oznacza dla jednorazowego skalara
CPace); jak uruchomić testy; znane ograniczenia; co dalej w planie 3 (trwały `SyncStore`, serwer HTTP,
endpointy parowania, Auto Backup).

- [ ] **Step 1: Napisz dokumenty.**
- [ ] **Step 2: Weryfikacja końcowa:** `.\gradlew.bat :core:test :app:testDebugUnitTest` w `android/` oraz `npm test && npm run typecheck` w katalogu głównym — PASS; test współpracy z `PASSHOLDER_INTEROP_TEST=1` — PASS.
- [ ] **Step 3: Commit** `git commit -m "Document the Kotlin P2P core"`
