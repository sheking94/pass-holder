# Wtyczka Chrome: logowanie PIN-em

> Uwaga (2026-11-01, poprawka S4 z [przeglądu bezpieczeństwa](PRZEGLAD_BEZPIECZENSTWA.md)): PIN zapisywany
> na dysku („Pamiętaj PIN po zamknięciu przeglądarki”) musi być **długi**: co najmniej 8 znaków i nie same
> cyfry. Krótki PIN 4-6 cyfr działa tylko w trybie „w pamięci”. Krótki PIN zapisany na dysku przez starszą
> wersję po pierwszym udanym odblokowaniu jest przenoszony do pamięci. Szczegóły w
> [POPRAWKI_BEZPIECZENSTWA.md](POPRAWKI_BEZPIECZENSTWA.md), punkt S4.

Dokument opisuje funkcję z gałęzi `claude/project-thread-qagvkj`: odblokowanie sejfu we wtyczce
PIN-em z 4-6 cyfr zamiast hasła głównego.

## 1. Jak to działa w skrócie

- PIN **nie zastępuje** hasła głównego. Hasło główne dalej działa zawsze, PIN jest tylko skrótem.
- PIN działa **tylko lokalnie, w tej jednej przeglądarce**. Serwer nic o nim nie wie, Android też nie.
- PIN włącza się przyciskiem **PIN** na liście wpisów, czyli dopiero po dodaniu (lub połączeniu) sejfu
  i odblokowaniu go hasłem głównym.
- Po **5 błędnych PIN-ach z rzędu** PIN jest kasowany i trzeba podać hasło główne.
- Domyślnie PIN jest trzymany **tylko w pamięci przeglądarki**: po zamknięciu Chrome trzeba raz podać
  hasło główne. Opcja **„Pamiętaj PIN po zamknięciu przeglądarki”** zapisuje go na dysku (słabsza ochrona,
  patrz punkt 4).

## 2. Kryptografia

Po odblokowaniu hasłem głównym wtyczka ma w pamięci dwa klucze (`SessionKeys` w `vault-store.ts`):

- `vaultKey`: szyfruje i odszyfrowuje wpisy,
- `authKey`: loguje do serwera przy synchronizacji.

Włączenie PIN-u (`createPinLock` w `extension/src/pin-lock.ts`) robi tak:

```
salt     = 16 losowych bajtów (nowa sól, niezwiązana z solą hasła głównego)
pinKey   = Argon2id(PIN, salt, 64 MiB, 3 iteracje, 4 wątki)   ← te same parametry co hasło główne
wrapped  = AES-256-GCM(pinKey, JSON {vaultKey, authKey}, AAD = "passholder/v1/pin-lock")
PinLock  = { kdf: {alg, salt, memoryKiB, iterations, parallelism}, wrappedKeys: wrapped, failedAttempts: 0 }
```

Odblokowanie PIN-em (`openPinLock`) liczy `pinKey` z wpisanego PIN-u i soli z `PinLock`, a potem
odszyfrowuje `wrappedKeys`. Zły PIN daje inny klucz, tag GCM się nie zgadza i `open` rzuca wyjątek,
który zamieniamy na `WrongPinError`. Z odzyskanych kluczy wtyczka startuje sesję tak samo, jak po haśle
głównym, więc działa też synchronizacja.

Dlaczego owijamy oba klucze, a nie samo hasło główne? Hasła głównego wtyczka nigdy nie zapisuje. Klucze
wystarczą do wszystkiego, co wtyczka robi, a hasło główne mogłoby się przydać atakującemu także na
innych urządzeniach.

## 3. Pliki i zmiany

### `extension/src/pin-lock.ts` (nowy)

| Element | Co robi |
|---|---|
| `PIN_PATTERN`, `isValidPin` | PIN to 4-6 cyfr (`/^\d{4,6}$/`). |
| `MAX_PIN_ATTEMPTS = 5` | Ile błędnych prób z rzędu, zanim PIN zostanie skasowany. |
| `PinLock` | Co jest zapisane w `chrome.storage`: parametry Argon2id, zaszyfrowane klucze, licznik błędów. |
| `createPinLock(pin, keys)` | Tworzy `PinLock` (opis w punkcie 2). |
| `openPinLock(pin, lock)` | Zwraca `{vaultKey, authKey}` albo rzuca `WrongPinError`. |

### `extension/src/pin-store.ts` i `extension/src/vault-store.ts`

Od PR #16 przechowywaniem PIN-u zajmuje się klasa `PinStore` (`pin-store.ts`); `VaultStore` tworzy ją w
konstruktorze i tylko deleguje.

- `STORAGE_KEYS.pinLock = "pinLock"` (`storage.ts`). `PinLock` leży **albo** w `chrome.storage.session`
  (domyślnie), **albo** w `chrome.storage.local` (opcja „Pamiętaj PIN…”), nigdy w obu naraz.
- `VaultStore.enablePin(pin, rememberAfterRestart)`: sprawdza kształt PIN-u, wymaga odblokowanego sejfu i woła
  `PinStore.enable`, który tworzy `PinLock` z bieżących kluczy, kasuje poprzedni PIN i zapisuje nowy we
  właściwym miejscu. PIN pamiętany po restarcie musi być długi (co najmniej 8 znaków, nie same cyfry,
  `isLongPin`, poprawka S4, zob. [POPRAWKI_BEZPIECZENSTWA.md](POPRAWKI_BEZPIECZENSTWA.md)).
- `VaultStore.unlockWithPin(pin)` → `PinStore.unlock(pin)`:
  1. odrzuca PIN w złym formacie **bez liczenia próby** (to literówka, nie zgadywanie),
  2. zwiększa `failedAttempts` i zapisuje go **przed** sprawdzeniem PIN-u. Argon2id trwa ok. sekundy;
     gdyby licznik był zapisywany dopiero po złym wyniku, zamknięcie okienka w trakcie liczenia dawałoby
     darmową próbę,
  3. przy dobrym PIN-ie zeruje licznik i startuje sesję; stary krótki PIN zapisany na dysku (sprzed S4)
     przenosi przy tym do pamięci (`movedToMemory`),
  4. przy złym PIN-ie zgłasza „Pozostało prób: N”, a po piątej próbie kasuje `PinLock`.
- `pinStatus()` → `PinStore.status()`: `undefined`, gdy PIN jest wyłączony, w przeciwnym razie gdzie jest
  zapisany i ile prób zostało.
- `disablePin()` → `PinStore.disable()`: usuwa `PinLock` z obu miejsc.
- `unlock(hasłoGłówne)` po sukcesie zeruje licznik błędnych PIN-ów (`PinStore.resetAttempts`).
- `createVault`, `connectExisting` i `disconnect` kasują PIN, żeby PIN od poprzedniego konta nie został.

### Widoki (`extension/src/views/locked.ts`, `extension/src/views/pin-settings.ts`)

- `showLocked()`: gdy PIN jest włączony, pokazuje ekran PIN-u (`pinLockedView`), w przeciwnym razie ekran
  hasła głównego (`lockedView`). Wołane przy starcie, po kliknięciu **Zablokuj** i po automatycznej blokadzie.
- `pinLockedView`: pole PIN (klawiatura numeryczna, maks. 6 znaków; dłuższe pole dla długiego PIN-u),
  **Odblokuj**, **Użyj hasła głównego**. Po ostatniej błędnej próbie przechodzi sam na ekran hasła głównego
  z komunikatem. Ma też przycisk **Otwórz w karcie**, a w karcie importu/eksportu CSV po odblokowaniu wraca
  do niej (`showUnlocked`, tak jak ekran hasła głównego).
- `pinSettingsView` (przycisk **PIN** na liście) wybiera `pinSetupView()` (PIN wyłączony: formularz PIN +
  powtórzenie + opcja „Pamiętaj PIN po zamknięciu przeglądarki” z ostrzeżeniem) albo
  `pinEnabledView(status)` (informacja i **Wyłącz PIN**).
- Komunikat po połączeniu z serwerem podpowiada, gdzie włączyć PIN.

### `extension/static/popup.css`

Dwie klasy: `label.check` (pole wyboru z opisem w jednej linii) i `.hint` (szary, mniejszy tekst).

## 4. Słabość krótkiego PIN-u (uczciwie)

PIN z 4 cyfr ma 10 000 możliwości, z 6 cyfr milion. To bardzo mało w porównaniu z hasłem głównym.

**Pewne:**

- Limit 5 prób chroni tylko przed kimś, kto zgaduje **przez okienko wtyczki**. Szansa trafienia w 5 próbach
  to 0,05% dla 4 cyfr i 0,0005% dla 6 cyfr.
- Kto zdobędzie sam `PinLock` (sól + `wrappedKeys`), może sprawdzać PIN-y **u siebie, bez limitu prób**:
  liczy Argon2id dla każdego PIN-u i patrzy, czy tag GCM się zgadza. Licznik `failedAttempts` go nie
  dotyczy, bo leży obok i można go po prostu pominąć.
- Wtyczka jest zainstalowana jako „rozpakowana”, więc w Chrome jest włączony tryb dewelopera. Ktoś,
  kto siedzi przy Twoim odblokowanym koncie systemowym, może przez narzędzia deweloperskie wtyczki
  odczytać `chrome.storage` (w tym `PinLock`) albo wyzerować licznik.

**Szacunki (nie mierzyłem, rząd wielkości):** Argon2id z 64 MiB i 3 iteracjami w natywnej implementacji
na zwykłym wielordzeniowym komputerze to kilkanaście do kilkudziesięciu prób na sekundę. Daje to
**minuty** na wszystkie PIN-y 4-cyfrowe i **godziny** (do ok. doby) na 6-cyfrowe. Karta graficzna niewiele
pomaga, bo Argon2id wymaga dużo pamięci na każdą próbę.

**Co z tego wynika:**

- **Domyślny tryb (PIN tylko w pamięci)**: `chrome.storage.session` Chrome trzyma w pamięci, nie na dysku.
  Kradzież dysku, laptopa po wyłączeniu albo kopii profilu Chrome nie daje `PinLock`. Po zamknięciu
  przeglądarki PIN znika i trzeba podać hasło główne. To ten sam kompromis, który stosują popularne
  menedżery haseł („wymagaj hasła głównego po ponownym uruchomieniu”).
- **„Pamiętaj PIN po zamknięciu przeglądarki”**: `PinLock` leży w profilu Chrome na dysku. Kto skopiuje
  profil (kopia zapasowa, skradziony dysk bez szyfrowania), ten w minuty-godziny odgadnie PIN i otworzy
  sejf **bez znajomości hasła głównego**. Włączaj to tylko, jeśli dysk jest zaszyfrowany (np. LUKS na Ubuntu).
  **Od poprawki S4** ten tryb wymaga długiego PIN-u (8+ znaków, nie same cyfry), co zamienia minuty-godziny
  na lata (patrz POPRAWKI_BEZPIECZENSTWA.md).
- Dłuższy PIN (6 cyfr) jest 100 razy trudniejszy do odgadnięcia niż 4-cyfrowy.

**Czego nie zrobiłem i dlaczego:** prawdziwy limit prób wymaga kogoś, kto pilnuje licznika i nie da się
go obejść: serwera (ale Pi jest zwykle wyłączone, a wtyczka ma działać offline) albo sprzętowego modułu
(TPM, klucz sprzętowy), do którego wtyczka Chrome nie ma dostępu. Klucz WebCrypto „nieeksportowalny”
w IndexedDB też leży w profilu na dysku, więc nie poprawiłby sytuacji w istotny sposób.

## 5. Testy

`extension/test/pin.test.ts` (z prawdziwym serwerem w pamięci, jak pozostałe testy wtyczki):

| Test | Co sprawdza |
|---|---|
| unlocks with the PIN… | PIN odblokowuje sejf offline, a odzyskany `authKey` pozwala zsynchronizować. |
| counts wrong PINs… | „Pozostało prób: 4…1”, po piątej próbie PIN skasowany, hasło główne działa. |
| resets the counter… | Dobry PIN i hasło główne zerują licznik. |
| does not count input… | Zły format nie zużywa prób; `enablePin` odrzuca 8 cyfr. |
| forgets a session PIN… | Po „restarcie” (pusta pamięć sesji) PIN w pamięci znika, zapamiętany działa. |
| keeps only encrypted keys… | `PinLock` ma tylko `kdf`, `wrappedKeys`, `failedAttempts`, własną sól; znika po wyłączeniu i odłączeniu. |
| needs an unlocked vault… | Nie da się włączyć PIN-u przy zablokowanym sejfie. |

Uruchomienie: `cd extension && npx vitest run test/pin.test.ts`. Każda próba PIN-u to jedno Argon2id
(ok. 1 s w czystym JavaScripcie), więc test z limitem prób trwa kilka-kilkanaście sekund.

## 6. Ręczne sprawdzenie w Chrome

1. `npm run build -w extension`, w `chrome://extensions` kliknij odświeżenie wtyczki.
2. Odblokuj sejf hasłem głównym, kliknij **PIN**, wpisz np. `4821` dwa razy, **Włącz PIN**.
3. **Zablokuj**: pojawia się ekran PIN-u. Wpisz zły PIN: „Pozostało prób: 4”. Wpisz dobry: lista wpisów.
4. Zamknij całą przeglądarkę i otwórz ponownie: wtyczka prosi o hasło główne (PIN był tylko w pamięci).
5. Pięć złych PIN-ów z rzędu: wtyczka przechodzi na hasło główne, PIN jest wyłączony.

Uwaga: Chrome czyści `chrome.storage.session` także przy przeładowaniu lub aktualizacji wtyczki, więc po
każdym `npm run build` i odświeżeniu w `chrome://extensions` PIN w trybie „tylko w pamięci” trzeba włączyć ponownie.
