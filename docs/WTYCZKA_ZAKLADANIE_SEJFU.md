# Wtyczka Chrome: naprawa zakładania sejfu, Enter i podgląd hasła

> Uwaga (2026-11-01): część nazw funkcji i plików opisanych niżej zmieniła się przy poprawkach po przeglądzie kodu, zob. [POPRAWKI_PRZEGLADU_2.md](POPRAWKI_PRZEGLADU_2.md).

Dokument opisuje poprawki z gałęzi `claude/project-thread-7gdpxw`.

## 1. Błąd: sejf nie był zakładany

### Objaw

Po kliknięciu **Załóż sejf** okienko wtyczki się zamykało, Chrome pytał o zgodę na dostęp do serwera,
po zgodzie nic się nie działo. Po ponownym otwarciu wtyczka nie była połączona, a **Mam już sejf**
kończyło się błędem serwera `Vault not set up`.

### Przyczyna

W `connectView` (`extension/src/popup.ts`) cała reszta pracy była w callbacku:

```ts
chrome.permissions.request({ origins: [origin] }, (granted) => {
  // tu: createVault / connectExisting
});
```

Wtyczka nie ma na stałe dostępu do żadnego adresu (`optional_host_permissions` w `manifest.json`), więc
przy pierwszym połączeniu Chrome pokazuje okno zgody. Okienko wtyczki (popup) zamyka się, gdy traci fokus,
a okno zgody ten fokus zabiera. Razem z okienkiem znika cała strona i jej JavaScript, więc callback
nigdy się nie wykonał: zgoda została zapisana, ale `POST /api/v1/setup` nie został wysłany.
Dlatego serwer dalej nie miał sejfu (`Vault not set up`).

Pewne: kod wykonujący się w callbacku i zamykanie się popupu (opisane przez Ciebie i zgodne z tym, jak
Chrome traktuje popupy). Nie odtworzyłem samego zamknięcia popupu w testach, bo Chrome bez okna (headless)
nie pokazuje okna zgody.

### Poprawka

Formularz połączenia działa teraz w zwykłej karcie (`popup.html?setup`), która nie zamyka się, gdy Chrome
pyta o zgodę.

- `IN_TAB`: `true`, gdy strona jest otwarta z parametrem `?setup`, czyli w karcie.
- `showConnect()`: w karcie pokazuje formularz (`connectView`). W popupie pokazuje krótkie wyjaśnienie
  i przycisk **Otwórz ustawienia połączenia**.
- `openSetupTab()`: otwiera `chrome.runtime.getURL("popup.html?setup")` w nowej karcie
  (`chrome.tabs.create` nie wymaga uprawnienia `tabs`) i zamyka popup.
- `start()` i przycisk **Odłącz tę przeglądarkę** wołają `showConnect()` zamiast `connectView()`.
- W karcie `body` dostaje klasę `tab` (wyśrodkowanie, `popup.css`).
- Po udanym połączeniu karta pokazuje listę wpisów i komunikat, że można ją zamknąć.

`chrome.permissions.request` nadal jest wołane od razu w obsłudze przycisku, przed jakimkolwiek `await`,
bo Chrome wymaga, żeby prośba o uprawnienie wynikała z działania użytkownika.

### Lepszy komunikat dla „Mam już sejf”

`VaultStore.connectExisting` (`extension/src/vault-store.ts`) zamienia odpowiedź 404 z `GET /api/v1/prelogin`
na komunikat `NO_VAULT_ON_SERVER`: „Na serwerze nie ma jeszcze sejfu. Wybierz „Nowy sejf” i załóż go.”
zamiast angielskiego `Vault not set up`.

## 2. Enter klika „Połącz” / „Załóż sejf”

Nowy pomocnik `form(onSubmit, ...children)` tworzy element `<form>`, którego zdarzenie `submit`
(`preventDefault()` + `onSubmit()`) uruchamia przycisk główny. Przeglądarka sama wysyła formularz,
gdy w dowolnym polu naciśniesz Enter.

- Formularz połączenia: pola i przycisk **Połącz** / **Załóż sejf** (`type: "submit"`) są w `form`.
  Zakładki **Mam już sejf** / **Nowy sejf** są poza formularzem.
- Ekran blokady: to samo dla **Odblokuj**. Wcześniejsza ręczna obsługa `keydown` została usunięta.
- Pozostałe przyciski w formularzu (**Pokaż**, **Odłącz tę przeglądarkę**) mają `type: "button"`,
  bo inaczej Enter mógłby uruchomić je zamiast przycisku głównego.

## 3. Odsłanianie hasła kliknięciem

Pomocnik `passwordField(input)` zwraca `{ row, setVisible }`:

- `row`: wiersz z polem i przyciskiem **Pokaż**, który przełącza `input.type` między `password` a `text`.
  Napis zmienia się na **Ukryj**, a `aria-pressed` mówi czytnikom ekranu, czy hasło jest widoczne.
- `setVisible(true/false)`: ustawia stan z kodu. Używa go generator w edycji wpisu, żeby po
  wygenerowaniu hasło było widać, a przycisk pokazywał **Ukryj**.

Przycisk jest przy: haśle głównym i jego powtórzeniu (połączenie), haśle na ekranie blokady oraz haśle
wpisu (edycja; wcześniej był tam osobny przycisk bez zmiany napisu).

Założenie: „odsłonięcie hasła” dotyczy pól z hasłem. Na liście wpisów hasło dalej tylko się kopiuje;
podgląd widać po kliknięciu **Edytuj** i **Pokaż**.

## 4. Testy

- Nowy test jednostkowy w `extension/test/edge-cases.test.ts`: „Mam już sejf” na serwerze bez sejfu
  daje `NO_VAULT_ON_SERVER` i nie zapisuje konta. Wszystkie 13 testów wtyczki przechodzi, `tsc` bez błędów.
- Test w Chrome bez okna (Playwright, wtyczka z `extension/dist`, serwer na `http://127.0.0.1:8787`):
  - popup bez `?setup` pokazuje przycisk, który otwiera kartę `popup.html?setup`;
  - **Nowy sejf** + Enter w polu powtórzenia hasła: serwer dostał `POST /api/v1/setup` (201), karta
    pokazała pustą listę;
  - drugi profil, **Mam już sejf**: złe hasło + Enter daje „Złe hasło główne”, dobre hasło + Enter łączy;
  - ekran blokady: **Pokaż** odsłania hasło, Enter odblokowuje;
  - edycja wpisu: **Generuj** odsłania hasło, przycisk pokazuje **Ukryj**.

  Ograniczenie: w trybie bez okna nie da się kliknąć okna zgody Chrome, więc do tego testu wtyczka
  dostała na stałe `host_permissions` dla `127.0.0.1` (tylko kopia testowa, nie w repozytorium).
  Kliknięcie zgody w prawdziwym Chrome trzeba sprawdzić ręcznie.

## 5. Jak sprawdzić u siebie

```sh
git pull
npm run build -w extension
```

W `chrome://extensions` kliknij odświeżenie przy PassHolder. Kliknij ikonę, **Otwórz ustawienia połączenia**,
**Nowy sejf**, wpisz dane i naciśnij Enter, zaakceptuj zgodę.

Jeśli serwer przy poprzedniej próbie nie założył sejfu, token z logu jest dalej ważny. Jeśli serwer był
restartowany, odczytaj nowy token (`journalctl -u passholder -b`).
