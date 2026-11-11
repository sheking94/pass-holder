# V3, podprojekt C: pytanie o zapis loginu (projekt)

Status: do akceptacji. Data: 2026-11-11. Ustalenia z właścicielem (wątek „Dodaj pytanie o zapis hasła”).

## 1. Cel i zakres

Po wysłaniu formularza logowania wtyczka Chrome i aplikacja na Androida pytają, czy zapisać nowy login albo
zaktualizować hasło istniejącego.

**W zakresie:** tylko loginy (login + hasło + adres strony / aplikacja). Wykrycie wysłania formularza w Chrome,
panel z pytaniem, `SaveInfo` i `onSaveRequest` na Androidzie, wspólna logika decyzji, testy, opis w docs/.

**Poza zakresem:** karty, kontakty, inne typy; TOTP; „Nigdy dla tej aplikacji” na Androidzie; synchronizacja
listy „Nigdy” między urządzeniami; pliki (osobny etap).

## 2. Decyzje

| Temat | Decyzja |
|---|---|
| Kroki | C1 Chrome, C2 Android (osobne wątki i PR), jeden spec |
| Typy | Tylko login: nowy wpis albo aktualizacja hasła |
| Chrome – uprawnienia | Opcjonalne: przełącznik „Pytaj o zapis haseł”, domyślnie wyłączony; prosi o `https://*/*` i `http://*/*` |
| Chrome – pytanie | Panel (iframe strony wtyczki) w prawym górnym rogu strony |
| Kandydat do zapisu | Per karta, w `chrome.storage.session`, 2 minuty albo do decyzji; pokazywany po każdym przeładowaniu |
| Zapisywany adres | Sama domena (`github.com`); wyjątki: strona `http` → `http://domena`, port niestandardowy zostaje |
| Android – pytanie | Systemowe okno autouzupełniania (`SaveInfo`) |
| Android – „nigdy” | Brak; przełącznik „Pytaj o zapis haseł” w Ustawieniach, domyślnie włączony |
| Logika | Czysta, osobno w TS i Kotlinie, wspólne wektory testowe |
| Wykonanie | Subagenci |

## 3. Logika wspólna (TS i Kotlin)

Pliki: `core/src/save/` (TS, eksport `@passholder/core/save`), `android/core/src/main/kotlin/.../core/save/`
(Kotlin). Wektory: `core/test-vectors/save/url.json` i `decide.json`; testy w obu językach czytają te same pliki.

### 3.1 Adres do zapisu (`saveUrl`)

Wejście: adres strony (Chrome) albo `webDomain` + `webScheme` (Android). Wynik: tekst albo `null`.

1. Schemat inny niż `http`/`https` → `null`. Nieparsowalny adres → `null`.
2. Host małymi literami, bez końcowej kropki i bez przedrostka `www.` (`www.github.com` → `github.com`).
3. Port: domyślny dla schematu jest pomijany; inny zostaje (`localhost:3000`).
4. Schemat: `https` → bez schematu (`github.com`); `http` → `http://` + host (bez tego wpis nie pasowałby do
   strony, bo adres bez schematu oznacza `https`, spec B 3.1).
5. Bez ścieżki, zapytania i fragmentu.

Wynik zawsze pasuje do strony wejściowej według `matchUrl` ze specu B (sprawdzane w wektorach).

### 3.2 Decyzja (`decideSave`)

Wejście: login (może być pusty), hasło (niepuste), lista pasujących loginów w kolejności z `matchLogins` /
`matchApp` (spec B 3.1, 3.2). Wynik:

- `none` – istnieje wpis z tym samym loginem i tym samym hasłem.
- `update(id)` – pierwszy wpis z tym samym loginem i innym hasłem.
- `create` – brak wpisu z tym loginem.

Porównanie loginu: bez wielkości liter i bez spacji na brzegach. Pusty login równa się tylko pustemu.
Puste hasło → wynik `none` (nic do zapisania).

### 3.3 Nowy wpis

Login: nazwa = host z `saveUrl` bez schematu i portu (Chrome) albo nazwa aplikacji (Android); `username`,
`password`; `urls` = `[saveUrl]` (Chrome, przeglądarka na Androidzie) albo `androidApps` = `[pakiet]` (inna
aplikacja na Androidzie). Pozostałe pola puste. Aktualizacja zmienia tylko `password`. Zmiana czeka na
synchronizację jak każda inna.

## 4. Chrome (krok C1)

### 4.1 Włączenie i ustawienia

- W pasku listy przycisk „Zapis” (obok „PIN”) otwiera widok „Zapis haseł”: przełącznik „Pytaj o zapis haseł”
  i lista „Nigdy dla tych stron” (host + „Usuń”).
- Włączenie: `chrome.permissions.request({origins: ["https://*/*", "http://*/*"]})` (manifest:
  `optional_host_permissions` dostaje `https://*/*`), potem `chrome.scripting.registerContentScripts`
  (`id: "save-watch"`, `matches` jak uprawnienia, `allFrames: true`, `runAt: "document_idle"`).
  Odmowa w oknie Chrome → przełącznik zostaje wyłączony.
- Wyłączenie: `unregisterContentScripts`, `permissions.remove` dla `https://*/*`; `http://*/*` usuwane tylko,
  gdy żaden adres telefonu nie jest `http`.
- Stan przełącznika: `chrome.storage.local`. Po starcie przeglądarki tło sprawdza, czy uprawnienie nadal jest
  (użytkownik mógł je odebrać w `chrome://extensions`); brak → przełącznik wyłączony, skrypt wyrejestrowany.

### 4.2 Skrypt obserwujący (`save-watch`)

- Działa w ramce głównej i w ramkach o tym samym origin co ramka główna; w innych nic nie robi.
- Zdarzenia: `submit` formularza z widocznym polem hasła; Enter w polu hasła; klik przycisku (`button`,
  `input[type=submit]`, element z `role=button`) w tym samym formularzu albo, gdy pola nie są w `<form>`,
  w najbliższym wspólnym kontenerze pola hasła.
- Pola: `classifyField` ze specu B. Hasło: `newPassword`, gdy jest z wartością (rejestracja, zmiana hasła;
  przy dwóch polach „nowe hasło” bierze pierwsze), inaczej `password`. Login: pole `username`, inaczej
  `email` przed polem hasła. Puste hasło → nic.
- Wysyła `{type: "save-candidate", username, password}` do tła. Nie wysyła adresu.
- Na każdej nowej stronie wysyła `{type: "save-pending"}`; tło odpowiada, czy pokazać panel.

### 4.3 Tło

1. Przyjmuje `save-candidate` tylko od skryptu wtyczki (`sender.id`) z kartą (`sender.tab`). Adres bierze z
   `sender.url` (ramka, która wysłała) i sprawdza, że ma ten sam origin co karta (`sender.tab.url`).
2. Host na liście „Nigdy” → koniec.
3. Sejf odblokowany: `decideSave` na wpisach z `matchLogins`. `none` → koniec. Sejf zablokowany: decyzja po
   odblokowaniu.
4. Kandydat `{id, tabId, url, username, password, decision?, at, formSignature}` w `chrome.storage.session`
   pod `saveCandidates` (dostęp tylko dla stron wtyczki: `setAccessLevel` `TRUSTED_CONTEXTS`, domyślny).
   Jeden na kartę; nowszy zastępuje starszy. Usuwany po decyzji, po 2 minutach (`chrome.alarms`) i po
   `chrome.tabs.onRemoved`.
5. Pokazuje panel od razu (wiadomość do skryptu w ramce głównej karty) i przy każdym `save-pending` z tej
   karty w czasie 2 minut.
6. **Złe hasło:** `formSignature` = origin + zestaw nazw/id pól formularza. Gdy `save-pending` przychodzi ze
   strony o tym samym origin, a skrypt zgłasza ten sam formularz z pustym polem hasła, panel się nie
   pokazuje (logowanie najpewniej się nie udało). Kandydat zostaje do kolejnego wysłania.

### 4.4 Panel

- `save-prompt.html` (strona wtyczki, `web_accessible_resources` z `use_dynamic_url: true`), wstawiana przez
  skrypt jako `<iframe>` w zamkniętym Shadow DOM, w prawym górnym rogu, nad treścią strony (`z-index`
  maksymalny). Strona nie może odczytać zawartości ramki (inny origin).
- Panel dostaje od tła tylko `{id, host, username, decision, locked}` – bez hasła.
- Tekst: „Zapisać login w PassHolder?” / „Zaktualizować hasło w PassHolder?” + host + login.
- Przyciski: „Zapisz” / „Aktualizuj”, „Nie teraz” (usuwa kandydata), „Nigdy dla tej strony” (dopisuje host
  do listy, usuwa kandydata), krzyżyk = „Nie teraz”.
- Sejf zablokowany: „Odblokuj i zapisz” → `chrome.action.openPopup()`. Okienko po odblokowaniu (hasło albo
  PIN) pokazuje najpierw pytanie o zapis kandydata z bieżącej karty, potem listę.
- Po zapisie panel pokazuje „Zapisano” przez 2 s i znika (skrypt usuwa ramkę).

## 5. Android (krok C2)

### 5.1 `SaveInfo`

- Każda odpowiedź dla grupy login z polem hasła (`password` albo `newPassword`) dostaje
  `SaveInfo(SAVE_DATA_TYPE_PASSWORD | SAVE_DATA_TYPE_USERNAME)`: wymagane – pole hasła, opcjonalne – pole
  loginu; flaga `FLAG_SAVE_ON_ALL_VIEWS_INVISIBLE`.
- Dotyczy też: braku pasujących wpisów (dziś `null` → teraz odpowiedź z samym `SaveInfo`) i zablokowanego
  sejfu (odpowiedź „Odblokuj PassHolder” + `SaveInfo`).
- Bez `SaveInfo`, gdy przełącznik „Pytaj o zapis haseł” jest wyłączony, gdy nie ma sejfu i dla samej
  aplikacji PassHolder.

### 5.2 `onSaveRequest`

1. Odczyt wartości pól z `request.fillContexts` (ostatnia struktura; pola po `autofillId` z odpowiedzi).
2. Cel: przeglądarka z listy zaufanych (spec B 3.2) i `webDomain` → `saveUrl`; inna aplikacja → pakiet,
   nazwa = etykieta aplikacji z `PackageManager`.
3. Sejf odblokowany: `decideSave` na wpisach z `matchApp` → zapis, `Toast` „Zapisano w PassHolder” /
   „Zaktualizowano hasło w PassHolder”; `none` → nic. `callback.onSuccess()`.
4. Sejf zablokowany: kandydat w pamięci procesu aplikacji (`PendingSave`, 2 minuty, bez zapisu na dysk),
   `callback.onSuccess(IntentSender)` otwiera `AutofillSaveActivity` (odcisk palca albo hasło główne, jak
   `AutofillUnlockActivity`), po odblokowaniu zapis jak w 3 i zamknięcie. Anulowanie → kandydat usunięty.
   Blokada po odblokowaniu jak w B2 (D1, R2).
5. Błąd zapisu → `callback.onFailure("Nie udało się zapisać w PassHolder")`.

### 5.3 Ustawienia

Ekran „Ustawienia”: przełącznik „Pytaj o zapis haseł” (domyślnie włączony, w `SharedPreferences`), pod
wierszem „Autouzupełnianie”. Działa tylko przy włączonej usłudze.

## 6. Błędy i bezpieczeństwo

- Chrome: strona nie podszyje się pod inną domenę (adres z `sender.url`, nie z wiadomości); ramki z innym
  origin są pomijane; hasło nie trafia do panelu ani do `chrome.storage.local`; kandydat żyje tylko w pamięci
  sesji (do 2 minut).
- Skrypt na stronach widzi pola formularzy (jak każdy menedżer haseł z zapisem) – dlatego uprawnienie jest
  opcjonalne i domyślnie wyłączone.
- Lista „Nigdy” jest jawna w `chrome.storage.local` (dostępna przy zablokowanym sejfie); ktoś z dostępem do
  profilu Chrome zobaczy te hosty.
- Android: domena tylko od zaufanych przeglądarek (spec B 3.2); obca aplikacja z WebView zapisuje się pod
  swoim pakietem. Kandydat przy zablokowanym sejfie nie trafia do intencji ani na dysk.

## 7. Testy

- **Wektory (TS i Kotlin):** `url.json` (https, http, `www.`, port domyślny i inny, IP, `localhost`, ścieżka,
  zły schemat; wynik pasuje przez `matchUrl`), `decide.json` (none, update – pierwszy z kilku, create, login
  bez wielkości liter, pusty login, puste hasło).
- **Wtyczka (happy-dom):** wykrycie przez submit, Enter, klik przycisku, pola bez `<form>`, logowanie bez
  przeładowania; rejestracja (`new-password`); ramka z innym origin pominięta; tło: adres z `sender.url`,
  „Nigdy”, 2 minuty, zamknięcie karty, zły formularz ponownie; panel (zapis, aktualizacja, nie teraz, nigdy,
  zablokowany sejf); przełącznik (zgoda, odmowa, odebrane uprawnienie). Zrzuty Playwright do
  `/mnt/project-files/wtyczka-v3/`.
- **Android:** testy jednostkowe `SaveInfo` w odpowiedziach (brak dopasowań, zablokowany, przełącznik
  wyłączony), `onSaveRequest` z atrapą struktury (przeglądarka, aplikacja, update/create/none, zablokowany).
- **Ręczne:** T20 (Chrome: włączenie, nowy login, zmiana hasła, logowanie bez przeładowania, przekierowania,
  „Nigdy”, zablokowany sejf), T21 (Android: aplikacja, Chrome z „inną usługą”, zablokowany sejf, przełącznik)
  w docs/TESTY.md.

## 8. Dokumentacja

Po każdym kroku: opis działania w docs/FUNKCJE.md (rozdział „Pytanie o zapis”) i ARCHITEKTURA.md (moduł
`save`), testy ręczne w TESTY.md, włączenie w INSTALACJA.md.
