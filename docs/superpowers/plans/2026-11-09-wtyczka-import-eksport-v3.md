# Import i eksport we wtyczce (V3, krok 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wtyczka importuje i eksportuje wszystkie typy wpisów w formatach PassHolder JSON (bezstratnie), Bitwarden JSON i NordPass CSV.

**Architecture:** Parsery i eksportery to czysty TS w `core/src/transfer/` (bez przeglądarki), wystawione jako
przestrzeń nazw `transfer` z `@passholder/core`. Pliki przykładowe z oczekiwanym wynikiem leżą w
`core/test-vectors/transfer/`, żeby krok 5 (Kotlin) porównał wynik 1:1. Wtyczka dostaje
`VaultStore.importContents` i nowy ekran `views/transfer.ts`; stary `extension/src/csv-transfer.ts` znika.

**Tech Stack:** TypeScript, vitest, happy-dom (testy widoków), Playwright (zrzuty).

**Spec:** `docs/superpowers/specs/2026-11-07-typy-wpisow-design.md` (sekcja 6) + decyzje właściciela z 2026-11-09 (niżej).

## Global Constraints

- Decyzje 2026-11-09 (zaakceptowane przez właściciela): (1) parsery w `core/src/transfer/`, pliki w `core/test-vectors/transfer/`; (2) import rozpoznaje format z treści pliku, wybór formatu tylko przy eksporcie; (3) kolumna `type` w CSV, jeśli jest, decyduje o typie (`password`, `note`, `credit_card`, `identity`); bez niej rozpoznawanie po kolumnach; (4) import Bitwarden identity z polem „Rodzaj dokumentu” odtwarza dokument; (5) duplikat = identyczna cała treść (typ, nazwa, notatka, pola, własne pola) po przycięciu spacji na brzegach każdego tekstu.
- PassHolder JSON: `{"format":"passholder","version":3,"entries":[…]}`, wpisy `{type,name,note,fields,custom}` (bez `v`, `hlc`).
- Nagłówek NordPass dokładnie: `name,url,username,password,note,cardholdername,cardnumber,cvc,expirydate,zipcode,folder,full_name,phone_number,email,address1,address2,city,country,state,totp,shared_folder`.
- Parser nie sprawdza formatu dat ani `expiry` (robią to tylko formularze).
- Wpis z szyfrogramem > 64 KiB: import pomija i liczy jako „za duży” (`p2p.ENTRY_TOO_LARGE`).
- Sejf zapisywany raz po całym imporcie.
- Teksty w UI po polsku. Pliki przykładowe tylko z fałszywymi danymi (`example.com`, „Jan Testowy”).
- Eksporty sortowane po nazwie (`localeCompare(…, "pl")`), przy równej nazwie w kolejności `ENTRY_TYPES` (login, contact, card, note, document).
- Nie zmieniać formatu wpisu v3 ani synchronizacji.

## Review Focus

- Plik Bitwarden zaszyfrowany (`"encrypted": true`) → czytelny błąd, nic nie zaimportowane (test w Task 3).
- Plik pusty, JSON uszkodzony albo nierozpoznany → błąd po polsku, sejf bez zmian (test w Task 5).
- Ten sam plik zaimportowany dwa razy → za drugim razem 0 dodanych, wszystko jako duplikaty (test w Task 5).
- Wpis PassHolder JSON z nieznanym kluczem albo złym typem → pominięty z numerem, reszta pliku wchodzi (test w Task 2).
- Wiersz CSV z mniejszą liczbą pól niż nagłówek → brakujące kolumny traktowane jako puste, bez wyjątku (test w Task 4).

---

### Task 1: Wspólne elementy `core/src/transfer/`

**Files:**
- Modify: `core/src/p2p/entry.ts` (nowa funkcja `parseEntryContent`)
- Create: `core/src/transfer/csv.ts` (przeniesione `parseCsv`, `toCsv` z `extension/src/csv-transfer.ts` bez zmian zachowania)
- Create: `core/src/transfer/common.ts`
- Create: `core/src/transfer/index.ts` (re-eksport wszystkich plików `transfer/`)
- Modify: `core/src/index.ts` (`export * as transfer from "./transfer/index.ts";`)
- Test: `core/test/transfer/common.test.ts`, `core/test/transfer/csv.test.ts` (testy `parseCsv` przeniesione z `extension/test/csv-transfer.test.ts`), dopisek w `core/test/p2p/entry-v3.test.ts`

**Interfaces:**
- Produces:
  - `p2p.parseEntryContent(value: unknown): EntryContentV3` – te same ścisłe reguły co `parseEntryData` dla v3, ale obiekt ma dokładnie klucze `type,name,note,fields,custom`; błąd `"Invalid entry payload"`. `parseEntryData` ma z niej korzystać (bez duplikacji walidacji pól).
  - `transfer.parseCsv(text: string): { line: number; fields: string[] }[]`, `transfer.toCsv(rows: readonly (readonly string[])[]): string`
  - `interface ImportSkip { at: string; reason: string }` – `at` gotowe po polsku: `"wiersz 3"` (CSV, nagłówek = wiersz 1) albo `"wpis 2"` (JSON, liczone od 1).
  - `interface ParsedImport { entries: EntryContentV3[]; skipped: ImportSkip[] }`
  - `contentKey(c: EntryContentV3): string` – JSON z kluczami w stałej (posortowanej) kolejności i każdym tekstem przyciętym; równe klucze = duplikat.
  - `sortForExport(entries: readonly EntryContentV3[]): EntryContentV3[]` – kopia posortowana wg Global Constraints.
  - `const SKIP_REASONS` nie wprowadzać; powody to zwykłe teksty w parserach.

- [ ] **Step 1: Testy (failing)**

```ts
it("parseEntryContent accepts content without v and hlc", () => {
  const c = { type: "note", name: "N", note: "x", fields: {}, custom: [] };
  expect(p2p.parseEntryContent(c)).toEqual(c);
});
it("parseEntryContent rejects v, hlc or an unknown key", () => {
  for (const extra of [{ v: 3 }, { hlc: { ms: 0, c: 0, d: "a" } }, { folder: "" }])
    expect(() => p2p.parseEntryContent({ type: "note", name: "N", note: "", fields: {}, custom: [], ...extra })).toThrow("Invalid entry payload");
});
it("contentKey ignores key order and outer spaces, not inner differences", () => {
  const a = { type: "note", name: " A ", note: "x", fields: {}, custom: [] } as const;
  const b = { custom: [], fields: {}, note: "x ", name: "A", type: "note" } as const;
  expect(contentKey(a)).toBe(contentKey(b));
  expect(contentKey(a)).not.toBe(contentKey({ ...a, note: "y" }));
});
it("sortForExport sorts by Polish name, then by type order", () => { /* "Łódź" po "Lublin"; login przed note przy tej samej nazwie */ });
```

- [ ] **Step 2:** `cd core && npx vitest run test/transfer test/p2p/entry-v3.test.ts` → FAIL (brak modułów).
- [ ] **Step 3:** Implementacja jak w Interfaces.
- [ ] **Step 4:** `cd core && npx vitest run && npx tsc --noEmit` → PASS (wszystkie stare testy też).
- [ ] **Step 5:** Commit `feat(core): transfer common helpers and parseEntryContent`.

### Task 2: PassHolder JSON

**Files:**
- Create: `core/src/transfer/passholder-json.ts`
- Create: `core/test-vectors/transfer/passholder.json` (po jednym wpisie każdego typu z niepustymi wszystkimi polami, listami po 2 elementy, własne pole ukryte i jawne; plus wpis z nieznanym kluczem i wpis `type:"wifi"`)
- Create: `core/test-vectors/transfer/passholder.expected.json` (`{entries, skipped}` = oczekiwany `ParsedImport`)
- Test: `core/test/transfer/passholder-json.test.ts`

**Interfaces:**
- Consumes: `parseEntryContent`, `sortForExport`, `ParsedImport` (Task 1)
- Produces:
  - `exportPassHolderJson(entries: readonly EntryContentV3[]): string` – `JSON.stringify({format:"passholder",version:3,entries: sortForExport(entries)}, null, 2) + "\n"`.
  - `parsePassHolderJson(text: string): ParsedImport` – rzuca `"To nie jest plik PassHolder w wersji 3"`, gdy brak `format:"passholder"`, `version !== 3` albo `entries` nie jest tablicą; zły wpis → `skipped: {at:"wpis N", reason:"zły format wpisu"}`.
  - `isPassHolderJson(value: unknown): boolean` – obiekt z `format === "passholder"` (dla wykrywania w Task 5).

- [ ] **Step 1: Testy (failing):** (a) `parsePassHolderJson(plik)` równa się `passholder.expected.json`; (b) obieg: `parsePassHolderJson(exportPassHolderJson(expected.entries)).entries` równa się `sortForExport(expected.entries)` – każdy typ bezstratnie; (c) `version: 2` → rzuca; (d) wpis z kluczem `folder` → pominięty jako `"wpis 6"` (numer zgodny z plikiem), pozostałe wchodzą.
- [ ] **Step 2:** `cd core && npx vitest run test/transfer/passholder-json.test.ts` → FAIL.
- [ ] **Step 3:** Implementacja.
- [ ] **Step 4:** test → PASS.
- [ ] **Step 5:** Commit `feat(core): PassHolder JSON import/export`.

### Task 3: Bitwarden JSON

**Files:**
- Create: `core/src/transfer/bitwarden-json.ts`
- Create: `core/test-vectors/transfer/bitwarden.json` – typy 1 (z `uris` https i `androidapp://com.example.app`, `totp`, `fields` typ 0/1/2/3), 2, 3 (z `brand`, `expMonth:"3"`, `expYear:"2027"`), 4 (z `title`, `middleName`, `company`, `ssn`, `username`, `state`, `address1..3`), 4 z polem „Rodzaj dokumentu”, typ 5, element bez nazwy; `folders` i `passwordHistory` niepuste.
- Create: `core/test-vectors/transfer/bitwarden.expected.json`
- Test: `core/test/transfer/bitwarden-json.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `parseBitwardenJson(text: string): ParsedImport`, `exportBitwardenJson(entries: readonly EntryContentV3[]): string`, `isBitwardenJson(value: unknown): boolean` (obiekt z tablicą `items`).

Mapowanie importu (spec 6 + decyzja 4):
- `encrypted: true` → rzuca `"Zaszyfrowany eksport Bitwarden nie jest obsługiwany. Wyeksportuj z Bitwardena plik JSON bez szyfrowania."`
- Wspólne: `name` (pusty → skip `"brak nazwy"`), `notes` (null → `""`) → `note`. `fields`: typ 0 → `{hidden:false}`, 1 → `{hidden:true}`, 2 → wartość `"true"`/`"false"`, `hidden:false`; typ 3 (powiązane) pomijane bez komunikatu. `null` → `""` wszędzie.
- typ 1: `uris[].uri` → `urls`, a `androidapp://<pakiet>` → `androidApps`; `username`, `password`, `totp`.
- typ 2 → notatka.
- typ 3: `cardholderName`→holder, `number`, `code`→cvc, `expMonth`/`expYear` → `MM/RR` (miesiąc dopełniony do 2 cyfr, rok = 2 ostatnie cyfry; gdy któreś puste → `""`), `brand` → własne „Marka karty”.
- typ 4: `firstName`, `lastName`, `email` → `emails:[{label:"",value}]`, `phone` → `phones:[{label:"",value}]`, adres (gdy cokolwiek niepuste) `{label:"", street: address1..3 niepuste złączone ", ", postalCode, city, country}`. Własne pola: „Tytuł” (title), „Drugie imię”, „Firma”, „Numer SSN”, „Numer paszportu”, „Numer prawa jazdy”, „Nazwa użytkownika”, „Województwo/stan” – tylko niepuste, w tej kolejności, przed polami z `fields`.
- typ 4 z własnym polem o etykiecie `Rodzaj dokumentu` i wartości z `DocumentKind` → dokument: `kind`; `number` = `passportNumber` || `licenseNumber` || pole „Numer dokumentu”; `fullName`, `issueDate`, `expiryDate`, `issuer` z pól „Imię i nazwisko”, „Data wydania”, „Data ważności”, „Wystawca”. Te pola znikają z `custom`, reszta zostaje.
- Inny typ N → skip `"typ N nie jest obsługiwany"`. `at` = `"wpis N"` (indeks w `items` od 1).

Mapowanie eksportu: `{"encrypted":false,"folders":[],"items":[…]}` (`JSON.stringify(…, null, 2)`), element `{type, name, notes, favorite:false, fields, <login|secureNote|card|identity>}`, `notes` puste → `null`, własne pola → `{name,value,type: hidden?1:0}`.
- login → typ 1: `uris` = urls i `androidapp://<pakiet>` jako `{match:null, uri}`.
- note → typ 2, `secureNote:{type:0}`.
- card → typ 3: `expiry` „MM/RR” → `expMonth` bez zera wiodącego, `expYear` `"20RR"`; inny zapis → oba `null` i własne „Ważność”. `brand:null`. PIN → pole `{name:"PIN",type:1}`.
- contact → typ 4: pierwszy telefon/e-mail/adres do pól identity; kolejne do `fields` jako „Telefon (etykieta)”, „E-mail (etykieta)”, „Adres (etykieta)” (bez nawiasu, gdy etykieta pusta; adres jako `ulica, kod miasto, kraj` z pominięciem pustych); `birthDate` → „Data urodzenia”.
- document → typ 4: `passport` → `passportNumber`, `driving_license` → `licenseNumber`, inne → pole „Numer dokumentu”; zawsze pole „Rodzaj dokumentu” (wartość = kod, np. `id_card`) oraz niepuste „Imię i nazwisko”, „Data wydania”, „Data ważności”, „Wystawca”.

- [ ] **Step 1: Testy (failing):** (a) plik = `bitwarden.expected.json`; (b) zaszyfrowany → rzuca podanym tekstem; (c) obieg dokument każdego rodzaju i notatka → bezstratnie; (d) obieg login (urls + androidApps + totp + custom) → bezstratnie; (e) karta: eksport `expiry:"03/27"` daje `expMonth:"3"`, `expYear:"2027"`, a PIN w `fields` z `type:1`.
- [ ] **Step 2:** `cd core && npx vitest run test/transfer/bitwarden-json.test.ts` → FAIL.
- [ ] **Step 3:** Implementacja.
- [ ] **Step 4:** test → PASS.
- [ ] **Step 5:** Commit `feat(core): Bitwarden JSON import/export`.

### Task 4: NordPass CSV

**Files:**
- Create: `core/src/transfer/nordpass-csv.ts`
- Create: `core/test-vectors/transfer/nordpass.csv` (nagłówek z szablonu; login, login bez nazwy z url, karta, kontakt, notatka, wiersz bez nazwy i url, wiersz krótszy niż nagłówek, pole z przecinkiem i nową linią)
- Create: `core/test-vectors/transfer/nordpass-typed.csv` (stary nagłówek PassHolder z kolumnami `type`, `additional_urls`, `custom_fields`; typy `password`, `note`, `credit_card`, `identity`, `folder`)
- Create: `core/test-vectors/transfer/nordpass.expected.json`, `nordpass-typed.expected.json`
- Test: `core/test/transfer/nordpass-csv.test.ts` (przenieść sensowne przypadki z `extension/test/csv-transfer.test.ts`)

**Interfaces:**
- Consumes: Task 1 (`parseCsv`, `toCsv`, `sortForExport`).
- Produces: `NORDPASS_COLUMNS` (21 kolumn, kolejność z Global Constraints), `parseNordPassCsv(text: string): ParsedImport`, `exportNordPassCsv(entries: readonly EntryContentV3[]): string`.

Import:
- Kolumny szukane po nazwie (bez wielkości liter, przycięte); brakująca kolumna albo krótszy wiersz → `""`. Plik pusty → `"Plik jest pusty"`; brak kolumny `name` i `url` → `"To nie wygląda na eksport z NordPass: brak kolumn name/url w pierwszym wierszu"`.
- Typ: jeśli jest kolumna `type` i niepusta wartość: `password`→login, `note`→notatka, `credit_card`→karta, `identity`→kontakt, inna → skip `typ „X” nie jest obsługiwany`. W przeciwnym razie: niepuste `cardnumber` → karta; niepuste `full_name`, `phone_number`, `email` lub `address1` → kontakt; niepuste tylko `name`/`note` (wszystkie inne kolumny poza `folder`, `shared_folder` puste) → notatka; reszta → login.
- Nazwa pusta → host z `url` bez `www.` (jak dziś `nameFromUrl`); dalej pusta → skip `"brak nazwy i adresu"`.
- login: `url` → `urls` (gdy niepusty), `username`, `password`, `totp`. Login bez hasła wchodzi (parser nie waliduje formularza).
- karta: `cardholdername`, `cardnumber`, `cvc`, `expirydate` (bez zmiany zapisu); `zipcode` → własne „Kod pocztowy”.
- kontakt: `full_name` dzielone po pierwszej spacji; `phone_number`, `email` → jednoelementowe listy z pustą etykietą; adres gdy coś niepuste z `address1`, `address2`, `zipcode`, `city`, `country`: `street` = `address1, address2` (puste pominięte); `state` → własne „Województwo/stan”.
- `note` → `note` dla każdego typu. `folder`, `shared_folder` i pozostałe kolumny ignorowane.

Eksport: `toCsv([NORDPASS_COLUMNS, ...wiersze])`, wiersz na wpis po `sortForExport`; nadmiar dopisany do `note` jako linie `etykieta: wartość` (po notatce i znaku nowej linii, gdy notatka niepusta), tylko niepuste:
- login: `url` = urls[0], kolejne „Adres strony: …”, „Aplikacja Androida: …”, `username`, `password`, `totp`.
- karta: `cardholdername`, `cardnumber`, `cvc`, `expirydate`; „PIN: …”.
- kontakt: `full_name` = `imię nazwisko` przycięte, pierwszy telefon/e-mail, pierwszy adres → `address1`=street, `zipcode`, `city`, `country`; kolejne „Telefon (etykieta): …”, „E-mail (etykieta): …”, „Adres (etykieta): …” (jak w Task 3), „Data urodzenia: …”.
- notatka: `name`, `note`.
- dokument → jako notatka: linie „Rodzaj dokumentu: <DOCUMENT_KIND_LABELS po polsku>”, „Numer: …”, „Imię i nazwisko: …”, „Data wydania: …”, „Data ważności: …”, „Wystawca: …”.
- Własne pola na końcu jako „etykieta: wartość” (także ukryte).
- Polskie nazwy rodzajów dokumentów skopiować do `core/src/transfer/nordpass-csv.ts` (stała `DOCUMENT_KIND_NAMES`); wtyczka nie zmienia swojej `DOCUMENT_KIND_LABELS`.

- [ ] **Step 1: Testy (failing):** (a) oba pliki = swoje `expected`; (b) eksport ma dokładnie nagłówek z Global Constraints; (c) obieg login (jedna strona, bez własnych pól), karta bez PIN, kontakt z jednym telefonem/e-mailem/adresem bez etykiet, notatka → bezstratnie; (d) dokument eksportuje się jako notatka z liniami w podanej kolejności; (e) krótszy wiersz nie rzuca.
- [ ] **Step 2:** `cd core && npx vitest run test/transfer/nordpass-csv.test.ts` → FAIL.
- [ ] **Step 3:** Implementacja.
- [ ] **Step 4:** test → PASS.
- [ ] **Step 5:** Commit `feat(core): NordPass CSV import/export for all entry types`.

### Task 5: Wykrywanie formatu i import do sejfu

**Files:**
- Create: `core/src/transfer/detect.ts`
- Modify: `extension/src/vault-store.ts` (`importContents` zamiast `importEntries`)
- Create: `extension/src/import-summary.ts` (przeniesione i uogólnione `importSummary`)
- Test: `core/test/transfer/detect.test.ts`, `extension/test/import.test.ts` (zastępuje część `extension/test/csv-transfer.test.ts`; plik `csv-transfer.test.ts` usunąć, gdy wszystkie jego przypadki mają odpowiednik)

**Interfaces:**
- Consumes: Task 2–4.
- Produces:
  - `type TransferFormat = "passholder" | "bitwarden" | "nordpass"`
  - `parseImportFile(text: string): { format: TransferFormat; parsed: ParsedImport }` – tekst (po zdjęciu BOM i spacji) zaczyna się od `{` → `JSON.parse` (błąd → `"Plik JSON jest uszkodzony"`), potem `isPassHolderJson` / `isBitwardenJson`, inaczej `"Nie rozpoznano pliku: to nie jest eksport PassHolder, Bitwarden ani NordPass"`; pusty tekst → `"Plik jest pusty"`; reszta → NordPass CSV.
  - `exportFile(format: TransferFormat, entries: readonly EntryContentV3[]): string`
  - `VaultStore.importContents(entries: readonly p2p.EntryContentV3[], newId?: () => string): Promise<ImportResult>` – pomija wpisy, których `contentKey` jest w sejfie (wszystkie typy, nie skasowane) albo wcześniej w tym imporcie; za duże liczy w `tooLarge`; zapis raz. `ImportResult` bez zmian.
  - `VaultStore.allContents(): p2p.EntryContentV3[]` – treść wszystkich żywych wpisów (do eksportu).
  - `importSummary(parsed: ParsedImport, result: ImportResult, format: TransferFormat): string` – jak dziś, ale lista pominiętych jako `${at}: ${reason}`, a ostatnie zdanie: „Usuń plik z dysku, zawiera hasła jawnym tekstem.”
  - Usunąć `VaultStore.importEntries`. `EntryFields`, `upsert`, `entries`, `entry` zostają (używają ich testy).

- [ ] **Step 1: Testy (failing):** detect: każdy z plików z `test-vectors/transfer/` daje swój format; `""`, `"{zły"`, `{"x":1}` → podane błędy. Import (`pairedBrowser` z `extension/test/fake-phone.ts`): (a) `passholder.json` → dodane wszystkie typy, `listEntries(typ)` je pokazuje; (b) drugi import tego samego pliku → `added: 0`, `duplicates` = liczba wpisów; (c) wpis różniący się tylko notatką → dodany; (d) wpis > 64 KiB → `tooLarge: 1`; (e) po imporcie synchronizacja wysyła wpisy na telefon (jak dziś w `csv-transfer.test.ts`); (f) błąd parsowania nie zmienia sejfu.
- [ ] **Step 2:** `npx vitest run` w `core` i `extension` → FAIL.
- [ ] **Step 3:** Implementacja.
- [ ] **Step 4:** `npm test && npm run typecheck` w katalogu głównym → PASS.
- [ ] **Step 5:** Commit `feat: detect import format and import all entry types`.

### Task 6: Ekran „Import i eksport”

**Files:**
- Modify: `extension/src/views/transfer.ts`, `extension/src/views/list.ts:107` (przycisk), `extension/src/page-mode.ts:9` (komentarz)
- Delete: `extension/src/csv-transfer.ts`
- Modify: `extension/test/screens/harness.ts`, `extension/scripts/screenshots.mjs` (nowy zrzut `11-import-eksport.png`)
- Test: `extension/test/ui/transfer-view.test.ts`

**Interfaces:**
- Consumes: `transfer.exportFile`, `transfer.parseImportFile`, `store.importContents`, `store.allContents`, `importSummary` (Task 5).
- Produces: `transferView()` i `openTransfer()` (nazwy bez zmian).

Ekran:
- Tytuł „Import i eksport”. Wstęp: „Import rozpoznaje format sam: PassHolder JSON, Bitwarden JSON (bez szyfrowania) albo NordPass CSV.”
- Eksport: trzy pola `radio` `name="format"`: „PassHolder JSON (wszystko, bez strat)” (domyślne), „Bitwarden JSON”, „NordPass CSV”. Pod Bitwarden/NordPass podpowiedź „Część pól trafi do notatki lub własnych pól.” Ostrzeżenie o jawnym pliku jak dziś (słowo „CSV” → „plik”). Checkbox „Rozumiem, plik będzie zawierał hasła jawnym tekstem”. Przycisk „Pobierz plik”. Nazwy plików: `passholder-RRRR-MM-DD.json`, `bitwarden-RRRR-MM-DD.json`, `nordpass-RRRR-MM-DD.csv`; typ MIME `application/json` albo `text/csv;charset=utf-8`. Status: „Wyeksportowano N wpisów. Usuń plik, gdy nie będzie już potrzebny.”
- Import: `accept=".json,.csv,application/json,text/csv"`, opis „Wpisy, które już są w sejfie z identyczną treścią, zostaną pominięte.”, przycisk „Importuj”, status = `importSummary`.
- Lista: przycisk „CSV” → tekst „Plik”, `title` „Import i eksport (PassHolder JSON, Bitwarden JSON, NordPass CSV)”.

- [ ] **Step 1: Testy (failing, happy-dom jak `extension/test/ui/list-view.test.ts`):** (a) bez checkboxa eksport pokazuje błąd i nic nie pobiera; (b) eksport każdego formatu tworzy link z właściwą nazwą pliku (podmień `URL.createObjectURL` i przechwyć `download`); (c) import pliku `passholder.json` (obiekt `File` w `input.files` przez `Object.defineProperty`) pokazuje „Dodano 5 wpisów”; (d) import uszkodzonego pliku pokazuje błąd jako status błędu.
- [ ] **Step 2:** `cd extension && npx vitest run test/ui/transfer-view.test.ts` → FAIL.
- [ ] **Step 3:** Implementacja; usuń `csv-transfer.ts`.
- [ ] **Step 4:** `npm test && npm run typecheck && npm run build` → PASS; `node extension/scripts/screenshots.mjs /tmp/claude-0/shots` → skrypt przechodzi (bez poziomego przewijania), zrzut `11-import-eksport.png` obejrzany i skopiowany do `/mnt/project-files/wtyczka-v3/`.
- [ ] **Step 5:** Commit `feat(extension): import/export screen for all formats`.

### Task 7: Dokumentacja

**Files:**
- Modify: `docs/FUNKCJE.md` (sekcja „Import i eksport CSV” → „Import i eksport”: formaty, mapowania w skrócie, duplikaty, kod), `docs/SPEC.md` (format pliku PassHolder JSON), `docs/ARCHITEKTURA.md` (`core/src/transfer/`), `docs/TESTY.md` (nowe pliki testów i `test-vectors/transfer/`; test ręczny: eksport PassHolder JSON → nowy sejf/inna przeglądarka → import → te same wpisy; import pliku z Bitwardena i NordPass)
- Modify: `docs/superpowers/specs/2026-11-07-typy-wpisow-design.md` sekcja 6: dopisać „Decyzje kroku 4 (2026-11-09)” – 5 decyzji z Global Constraints i nazwy pól (etykiety własnych pól z Task 3–4), żeby krok 5 je przeniósł.

- [ ] **Step 1:** Zmiany w dokumentach (krótko, po polsku, styl istniejących plików; usunąć zdanie „CSV nadal tylko loginy”).
- [ ] **Step 2:** `grep -rn "csv-transfer" docs extension core` → brak trafień poza archiwum.
- [ ] **Step 3:** Commit `docs: import/export for all entry types`.
