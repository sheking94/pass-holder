# V3, podprojekt B: autouzupełnianie (projekt)

Status: do akceptacji. Data: 2026-11-09. Ustalenia z właścicielem (wątek „Zbuduj autouzupełnianie V3”).

## 1. Cel i zakres

Wtyczka Chrome i aplikacja na Androida wpisują dane z sejfu w formularze: loginy, karty płatnicze, kontakty.

**W zakresie:** dopasowanie wpisu do strony/aplikacji, rozpoznawanie pól, wypełnianie we wtyczce (krok B1)
i usługa autouzupełniania Androida (krok B2), testy automatyczne i ręczne (T18, T19), opis w docs/.

**Poza zakresem:** zapis nowych danych (podprojekt C), liczenie i wpisywanie kodów TOTP, dokumenty i notatki,
ikonka w polach formularza na każdej stronie, ramki operatorów płatności z innej domeny.

## 2. Decyzje

| Temat | Decyzja |
|---|---|
| Kroki | B1 Chrome, B2 Android (osobne wątki i PR), jeden spec |
| Typy | Login (login, hasło), karta, kontakt |
| Chrome – uruchomienie | „Wypełnij” w okienku + skrót Ctrl+Shift+L; `activeTab` + `scripting`, skrypt wstrzykiwany dopiero po akcji użytkownika |
| Dopasowanie adresu | Host równy albo subdomena hosta zapisanego, bez `www.`, bez listy sufiksów; https ≠ http |
| Android | Autofill Framework (`AutofillService`), pakiet + domena od znanych przeglądarek |
| Logika | Czysta, osobno w TS i Kotlinie, wspólne wektory testowe |
| Wykonanie | Subagenci |

## 3. Logika wspólna (TS i Kotlin)

Pliki: `core/src/autofill/` (TS), `android/core/src/main/kotlin/.../core/autofill/` (Kotlin).
Wektory: `core/test-vectors/autofill/match.json` i `fields.json`; testy w obu językach czytają te same pliki.

### 3.1 Dopasowanie loginu do strony (`matchLogins`)

Wejście: adres strony, lista loginów. Dla każdego adresu z `urls` loginu:
1. Adres bez schematu traktowany jak `https://`. Nieparsowalny adres jest pomijany.
2. Host małymi literami, bez końcowej kropki i bez przedrostka `www.` (po obu stronach).
3. Pasuje, gdy host strony = host zapisany albo kończy się na `.` + host zapisany
   (`login.google.com` pasuje do `google.com`; `evilgoogle.com` nie pasuje).
4. Schemat: zapisany `https` pasuje tylko do strony `https`; zapisany `http` pasuje do `http` i `https`.
5. Port: zapisany port musi być równy portowi strony; bez portu pasuje każdy domyślny dla schematu.
6. Adresy IP i `localhost`: tylko równość (bez subdomen).

Wynik: loginy z pasującym adresem, posortowane: najpierw dokładny host, potem subdomeny; w grupie po nazwie
(`Collator` pl, jak w eksporcie). Strona inna niż `http(s)` → pusta lista.

### 3.2 Dopasowanie loginu do aplikacji Androida (`matchApp`)

- Pakiet równy jednemu z `androidApps` → pasuje.
- Domena strony (pole `webDomain` z Androida) liczy się tylko, gdy pakiet jest na liście zaufanych przeglądarek:
  `com.android.chrome`, `com.chrome.beta`, `com.chrome.dev`, `com.chrome.canary`, `org.mozilla.firefox`,
  `org.mozilla.firefox_beta`, `org.mozilla.focus`, `com.microsoft.emmx`, `com.brave.browser`,
  `com.sec.android.app.sbrowser`, `com.opera.browser`, `com.duckduckgo.mobile.android`, `com.vivaldi.browser`.
  Wtedy dopasowanie jak w 3.1 (schemat z `webScheme`, gdy podany; brak → `https`).
- Inna aplikacja z `webDomain` (np. WebView w obcej aplikacji) dostaje tylko loginy przypisane do jej pakietu.
  To blokuje aplikację, która udaje stronę banku.

### 3.3 Rozpoznawanie pól (`classifyField`)

Wejście: opis pola (`autocomplete`/`autofillHints`, `type`/`inputType`, `name`, `id`, etykieta, `placeholder`,
dla `<select>` lista opcji). Wynik: rodzaj pola albo `null`.

Rodzaje: `username`, `password`, `newPassword` (pomijane: to rejestracja/zmiana hasła), `ccName`, `ccNumber`,
`ccExp` (jedno pole), `ccExpMonth`, `ccExpYear`, `ccCsc`, `givenName`, `familyName`, `fullName`, `email`, `tel`,
`street`, `postalCode`, `city`, `country`, `bday`.

Kolejność reguł (pierwsza trafiona wygrywa):
1. **Atrybut `autocomplete`** (HTML) / `autofillHints` (Android) – mapa tokenów: `username`, `email`,
   `current-password`, `new-password`, `cc-name`, `cc-number`, `cc-exp`, `cc-exp-month`, `cc-exp-year`, `cc-csc`,
   `given-name`, `family-name`, `name`, `tel`, `street-address`, `address-line1`, `postal-code`,
   `address-level2`, `country`, `country-name`, `bday`; stałe Androida `View.AUTOFILL_HINT_*` i
   `HintConstants`. `off` i nieznane tokeny → idź dalej.
2. **Typ pola:** `password` → `password`; `email` → `email`; `tel` → `tel`. Na Androidzie `inputType`
   z flagą hasła → `password`.
3. **Słowa** w `name`, `id`, etykiecie, `placeholder` (małe litery, bez polskich znaków): listy PL + EN
   w jednym pliku słownika (`keywords`), np. `login|user|e-?mail|uzytkownik` → `username`;
   `card.?number|numer.?karty|cc-?num` → `ccNumber`; `cvc|cvv|csc|kod.?zabezp` → `ccCsc`;
   `kod.?pocztowy|zip|postal` → `postalCode`. Pełne listy w wektorach.
4. Nic → `null` (pole pomijane).

Pola ukryte (`type=hidden`, niewidoczne, `disabled`, `readonly`) nie są wypełniane.

### 3.4 Wartości do wpisania (`fillValues`)

- **Login:** `username`, `password`. Pole `email` bez pola `username` w formularzu dostaje login.
- **Karta:** `ccName` ← `holder`, `ccNumber` ← `number` (bez spacji), `ccCsc` ← `cvc`.
  `ccExp` ← `expiry` w formacie pola: `MM/RR` domyślnie, `MM/RRRR` gdy `maxlength` ≥ 7 albo `placeholder`
  zawiera `RRRR`/`YYYY`. `ccExpMonth` ← `MM` (albo `M` gdy opcje `<select>` są bez zera), `ccExpYear` ←
  `RR` albo `RRRR` (z `maxlength`/opcji `<select>`). Zły format `expiry` → pola daty puste.
- **Kontakt:** `givenName`/`familyName`/`fullName` (imię + spacja + nazwisko), pierwszy telefon, pierwszy
  e-mail, pierwszy adres (`street`, `postalCode`, `city`, `country`), `bday` (`RRRR-MM-DD`).
- `<select>`: wybierana opcja o równej wartości albo tekście (bez wielkości liter); brak → pole bez zmian.
- Puste wartości nie nadpisują pól.

## 4. Chrome (krok B1)

### 4.1 Uprawnienia i manifest

- Nowe uprawnienia: `activeTab`, `scripting`. Bez `host_permissions` i bez stałych content scriptów.
- `commands`: `fill-login` z `suggested_key` `Ctrl+Shift+L` (Mac: `Command+Shift+L`).
- `minimum_chrome_version` 127 (`chrome.action.openPopup` przy skrócie).

### 4.2 Okienko

- **Zakładka Loginy:** przy otwarciu okienka pobierany jest adres bieżącej karty (`chrome.tabs.query`,
  dostępny dzięki `activeTab`). Jeśli są pasujące loginy, nad listą sekcja „Pasujące do tej strony” z
  wierszami i przyciskiem „Wypełnij”. Wyszukiwanie dalej działa na całej liście.
- **Karty, Kontakty:** w każdym wierszu przycisk „Wypełnij”.
- Tryb „Otwórz w karcie” (strona wtyczki w zwykłej karcie) nie pokazuje „Wypełnij” (bieżąca karta to sama
  wtyczka).
- Po kliknięciu: wypełnienie, okienko się zamyka. Błąd → komunikat w okienku, okienko zostaje.

### 4.3 Wypełnianie

1. Okienko wysyła do service workera `{type: "fill", entryId}` (bez danych).
2. Service worker odszyfrowuje wpis kluczami z `chrome.storage.session` (jak dziś okienko) i sprawdza kartę:
   adres `http(s)`; dla loginu ponownie `matchLogins` (adres mógł się zmienić); dla karty tylko `https`
   (wyjątek: `localhost`).
3. `chrome.scripting.executeScript({target: {tabId, allFrames: true}, func: fillPage, args: [plan]})`.
   Chrome wstrzykuje tylko tam, gdzie `activeTab` daje dostęp (strona główna); ramki z innej domeny są
   pomijane. Dodatkowo `fillPage` sprawdza `location.origin` ramki: wypełnia tylko ramki o tym samym origin
   co strona główna.
4. `fillPage` (samodzielna funkcja, bez importów): zbiera pola formularza, klasyfikuje je (`classifyField`
   wstrzykiwane razem ze słownikiem), wpisuje wartości (`value` + zdarzenia `input` i `change`, dla Reacta
   przez setter z prototypu), zwraca liczbę wypełnionych pól.
5. Wynik 0 → komunikat: login „Nie znaleziono pól logowania”, karta „Nie znaleziono pól karty (mogą być w
   ramce operatora płatności), skopiuj dane ręcznie”, kontakt „Nie znaleziono pól adresu”.
6. Dane trafiają do strony tylko w `args` jednego wywołania; nic nie zostaje w stronie poza wpisanymi
   wartościami. Wypełnienie przesuwa termin automatycznej blokady jak każda aktywność.

Formularz logowania: wypełniany jest formularz zawierający widoczne pole hasła (pierwszy taki); gdy nie ma
pola hasła (logowanie dwuetapowe), wypełniane jest samo pole loginu.

### 4.4 Skrót klawiszowy

Ctrl+Shift+L: sejf odblokowany i dokładnie jeden pasujący login → wypełnienie jak w 4.3 bez okienka.
W pozostałych przypadkach (zero, kilka, zablokowany sejf, PIN) → `chrome.action.openPopup()`.

## 5. Android (krok B2)

### 5.1 Usługa

- `PassHolderAutofillService : AutofillService`, w manifeście z uprawnieniem
  `android.permission.BIND_AUTOFILL_SERVICE` i `res/xml/autofill_service.xml` (`settingsActivity` =
  `MainActivity`).
- `onFillRequest`: przejście po `AssistStructure` (ostatnie okno), zebranie pól (`autofillId`,
  `autofillHints`, `htmlInfo` z atrybutami, `inputType`, `idEntry`, `hint`, `webDomain`, `webScheme`),
  `classifyField` z rdzenia, wybór grupy (login / karta / kontakt) według rozpoznanych pól.
- Pakiet aplikacji: `structure.activityComponent.packageName`. Własna aplikacja PassHolder jest pomijana.
- `onSaveRequest`: brak (podprojekt C); `FillResponse` bez `SaveInfo`.

### 5.2 Podpowiedzi

- Sejf odblokowany: `Dataset` na każdy pasujący wpis, `RemoteViews` z nazwą i opisem (login; „Visa •••• 1234”
  jak w liście; imię i nazwisko). Najwyżej 10 podpowiedzi; dla kart i kontaktów kolejność jak na liście.
- Sejf zablokowany: jedna podpowiedź „Odblokuj PassHolder” z `setAuthentication(IntentSender)`. Otwiera
  `AutofillUnlockActivity` (odcisk palca albo hasło główne, jak `LockedScreen`), która po odblokowaniu
  buduje `FillResponse` i zwraca go w `EXTRA_AUTHENTICATION_RESULT`. Anulowanie → bez wyniku.
- Brak pasujących wpisów → `callback.onSuccess(null)`.
- Dane wpisów są odszyfrowywane dopiero przy budowie odpowiedzi; usługa nie trzyma ich w polach klasy.

### 5.3 Ustawienia

Ekran „Ustawienia”: wiersz „Autouzupełnianie” ze stanem (`AutofillManager.hasEnabledAutofillServices()`)
i przyciskiem „Włącz”, który otwiera `Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE`. INSTALACJA.md opisuje
dodatkowo opcję Chrome na Androidzie: Ustawienia → Autouzupełnianie → „Autouzupełnianie przez inną usługę”.

## 6. Błędy i bezpieczeństwo

- Wtyczka: skrypt na stronie nie dostaje kluczy ani innych wpisów; strona widzi tylko wpisane wartości.
- Brak wypełniania: na stronach innych niż `http(s)` (np. `chrome://`, Chrome Web Store – Chrome i tak
  blokuje), kart na `http`, ramek z innym origin, pól ukrytych.
- Android: domena tylko od zaufanych przeglądarek (3.2); usługa odpowiada tylko na żądania systemu
  (`BIND_AUTOFILL_SERVICE`), inne aplikacje nie mogą jej wywołać.
- Wycieki przez zdarzenia: wpisanie wartości jest widoczne dla skryptów strony (jak u każdego menedżera
  haseł); dlatego dopasowanie adresu jest ścisłe.

## 7. Testy

- **Wektory (TS i Kotlin):** `match.json` (host, subdomena, `www.`, schemat, port, IP, `evilgoogle.com`,
  przeglądarka/obca aplikacja), `fields.json` (opisy pól → rodzaj), `values.json` (karta: formaty ważności,
  `<select>`; kontakt).
- **Wtyczka (happy-dom):** `fillPage` na formularzach: logowanie, logowanie dwuetapowe, rejestracja
  (`new-password` pomijane), karta z jednym i dwoma polami ważności, adres; ramka z innym origin pominięta;
  sekcja „Pasujące do tej strony”; skrót (jeden / kilka / zablokowany). Zrzuty Playwright do
  `/mnt/project-files/wtyczka-v3/`.
- **Android:** testy jednostkowe budowy odpowiedzi (`FillResponse` z atrapy struktury pól), testy
  `matchApp` (pakiet, przeglądarka, obca aplikacja z `webDomain`).
- **Ręczne:** T18 (Chrome: login, skrót, karta, adres), T19 (Android: aplikacja z pakietem, Chrome z
  domeną, zablokowany sejf → odblokowanie → podpowiedzi, karta, kontakt) w docs/TESTY.md.

## 8. Dokumentacja

Po każdym kroku: opis działania w docs/FUNKCJE.md (rozdział „Autouzupełnianie”) i ARCHITEKTURA.md (moduł
`autofill`), testy ręczne w TESTY.md, włączenie usługi w INSTALACJA.md.
