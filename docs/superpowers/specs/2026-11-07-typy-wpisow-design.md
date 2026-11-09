# V3, podprojekt A: typy wpisów (projekt)

Status: do akceptacji. Data: 2026-11-07. Ustalenia z sesji brainstormingu z właścicielem.

## 1. Cel i zakres

Sejf przechowuje oprócz loginów także kontakty, karty płatnicze, notatki i dokumenty. Pełny obieg
PassHolder → plik → PassHolder bez strat. Import i eksport również w formatach Bitwarden JSON i NordPass CSV.

**W zakresie:** format wpisu v3, ścisłe nagrobki (punkt z listy V3), limit rozmiaru wpisu i stronicowanie po
bajtach, blokada starych wersji, ekrany w obu aplikacjach, import/eksport w obu aplikacjach, pole TOTP
(tylko przechowywanie i kopiowanie).

**Poza zakresem (osobne podprojekty, każdy z własnym brainstormingiem):**
- B. Autouzupełnianie (Chrome, Android).
- C. Pytanie o zapis nowych danych (zależy od B).
- Pliki w sejfie (wymagają zmian w protokole, bo synchronizacja mieści się w 1 MiB na żądanie).
- Pełne TOTP: liczenie kodów i autouzupełnianie kodu.
- Bitwarden CSV, foldery, ulubione, historia haseł.

## 2. Decyzje

| Temat | Decyzja |
|---|---|
| Pola | Stałe typy ze stałymi polami + własne pola (etykieta, wartość, ukryte) |
| Model | Typowane schematy, ściśle sprawdzane w TS i Kotlinie |
| Przejście | Jedna aktualizacja wszystkich urządzeń; stare wpisy czytane jako login; stare urządzenie odmawia synchronizacji |
| TOTP | Pole w loginie, bez liczenia kodów |
| Import/eksport | PassHolder JSON (bezstratny), Bitwarden JSON, NordPass CSV; we wtyczce i na Androidzie |
| Lista | Zakładka na typ, własne wyszukiwanie i „+” w każdej zakładce |

## 3. Format wpisu v3

Treść w szyfrogramie (AES-256-GCM, AAD bez zmian: `passholder/v2/entry/<id>`):

```json
{
  "v": 3,
  "type": "login",
  "name": "Poczta",
  "note": "",
  "fields": { "username": "jan", "password": "…", "totp": "", "urls": ["https://mail.example"], "androidApps": [] },
  "custom": [ { "label": "PIN do konta", "value": "1234", "hidden": true } ],
  "hlc": { "ms": 0, "c": 0, "d": "…" }
}
```

Wspólne pola: `v` (= 3), `type`, `name`, `note`, `fields`, `custom`, `hlc`. Wszystkie wartości tekstowe;
puste pole to `""`, pusta lista to `[]`.

| `type` | `fields` |
|---|---|
| `login` | `username`, `password`, `totp`, `urls: string[]`, `androidApps: string[]` (nazwy pakietów) |
| `contact` | `firstName`, `lastName`, `birthDate` (`RRRR-MM-DD` albo `""`), `phones: {label,value}[]`, `emails: {label,value}[]`, `addresses: {label,street,postalCode,city,country}[]` |
| `card` | `holder`, `number`, `expiry` (`MM/RR` albo `""`), `cvc`, `pin` |
| `note` | `{}` (treść w `note`; w aplikacji pola „Nazwa” i „Treść”) |
| `document` | `kind` (`id_card`, `passport`, `driving_license`, `student_id`, `other`), `number`, `fullName`, `issueDate`, `expiryDate` (`RRRR-MM-DD` albo `""`), `issuer` |

**Odczyt (TS: `core/src/p2p/entry.ts`, Kotlin: `EntryV2.kt` lub nowy `EntryV3.kt`):**
- Nieznany `type`, brak wymaganego pola, zły typ wartości albo nieznany dodatkowy klucz → błąd.
- Format dat i `expiry` sprawdzają tylko formularze, nie parser (import może przynieść inne zapisy).
- **Stara treść v2** `{name, username, password, hlc}` (bez `v`) → login z pustymi pozostałymi polami.
  Zapis zawsze tworzy v3, więc sejf przechodzi na v3 stopniowo, przy edycjach. To samo dotyczy lokalnych
  magazynów (`vaultV2` we wtyczce, sejf na telefonie).
- **Nagrobek** to dokładnie `{"hlc": …}`; każdy inny klucz → błąd (naprawa dawnego S2).
- **Limit:** szyfrogram (Base64) ≤ 64 KiB. Formularz nie zapisze większego wpisu („Wpis jest za duży”),
  import pomija taki wpis z powodem, host odrzuca żądanie z większym blobem (400).

## 4. Synchronizacja

Telefon jako host dalej nie odszyfrowuje wpisów. Zmiany:

- **Nowe ścieżki** `/p2p/v2/handshake` i `/p2p/v2/sync` (ta sama treść co v1). Parowanie `/p2p/v1/pair/*` i
  `/p2p/v1/ping` bez zmian.
- **Stara wtyczka** wołająca `/p2p/v1/handshake` lub `/p2p/v1/sync` dostaje `410 {"error":"update required"}`;
  starej wersji nie da się już zmienić, więc pokaże swój ogólny błąd synchronizacji.
- **Nowa wtyczka** przy starym telefonie dostaje 404 i pokazuje „Zaktualizuj aplikację na telefonie”.
- **Stronicowanie po bajtach:** w obu kierunkach na rundę najwyżej 500 zmian i najwyżej 512 KiB sumy blobów
  (ramki są w Base64, ×4/3: 768 KiB przekroczyłoby limit ciała 1 MiB); nadmiar idzie w kolejnych rundach
  (istniejące `more` i pętla rund). Host tnie też `conflicts` (budżet bajtów schodzi najpierw na nie, potem na
  `changes`). Ciało żądania dalej ≤ 1 MiB.
- Walidacja żądania (`validateP2pSyncRequest`, `HostSync.validate`): dodatkowo blob ≤ 64 KiB.

## 5. Ekrany (wtyczka i Android)

- **Zakładki:** Loginy (startowa), Kontakty, Karty, Notatki, Dokumenty. Android: dolny pasek nawigacji;
  wtyczka: rząd ikon z krótkimi podpisami. Każda zakładka ma własne wyszukiwanie (po nazwie i polu z opisu)
  i „+”, który dodaje wpis tego typu.
- **Wiersz listy:** ikona typu, nazwa, opis: login; `•••• 1234` dla karty; rodzaj dokumentu; pierwszy
  telefon kontaktu; pierwsza linia notatki.
- **Formularz:** pola typu; listy z „+ Dodaj” i „Usuń”; Notatka; Własne pola (etykieta, wartość,
  przełącznik „ukryte”). Generator haseł przy haśle loginu jak dziś.
- **Pola wrażliwe** (hasło, TOTP, CVC, PIN, numer karty, ukryte własne pola): zakryte, „Pokaż” i „Kopiuj”;
  schowek czyszczony jak dziś.
- Kliknięcie wpisu otwiera formularz (bez osobnego ekranu podglądu).
- **Aplikacje Androida:** na telefonie wybór z listy zainstalowanych aplikacji, we wtyczce ręczne wpisanie
  nazwy pakietu.
- Daty jako tekst z kontrolą formatu, bez kalendarza.
- **Odstępstwo (krok 3):** wybór aplikacji pokazuje tylko aplikacje z ikoną w launcherze (`<queries>` MAIN + LAUNCHER),
  a nie „listę zainstalowanych aplikacji”: pełna lista wymagałaby uprawnienia `QUERY_ALL_PACKAGES`. Pozostałe
  aplikacje wpisuje się ręcznie przyciskiem „+ Wpisz pakiet”.

## 6. Import i eksport (wtyczka i Android)

Jeden ekran „Import / eksport” z wyborem formatu. Na Androidzie pliki przez systemowy wybór pliku (Storage
Access Framework), bez uprawnień do pamięci. Przed eksportem ostrzeżenie, że plik jest jawny.

| Format | Import | Eksport |
|---|---|---|
| PassHolder JSON | wszystkie typy, bezstratnie | `{"format":"passholder","version":3,"entries":[…]}`; wpisy jak w punkcie 3 bez `hlc` |
| Bitwarden JSON | typy 1–4 | wszystkie typy |
| NordPass CSV | nagłówek z szablonu NordPass | ze stratą |

**Bitwarden JSON:**
- `type 1` → login (`login.uris[].uri` → `urls`, a adresy `androidapp://<pakiet>` → `androidApps`, `username`, `password`, `totp`); `type 2` → notatka;
  `type 3` → karta (`cardholderName`, `number`, `code` → `cvc`, `expMonth`/`expYear` → `MM/RR`);
  `type 4` → kontakt (`firstName`, `lastName`, `email`, `phone`, adres z `address1..3`, `postalCode`, `city`,
  `country`).
- `fields` typ 0 → własne pole, 1 → ukryte, 2 → własne pole z wartością `true`/`false`.
- Bez odpowiednika → własne pola: `card.brand`, `identity.title`, `middleName`, `company`, `ssn`,
  `passportNumber`, `licenseNumber`, `username`, `state`.
- Pomijane: `folders`, `folderId`, `favorite`, `passwordHistory`, daty, `collectionIds`, `organizationId`.
- Eksport: dokument → `type 4` (`passportNumber` lub `licenseNumber` według rodzaju, pozostałe pola i rodzaj
  w `fields`); PIN karty, kolejne telefony, e-maile, adresy → `fields`; aplikacje Androida → `uris` jako `androidapp://<pakiet>`.

**NordPass CSV** (nagłówek: `name,url,username,password,note,cardholdername,cardnumber,cvc,expirydate,zipcode,folder,full_name,phone_number,email,address1,address2,city,country,state,totp,shared_folder`):
- Typ rozpoznawany po kolumnach: wypełnione `cardnumber` → karta; `full_name`, `phone_number`, `email` lub
  `address1` → kontakt; tylko `name` i `note` → notatka; reszta → login. Kolumny szukane po nazwie.
- Kontakt: `full_name` dzielone po pierwszej spacji na imię i nazwisko.
- Eksport: pierwsze wartości do kolumn, nadmiar (kolejne adresy stron, telefony, własne pola, PIN, dokumenty
  jako notatki) dopisany do `note` jako linie `etykieta: wartość`.
- Obecny nagłówek wzięty z Bitwardena (`type`, `additional_urls`, `custom_fields`) zostaje zastąpiony.

**Wspólne:** duplikat (ten sam typ i identyczna treść w sejfie lub w pliku) → pominięty. Podsumowanie:
dodano, pominięto (z powodem i numerem wiersza/wpisu). Sejf zapisywany raz po całym imporcie. Parsery w TS
i Kotlinie testowane tymi samymi plikami przykładowymi (z fałszywymi danymi), wynik porównywany 1:1.

## 7. Testy

- Jednostkowe TS (`core/`, `extension/`) i Kotlin (`:core:test`).
- `core/test-vectors/v3.json`: wpis każdego typu, stary wpis v2, nagrobek, przykłady odrzucane; obie
  implementacje muszą dać ten sam wynik.
- Synchronizacja: stronicowanie po bajtach, 410/404, limit 64 KiB.
- Android: testy UI Robolectric + zrzuty ekranów; wtyczka: zrzuty ekranów.
- Import/eksport: pełny obieg PassHolder JSON dla każdego typu; pliki przykładowe Bitwarden i NordPass.
- Nowe testy ręczne w `docs/TESTY.md`: synchronizacja każdego typu, obieg eksport → import, komunikat o
  aktualizacji.

## 8. Kroki (1 krok = 1 wątek = 1 PR)

1. **Rdzeń v3 (TS + Kotlin):** model i parsery, odczyt v2 jako login, ścisłe nagrobki, limit 64 KiB,
   stronicowanie po bajtach, `/p2p/v2` + 410/404, wektory v3. UI bez zmian (pokazuje loginy).
2. **Wtyczka – ekrany:** zakładki, formularze, pola wrażliwe.
3. **Android – ekrany:** dolny pasek, formularze, wybór aplikacji.
4. **Import/eksport we wtyczce.**
5. **Import/eksport na Androidzie** (port parserów, wspólne pliki testowe).

Każdy krok aktualizuje `docs/SPEC.md`, `docs/SYNCHRONIZACJA.md`, `docs/FUNKCJE.md`, `docs/TESTY.md`.

## 9. Ryzyka

- Po kroku 1 obie aplikacje trzeba zaktualizować razem; inaczej synchronizacja nie działa (celowo).
- Format NordPass sprawdzony tylko na szablonie importu, nie na prawdziwym eksporcie.
- Ścisły parser (odrzuca nieznane klucze) wymaga, żeby TS i Kotlin zmieniały schemat jednocześnie.
