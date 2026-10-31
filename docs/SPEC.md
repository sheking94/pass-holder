# PassHolder: specyfikacja v1

Ten dokument jest źródłem prawdy dla wszystkich części systemu: serwera na Raspberry Pi (TypeScript),
wtyczki do Chrome (TypeScript) i aplikacji na Androida (Kotlin). Implementacja referencyjna jest w `core/`,
a `core/test-vectors/v1.json` zawiera wartości, które każdy klient musi odtworzyć bit w bit.

## 1. Założenia

- Jeden użytkownik, jeden sejf.
- **Zero-knowledge:** serwer nigdy nie widzi hasła głównego ani odszyfrowanych wpisów. Szyfrowanie i
  rozwiązywanie konfliktów odbywa się na urządzeniach.
- **Offline-first:** Raspberry Pi jest zwykle wyłączone. Klienci działają w pełni bez serwera i
  synchronizują się, gdy serwer jest dostępny. Serwer to tylko punkt wymiany.
- Zakres v1: nazwa serwisu, login, hasło, generator haseł.

## 2. Klucze

```
hasło główne ──NFC, UTF-8──► Argon2id(salt, m, t, p) ──► masterKey (32 B)
masterKey ──HKDF-SHA256(info="passholder/v1/enc")──►  encKey  (32 B, nigdy nie opuszcza urządzenia)
masterKey ──HKDF-SHA256(info="passholder/v1/auth")──► authKey (32 B, wysyłany do serwera przy logowaniu)
serwer przechowuje authHash = SHA-256(authKey)
vaultKey  = 32 losowe bajty, utworzony raz przy zakładaniu sejfu
wrappedVaultKey = seal(encKey, vaultKey, aad="passholder/v1/vault-key")
```

- HKDF: pusty salt, długość 32.
- Argon2id domyślnie: `m = 65536 KiB (64 MiB)`, `t = 3`, `p = 4`, salt 16 losowych bajtów.
  Parametry i salt są jawne i leżą na serwerze, żeby nowe urządzenie mogło wyprowadzić te same klucze.
- Klient odrzuca parametry słabsze niż `m = 19456`, `t = 2`, `p = 1`, żeby złośliwy serwer nie mógł
  wymusić słabego KDF.
- Hasło jest normalizowane do NFC przed kodowaniem UTF-8 (to samo „ż” wpisane na różnych klawiaturach
  daje te same bajty).
- Dlaczego dwa klucze z jednego: serwer może sprawdzić, że znasz hasło (authKey), ale nie może z tego
  odszyfrować sejfu (encKey jest niezależny dzięki HKDF). Zmiana hasła głównego wymaga tylko ponownego
  zawinięcia vaultKey, bez przeszyfrowania wpisów (poza zakresem v1).

## 3. Format szyfrogramu

AES-256-GCM, nonce 12 losowych bajtów, tag 16 bajtów. Zapis jako standardowe Base64 z dopełnieniem:

```
blob = Base64( 0x01 || nonce[12] || ciphertext || tag[16] )
```

Bajt `0x01` to wersja formatu. AAD (dane uwierzytelniane, nieszyfrowane):

| Co | AAD |
|----|-----|
| zawinięty vaultKey | `passholder/v1/vault-key` |
| wpis o identyfikatorze `id` | `passholder/v1/entry/<id>` |

AAD z `id` wiąże szyfrogram z wpisem, więc serwer nie może podmienić treści między wpisami.

## 4. Wpisy

- `id`: UUID v4 nadawany przez urządzenie, które tworzy wpis.
- Treść żywego wpisu (JSON, szyfrowany vaultKey):
  `{"name": "...", "username": "...", "password": "...", "modifiedAt": <ms od epoki>}`
- Usunięty wpis to „nagrobek”: `deleted = true` jawnie dla serwera, a w szyfrogramie tylko
  `{"modifiedAt": <ms>}`. Nagrobki zostają na serwerze, żeby usunięcie dotarło do każdego urządzenia.
- Wpis, który nigdy nie trafił na serwer, jest po prostu kasowany lokalnie.
- `modifiedAt` jest wewnątrz szyfrogramu, więc serwer nie zna czasów zmian.

## 5. Synchronizacja

Serwer ma jeden licznik `revision`, rosnący przy każdej zaakceptowanej zmianie. Każdy rekord na serwerze to
`{id, revision, deleted, blob}`. Klient pamięta `lastSyncRevision` i dla każdego wpisu ostatnio znaną
`revision` oraz flagę `dirty` (zmieniony lokalnie od ostatniej synchronizacji).

`POST /api/v1/sync`

```json
// żądanie
{ "sinceRevision": 12,
  "changes": [ { "id": "…", "baseRevision": 7, "deleted": false, "blob": "…" } ] }
// odpowiedź
{ "currentRevision": 15,
  "accepted":  [ { "id": "…", "revision": 13 } ],
  "conflicts": [ { "id": "…", "revision": 14, "deleted": false, "blob": "…" } ],
  "changes":   [ { "id": "…", "revision": 15, "deleted": true,  "blob": "…" } ] }
```

Serwer (w jednej transakcji):
1. Dla każdej zmiany: jeśli bieżąca `revision` rekordu (0 gdy brak) równa się `baseRevision`, zapisuje go z
   nową `revision` i dodaje do `accepted`. W przeciwnym razie zwraca swoją wersję w `conflicts`.
   `baseRevision ≠ 0` dla nieznanego `id` to błąd 400.
2. `changes` = rekordy z `revision > sinceRevision`, z pominięciem `id` z tego żądania.

Klient:
1. Wysyła wszystkie wpisy `dirty`.
2. Dla `accepted` ustawia nową `revision`, `dirty = false`.
3. Dla `conflicts` i `changes` odszyfrowuje wersję z serwera. Jeśli lokalny wpis jest `dirty` i ma
   większe `modifiedAt`, wygrywa lokalny (przyjmuje `revision` serwera i zostaje `dirty`). W każdym innym
   przypadku, także przy remisie, wygrywa wersja z serwera.
4. Ustawia `lastSyncRevision = currentRevision`.
5. Jeśli jakiś lokalny wpis wygrał konflikt, powtarza synchronizację (maksymalnie 3 rundy).

Reguła „ostatni zapis wygrywa” opiera się na zegarach urządzeń. Przy jednym użytkowniku i ręcznej
synchronizacji to rozsądny kompromis; rozjechany zegar może sprawić, że wygra starsza zmiana.

## 6. API serwera (wdrożenie w kroku 2)

Wszystko przez HTTPS. Odpowiedzi JSON, binaria jako Base64.

| Metoda i ścieżka | Autoryzacja | Opis |
|---|---|---|
| `GET /api/v1/status` | brak | `{ "initialized": bool, "version": "1" }` |
| `POST /api/v1/setup` | jednorazowy `setupToken` | `{ setupToken, kdf, authKey, wrappedVaultKey }`; działa tylko gdy sejf nie istnieje |
| `GET /api/v1/prelogin` | brak | `{ kdf }` |
| `POST /api/v1/session` | `authKey` | `{ authKey }` → `{ token, expiresAt, wrappedVaultKey }` |
| `POST /api/v1/sync` | `Authorization: Bearer <token>` | patrz sekcja 5 |

- `setupToken` serwer wypisuje w konsoli przy pierwszym uruchomieniu, żeby nikt inny w sieci nie
  założył sejfu przed Tobą.
- Serwer porównuje `SHA-256(authKey)` z `authHash` w stałym czasie. Token sesji: 32 losowe bajty,
  ważny 15 minut, trzymany tylko w pamięci serwera.
- Limit prób logowania (np. 5 na minutę), bo endpoint jest dostępny w sieci.

## 7. Sieć i transport

- Serwer nasłuchuje na HTTPS z własnym certyfikatem (lokalne CA lub samopodpisany).
- Android: przypięcie odcisku SHA-256 certyfikatu podanego przy parowaniu.
- Chrome: wtyczka nie może przypiąć certyfikatu, więc certyfikat (lub lokalne CA) trzeba dodać do
  zaufanych w systemie albo w Chrome.
- Poza domem: VPN (WireGuard lub Tailscale) z jedną komendą do włączania i wyłączania. Bez VPN serwer
  jest osiągalny tylko w sieci lokalnej.
- Treść wpisów jest szyfrowana end-to-end niezależnie od TLS; TLS chroni authKey i token sesji.

## 8. Generator haseł

- Grupy znaków: małe litery, wielkie litery, cyfry, symbole `!@#$%^&*()-_=+[]{};:,.<>?/~`.
- Długość 4–128, domyślnie 20, wszystkie grupy.
- Co najmniej jeden znak z każdej wybranej grupy, reszta z sumy grup, potem tasowanie Fishera-Yatesa.
- Losowanie z CSPRNG z odrzucaniem (bez przewagi żadnego znaku).

## 9. Poza zakresem v1

Zmiana hasła głównego, wiele kont, współdzielenie, TOTP, autouzupełnianie, eksport/import.
