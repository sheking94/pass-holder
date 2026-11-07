# PassHolder: specyfikacja (kryptografia i dane)

Ten dokument opisuje kryptografię i format danych wspólne dla wtyczki do Chrome (TypeScript) i aplikacji na
Androida (Kotlin). Implementacja referencyjna jest w `core/`, a `core/test-vectors/v1.json` (KDF, klucz
sejfu) i `v2.json` (wpisy, parowanie, Noise) zawierają wartości, które obie implementacje muszą odtworzyć
bit w bit. Synchronizację telefon–wtyczka opisuje [SYNCHRONIZACJA.md](SYNCHRONIZACJA.md).

## 1. Założenia

- Jeden użytkownik, jeden sejf.
- **Zero-knowledge transportu:** hasło główne i odszyfrowane wpisy nigdy nie opuszczają urządzeń, które
  znają hasło główne. Telefon jako host przechowuje i przekazuje tylko szyfrogramy; rozwiązywanie
  konfliktów odbywa się na urządzeniach.
- **Offline-first:** wtyczka i telefon działają w pełni bez połączenia i synchronizują się, gdy telefon
  jest w trybie Synchronizacja.
- Zakres: nazwa serwisu, login, hasło, generator haseł.

## 2. Klucze

```
hasło główne ──NFC, UTF-8──► Argon2id(salt, m, t, p) ──► masterKey (32 B)
masterKey ──HKDF-SHA256(info="passholder/v1/enc")──►  encKey  (32 B, nigdy nie opuszcza urządzenia)
masterKey ──HKDF-SHA256(info="passholder/v1/auth")──► authKey (32 B, nieużywany)
vaultKey  = 32 losowe bajty, utworzony raz przy zakładaniu sejfu
wrappedVaultKey = seal(encKey, vaultKey, aad="passholder/v1/vault-key")
```

- HKDF: pusty salt, długość 32.
- Argon2id domyślnie: `m = 65536 KiB (64 MiB)`, `t = 3`, `p = 4`, salt 16 losowych bajtów.
  Parametry, salt i `wrappedVaultKey` są jawne: telefon przekazuje je wtyczce przy parowaniu (a wtyczka
  telefonowi przy „Odtwórz z wtyczki”), żeby druga strona wyprowadziła ten sam klucz.
- Urządzenie odrzuca parametry słabsze niż `m = 19456`, `t = 2`, `p = 1`, żeby druga strona nie mogła
  wymusić słabego KDF, oraz większe niż `m = 1048576` (1 GiB), `t = 100`, `p = 64`, żeby nie mogła
  wyczerpać pamięci urządzenia. Każdy parametr musi być liczbą całkowitą.
- Hasło jest normalizowane do NFC przed kodowaniem UTF-8 (to samo „ż” wpisane na różnych klawiaturach
  daje te same bajty).
- **`authKey`** służył do logowania na serwerze Pi (serwer trzymał `SHA-256(authKey)`). Od planu 4 nikt go
  nie używa, ale nadal jest wyprowadzany: podział `masterKey` na dwa klucze to część formatu danych i jego
  zmiana dałaby inny `encKey`, czyli nieczytelne istniejące sejfy.
- Zmiana hasła głównego wymagałaby tylko ponownego zawinięcia vaultKey, bez przeszyfrowania wpisów (poza
  zakresem).

## 3. Format szyfrogramu

AES-256-GCM, nonce 12 losowych bajtów, tag 16 bajtów. Zapis jako standardowe Base64 z dopełnieniem:

```
blob = Base64( 0x01 || nonce[12] || ciphertext || tag[16] )
```

Bajt `0x01` to wersja formatu. AAD (dane uwierzytelniane, nieszyfrowane):

| Co | AAD |
|----|-----|
| zawinięty vaultKey | `passholder/v1/vault-key` |
| wpis o identyfikatorze `id` | `passholder/v2/entry/<id>` |
| lokalny sejf wtyczki, klucz statyczny wtyczki | `passholder/v2/local-vault`, `passholder/v2/ext-static-key` ([SYNCHRONIZACJA.md](SYNCHRONIZACJA.md#73-dane-w-chromestorage)) |
| klucze zawinięte PIN-em we wtyczce | `passholder/v1/pin-lock` ([FUNKCJE.md](FUNKCJE.md#pin-we-wtyczce)) |

AAD z `id` wiąże szyfrogram z wpisem, więc host nie może podmienić treści między wpisami.

## 4. Wpisy

- `id`: UUID v4 nadawany przez urządzenie, które tworzy wpis.
- Treść żywego wpisu (JSON, szyfrowany vaultKey):
  `{"name": "...", "username": "...", "password": "...", "hlc": {"ms": …, "c": …, "d": "<deviceId>"}}`
- Usunięty wpis to „nagrobek”: `deleted = true` jawnie dla hosta, a w szyfrogramie tylko `{"hlc": …}`.
  Nagrobki zostają na telefonie, żeby usunięcie dotarło do każdej wtyczki.
- Flaga `deleted` jest jawna. Odbiorca sprawdza tylko, czy treść pasuje do flagi: przy `deleted = true`
  musi mieć poprawne pole `hlc`, przy `deleted = false` pola `name`, `username`, `password` i `hlc`
  (`parseTombstoneDataV2` / `parseEntryDataV2` w `core/src/p2p/entry.ts`, `EntryV2.kt`). Inne pola nagrobka
  nie są odrzucane: rekordy pochodzą od sparowanego urządzenia, które zna hasło główne, a kanał Noise KK
  je uwierzytelnia.
- Wpis, który nigdy nie trafił na telefon, wtyczka kasuje lokalnie.
- HLC (hybrydowy zegar logiczny) jest wewnątrz szyfrogramu, więc host nie zna czasów zmian. Konflikty
  rozstrzyga większy HLC: [SYNCHRONIZACJA.md](SYNCHRONIZACJA.md#43-konflikty-hlc).

## 5. Synchronizacja

Protokół (parowanie CPace, Noise KK, `POST /p2p/v1/*` na porcie 8787 telefonu, numery `revision`, epoka,
adresy) opisuje [SYNCHRONIZACJA.md](SYNCHRONIZACJA.md).

## 6. Generator haseł

- Grupy znaków: małe litery, wielkie litery, cyfry, symbole `!@#$%^&*()-_=+[]{};:,.<>?/~`.
- Długość 4–128, domyślnie 20, wszystkie grupy.
- Co najmniej jeden znak z każdej wybranej grupy, reszta z sumy grup, potem tasowanie Fishera-Yatesa.
- Losowanie z CSPRNG z odrzucaniem (bez przewagi żadnego znaku).

## 7. Funkcje urządzeń

Automatyczna blokada, PIN, odcisk palca, CSV, strona w karcie i czyszczenie schowka działają tylko na
urządzeniu i nie zmieniają formatu danych ani protokołu: [FUNKCJE.md](FUNKCJE.md).

## 8. Poza zakresem

Zmiana hasła głównego, wiele kont, współdzielenie, TOTP, autouzupełnianie, synchronizacja wtyczka–wtyczka
bez telefonu. Sejf telefonu odtwarza się z wtyczki („Odtwórz z wtyczki”), a import CSV pozwala wgrać wpisy
do nowego sejfu ([INSTALACJA.md](INSTALACJA.md#kopia-zapasowa)).
