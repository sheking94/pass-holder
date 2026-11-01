# Wtyczka Chrome: import i eksport haseł w CSV (format NordPass)

Dokument opisuje zmiany z gałęzi `claude/project-thread-v0cuwv`.

## Jak tego używać

1. Otwórz wtyczkę i odblokuj sejf.
2. Na liście kliknij **CSV**. Otworzy się karta **Import i eksport CSV** (to ta sama strona `popup.html`,
   tylko z `?transfer` w adresie). Jeśli sejf jest zablokowany, karta najpierw poprosi o hasło główne.
3. **Eksport:** zaznacz „Rozumiem, plik będzie zawierał hasła jawnym tekstem” i kliknij **Pobierz plik CSV**.
   Plik `passholder-RRRR-MM-DD.csv` trafi do folderu Pobrane (albo Chrome zapyta, gdzie go zapisać).
4. **Import:** wybierz plik CSV wyeksportowany z NordPass (albo z PassHolder) i kliknij **Importuj**.
   Pod przyciskami pojawi się podsumowanie: ile dodano, ile pominięto jako duplikaty, które wiersze i dlaczego
   zostały pominięte.
5. Zaimportowane wpisy są tylko lokalne (oznaczone • na liście). Kliknij **Synchronizuj**, żeby trafiły na serwer.
6. Usuń plik CSV z dysku, gdy nie jest już potrzebny.

## Dlaczego w osobnej karcie

Chrome zamyka okienko wtyczki, gdy traci ono fokus. Okno wyboru pliku zabiera fokus, więc w okienku
wybrany plik nigdy by nie dotarł do kodu (to ten sam problem co z oknem zgody przy zakładaniu sejfu, patrz
`WTYCZKA_ZAKLADANIE_SEJFU.md`). W karcie strona żyje dalej.

Odblokowany sejf jest trzymany w `chrome.storage.session`, które jest wspólne dla okienka i karty, więc
karta zwykle nie pyta drugi raz o hasło (`store.resume()`).

## Pliki

| Plik | Co robi |
|---|---|
| `extension/src/csv-transfer.ts` | Nowy. Parser i generator CSV oraz układ kolumn NordPass. Czyste funkcje bez Chrome, łatwe do testowania. |
| `extension/src/vault-store.ts` | Nowa metoda `importEntries`. |
| `extension/src/popup.ts` | Przycisk **CSV** na liście, widok `transferView`, obsługa `?transfer` przy starcie i po odblokowaniu. |
| `extension/static/popup.css` | Dwie klasy: `.warning` (czerwony tekst ostrzeżenia) i `label.check` (pole wyboru z opisem). |
| `extension/test/csv-transfer.test.ts` | Nowe testy. |

## Format pliku

Nagłówek eksportu (kolejność jak w NordPass):

```
name,url,additional_urls,username,password,note,cardholdername,cardnumber,cvc,expirydate,zipcode,folder,full_name,phone_number,email,address1,address2,city,country,state,type,custom_fields
```

PassHolder przechowuje tylko nazwę, login i hasło, więc przy eksporcie wypełnia `name`, `username`,
`password` i `type=password`, a resztę kolumn zostawia pustą. Kodowanie UTF-8, końce wierszy CRLF.

**Czego nie jestem pewien:** nie miałem dostępu do prawdziwego pliku z NordPass ani do ich strony pomocy.
Listę kolumn wziąłem z importera NordPass w Bitwardenie (kod open source, który czyta eksporty NordPass).
Dlatego import **nie zależy od kolejności kolumn**: szuka ich po nazwie w pierwszym wierszu i wymaga tylko
`password` oraz `name` albo `url`. Jeśli NordPass ma dziś inną kolejność, import i tak zadziała; eksport
mógłby wtedy mieć kolumny w innej kolejności niż NordPass, co nie przeszkadza programom czytającym po nazwach
(tak robi m.in. Bitwarden). Najlepiej sprawdzić to na swoim pliku z NordPass.

### Import: które wiersze są brane

Funkcja `parseNordPassCsv`:

- `type` = `password` albo brak kolumny `type` → wpis jest importowany.
- Inny `type` (`note`, `credit_card`, `identity`…) → pominięty, bo PassHolder nie ma gdzie tego zapisać.
- Pusta `name`, ale jest `url` → nazwą zostaje host z adresu bez `www.` (np. `https://www.example.com/login` → `example.com`).
- Brak nazwy i adresu albo brak hasła → pominięty z podaniem powodu.
- Pozostałe kolumny (notatka, folder, dodatkowe adresy, pola własne) są ignorowane.

Numer wiersza w komunikacie to numer linii w pliku (nagłówek = 1). Gdy pole w cudzysłowie zawiera
przejście do nowej linii, kolejne wiersze mają odpowiednio większe numery, tak jak w edytorze tekstu.

### Duplikaty

`VaultStore.importEntries` pomija wpis, jeśli w sejfie (albo wcześniej w tym samym pliku) jest już wpis
z identyczną nazwą, loginem i hasłem. Dzięki temu dwukrotny import tego samego pliku niczego nie dubluje.
Wpis z tą samą nazwą i loginem, ale innym hasłem, jest dodawany jako nowy (niczego nie nadpisujemy po cichu);
starszy trzeba usunąć ręcznie, jeśli jest niepotrzebny.

Każdy dodany wpis dostaje nowy identyfikator (`crypto.randomUUID()`), trafia do sejfu przez `upsertEntry`
z rdzenia jako zmiana lokalna (`dirty`), a sejf jest zaszyfrowany i zapisany na dysk **raz**, po całym
imporcie, a nie po każdym wpisie.

## Parser CSV (`parseCsv`)

Prosty automat znak po znaku zgodny z RFC 4180:

- pole w cudzysłowie może zawierać przecinki, przejścia do nowej linii i `""` (oznacza jeden cudzysłów),
- końce linii CRLF lub LF,
- znak BOM na początku pliku (dodają go niektóre programy, np. Excel) jest usuwany,
- puste linie są pomijane,
- niezamknięty cudzysłów kończy się błędem „Plik CSV jest uszkodzony”.

Generator (`toCsv`) bierze pole w cudzysłów, jeśli zawiera przecinek, cudzysłów, nową linię albo spacje na
początku/końcu (żeby żaden program ich nie obciął). Hasło jest zapisywane dokładnie tak, jak jest.

## Bezpieczeństwo

- Eksport to **jedyne miejsce, gdzie hasła opuszczają sejf niezaszyfrowane**. Dlatego przycisk eksportu działa
  dopiero po zaznaczeniu pola „Rozumiem…”, a nad nim jest czerwone ostrzeżenie. Po eksporcie i imporcie
  komunikat przypomina o usunięciu pliku.
- Plik powstaje w pamięci przeglądarki (`Blob`) i jest zapisywany przez zwykłe pobieranie; nic nie idzie
  do serwera.
- Celowo **nie** ma zabezpieczenia przed „formułami” w arkuszach (dopisywania `'` przed wartościami
  zaczynającymi się od `=`, `+`, `-`, `@`). Hasła często tak się zaczynają, a takie dopisanie zepsułoby je
  przy imporcie do NordPass. Nie otwieraj tego pliku w Excelu ani w Arkuszach Google.
- Import nie wysyła niczego na serwer; dopiero **Synchronizuj** szyfruje nowe wpisy i je wysyła, jak każdą zmianę.

## Testy

`extension/test/csv-transfer.test.ts`:

- parser: cudzysłowy, przecinki, `""`, nowe linie w polu, CRLF, BOM, puste linie, ostatni wiersz bez
  końca linii, niezamknięty cudzysłów;
- eksport: nagłówek NordPass, sortowanie po nazwie, `type=password`;
- eksport → import daje te same wpisy (także hasło z przecinkiem, cudzysłowem, nową linią i spacjami);
- import: tylko loginy, kolumny po nazwie w dowolnej kolejności, nazwa z URL, powody pominięcia, plik
  niebędący eksportem NordPass, pusty plik, sam nagłówek;
- `importEntries` na prawdziwym serwerze: pomijanie duplikatów (z sejfu i z pliku), wpisy jako zmiany
  lokalne, synchronizacja po imporcie.

Uruchomienie: `npm test --workspace extension` (albo `npm test` w katalogu głównym).

## Ograniczenia

- Przenoszone są tylko nazwa, login i hasło. Adres strony, notatki i foldery z NordPass giną przy imporcie,
  bo model wpisu PassHolder ich nie ma (rozszerzenie modelu wymagałoby zmian w rdzeniu i na Androidzie).
- Nie ma importu z innych menedżerów (Chrome, Bitwarden, KeePass); format jest jeden.
- Import na Androidzie nie jest częścią tego kroku.
