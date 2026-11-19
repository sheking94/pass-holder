# V3 krok 2: ekrany typów wpisów we wtyczce – plan wykonania

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Cel:** wtyczka pokazuje, dodaje, edytuje i usuwa wpisy wszystkich pięciu typów v3 (login, kontakt, karta, notatka, dokument): zakładki z własnym wyszukiwaniem i „+”, formularz każdego typu z listami, notatką i własnymi polami, pola wrażliwe zakryte z „Pokaż” i „Kopiuj”.

**Podejście:** logika bez DOM (opis wiersza, wyszukiwanie, puste wpisy, sprawdzanie formularza) w nowym `extension/src/entry-types.ts`, testowana w Node. `VaultStore` dostaje typowane API obok dzisiejszego API loginów (to zostaje dla CSV do kroku 4). Widoki budowane jak dziś funkcją `h()`; formularz to wspólna „skorupa” (nazwa, notatka, własne pola, Zapisz/Anuluj/Usuń) i sekcja pól typu w osobnym pliku. Widoki testowane w vitest z `happy-dom` i atrapą `chrome.*`; zrzuty ekranów skryptem Playwright (tylko w kontenerze).

**Stos:** TypeScript, esbuild, vitest + happy-dom (nowa zależność dev), Playwright (preinstalowany w kontenerze, nie jest zależnością).

**Spec:** `docs/superpowers/specs/2026-11-07-typy-wpisow-design.md` (sekcja 5, sekcja 8 krok 2). Format i synchronizacja z kroku 1 bez zmian.

## Ograniczenia globalne

- Bez zmian w `core/`, formacie wpisu, synchronizacji i Androidzie.
- Zakładki w tej kolejności, Loginy startowa: `login` 🔑 „Loginy”, `contact` 👤 „Kontakty”, `card` 💳 „Karty”, `note` 📝 „Notatki”, `document` 🪪 „Dokumenty”. Ikona + krótki podpis, szerokość okienka 360 px bez przewijania w poziomie.
- Opis w wierszu (spec): login → `username`; karta → `•••• ` + ostatnie 4 znaki numeru bez spacji (krótszy numer: cały; pusty: `""`); dokument → nazwa rodzaju; kontakt → pierwszy telefon (`value`); notatka → pierwsza niepusta linia `note`.
- Rodzaje dokumentu: `id_card` „Dowód osobisty”, `passport` „Paszport”, `driving_license` „Prawo jazdy”, `student_id` „Legitymacja”, `other` „Inny”. Domyślny dla nowego: `id_card`.
- Wyszukiwanie: bez rozróżniania wielkości liter, podciąg w `name + " " + opis wiersza`.
- Pola wrażliwe: hasło, TOTP, CVC, PIN, numer karty, własne pola z `hidden: true`. Zakryte (`type="password"`), przyciski „Pokaż/Ukryj” i „Kopiuj”. Kopia pola wrażliwego czyści schowek po `CLEAR_AFTER_MINUTES` (dzisiejszy mechanizm `password-copied`); kopia jawnego pola nie czyści.
- Formaty (sprawdza tylko formularz): daty `RRRR-MM-DD` (prawdziwa data kalendarzowa), ważność karty `MM/RR` (miesiąc 01–12); puste dozwolone. Sprawdzane jest tylko pole, którego wartość różni się od zapisanej (import z kroku 4 może przynieść inny zapis i otwarcie + zapis takiego wpisu nie może się wywrócić).
- Komunikaty błędów formularza (dokładnie): „Podaj nazwę”, „Podaj albo wygeneruj hasło” (login, jak dziś), „<Etykieta pola>: wpisz datę RRRR-MM-DD”, „Ważność: wpisz MM/RR”, „Wpis jest za duży”, „Ten wpis ma inny typ” (zapis pod `id` żywego wpisu innego typu).
- Przy zapisie: wartości tekstowe bez zmian (bez przycinania, poza `name`, które jest przycinane jak dziś); elementy list, w których wszystkie pola tekstowe są puste, są pomijane; puste własne pole (etykieta i wartość `""`) pomijane.
- Wpis otwiera się kliknięciem wiersza (bez osobnego podglądu). Wiersz loginu zachowuje przyciski „Login” i „Hasło” (kopiowanie).
- Po zapisie, anulowaniu i usunięciu lista wraca na zakładkę typu tego wpisu.
- Aplikacje Androida: ręczne wpisanie nazwy pakietu; format `^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$`, błąd „Aplikacje Androida: zła nazwa pakietu <x>” (tylko dla nowych/zmienionych elementów, jak daty).
- Import/eksport CSV bez zmian (loginy); w widoku eksportu zdanie „Na razie eksportowane są tylko loginy.”
- Po każdym zadaniu: `npm test`, `npm run typecheck`, `npm run build` w katalogu głównym. npm w kontenerze: `NO_PROXY=localhost npm ci --cafile=/root/.ccr/ca-bundle.crt` (instalacja paczki: `NO_PROXY=localhost npm i -D -w extension happy-dom@21.0.4 --cafile=/root/.ccr/ca-bundle.crt`).
- Teksty interfejsu po polsku, komentarze i nazwy w kodzie po angielsku (jak dziś).

## Na co uważać przy przeglądzie

1. Wpis z importu/innego urządzenia z datą w innym zapisie (np. `01.02.2030`) albo ważnością `2/2030`: otwarcie i „Zapisz” bez zmian tego pola przechodzi. Testy: zadanie 1 krok 1, zadanie 6 krok 1.
2. Edycja loginu zachowuje pola, których formularz nie zmieniał (np. `androidApps` po synchronizacji z telefonu), a zmiana typu wpisu jest niemożliwa. Testy: zadanie 2 krok 1, zadanie 5 krok 1.
3. Ukryte własne pole: zakryte przy otwarciu, „Pokaż” odkrywa, kopia czyści schowek; przełączenie „ukryte” zmienia zakrycie od razu. Test: zadanie 3 krok 1, zadanie 5 krok 1.
4. Pusty element listy dodany „+ Dodaj” i niewypełniony nie trafia do wpisu (inaczej każdy zapis rośnie). Testy: zadanie 1 krok 1, zadanie 6 krok 1.
5. Wyszukiwanie w zakładce Karty po końcówce numeru i w Kontaktach po telefonie; wyszukiwanie nie przecieka między zakładkami (fraza z Loginów nie filtruje Kart). Test: zadanie 4 krok 1.

---

### Zadanie 1: Logika typów bez DOM

**Pliki:**
- Utwórz: `extension/src/entry-types.ts`
- Test: `extension/test/entry-types.test.ts`

**Interfejsy:**
- Konsumuje z `@passholder/core` (`p2p`): `EntryType`, `EntryContentV3`, `DocumentKind`.
- Produkuje:
  ```ts
  export const ENTRY_TYPES: readonly EntryType[]; // kolejność zakładek
  export const TYPE_INFO: Record<EntryType, { icon: string; tab: string; newTitle: string; editTitle: string }>;
  //  newTitle/editTitle: „Nowy login”/„Edytuj login”, „Nowy kontakt”, „Nowa karta”, „Nowa notatka”, „Nowy dokument” (edycja: „Edytuj …”)
  export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string>;
  export function emptyContent(type: EntryType): EntryContentV3;          // login = p2p.emptyLogin(); document.kind = "id_card"
  export function entrySummary(content: EntryContentV3): string;          // opis wiersza
  export function matchesQuery(content: EntryContentV3, query: string): boolean;
  export function tidyContent(content: EntryContentV3): EntryContentV3;   // przycina name, usuwa puste elementy list i puste własne pola
  export function validateContent(content: EntryContentV3, original?: EntryContentV3): string | undefined; // komunikat albo undefined
  ```

- [ ] **Krok 1: Testy (najpierw czerwone)** – w `entry-types.test.ts`:
  - `entrySummary`: karta `"1234 5678 9012 3456"` → `"•••• 3456"`, `"12"` → `"•••• 12"`, `""` → `""`; dokument `passport` → `"Paszport"`; kontakt z telefonami `[{label:"dom",value:"+48 600"}, …]` → `"+48 600"`, bez telefonów → `""`; notatka `"\n\nPierwsza\nDruga"` → `"Pierwsza"`; login → `username`.
  - `matchesQuery`: karta `name:"Visa"`, numer kończący się `3456` pasuje do `"3456"` i `"visa"`, nie do `"7777"`; pusta fraza pasuje zawsze.
  - `tidyContent`: kontakt z `phones:[{label:"",value:""},{label:"praca",value:"1"}]` → zostaje tylko drugi; login `urls:["", "https://a.pl"]` → `["https://a.pl"]`; `custom:[{label:"",value:"",hidden:false}]` → `[]`; `name:"  X "` → `"X"`; wartości z wiodącą spacją w innych polach bez zmian.
  - `validateContent`: brak nazwy → `"Podaj nazwę"`; login bez hasła → `"Podaj albo wygeneruj hasło"`; kontakt `birthDate:"2026-02-30"` → `"Data urodzenia: wpisz datę RRRR-MM-DD"`; dokument `expiryDate:"30-01-2030"` → `"Data ważności: wpisz datę RRRR-MM-DD"` (etykiety: „Data urodzenia”, „Data wydania”, „Data ważności”); karta `expiry:"13/27"` → `"Ważność: wpisz MM/RR"`, `"02/27"` → `undefined`; `androidApps:["com"]` → `"Aplikacje Androida: zła nazwa pakietu com"`; **ta sama zła data jak w `original`** → `undefined` (punkt 1 przeglądu); pakiet obecny w `original.fields.androidApps` → nie sprawdzany.
  - `emptyContent` dla każdego typu przechodzi `p2p.parseEntryData({...c, v:3, hlc:{ms:0,c:0,d:"x"}})` (zgodność ze ścisłym parserem).
- [ ] **Krok 2:** `npm test -w extension -- entry-types` → FAIL (brak modułu).
- [ ] **Krok 3:** Implementacja w `entry-types.ts` według interfejsu i ograniczeń globalnych. Data: regex `^\d{4}-\d{2}-\d{2}$` + sprawdzenie przez `Date.UTC` i porównanie części.
- [ ] **Krok 4:** `npm test -w extension` → PASS; `npm run typecheck`.
- [ ] **Krok 5:** Commit `feat(extension): entry type helpers for v3 screens`.

### Zadanie 2: Typowane API `VaultStore`

**Pliki:**
- Modyfikuj: `extension/src/vault-store.ts`
- Test: `extension/test/vault-store-types.test.ts`

**Interfejsy:**
- Konsumuje: `p2p.upsertEntryV2`, `p2p.ENTRY_TOO_LARGE`, istniejące `tooLargeInPolish`, `requireVault`, `requireClock`, `save`.
- Produkuje (dzisiejsze `entries()/entry()/upsert()/importEntries()` zostają bez zmian, dla CSV):
  ```ts
  export interface StoredEntry { id: string; dirty: boolean; data: p2p.EntryContentV3 } // data bez v i hlc
  listEntries(type: p2p.EntryType): StoredEntry[];   // żywe wpisy tego typu, posortowane po name (localeCompare "pl")
  getEntry(id: string): StoredEntry | undefined;     // żywy wpis dowolnego typu
  putEntry(id: string, content: p2p.EntryContentV3): Promise<void>;
  ```

- [ ] **Krok 1: Testy** (z `pairedBrowser()` z `fake-phone.ts`):
  - `putEntry` karty i kontaktu → `listEntries("card")` zawiera tylko kartę, `getEntry` zwraca treść równą zapisanej, `dirty: true`; po `store.sync()` telefon ma wpis (odszyfrowany `phone` w teście jak w istniejących testach) i `dirty: false`.
  - `listEntries("login")` zwraca login dodany starym `upsert` (zgodność).
  - `putEntry("x", login)` gdy `x` to żywa karta → `rejects.toThrow("Ten wpis ma inny typ")`; po usunięciu (`delete`) ten sam `id` można zapisać innym typem.
  - Za duży wpis (notatka z 70 000 znaków) → `"Wpis jest za duży"`, nic nie zapisane.
  - Login z `androidApps:["pl.bank"]` zapisany `putEntry` → stary `upsert` tego `id` zmienia hasło i `getEntry(id).data.fields.androidApps` dalej `["pl.bank"]` (punkt 2 przeglądu).
- [ ] **Krok 2:** uruchom → FAIL.
- [ ] **Krok 3:** Implementacja. `putEntry` nie używa `loginContent`; zapisuje dokładnie podaną treść (bez `tidyContent` – to robi formularz).
- [ ] **Krok 4:** `npm test`, `npm run typecheck` → PASS.
- [ ] **Krok 5:** Commit `feat(extension): typed entry API in VaultStore`.

### Zadanie 3: Testy widoków w happy-dom + wspólne elementy UI

**Pliki:**
- Modyfikuj: `extension/package.json` (dev: `happy-dom@21.0.4`), `package-lock.json`
- Utwórz: `extension/test/ui/fake-chrome.ts`, `extension/src/ui/copy.ts`, `extension/src/ui/list-editor.ts`
- Modyfikuj: `extension/src/ui/dom.ts` (nowe `secretField`), `extension/src/views/list.ts` (kopiowanie przez `ui/copy.ts`)
- Test: `extension/test/ui/widgets.test.ts`

**Interfejsy:**
- Produkuje:
  ```ts
  // test/ui/fake-chrome.ts – pliki testów UI zaczynają się od: // @vitest-environment happy-dom
  export async function setupPopup(entries?: { id: string; content: p2p.EntryContentV3 }[]):
    Promise<{ app: HTMLElement; store: VaultStore; clipboard: string[]; messages: unknown[] }>;
  //  Tworzy <main id="app">, instaluje globalThis.chrome (storage.local/session na Map, runtime.sendMessage
  //  zapisuje do messages, runtime.getURL, permissions.contains → true; inne API rzuca), navigator.clipboard.writeText
  //  zapisuje do clipboard. Paruje przeglądarkę z FakePhone (jak pairedBrowser) na tych samych obszarach storage,
  //  dodaje entries przez putEntry, potem vi.resetModules() + dynamiczny import "../../src/ui/state.ts"
  //  i await store.resume(); zwraca store widoków.
  export function click(el: Element): Promise<void>;           // klik + oczekiwanie na mikrozadania
  export function byText(root: Element, text: string): HTMLElement; // pierwszy button/label o tym tekście, rzuca gdy brak

  // src/ui/copy.ts
  export function copyText(text: string, what: string, status: HTMLElement): Promise<void>;   // „Skopiowano <what>.”
  export function copySecret(text: string, what: string, status: HTMLElement): Promise<void>; // + password-copied, „… Schowek zostanie wyczyszczony za 1 min.”

  // src/ui/dom.ts (passwordField zostaje, dla innych ekranów)
  export function secretField(input: HTMLInputElement, what: string, status: HTMLElement):
    { row: HTMLElement; setVisible(v: boolean): void; setSecret(secret: boolean): void };
  //  setSecret(false): pole jawne, bez „Pokaż”, „Kopiuj” bez czyszczenia schowka (dla przełącznika „ukryte”)

  // src/ui/list-editor.ts
  export function listEditor<T>(o: { items: readonly T[]; empty: () => T; addLabel: string;
    row: (item: T) => { node: HTMLElement; read: () => T } }): { node: HTMLElement; read: () => T[] };
  //  każdy wiersz z przyciskiem „Usuń” (type="button"), na końcu „+ <addLabel>”
  ```

- [ ] **Krok 1: Testy** w `widgets.test.ts`: `secretField` – start zakryty, „Pokaż” → `type="text"`, „Kopiuj” → `clipboard` ma wartość i `messages` ma `{type:"password-copied"}`; `setSecret(false)` → jawne, kopia bez wiadomości. `listEditor` – „+ Dodaj” dodaje wiersz, „Usuń” usuwa, `read()` w kolejności wierszy. `setupPopup()` z jednym loginem → `store.listEntries("login")` ma 1 wpis.
- [ ] **Krok 2:** uruchom → FAIL.
- [ ] **Krok 3:** Implementacja; `views/list.ts` używa `copyText`/`copySecret` zamiast własnych `copyLogin`/`copyPassword` (teksty statusu: „Skopiowano login.”, „Skopiowano hasło. Schowek zostanie wyczyszczony za 1 min.” – bez zmian).
- [ ] **Krok 4:** `npm test`, `npm run typecheck`, `npm run build` → PASS.
- [ ] **Krok 5:** Commit `test(extension): happy-dom view tests, secret field and list editor`.

### Zadanie 4: Lista z zakładkami

**Pliki:**
- Modyfikuj: `extension/src/views/list.ts`, `extension/static/popup.css`
- Test: `extension/test/ui/list-view.test.ts`

**Interfejsy:**
- Konsumuje: `ENTRY_TYPES`, `TYPE_INFO`, `entrySummary`, `matchesQuery` (zadanie 1); `listEntries` (zadanie 2); `copyText/copySecret` (zadanie 3).
- Produkuje: `listView(message = "", isError = false, type?: p2p.EntryType)` – bez `type` pokazuje ostatnio wybraną zakładkę (zmienna modułu, start `"login"`). `editView(type, id?)` z zadania 5 (podpis zmieniony – wszystkie wywołania).

- [ ] **Krok 1: Testy:** pięć przycisków zakładek z `aria-pressed`, startowa Loginy; klik „Karty” pokazuje tylko karty z opisem `•••• 3456`; pole wyszukiwania w Kartach `"3456"` filtruje, a po przejściu na Loginy pole jest puste i lista pełna (punkt 5); Kontakty po telefonie; pusta zakładka → „Brak wpisów. Dodaj pierwszy.”; „+ Dodaj” w zakładce Notatki otwiera formularz z tytułem „Nowa notatka”; klik wiersza otwiera „Edytuj …” tego wpisu; wiersz loginu ma „Login” i „Hasło”, a „Hasło” kopiuje z czyszczeniem schowka; znacznik `•` dla niezsynchronizowanego.
- [ ] **Krok 2:** uruchom → FAIL.
- [ ] **Krok 3:** Implementacja. Wiersz: `<button class="entry-open">` z ikoną typu, nazwą i opisem (zastępuje przycisk „Edytuj”). Pasek zakładek `.tabs` (styl już jest w CSS; dopasuj na 5 przycisków: ikona nad podpisem, równa szerokość). Dolne przyciski (Synchronizuj, PIN, Zablokuj, Adresy telefonu, CSV) bez zmian.
- [ ] **Krok 4:** `npm test`, `npm run typecheck`, `npm run build` → PASS.
- [ ] **Krok 5:** Commit `feat(extension): tabs per entry type in the list`.

### Zadanie 5: Formularz – skorupa, notatka, własne pola, login

**Pliki:**
- Modyfikuj: `extension/src/views/edit.ts` (skorupa)
- Utwórz: `extension/src/views/forms/types.ts`, `forms/login.ts`, `forms/generator.ts` (wydzielony z dzisiejszego `edit.ts`), `forms/custom-fields.ts`, `forms/note.ts`
- Test: `extension/test/ui/edit-login.test.ts`

**Interfejsy:**
- Produkuje:
  ```ts
  // forms/types.ts
  export interface FieldsForm<T extends p2p.EntryType> {
    nodes: HTMLElement[];
    read(): Extract<p2p.EntryContentV3, { type: T }>["fields"];
  }
  // views/edit.ts
  export async function editView(type: p2p.EntryType, id?: string): Promise<void>;
  // forms/login.ts
  export async function loginForm(fields: p2p.LoginFields, status: HTMLElement): Promise<FieldsForm<"login">>;
  // forms/custom-fields.ts
  export function customFieldsEditor(items: readonly p2p.CustomField[], status: HTMLElement): { node: HTMLElement; read(): p2p.CustomField[] };
  ```
- Skorupa: tytuł z `TYPE_INFO`, „Nazwa”, sekcja typu, „Notatka” (`<textarea>`; dla typu `note` z etykietą „Treść” i bez osobnego pola notatki), fieldset „Własne pola” (etykieta, wartość, checkbox „ukryte”), Zapisz/Anuluj/Usuń (`confirmButton` jak dziś). Zapis: `tidyContent` → `validateContent(content, original)` → `store.putEntry` → `listView("Zapisano lokalnie. Zsynchronizuj, gdy telefon będzie w trybie Synchronizacja.", false, type)`.
- Login: Login, Hasło (`secretField` + generator jak dziś, zapamiętane ustawienia `STORAGE_KEYS.generator`), TOTP (`secretField`), „Adresy stron” (`listEditor` pól `type="url"`, „+ Dodaj adres”), „Aplikacje Androida” (`listEditor`, placeholder `np. pl.mbank`, „+ Dodaj aplikację”).

- [ ] **Krok 1: Testy:** nowy login z adresem, aplikacją, TOTP i ukrytym własnym polem → zapis → `store.getEntry` ma dokładnie te pola i `note`; edycja istniejącego loginu z `androidApps:["pl.bank"]` i `custom` – zmiana hasła zachowuje resztę (punkt 2); własne pole `hidden:true` otwiera się zakryte, odznaczenie „ukryte” odkrywa je od razu (punkt 3); „Generuj” wstawia hasło o długości z suwaka; brak hasła → „Podaj albo wygeneruj hasło”; notatka typu `note` zapisuje treść w `note` i `fields: {}`; „Usuń” dwa razy → wpis usunięty, lista na zakładce typu.
- [ ] **Krok 2:** uruchom → FAIL.
- [ ] **Krok 3:** Implementacja.
- [ ] **Krok 4:** `npm test`, `npm run typecheck`, `npm run build` → PASS.
- [ ] **Krok 5:** Commit `feat(extension): entry form shell, login and note forms`.

### Zadanie 6: Formularze kontaktu, karty i dokumentu

**Pliki:**
- Utwórz: `extension/src/views/forms/contact.ts`, `forms/card.ts`, `forms/document.ts`
- Modyfikuj: `extension/src/views/edit.ts` (wybór sekcji), `extension/src/views/transfer.ts` (zdanie o loginach)
- Test: `extension/test/ui/edit-types.test.ts`

**Interfejsy:**
- Produkuje: `contactForm(f: p2p.ContactFields): FieldsForm<"contact">`, `cardForm(f: p2p.CardFields, status: HTMLElement): FieldsForm<"card">`, `documentForm(f: p2p.DocumentFields): FieldsForm<"document">`.
- Kontakt: Imię, Nazwisko, Data urodzenia (placeholder `RRRR-MM-DD`), Telefony i E-maile (`listEditor`: etykieta + wartość), Adresy (`listEditor`: etykieta, ulica, kod pocztowy, miasto, kraj).
- Karta: Posiadacz, Numer (`secretField`, `inputmode="numeric"`), Ważność (placeholder `MM/RR`), CVC i PIN (`secretField`).
- Dokument: Rodzaj (`<select>` z `DOCUMENT_KIND_LABELS`), Numer, Imię i nazwisko, Data wydania, Data ważności, Wystawca.

- [ ] **Krok 1: Testy:** dla każdego typu: wypełnij → zapisz → `getEntry` równa się oczekiwanej treści (pełny obiekt); kontakt z dodanym i niewypełnionym telefonem zapisuje `phones: []` (punkt 4); karta: numer, CVC i PIN zakryte, „Kopiuj” przy CVC wysyła `password-copied`; ważność `13/27` → „Ważność: wpisz MM/RR”; dokument: zmiana rodzaju na Paszport zapisuje `kind:"passport"`; wpis kontaktu z `birthDate:"01.02.1990"` (dodany przez `setupPopup`) zapisuje się bez zmiany tego pola (punkt 1), a po wpisaniu `1990-02-30` → błąd.
- [ ] **Krok 2:** uruchom → FAIL.
- [ ] **Krok 3:** Implementacja.
- [ ] **Krok 4:** `npm test`, `npm run typecheck`, `npm run build` → PASS.
- [ ] **Krok 5:** Commit `feat(extension): contact, card and document forms`.

### Zadanie 7: Zrzuty ekranów i dokumentacja

**Pliki:**
- Utwórz: `extension/scripts/screenshots.mjs`, `extension/test/screens/harness.ts`
- Modyfikuj: `docs/FUNKCJE.md`, `docs/TESTY.md`, `docs/ARCHITEKTURA.md`, `docs/SPEC.md` (tylko jeśli coś tam opisuje ekrany wtyczki), `docs/superpowers/specs/2026-11-07-typy-wpisow-design.md` (nie zmieniać, chyba że wykonanie od niego odeszło – wtedy dopisać „Odstępstwo”)

**Interfejsy:**
- `node extension/scripts/screenshots.mjs <katalog>`: esbuild pakuje `harness.ts` (atrapa `chrome.*` jak w `fake-chrome.ts`, `FakePhone` w przeglądarce, przykładowe wpisy każdego typu z fałszywymi danymi), otwiera w Chromium (`require('playwright')`, szerokość 360 px, `deviceScaleFactor: 2`) stronę z `popup.css` i zapisuje: `01-loginy.png`, `02-kontakty.png`, `03-karty.png`, `04-notatki.png`, `05-dokumenty.png`, `06-formularz-login.png`, `07-formularz-kontakt.png`, `08-formularz-karta.png`, `09-formularz-dokument.png`, `10-pole-ukryte-pokazane.png`. Skrypt nie jest częścią `npm test`.

- [ ] **Krok 1:** Skrypt i harness; uruchom do `/mnt/project-files/wtyczka-v3/`, obejrzyj każdy zrzut (brak poziomego przewijania, zakładki w jednym rzędzie, pola wrażliwe zakryte).
- [ ] **Krok 2:** `docs/FUNKCJE.md`: sekcję „Stan ekranów po zmianie formatu wpisów” zastąp „Typy wpisów we wtyczce” (zakładki, opis wiersza, pola wrażliwe, sprawdzanie formatów tylko zmienionych pól, CSV nadal tylko loginy, Android nadal tylko loginy do kroku 3 – wpisy innych typów z wtyczki są tam synchronizowane, ale niewidoczne). `docs/ARCHITEKTURA.md`: nowe pliki wtyczki. `docs/TESTY.md`: liczby testów, testy widoków w happy-dom (usuń z „Czego brakuje” zdanie o widokach), skrypt zrzutów, test ręczny **T14** „Typy wpisów we wtyczce”: dodaj po jednym wpisie każdego typu, „Synchronizuj”, przeładuj wtyczkę → wpisy są, telefon ich nie gubi przy edycji loginu na telefonie.
- [ ] **Krok 3:** `npm test`, `npm run typecheck`, `npm run build` → PASS.
- [ ] **Krok 4:** Commit `docs: v3 extension screens` (zrzuty nie trafiają do repo).
