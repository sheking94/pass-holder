# Funkcje wtyczki i aplikacji

Funkcje działające tylko na urządzeniu: nie zmieniają formatu danych ani protokołu synchronizacji. Dla
każdej: jak działa, gdzie jest kod, ograniczenia. Na początku: [typy wpisów](#typy-wpisów-wtyczka-i-telefon).

Spis: [Automatyczna blokada](#automatyczna-blokada) · [PIN we wtyczce](#pin-we-wtyczce) ·
[Import i eksport](#import-i-eksport) · [Otwórz w karcie](#otwórz-w-karcie) ·
[Odcisk palca i blokada po wyjściu (Android)](#odcisk-palca-i-blokada-po-wyjściu-android) ·
[Czyszczenie schowka](#czyszczenie-schowka) · [Autouzupełnianie](#autouzupełnianie) ·
[Pytanie o zapis](#pytanie-o-zapis)

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
- **Załączniki** (każdy typ wpisu, sekcja „Pliki” formularza; opis w SPEC punkt 4):
  - **Dodawanie:** „+ Dodaj plik” wybiera plik, który jest szyfrowany od razu, ale zapisuje się dopiero z wpisem
    („Zapisz”); „Anuluj” nie zostawia nic. Ten sam plik wybrany dwa razy to dwa niezależne załączniki. „Usuń” zdejmuje
    plik z formularza.
  - **Limity** (z rdzenia, `MAX_FILE_SIZE`, `MAX_ATTACHMENTS_PER_ENTRY`): plik do 10 MB, najwyżej 20 we wpisie.
    Błędy: „Plik jest za duży (limit 10 MB)”, „Najwyżej 20 plików we wpisie”, „Plik jest pusty”,
    „Nieprawidłowa nazwa pliku”. Rozmiar na ekranie: „N KB” poniżej 1 MiB, wyżej „4,6 MB”.
  - **Okienko i karta:** okienko zamyka się przy wyborze pliku, więc „+ Dodaj plik” w okienku najpierw pyta: „Formularz
    otworzy się w karcie. Niezapisane zmiany z tego okna przepadną – najpierw zapisz wpis, jeśli coś zmieniłeś.”
    („Otwórz w karcie” / „Anuluj”) i otwiera ten sam formularz w karcie (`?edit&type=<typ>&id=<id>`).
  - **Pobieranie:** „Pobierz” pokazuje ostrzeżenie „Pobierasz plik, który zostanie odszyfrowany i będzie dostępny na tym
    urządzeniu.” („Pobierz” / „Anuluj”); dopiero po nim plik jest odszyfrowywany i zapisywany. Treść jawna nie trafia
    nigdzie indziej (ani do IndexedDB, ani do `chrome.storage`).
  - **Stany:** „czeka na synchronizację” (pliku nie ma jeszcze lokalnie albo nie został wysłany), „Plik jest
    uszkodzony”; takiego pliku nie da się pobrać. Wiersz listy pokazuje „📎 N”.
  - Edycja loginu przez pytanie o zapis zachowuje załączniki. Synchronizacja plików: [SYNCHRONIZACJA.md](SYNCHRONIZACJA.md#75-pliki-we-wtyczce-vault-storets-filesidb-file-storets).
- **Import i eksport obejmują wszystkie typy** ([Import i eksport](#import-i-eksport)); pliki wpisów nie są eksportowane.
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
  **Załączniki wpisów nie są eksportowane:** gdy sejf je ma, ekran eksportu pisze np. „2 pliki nie zostaną
  wyeksportowane (eksport z plikami będzie w kolejnej wersji).” (`transfer.countAttachments`; odmiana `filesNoun`:
  1 plik, 2–4 pliki, 5+ plików). Import też ich nie przenosi, a wpis różniący się tylko plikami jest duplikatem.
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
  sprawdzenie przy powrocie i tak zablokuje sejf przed pokazaniem wpisu. Usługa autouzupełniania sprawdza ten
  sam termin (`LeaveLock.expired()`) przed podpowiedziami: po 60 s blokuje sejf i pokazuje „Odblokuj PassHolder”.
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

Chrome: wtyczka wpisuje login, kartę albo adres w pola otwartej strony. Android: telefon podpowiada wpisy z
sejfu w polach innych aplikacji i przeglądarek ([niżej](#android-1)).

### Chrome

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
  (rejestracja) zostaje puste. Pomija też pola niewidoczne (`opacity: 0`, zerowy rozmiar, poza ekranem). Formularz z dokładnie jednym widocznym polem hasła dostaje login i hasło; w przeciwnym razie (logowanie dwuetapowe, ale też rejestracja z dwoma polami hasła) wypełniane jest tylko pierwsze widoczne pole loginu, a gdy go nie ma, pierwsze pole e-mail.
- **Komunikaty:** „Nie znaleziono pól logowania”, „Nie znaleziono pól karty (mogą być w ramce operatora
  płatności), skopiuj dane ręcznie”, „Nie znaleziono pól adresu”; ponadto zablokowany sejf, strona niepasująca do
  loginu, karta na stronie bez https i strona, na której Chrome nie pozwala wstrzykiwać skryptów (np. `chrome://`).

**Bezpieczeństwo:**

- Nowe uprawnienia to tylko `activeTab` i `scripting`: bez `host_permissions` i bez skryptów w manifeście (istniejące opcjonalne `optional_host_permissions` `http://*/*` służy połączeniu z telefonem, nie autouzupełnianiu). Skrypt
  `autofill-content.js` jest wstrzykiwany dopiero przy wypełnianiu, w czynnej karcie.
- Do strony trafia tylko plan wypełnienia (`FillPlan`: pola jednego wpisu), nigdy klucze ani inne wpisy.
- Service worker sam sprawdza stronę (adres pobrany z karty przez `tabs.get`, `matchLogins` dla loginu, https dla
  karty) i przyjmuje komunikat tylko z kontekstów tego rozszerzenia (`sender.id`: jego strony i wstrzyknięty skrypt; to nie dowodzi, że nadawcą jest okienko). Okienku nie ufa.
- Wypełniane są tylko ramki z tym samym origin co górna ramka, a origin sprawdzonej strony jest przypięty przy
  wstrzyknięciu (po nawigacji karty nic się nie wpisze). Ramki płatnicze z innego origin zostają puste.

Kod: `core/src/autofill/` (`match.ts`, `fields.ts`, `keywords.ts`, `values.ts`), `extension/src/autofill/`
(`fill-page.ts`, `fill-tab.ts`), `autofill-content.ts`, `background.ts` (komunikat `fill`, polecenie `fill-login`),
`ui/active-tab.ts`, `views/list.ts`. Wymaga Chrome 127 lub nowszego.

### Android

PassHolder jest systemową usługą autouzupełniania (Android 8+). Włączenie: **Ustawienia** → wiersz
**Autouzupełnianie** („Włączone”/„Wyłączone”) → **Włącz** otwiera systemowy wybór usługi
([INSTALACJA.md](INSTALACJA.md#24-autouzupełnianie)).

- **Podpowiedzi:** pod polem lista (nazwa wpisu i opis: login, `•••• 1234`, imię i nazwisko), najwyżej 10. Na
  Androidzie 11+ z klawiaturą, która to obsługuje (np. Gboard), te same podpowiedzi także w pasku klawiatury.
  Wybór wpisuje wszystkie pola formularza naraz.
- **Co pasuje:** loginy w aplikacji – te z pakietem aplikacji na liście „Aplikacje” wpisu (po nazwie); w
  zaufanej przeglądarce (Chrome, Firefox, Edge, Brave, Samsung Internet, Opera, DuckDuckGo, Vivaldi i ich
  odmiany) – po adresie strony, te same reguły co we wtyczce. Domenę strony podaną przez inną aplikację (np. jej
  WebView) PassHolder pomija, więc obca aplikacja nie dostanie loginu banku. Karty i kontakty: wszystkie, w
  kolejności listy; kartę przeglądarka dostaje tylko na `https` (i `localhost`).
- **Rodzaj formularza:** pola rozpoznawane jak we wtyczce (`autofillHints`, `autocomplete` z HTML, typ pola,
  identyfikator, podpowiedź, opis; polskie i angielskie słowa). Pole loginu lub hasła → loginy; samo pole
  e-mail (pierwszy krok logowania, np. Google) → też loginy; pola karty → karty; pozostałe pola adresu → kontakty.
  Formularz rejestracji z samym polem `new-password` nie dostaje nic; z polem e-mail i `new-password` pole e-mail
  dostaje loginy (jak wyżej), pole nowego hasła nic. Wpis bez żadnej wartości dla pól jest pomijany.
- **Zablokowany sejf:** jedna podpowiedź **Odblokuj PassHolder** → ekran z hasłem głównym i
  **Odblokuj odciskiem palca** (okno odcisku otwiera się samo) → od razu podpowiedzi dla tego samego formularza.
  Potem sejf znów się blokuje: po 60 s albo od razu, zależnie od „Blokuj dopiero po 60 s poza aplikacją”.
  **Anuluj** albo Wstecz: nic się nie wypełnia, sejf zostaje zablokowany (także gdy odblokowanie już trwało).
- Bez sejfu na telefonie i w samym PassHolderze usługa nic nie podpowiada. Zapisywanie nowych haseł:
  [Pytanie o zapis, Android](#android-2).

**Bezpieczeństwo:**

- Usługę wywołuje tylko system (`BIND_AUTOFILL_SERVICE`); ekran odblokowania nie jest dostępny dla innych
  aplikacji (`exported="false"`) i ma blokadę zrzutów ekranu (`FLAG_SECURE`).
- Usługa nie trzyma wpisów ani kluczy: wpisy są odszyfrowywane przy każdym żądaniu, tylko do budowy odpowiedzi.
- Aplikacja widzi tylko wartości wybranego wpisu, i to dopiero po wyborze podpowiedzi.

Kod: `android/core/.../core/autofill/` (`Keywords.kt`, `Fields.kt`, `Values.kt`, `Match.kt`, `Planner.kt`; port
`core/src/autofill/` plus `matchApp` i `planDatasets`), `android/app/.../app/autofill/` (`ViewNodeReader.kt`,
`ResponseBuilder.kt`, `PassHolderAutofillService.kt`, `AutofillUnlockActivity.kt`), `ui/AutofillUnlockScreen.kt`,
`AutofillStatus.kt`, `ui/SettingsScreen.kt`.

## Pytanie o zapis

Po zalogowaniu wtyczka (Chrome) albo telefon (Android) pyta, czy zapisać nowy login albo zaktualizować hasło
istniejącego. Tylko loginy.

### Chrome

- **Włączenie:** przycisk **Zapis** na liście (obok „PIN”) → **Pytaj o zapis haseł**. Chrome prosi o dostęp do
  wszystkich stron (`https://*/*` i `http://*/*`); odmowa zostawia przełącznik wyłączony. Domyślnie wyłączone.
  Przełącznik to samo uprawnienie `https://*/*` (bez osobnej flagi): odebranie go w `chrome://extensions` też
  wyłącza pytanie. Wyłączenie zabiera uprawnienie; `http://*/*` zostaje, gdy któryś adres telefonu jest `http`.
- **Kiedy pyta:** po wysłaniu formularza z widocznym, niepustym polem hasła (submit, Enter w polu hasła, klik
  przycisku w tym samym formularzu albo kontenerze), także formularza z danymi kontaktowymi i hasłem oraz z
  samym polem „nowe hasło”. Hasło: pole „nowe hasło” (rejestracja, zmiana hasła), inaczej
  hasło; login: pole loginu, inaczej e-mail przed hasłem. Pyta, gdy nie ma wpisu z tym loginem (**Zapisz**) albo
  jest z innym hasłem (nagłówek „Zmiana hasła: <wpis>”, **Zapisz** zmienia tylko hasło); to samo hasło: cisza. Login porównywany bez
  wielkości liter i spacji na brzegach. Decyzja liczona jest od nowa przy każdym pytaniu i odpowiedzi.
- **Co się zapisuje:** nazwa i adres to sama domena (`github.com`, bez `www.` i ścieżki); strona `http` →
  `http://domena`, port niestandardowy zostaje.
- **Panel (podgląd z edycją):** w prawym górnym rogu strony; nagłówek na żywo: „Nowy login”, „Zmiana hasła:
  <wpis>” albo „Ten login jest już zapisany”. Pola **Nazwa** (tylko nowy login; puste = domena), **Login**,
  **Hasło** (Pokaż/Ukryj, bez Kopiuj), „Strona: <host>”. Przyciski **Zapisz** (nieaktywny bez hasła i gdy login już jest),
  **Nie teraz** (×: to samo), **Nigdy dla tej strony**. Zmiana loginu albo hasła przelicza decyzję (nowy /
  zmiana hasła / już jest); zmiana hasła zmienia tylko hasło. Po zapisie „Zapisano” i panel znika po 2 s. Kandydat (login i hasło)
  żyje w pamięci sesji Chrome do 2 minut albo do decyzji, jeden na kartę, i panel wraca po przeładowaniu
  strony (przekierowania po logowaniu).
- **„Nigdy”:** host trafia na listę w **Zapis** → „Nigdy dla tych stron” (**Usuń** przywraca pytanie).
- **Zablokowany sejf:** panel nie ma pól ani hasła, tylko host, login i **Odblokuj i zapisz** → otwiera
  okienko; po odblokowaniu (hasło albo PIN) okienko najpierw pokazuje ten sam podgląd z bieżącej karty, potem pokazuje listę. Czytanie sejfu na potrzeby pytania nie
  przedłuża automatycznej blokady.
- **Złe hasło:** gdy po wysłaniu strona (ten sam origin) znów pokazuje ten sam pusty formularz logowania,
  panel się nie pokazuje; kandydat czeka na następne wysłanie.

**Ograniczenia:**

- Karty otwarte przed włączeniem wymagają przeładowania.
- Logowanie w ramce z innym origin niż strona nie jest zgłaszane.
- Złe hasło bez przeładowania strony (SPA) i tak pokazuje panel.
- Lista „Nigdy” jest jawna w `chrome.storage.local` (działa przy zablokowanym sejfie): kto ma dostęp do profilu
  Chrome, zobaczy te hosty.

**Bezpieczeństwo:**

- Skrypt `save-watch.js` widzi pola formularzy na wszystkich stronach, dlatego uprawnienie jest opcjonalne i
  domyślnie wyłączone. Wysyła do tła tylko login, hasło i podpis formularza, bez adresu.
- Service worker bierze adres z `sender.url` (ramka, która wysłała), sprawdza, że ma ten sam origin co karta, i
  przyjmuje wiadomości tylko od własnych skryptów (`sender.id`); pytania i odpowiedzi tylko ze stron wtyczki.
  Strona nie podszyje się pod inną domenę.
- Panel to strona wtyczki w `<iframe>` w zamkniętym Shadow DOM (inny origin: strona nie czyta jego treści) i
  dostaje `{id, host, username, password, decision, entryName, locked}`: hasło kandydata, żeby dało się je
  poprawić (przy zablokowanym sejfie bez hasła). Strona go nie czyta; hasło nie trafia do skryptu strony ani do
  `chrome.storage.local`. Haseł innych wpisów sejfu panel nie dostaje.
- Panel ukrywa service worker: od razu po „Nie teraz” i „Nigdy”, 2 s po zapisie.

Kod: `core/src/save/` (`url.ts`: `saveUrl`, `saveName`; `decide.ts`: `decideSave`, `newLogin`, `withPassword`;
wektory `core/test-vectors/save/`), `extension/src/save/` (`read-form.ts`, `watch.ts`, `candidates.ts`,
`registration.ts`, `messages.ts`, `prompt-view.ts`: podgląd z edycją), `save-watch.ts`, `save-prompt.ts`, `views/save-settings.ts`,
`views/save-question.ts`, `background.ts`.

### Android

Po wysłaniu formularza logowania w aplikacji lub w Chrome system wyświetla okno z pytaniem o zapis w
PassHolder (treść zależy od wersji Androida i języka). Od Androida 9 po „Zapisz” otwiera się podgląd, w którym można poprawić dane
przed zapisem; PassHolder zapisuje nowy login albo nowe hasło istniejącego. Tylko loginy.

- **Włączenie:** ⋮ → **Ustawienia** → **Pytaj o zapis haseł** (domyślnie włączone). Wymaga włączonej usługi
  autouzupełniania ([Autouzupełnianie](#android-1)). Chrome musi używać „innej usługi autouzupełniania”. Przy
  wyłączonym przełączniku odpowiedzi usługi nie mają prośby o zapis; zmiana działa od następnego wypełniania.
- **Kiedy pyta:** system pyta, gdy ekran z polem hasła (także „nowe hasło”) znika po wpisaniu danych: logowanie,
  rejestracja, formularz z danymi kontaktowymi i hasłem, zmiana hasła. Login może być pusty (uzupełnisz go w podglądzie).
  Hasło: pole „nowe hasło”, inaczej hasło; login: pole loginu, inaczej ostatni e-mail przed hasłem. Decyzja jak w
  Chrome: brak wpisu z tym loginem → nowy; jest z innym hasłem → zmiana samego hasła; to samo hasło: nic.
  Login porównywany bez wielkości liter i spacji na brzegach. Pytanie dotyczy także ekranu logowania, na którym
  nie było pasujących wpisów (usługa zwraca wtedy odpowiedź tylko z prośbą o zapis, nie „nic”).
- **Podgląd przed zapisem (Android 9+):** ekran „Zapisz w PassHolder” z polami **Nazwa** (tylko nowy wpis),
  **Login** i **Hasło** (ukryte, **Pokaż**) do edycji oraz adresem strony albo aplikacją (tylko do odczytu).
  Nagłówek liczy się na bieżąco: „Nowy login” albo „Zmiana hasła: <nazwa wpisu>”. **Zapisz** jest nieaktywny przy
  pustym haśle i gdy login z tym hasłem już jest; jeśli taki jest już przy wejściu, krótki komunikat „Ten login jest
  już zapisany w PassHolder” i zamknięcie. Przy zapisie sejf jest czytany od nowa, więc zmiana z ostatnich chwil
  (synchronizacja, inny zapis) nie zostaje nadpisana. Zablokowanie sejfu w trakcie podglądu: „Zapisz” prosi o
  odblokowanie i wraca do podglądu z tym, co wpisano. Wyjście z podglądu (także w tło) blokuje sejf (D1), jeśli to
  ten ekran go odblokował; sejf otwarty wcześniej w aplikacji zostaje otwarty.
  Dane z podglądu żyją tylko w pamięci ekranu.
- **Co się zapisuje:** w zaufanej przeglądarce (Chrome i pozostałe z listy) nazwa i adres to sama domena, jak w
  Chrome (`github.com`; `http` → `http://domena`). W innej aplikacji wpis dostaje nazwę aplikacji i jej pakiet na
  liście „Aplikacje”; domenę zgłoszoną przez obcą aplikację (WebView) PassHolder pomija. Po zapisie komunikat
  „Zapisano w PassHolder” albo „Zaktualizowano hasło w PassHolder”; błąd to komunikat „Nie udało się zapisać w
  PassHolder” (Android 8.0–8.1: błąd trafia do systemu, a czy i jak go pokaże, zależy od niego). Zmiana czeka na synchronizację jak każda inna.
- **Zablokowany sejf:** po zaakceptowaniu okna systemowego otwiera się ekran odblokowania (hasło główne albo
  odcisk palca, ten sam co przy podpowiedzi), po nim podgląd (otwarty sejf: od razu podgląd) i zapis z komunikatem. Login i hasło czekają w pamięci procesu
  do 2 minut (nie w intencji, nie na dysku); starszych nie zapisuje nic. Wstecz i **Anuluj**: nic nie zapisane,
  kandydat skasowany; przed odblokowaniem sejf zostaje zablokowany, na podglądzie blokuje się jak po zapisie (D1). Po zapisie sejf blokuje się jak po podpowiedzi: po 60 s albo od
  razu (zależnie od „Blokuj dopiero po 60 s poza aplikacją”); stary termin 60 s po wcześniejszym odblokowaniu nie
  przeszkadza. Sejf otwarty wcześniej w aplikacji zostaje otwarty.
- **Android 8.0–8.1 (API 26–27):** bez podglądu (system nie pozwala otworzyć ekranu): otwarty sejf zapisuje od
  razu; przy zablokowanym system dostaje komunikat „Odblokuj PassHolder i
  spróbuj ponownie” (ekran odblokowania z prośby o zapis działa od API 28); nic nie jest zapisane.

**Ograniczenia:**

- Tylko login i hasło; adres w aplikacji bez przeglądarki z listy zaufanych zapisuje się pod pakietem.
- Okno systemowe pojawia się wedle uznania Androida i aplikacji (np. gdy ekran logowania nie znika).
- Logowanie dwuetapowe (e-mail na wcześniejszym ekranie, hasło na następnym): wpis zapisuje się z pustym loginem, który (od API 28) można uzupełnić w podglądzie.
- Zapis w tle odświeża listę po powrocie do aplikacji, ale otwarty już formularz edycji nie jest przeładowywany:
  edycja tego samego wpisu tuż po zapisie w tle może nadpisać nowe hasło.

**Bezpieczeństwo:**

- Prośbę o zapis dokleja tylko usługa; identyfikatory pól i opis aplikacji (pakiet, domena) trafiają do
  `clientState` w chwili wypełniania, bo przy zapisie formularz bywa już ukryty.
- Kandydat przy zablokowanym sejfie żyje tylko w pamięci procesu (2 minuty), ekran odblokowania ma
  `exported="false"` i `FLAG_SECURE`.

Kod: `android/core/.../core/save/` (`SaveUrl.kt`, `Decide.kt`, `SaveFields.kt`; port `core/src/save/`, te same
wektory), `android/app/.../app/autofill/` (`SaveState.kt`, `SaveLogin.kt`, `PendingSave.kt`,
`AutofillAuthActivity.kt`, `AutofillSaveActivity.kt`, `AutofillUnlockActivity.kt`, `PassHolderAutofillService.kt`,
`ResponseBuilder.kt`), `PassHolderApp.kt` (`Settings.askToSave`), `ui/SettingsScreen.kt`.
