# Funkcje wtyczki i aplikacji

Funkcje działające tylko na urządzeniu: nie zmieniają formatu danych ani protokołu synchronizacji. Dla
każdej: jak działa, gdzie jest kod, ograniczenia. Na początku: [typy wpisów](#typy-wpisów-wtyczka-i-telefon).

Spis: [Automatyczna blokada](#automatyczna-blokada) · [PIN we wtyczce](#pin-we-wtyczce) ·
[Import i eksport](#import-i-eksport) · [Otwórz w karcie](#otwórz-w-karcie) ·
[Odcisk palca i blokada po wyjściu (Android)](#odcisk-palca-i-blokada-po-wyjściu-android) ·
[Czyszczenie schowka](#czyszczenie-schowka) · [Autouzupełnianie](#autouzupełnianie)

## Typy wpisów (wtyczka i telefon)

Sejf używa formatu wpisu v3 ([SPEC.md](SPEC.md) punkt 4). Wtyczka i telefon pokazują i edytują wszystkie pięć
typów; reguły (opis wiersza, pola wrażliwe, formaty, zapis) są wspólne, różni się układ ekranów.

### Wtyczka

- **Zakładki** nad listą, w jednym rzędzie (ikona + podpis, 360 px bez przewijania w poziomie): 🔑 Loginy
  (startowa), 👤 Kontakty, 💳 Karty, 📝 Notatki, 🪪 Dokumenty. „+ Dodaj” dodaje wpis typu otwartej zakładki.
  Po zapisie, anulowaniu i usunięciu lista wraca na zakładkę typu wpisu.
- **Wiersz:** ikona, nazwa i opis: login → `username`; karta → `•••• ` + 4 ostatnie znaki numeru bez spacji; dokument →
  rodzaj (Dowód osobisty, Paszport, Prawo jazdy, Legitymacja, Inny); kontakt → pierwszy telefon; notatka →
  pierwsza niepusta linia. Kliknięcie wiersza otwiera formularz (bez podglądu); login ma też „Login” i „Hasło”.
- **Wyszukiwanie** w obrębie zakładki: podciąg nazwy i opisu, bez rozróżniania wielkości liter. Zmiana
  zakładki czyści frazę.
- **Formularz:** Nazwa, pola typu (listy z „+ Dodaj” i „Usuń”), Notatka (w notatce „Treść”), Własne pola
  (etykieta, wartość, „ukryte”). Generator haseł przy haśle loginu jak dotąd. Aplikacje Androida wpisuje się
  ręcznie (nazwa pakietu, np. `com.example.app`).
- **Pola wrażliwe** (hasło, TOTP, numer karty, CVC, PIN, własne pola „ukryte”): zakryte, „Pokaż/Ukryj” i
  „Kopiuj”; kopia czyści schowek po minucie ([Czyszczenie schowka](#czyszczenie-schowka)). Kopia jawnego pola
  nie czyści schowka. Zaznaczenie „ukryte” zakrywa pole od razu.
- **Formaty:** daty `RRRR-MM-DD` (prawdziwa data), ważność karty `MM/RR`; puste wolno. Sprawdzane jest tylko
  pole zmienione w formularzu, więc wpis z innym zapisem (z telefonu, z importu) da się otworzyć i zapisać.
  Błędy: „Podaj nazwę”, „Podaj albo wygeneruj hasło”, „<Pole>: wpisz datę RRRR-MM-DD”, „Ważność: wpisz
  MM/RR”, „Aplikacje Androida: zła nazwa pakietu <x>”, „Wpis jest za duży” (blob > 64 KiB), „Ten wpis ma
  inny typ”.
- **Zapis:** tekst bez zmian (przycinana tylko nazwa); puste elementy list i puste własne pola są pomijane.
  Pola, których formularz nie zna, zostają; typu wpisu nie da się zmienić.
- **Import i eksport obejmują wszystkie typy** ([Import i eksport](#import-i-eksport)).
- **Obie aplikacje trzeba zaktualizować razem.** Stara wtyczka dostaje od nowego telefonu 410 i pokazuje
  ogólny błąd synchronizacji; nowa wtyczka ze starym telefonem pokazuje „Zaktualizuj aplikację na telefonie”
  ([SYNCHRONIZACJA.md](SYNCHRONIZACJA.md#41-transport-noise-kk)).
- Stare bloby v2 są czytane jako loginy. Na telefonie zostają v2, dopóki wpis nie zostanie edytowany; we wtyczce
  cały lokalny sejf jest przy odblokowaniu w pamięci zamieniany na v3 i zapisywany jako v3 przy najbliższym
  zapisie dowolnego rodzaju, a po zmianie epoki (`adoptEpoch`) wpisy idą na telefon ponownie jako v3.

Kod: `extension/src/entry-types.ts` (zakładki, opis wiersza, `tidyContent`, `validateContent`),
`views/list.ts`, `views/edit.ts`, `views/forms/*.ts`, `ui/dom.ts` (`secretField`), `ui/list-editor.ts`,
`ui/copy.ts`; `VaultStore.listEntries`, `getEntry`, `putEntry`.

### Telefon (Android)

- **Górny pasek:** „Synchronizacja” i menu ⋮ „Więcej” (Urządzenia, Ustawienia, Zablokuj). **Ustawienia**: przełączniki
  odcisku palca i opóźnienia blokady po wyjściu z aplikacji ([opis](#odcisk-palca-i-blokada-po-wyjściu-android)).
- **Dolny pasek** z pięcioma zakładkami jak we wtyczce (🔑 Loginy startowa, 👤 Kontakty, 💳 Karty, 📝 Notatki,
  🪪 Dokumenty). Każda zakładka ma własne wyszukiwanie, czyszczone przy zmianie zakładki; „+ Dodaj” dodaje wpis
  typu otwartej zakładki. Wiersz: ikona, nazwa, opis; login zachowuje „Login” i „Hasło”.
- **Formularz** jak we wtyczce (Nazwa, pola typu, Notatka/Treść, Własne pola z „ukryte”). Pola wrażliwe: zakryte,
  „Pokaż/Ukryj” i „Kopiuj”; kopia czyści schowek po minucie, status „Skopiowano PIN. Schowek zostanie wyczyszczony
  za 1 min.”. Błędy i formaty jak we wtyczce; „Ten wpis ma inny typ” gdy `id` należy do żywego wpisu innego typu.
- **Aplikacje Androida** (login): „+ Wybierz aplikację” otwiera „Wybierz aplikację” z wyszukiwaniem (wiersz „nazwa · pakiet”);
  „+ Wpisz pakiet” pozwala wpisać nazwę ręcznie. Lista zawiera tylko aplikacje z ikoną w launcherze (`<queries>`
  MAIN + LAUNCHER, bez `QUERY_ALL_PACKAGES`), więc usług bez ikony brak: te wpisuje się ręcznie.
- **Stare wpisy** i wpisy dodane we wtyczce są widoczne od razu; zapis zachowuje pola, których formularz nie zna.
- Stan formularza jest tylko w pamięci (nie w stanie zapisanym przez system); blokada zamyka formularz i Ustawienia,
  a po odblokowaniu lista jest na zakładce Loginy.

Kod: `app/entries/EntryTypes.kt` (typy, opisy, wyszukiwanie, `tidy`, walidacja), `ui/ListScreen.kt`,
`ui/VaultTopBar.kt`, `ui/SettingsScreen.kt`, `ui/EditScreen.kt`, `ui/forms/*`, `InstalledApps.kt`;
`PhoneVault.entries()`, `upsertContent`.

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

## Import i eksport

Wszystkie pięć typów wpisów, w trzech formatach. Lista → **Plik** otwiera kartę `?transfer` (okno wyboru pliku
zamknęłoby okienko).

- **Eksport:** wybierz format (PassHolder JSON, Bitwarden JSON, NordPass CSV), zaznacz „Rozumiem, plik będzie
  zawierał hasła jawnym tekstem” → **Pobierz plik** (`<format>-RRRR-MM-DD.json` albo `.csv`). Wpisy posortowane po
  nazwie (`localeCompare` „pl”), przy równej nazwie w kolejności login, kontakt, karta, notatka, dokument.
- **Import:** wybierz plik → **Importuj**. Format rozpoznaje się z treści pliku (JSON z `"format":"passholder"` →
  PassHolder; JSON z `items` → Bitwarden; plik niebędący JSON-em → NordPass CSV; inny JSON → błąd). Podsumowanie mówi, ile dodano, ile pominięto i dlaczego
  (z numerem wpisu albo wiersza). Wpisy są zmianami lokalnymi (•); na telefon trafiają po **Synchronizuj**.

| Format | Import | Eksport |
|---|---|---|
| PassHolder JSON `{"format":"passholder","version":3,"entries":[…]}` | wszystko, bez strat; wpis ze złym typem albo nieznanym kluczem pominięty z numerem | wpisy `{type,name,note,fields,custom}` (bez `v`, `hlc`) |
| Bitwarden JSON | typy 1–4; plik zaszyfrowany (`"encrypted": true`, także chroniony hasłem, bez `items`) → komunikat o zaszyfrowanym eksporcie, nic nie wchodzi | wszystkie typy |
| NordPass CSV | typ z kolumny `type` (`password`, `note`, `credit_card`, `identity`), a bez niej po kolumnach | ze stratą: nadmiar do `note` |

**Bitwarden:** login (adresy `androidapp://<pakiet>` → aplikacje), notatka, karta (`expMonth`/`expYear` →
`MM/RR`), tożsamość → kontakt. Tożsamość z własnym polem „Rodzaj dokumentu” wraca jako dokument. Bez odpowiednika:
własne pola („Marka karty”, „Tytuł”, „Drugie imię”, „Firma”, „Numer SSN”, …). Eksport: dokument → tożsamość, PIN
karty, dalsze telefony, e-maile i adresy → własne pola. Pełne mapowania i etykiety:
[spec typów wpisów](superpowers/specs/2026-11-07-typy-wpisow-design.md) punkt 6.

**NordPass:** nagłówek `name,url,username,password,note,cardholdername,cardnumber,cvc,expirydate,zipcode,folder,
full_name,phone_number,email,address1,address2,city,country,state,totp,shared_folder`; kolumny po nazwie, w dowolnej
kolejności, brakujące traktowane jak puste. Pusta `name` przy `url` → host bez `www.`. Eksport pierwsze wartości
wpisuje w kolumny, resztę w `note` jako linie `etykieta: wartość`. (Listę kolumn wzięto z importera NordPass w
Bitwardenie; prawdziwego pliku NordPass nie sprawdzono.)

**Duplikaty:** wpis jest duplikatem, gdy jego cała treść (typ, nazwa, notatka, pola, własne pola) jest identyczna z
wpisem w sejfie albo wcześniejszym w pliku, po przycięciu spacji na brzegach każdego tekstu. Ten sam plik
zaimportowany drugi raz: 0 dodanych. Wpis usunięty nie liczy się. Wpis powyżej 64 KiB po zaszyfrowaniu jest
pomijany jako „za duży”. Sejf zapisuje się raz, po całym imporcie. Pusty plik, uszkodzony JSON i nierozpoznany
format dają błąd po polsku, a sejf zostaje bez zmian. Parser nie sprawdza formatu dat ani `expiry`.

**Parser CSV** (`parseCsv`, RFC 4180): cudzysłowy z przecinkami, nowymi liniami i `""`, CRLF/LF, BOM usuwany,
puste linie pomijane, niezamknięty cudzysłów → „Plik CSV jest uszkodzony”. Eksport bierze pole w cudzysłów
przy przecinku, cudzysłowie, nowej linii albo spacji na brzegu.

**Bezpieczeństwo:** eksport to jedyne miejsce, gdzie hasła opuszczają sejf jawnie. Celowo **brak** ochrony
przed formułami arkusza (`'` przed `=`, `+`, `-`, `@`), bo zepsułaby hasła; nie otwieraj pliku w Excelu.
Usuń plik po użyciu.

**Ograniczenia:** foldery, ulubione, historia haseł i daty z innych menedżerów giną; Bitwarden tylko bez
szyfrowania.

### Android

Menu ⋮ → **Import i eksport** (po „Ustawienia”). Te same trzy formaty, te same reguły mapowania, duplikatów i
sortowania co we wtyczce; pliki przez systemowy wybór pliku (bez uprawnień do pamięci).

- **Import:** **Importuj plik** → wybór pliku, format rozpoznawany z treści. Plik ponad **10 MiB** →
  „Plik jest za duży (limit 10 MiB)”; plik niebędący UTF-8 (np. Windows-1250 z Excela) → „Plik nie jest zapisany w
  UTF-8”. Podsumowanie jak we wtyczce („Dodano N wpisów (zsynchronizuj, żeby trafiły do wtyczki).”, w NordPass
  „wiersze”); nowe wpisy są lokalne do następnej synchronizacji. Import jest atomowy (jeden zapis `putAll`).
- **Eksport:** wybór formatu, ostrzeżenie, „Rozumiem…”, **Zapisz plik** (nieaktywny do zaznaczenia zgody) →
  wybór miejsca; nazwa `passholder-RRRR-MM-DD.json` (NordPass `.csv`). Po zapisie: „Zapisano plik. Usuń go zaraz
  po użyciu, zawiera hasła jawnym tekstem.”
- **Okno wyboru pliku (60 s):** wybór pliku wyprowadza z aplikacji, więc zwykła blokada po wyjściu zablokowałaby
  sejf w trakcie. Przy otwieraniu wyboru blokada po pierwszym wyjściu czeka 60 s, nawet gdy opóźnienie jest
  wyłączone; po powrocie po ponad 60 s sejf jest zablokowany („Zablokowano: wybór pliku trwał ponad 60 s”).
  Kolejne wyjście blokuje już według ustawienia.
- **Sortowanie eksportu:** `Collator` JDK „pl” z dodatkowymi regułami (spacja i interpunkcja przed cyframi, jak w
  ICU). Zgodny z wektorem `sort.json`; znane różnice: apostrof i znaki sterujące są pomijane przy porównaniu,
  `$`, emoji, pełna szerokość, `æ œ ß Ø` mogą wypaść inaczej niż w przeglądarce. Różni się tylko kolejność wpisów w
  pliku.

Zrzut: `android/app/screenshots/50-import-eksport.png`.

Kod: `core/src/transfer/` (parsery i eksport, czyste funkcje), `VaultStore.importContents` i `allContents`,
`import-summary.ts`, `views/transfer.ts`; Android: `core/transfer/*.kt`, `PhoneVault.importContents`,
`ImportSummary.kt`, `TransferFiles.kt`, `ui/TransferScreen.kt`.

## Otwórz w karcie

Chrome zamyka okienko wtyczki, gdy traci fokus, i wpisany formularz przepada. Przycisk **Otwórz w karcie ↗**
(ekrany: blokada, lista, edycja wpisu) otwiera tę samą stronę jako `popup.html?tab` w zwykłej karcie.

- Jeśli karta PassHolder jest już otwarta, przycisk przełącza na nią. W karcie przycisku nie ma.
- Odblokowany sejf zostaje odblokowany: klucze są w `chrome.storage.session`, wspólnym dla okienka i kart.
- To, co już wpisałeś w okienku, nie przechodzi do karty: kliknij przycisk przed pisaniem.

**Tryby strony** (`page-mode.ts`): `popup`, `tab` (karta z przycisku), `setup` (parowanie), `addresses`,
`transfer` (import i eksport). `isMainTab` to `tab` albo `setup`; tylko na nie przełącza przycisk. `showInTab(tryb,
widok)` (`ui/page.ts`) pokazuje widok od razu w karcie albo otwiera kartę i zamyka okienko.

`open-in-tab.ts`: `chrome.runtime.getContexts({contextTypes: ["TAB"]})` znajduje karty wtyczki bez
uprawnienia `tabs` (Chrome 116+), `chrome.tabs.update` + `chrome.windows.update` przełączają, a
`chrome.tabs.create` otwiera nową.

## Odcisk palca i blokada po wyjściu (Android)

### Co widzi użytkownik

- Przełącznik **„Odblokowanie odciskiem palca”** w **Ustawieniach** (menu ⋮ „Więcej”; bez czytnika go nie ma; bez zapisanego
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

## Autouzupełnianie

Chrome: wtyczka wpisuje login, kartę albo adres w pola otwartej strony. Android dojdzie w następnym kroku.

- **Pasujące do tej strony:** na zakładce Loginy okienko pokazuje u góry sekcję „Pasujące do tej strony” z
  loginami dla adresu otwartej karty (dokładny host przed subdomenami, w grupie po nazwie). Przycisk
  **Wypełnij** wpisuje login i hasło. Adres wpisu `http` pasuje do strony `http` i `https`, adres `https` tylko
  do `https`; `www.`, port i schemat są brane pod uwagę, `localhost` i adresy IP tylko dokładnie.
- **Karta i kontakt:** wiersz na zakładce Karty i Kontakty ma **Wypełnij** (tylko w okienku, nie w karcie
  PassHolder). Karta: tylko na stronach `https` (i `localhost`); kontakt: imię, nazwisko, e-mail, telefon,
  pierwszy adres i data urodzenia. Ważność karty dzielona na miesiąc i rok zależnie od pól i opcji `<select>`.
- **Skrót** `Ctrl+Shift+L` (Mac: `Command+Shift+L`): przy dokładnie jednym pasującym loginie wypełnia od razu,
  przy zerze lub kilku (albo zablokowanym sejfie) otwiera okienko. Zmiana skrótu: `chrome://extensions/shortcuts`.
- **Jak wpisuje:** pola rozpoznaje po `autocomplete`, typie, nazwie, etykiecie i placeholderze (polskie i
  angielskie słowa); wpisuje przez setter prototypu i wysyła `input` oraz `change`, więc działa z React/Vue. Pomija
  pola ukryte, wyłączone, tylko do odczytu i `type=hidden`; pusta wartość nie nadpisuje pola; `new-password`
  (rejestracja) zostaje puste. Logowanie dwuetapowe: bez hasła na stronie wypełnia pierwsze pole loginu/e-mail.
- **Komunikaty:** „Nie znaleziono pól logowania”, „Nie znaleziono pól karty (mogą być w ramce operatora
  płatności), skopiuj dane ręcznie”, „Nie znaleziono pól adresu”; ponadto zablokowany sejf, strona niepasująca do
  loginu, karta na stronie bez https i strona, na której Chrome nie pozwala wstrzykiwać skryptów (np. `chrome://`).

**Bezpieczeństwo:**

- Uprawnienia tylko `activeTab` i `scripting`: bez `host_permissions` i bez skryptów w manifeście. Skrypt
  `autofill-content.js` jest wstrzykiwany dopiero przy wypełnianiu, w czynnej karcie.
- Do strony trafia tylko plan wypełnienia (`FillPlan`: pola jednego wpisu), nigdy klucze ani inne wpisy.
- Service worker sam sprawdza stronę (adres pobrany z karty przez `tabs.get`, `matchLogins` dla loginu, https dla
  karty) i przyjmuje komunikat tylko od stron PassHolder (`sender.id`). Okienku nie ufa.
- Wypełniane są tylko ramki z tym samym origin co górna ramka, a origin sprawdzonej strony jest przypięty przy
  wstrzyknięciu (po nawigacji karty nic się nie wpisze). Ramki płatnicze z innego origin zostają puste.

Kod: `core/src/autofill/` (`match.ts`, `fields.ts`, `keywords.ts`, `values.ts`), `extension/src/autofill/`
(`fill-page.ts`, `fill-tab.ts`), `autofill-content.ts`, `background.ts` (komunikat `fill`, polecenie `fill-login`),
`ui/active-tab.ts`, `views/list.ts`. Wymaga Chrome 127 lub nowszego.
