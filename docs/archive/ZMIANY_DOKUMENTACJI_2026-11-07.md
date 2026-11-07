# Porządki w dokumentacji (2026-11-07)

> Dokument historyczny: opisuje jednorazową zmianę po PR #26.

Podstawa: `main` @ `8e4935a`. Kod się nie zmienił, poza czterema komentarzami z odnośnikami do dokumentów.
`docs/` miało 15 dokumentów (ok. 190 KB) z powtórzeniami i historią planów; teraz ma 6 (ok. 73 KB).

## Nowa struktura

| Dokument | Z czego powstał |
|---|---|
| `INSTALACJA.md` | `INSTALACJA.md` + `DEZINSTALACJA.md` (sekcja „Dezinstalacja”, kroki D1–D7) |
| `ARCHITEKTURA.md` | bez spisu dokumentów (jest w README) i tabeli „Stare nazwy” (jest w `archive/README.md`) |
| `SPEC.md` | sekcje 5–7 o Pi zastąpione odnośnikiem; numeracja 1–8 |
| `SYNCHRONIZACJA.md` | `SYNCHRONIZACJA_P2P.md` + `P2P_RDZEN.md` + `P2P_ANDROID_RDZEN.md` + `P2P_TELEFON.md` + `P2P_WTYCZKA.md` |
| `FUNKCJE.md` | `WTYCZKA_PIN.md` + `WTYCZKA_IMPORT_EKSPORT_CSV.md` + `WTYCZKA_OTWIERANIE_W_KARCIE.md` + `ANDROID_ODCISK_PALCA.md` + blokada S1 z `archive/POPRAWKI_BEZPIECZENSTWA.md` |
| `TESTY.md` | dawny `TESTY.md` + testy ręczne z `P2P_TELEFON.md` §11 + tabele testów z dokumentów P2P |

Przeniesione do `archive/`: `P2P_USUNIECIE_SERWERA.md` i cztery wykonane plany (`superpowers/plans/` →
`archive/plany/`).

## Co usunięto z treści

- Statusy i historię planów 1–4, nazwy gałęzi, „co dalej w planie 3”, opis spike'a z Task 0 (wynik zostaje
  w `SYNCHRONIZACJA.md` §1).
- Uwagi typu „nazwy aktualne po PR #16” i „do planu 4 nazywało się…”.
- Tabelę „Dziś (Pi) / po zmianie” i plan zmian w repo (zrobione).
- Powtórzone tabele kodów HTTP, plików i testów (każda jest teraz w jednym miejscu).
- Instrukcję przejścia z wtyczki v1 przez CSV (dotyczyła jednorazowej aktualizacji z wersji z Pi).

## Poprawione przy okazji

- `extension/src/auto-lock.ts` wskazywał nieistniejący `docs/POPRAWKI_BEZPIECZENSTWA.md`; teraz `FUNKCJE.md`.
- Zrzuty odcisku palca to `13-…` do `19-…` (dokument podawał `12-…` do `18-…`).
- `Generator.kt` odwołuje się do `SPEC.md` §6 (było §8).

## Czego nie wiem na pewno

- Wyniki testów ręcznych T4 (Tailscale) i T7 (zgoda Chrome) nadal nie są zapisane; dokumenty mówią, że są
  niesprawdzone.
- Liczby testów w `TESTY.md` pochodzą z poprzedniej wersji dokumentu (2026-11-07), nie z nowego uruchomienia.
