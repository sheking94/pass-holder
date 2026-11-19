# Porządki w repozytorium i dokumentacji (2026-11-19)

Stan: `main` @ `68a376c` (po PR #71, ostatniej grupie przeglądu czystości kodu V3). Zmieniona tylko
dokumentacja; kod i zachowanie bez zmian.

## Przeniesione do archiwum

| Było | Jest | Dlaczego |
|---|---|---|
| `docs/PRZEGLAD_BEZPIECZENSTWA_V3.md` | `docs/archive/` | wszystkie 5 grup poprawek zrobione (PR #51–#55); dopisano „Zrobione w PR #52” przy grupie 4 |
| `docs/PRZEGLAD_CZYSTOSCI_KODU_V3.md` | `docs/archive/` | grupy G1–G14 zrobione (PR #58–#71); dopisano brakujące „zrobione” przy G6 |
| `docs/superpowers/plans/*.md` (16) | `docs/archive/plany/` | plany wykonane |
| `docs/superpowers/specs/*.md` (4) | `docs/archive/specs/` | specyfikacje zrealizowane; stan opisują SPEC, FUNKCJE, ARCHITEKTURA |

Odnośniki w przeniesionych plikach i w dokumentach, które na nie wskazują, poprawione. Katalog `docs/superpowers/`
zniknął; skille superpowers założą go znowu przy następnym planie.

## Usunięte

Nic. Sprawdzone i potrzebne: wszystkie zrzuty w `android/app/screenshots/` (każdy tworzy jakiś test), skrypty w
`core/scripts/` (w tym `transfer-vectors.ts`, uruchamiany bez wpisu w `package.json`), pliki konfiguracyjne w
katalogu głównym.

## Poprawki zgodności z kodem

| Dokument | Zmiana |
|---|---|
| `README.md` | lista funkcji V3 (typy wpisów, pliki, autouzupełnianie, pytanie o zapis, ZIP, zmiana hasła), lint i formatowanie, wszystkie generatory wektorów, CI; spis dokumentów bez raportów przeglądów (są w archiwum) |
| `docs/ARCHITEKTURA.md` | `ChangePasswordScreen` w liście ekranów; odnośniki do raportów w archiwum; grupa 4 (PR #52) w stanie przeglądu bezpieczeństwa; nowa sekcja „Stan przeglądu czystości kodu” |
| `docs/SYNCHRONIZACJA.md` | po podziale `VaultStore` (G10): parowanie w `vault/pairing.ts`, pliki w `vault/files.ts`, sprzątanie to `VaultFiles.prune` (nie `pruneUnusedFiles`) |
| `docs/FUNKCJE.md` | „Zmiana hasła głównego” w spisie; cztery formaty importu i eksportu (był „trzy”); `repair` w `vault/pairing.ts`; martwa kotwica do SPEC (`#8-import-i-eksport` → `#4-wpisy`); odnośnik do specyfikacji typów wpisów w archiwum |
| `docs/TESTY.md` | liczby testów TS (core 40 plików / 690 testów, extension 36 / 415, przebieg 2026-11-19); brakujące pliki testów (`errors`, `error-messages`, `vault-store-archive`, `zip`, `passholder-zip`, `PassHolderZipTest`, `PhoneVaultStoreArchiveTest`, `TransferZipScreenTest`); czas testów ekranów (15–19 min); ktlint: reguła nazw plików włączona od G3 |
| `docs/archive/README.md` | nowe pozycje archiwum i uwaga o starych ścieżkach w planach V3 |

## Jak sprawdzone

- `npm ci` i `npm test`: 690 + 415 testów zielonych.
- Skrypt sprawdzający odnośniki Markdown (pliki i kotwice w stylu GitHuba) we wszystkich `.md` poza `.claude/`:
  0 błędów w aktualnych dokumentach.
- Nazwy plików i identyfikatory w `` `…` `` z aktualnych dokumentów porównane z kodem; poprawione te, których
  już nie ma (wyżej). Zostały celowo: nazwy historyczne opisane jako „zastąpione” (np. w „Ekrany i autouzupełnianie
  Androida”).
- Nie uruchomiono testów Androida (zmiana dotyczy tylko dokumentacji); liczby testów Androida w TESTY.md zostają z
  2026-11-15.
