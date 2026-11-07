# Funkcje wtyczki i aplikacji

Funkcje działające tylko na urządzeniu: nie zmieniają formatu danych ani protokołu synchronizacji. Dla
każdej: jak działa, gdzie jest kod, ograniczenia.

Spis: [Automatyczna blokada](#automatyczna-blokada) · [PIN we wtyczce](#pin-we-wtyczce) ·
[Import i eksport CSV](#import-i-eksport-csv) · [Otwórz w karcie](#otwórz-w-karcie) ·
[Odcisk palca i blokada po wyjściu (Android)](#odcisk-palca-i-blokada-po-wyjściu-android) ·
[Czyszczenie schowka](#czyszczenie-schowka)

## Automatyczna blokada

Obie części blokują sejf po **15 minutach** bez aktywności. Niezapisany formularz wpisu przepada.

**Wtyczka** (`extension/src/auto-lock.ts`), dwa niezależne strażniki:

1. Każda otwarta strona (okienko albo karta) uruchamia `watchIdle()`: co 15 s oraz przy `visibilitychange`
   i `focus` woła `VaultStore.lockIfIdle()`. Kliknięcie i klawisz przesuwają termin (`noteActivity()`, zapis
   najwyżej co 30 s).
2. Service worker (`background.ts`) ustawia alarm `auto-lock` na termin `unlockedUntil` i po nim usuwa
   klucze z `chrome.storage.session`, nawet gdy żadna strona nie jest otwarta.

Po terminie `requireVault()` / `requireKeys()` odmawiają każdej akcji, zanim strona zdąży się zablokować.
Strony dzielą termin przez `storage.session`, więc blokada w jednej blokuje wszystkie.

**Android:** `LockController.checkIdle()` co 15 s; blokada po wyjściu z aplikacji opisana niżej.

## PIN we wtyczce

PIN to skrót zamiast hasła głównego, **tylko w tej jednej przeglądarce**. Hasło główne działa zawsze.

- Włączanie: przycisk **PIN** na liście (przy odblokowanym sejfie). PIN to 4-6 cyfr.
- Po **5 błędnych PIN-ach z rzędu** PIN jest kasowany i trzeba podać hasło główne.
- Domyślnie PIN jest tylko w pamięci (`chrome.storage.session`): po zamknięciu Chrome albo przeładowaniu
  wtyczki trzeba raz podać hasło główne.
- **„Pamiętaj PIN po zamknięciu przeglądarki”** zapisuje go na dysku (`chrome.storage.local`). Ten tryb
  wymaga **długiego PIN-u**: co najmniej 8 znaków i nie same cyfry. Stary krótki PIN zapisany na dysku jest
  po udanym odblokowaniu przenoszony do pamięci.

**Kryptografia** (`extension/src/pin-lock.ts`):

```
salt    = 16 losowych bajtów (własna sól PIN-u)
pinKey  = Argon2id(PIN, salt, 64 MiB, 3 iteracje, 4 wątki)
wrapped = AES-256-GCM(pinKey, JSON {vaultKey}, AAD = "passholder/v1/pin-lock")
PinLock = { kdf, wrappedKeys: wrapped, failedAttempts }
```

Zły PIN daje inny klucz, więc tag GCM się nie zgadza (`WrongPinError`). Wtyczka nigdy nie zapisuje hasła
głównego, tylko klucz sejfu.

**Przechowywanie** (`pin-store.ts`, `PinStore`): `PinLock` leży albo w `session`, albo w `local`, nigdy w
obu. `unlock(pin)` odrzuca zły format bez liczenia próby, a licznik zapisuje **przed** sprawdzeniem PIN-u
(Argon2id trwa ok. 1 s; zamknięcie okienka w trakcie nie daje darmowej próby). Udane hasło główne zeruje
licznik. Parowanie przeglądarki (`pairFinish`) i odłączenie kasują PIN; `repair` (inny telefon) go
zostawia, bo klucz sejfu jest ten sam.

**Słabość krótkiego PIN-u (uczciwie):**

- Limit 5 prób chroni tylko przed zgadywaniem przez okienko wtyczki.
- Kto zdobędzie `PinLock` (sól + `wrappedKeys`), sprawdza PIN-y u siebie bez limitu. Szacunek (nie
  mierzony): minuty dla 4 cyfr, godziny dla 6 cyfr.
- Wtyczka jest „rozpakowana” (tryb dewelopera), więc ktoś przy odblokowanym koncie systemowym może odczytać
  `chrome.storage` narzędziami deweloperskimi.
- Dlatego PIN na dysku musi być długi, a dysk powinien być zaszyfrowany (BitLocker). Prawdziwy limit prób
  wymagałby sprzętu (TPM), do którego wtyczka nie ma dostępu.

Widoki: `views/locked.ts` (`pinLockedView`), `views/pin-settings.ts`.

## Import i eksport CSV

Format CSV NordPass. Lista → **CSV** otwiera kartę `?transfer` (okno wyboru pliku zamknęłoby okienko).

- **Eksport:** zaznacz „Rozumiem, plik będzie zawierał hasła jawnym tekstem” → **Pobierz plik CSV**
  (`passholder-RRRR-MM-DD.csv`). Wypełnia `name`, `username`, `password`, `type=password`; reszta kolumn
  pusta. UTF-8, CRLF.
- **Import:** wybierz plik → **Importuj**. Podsumowanie mówi, ile dodano, ile pominięto i dlaczego.
  Wpisy są zmianami lokalnymi (•); na telefon trafiają po **Synchronizuj**.

Nagłówek (kolejność jak w NordPass):

```
name,url,additional_urls,username,password,note,cardholdername,cardnumber,cvc,expirydate,zipcode,folder,full_name,phone_number,email,address1,address2,city,country,state,type,custom_fields
```

**Zasady importu** (`parseNordPassCsv`):

- Kolumny są szukane po nazwie, w dowolnej kolejności. Wymagane: `password` oraz `name` albo `url`.
  (Listę kolumn wzięto z importera NordPass w Bitwardenie; prawdziwego pliku NordPass nie sprawdzono.)
- `type` = `password` albo brak kolumny → import; inne typy (notatki, karty) → pominięte.
- Pusta `name`, ale jest `url` → nazwa to host bez `www.`.
- Duplikat (ta sama nazwa, login i hasło w sejfie albo w pliku) → pominięty. Inne hasło → nowy wpis.
- Sejf jest zapisywany raz, po całym imporcie.

**Parser** (`parseCsv`, RFC 4180): cudzysłowy z przecinkami, nowymi liniami i `""`, CRLF/LF, BOM usuwany,
puste linie pomijane, niezamknięty cudzysłów → „Plik CSV jest uszkodzony”. Eksport bierze pole w cudzysłów
przy przecinku, cudzysłowie, nowej linii albo spacji na brzegu.

**Bezpieczeństwo:** eksport to jedyne miejsce, gdzie hasła opuszczają sejf jawnie. Celowo **brak** ochrony
przed formułami arkusza (`'` przed `=`, `+`, `-`, `@`), bo zepsułaby hasła; nie otwieraj pliku w Excelu.
Usuń plik po użyciu.

**Ograniczenia:** przenoszone tylko nazwa, login i hasło (adres, notatki, foldery giną); jeden format; brak
importu na Androidzie.

Kod: `extension/src/csv-transfer.ts`, `VaultStore.importEntries`, `views/transfer.ts`.

## Otwórz w karcie

Chrome zamyka okienko wtyczki, gdy traci fokus, i wpisany formularz przepada. Przycisk **Otwórz w karcie ↗**
(ekrany: blokada, lista, edycja wpisu) otwiera tę samą stronę jako `popup.html?tab` w zwykłej karcie.

- Jeśli karta PassHolder jest już otwarta, przycisk przełącza na nią. W karcie przycisku nie ma.
- Odblokowany sejf zostaje odblokowany: klucze są w `chrome.storage.session`, wspólnym dla okienka i kart.
- To, co już wpisałeś w okienku, nie przechodzi do karty: kliknij przycisk przed pisaniem.

**Tryby strony** (`page-mode.ts`): `popup`, `tab` (karta z przycisku), `setup` (parowanie), `addresses`,
`transfer` (CSV). `isMainTab` to `tab` albo `setup`; tylko na nie przełącza przycisk. `showInTab(tryb,
widok)` (`ui/page.ts`) pokazuje widok od razu w karcie albo otwiera kartę i zamyka okienko.

`open-in-tab.ts`: `chrome.runtime.getContexts({contextTypes: ["TAB"]})` znajduje karty wtyczki bez
uprawnienia `tabs` (Chrome 116+), `chrome.tabs.update` + `chrome.windows.update` przełączają, a
`chrome.tabs.create` otwiera nową.

## Odcisk palca i blokada po wyjściu (Android)

### Co widzi użytkownik

- Przełącznik **„Odblokowanie odciskiem palca”** na liście wpisów (bez czytnika go nie ma; bez zapisanego
  odcisku jest wyszarzony).
- Okno odcisku otwiera się samo przy każdym otwarciu aplikacji i po blokadzie po 15 min. Po ręcznym
  „Zablokuj” trzeba nacisnąć przycisk „Odblokuj odciskiem palca”. Hasło główne działa zawsze.
- **Sejf blokuje się po wyjściu z aplikacji** (Home, lista aplikacji, wyłączenie ekranu, Wstecz),
  domyślnie **60 s** po wyjściu. Przełącznik **„Blokuj dopiero po 60 s poza aplikacją”** wyłącza
  opóźnienie. Obrót ekranu nie blokuje.
- „Usuń sejf z telefonu” wyłącza też odcisk.

Zrzuty (z testów): `android/app/screenshots/13-odcisk-wylaczony.png` … `19-opoznienie-wylaczone.png`.

### Blokada po wyjściu

Klucze sejfu trzyma `PhoneVaultStore`, który należy do procesu (`PassHolderApp`), a nie do ekranu. Proces
żyje po zamknięciu aktywności, więc blokadę trzeba wywołać jawnie:

```
MainActivity.onStop()  (nie przy obrocie ekranu)
  → LockController.onLeftApp()
      offerFingerprint = true, timesLeftApp += 1
      opóźnienie włączone → LeaveLock.schedule(60 s)
      opóźnienie wyłączone → lockNow()
lockNow(): trwa operacja → zablokuj po jej końcu; inaczej PhoneVaultStore.lock()
MainActivity.onStart() → LockController.onReturn()
      LeaveLock.cancel(): minęło 60 s? → lockNow()
  → LockedScreen: LaunchedEffect(timesLeftApp) → okno odcisku, gdy aktywność jest RESUMED
```

- `LeaveLock` odlicza `SystemClock.elapsedRealtime` (liczy też w uśpieniu). Gdy system zamrozi minutnik,
  sprawdzenie przy powrocie i tak zablokuje sejf przed pokazaniem wpisu.
- Operacja na sejfie (np. Argon2id) trzyma blokadę `@Synchronized`, więc `lock()` na głównym wątku
  zamroziłby aplikację; zamiast tego `lockWaitsForOperation` blokuje sejf zaraz po końcu operacji.
- Ustawienie: `SharedPreferences "settings"`, klucz `lockDelay` (domyślnie `true`).
- Koszt: przez 60 s klucze zostają w pamięci; po blokadzie niezapisany formularz przepada.

### Kryptografia

Hasło główne nie jest nigdzie zapisywane. Zapisywany jest klucz sejfu (32 B), zaszyfrowany kluczem z
Android Keystore:

```
Włączanie: Keystore: AES-256-GCM "passholder-biometric-unlock"
           (silna biometria przy każdym użyciu, unieważniany po dodaniu odcisku)
           okno odcisku → AES-GCM(klucz sejfu) → SharedPreferences "biometric": iv + data
Odblokowanie: okno odcisku → odszyfruj data → PhoneVaultStore.unlockWithKeys
              (porównanie z keyCheck w stałym czasie; zły klucz = odmowa)
```

- Klucz Keystore nie opuszcza Keystore (TEE/StrongBox); kopia plików aplikacji nic nie daje.
- Każde użycie wymaga palca (`setUserAuthenticationRequired(true)` bez okna czasowego), tylko
  `BIOMETRIC_STRONG`.
- Nowy odcisk w telefonie unieważnia klucz (`KeyPermanentlyInvalidatedException`): aplikacja kasuje dane i
  prosi o hasło główne.
- Słabe punkty: odcisk jest tak silny jak zabezpieczenie telefonu (można zmusić do przyłożenia palca);
  root albo Keystore bez sprzętu osłabia ochronę.

Kod (`android/app/.../app/`): `BiometricUnlock.kt` (Keystore, zapis, okno systemowe), `BiometricController.kt`,
`LockController.kt`, `LeaveLock.kt`, `ui/FingerprintDialog.kt`, `ui/LockedScreen.kt`, `ui/ListScreen.kt`;
`PhoneVaultStore.exportUnlockKeys()` / `unlockWithKeys()`.

**Nie sprawdzono na prawdziwym telefonie** w testach automatycznych (Robolectric nie ma Keystore ani
czytnika). Do ręcznego sprawdzenia: włączenie, odblokowanie, Home i powrót przed i po 60 s, wyłączenie
ekranu, obrót, dodanie nowego odcisku.

## Czyszczenie schowka

Skopiowane hasło znika ze schowka po minucie.

- Wtyczka: alarm w service workerze i dokument offscreen (`clipboard.ts`, `background.ts`, `offscreen.ts`).
- Android: WorkManager (`SecureClipboard.kt`).
