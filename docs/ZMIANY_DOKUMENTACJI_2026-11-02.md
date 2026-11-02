# Aktualizacja dokumentacji i czyszczenie (2026-11-02)

Podstawa: `main` @ `3b30d6e` (po PR #18). Kod się nie zmienił; zmieniły się dokumenty i `.gitignore`.

## Co wiem na pewno, a co zakładam

**Sprawdzone:**

- `npm test` przed zmianami: core 68, server 24, extension 53, wszystkie zielone; `npm run typecheck` bez błędów.
- Każda nazwa funkcji, klasy i pliku w zaktualizowanych opisach istnieje w kodzie (sprawdzone wyszukiwaniem
  w repozytorium), a wszystkie odnośniki między dokumentami prowadzą do istniejących plików.
- Nieużywany kod: narzędzie `knip` zgłosiło 16 „nieużywanych” plików wtyczki, ale to fałszywy alarm (są
  punktami wejścia w `extension/build.mjs` albo importowane przez nie). Zgłoszone nieużywane eksporty są
  używane wewnątrz własnych plików. W Kotlinie nie ma klasy ani funkcji najwyższego poziomu bez użycia.
  Nie usunąłem więc żadnego kodu.

**Nie sprawdzone:**

- Testów Androida (Gradle) nie uruchamiałem; liczby w `TESTY.md` to liczba adnotacji `@Test` w plikach.

## Zaktualizowane dokumenty

| Plik | Co było nieaktualne | Co zrobiłem |
|---|---|---|
| `README.md` | Tabela z kolumną „Status”, brak spisu dokumentów | Krótki opis funkcji i spis dokumentacji |
| `docs/SPEC.md` | §6 „wdrożenie w kroku 2”, limit logowań „np. 5 na minutę”, brak kilku adresów, §9 mówiło, że eksport/import jest poza zakresem | Dokładne limity (5/min na IP, 20/min łącznie, 429), restart serwera i 401, kody błędów; kilka adresów w §7; nowy §9 z funkcjami klientów poza protokołem; §10 „Poza zakresem” |
| `docs/TESTY.md` | Liczby z 31.10, brak testów z PR #8–#18, odnotowany problem „mapy sesji nie są czyszczone” (naprawiony w N3), „popup.ts bez testów” (plik już podzielony) | Kolumna „Teraz”, tabela nowych plików testów, usunięty naprawiony problem, poprawione „Czego brakuje” |
| `docs/INSTALACJA.md` | „Używanie” we wtyczce i na telefonie bez PIN-u, CSV, „Otwórz w karcie”, odcisku palca i blokady 60 s | Dopisane te funkcje; awaryjne przeniesienie sejfu przez CSV w „Kopii zapasowej” i „Znanych ograniczeniach” |
| `docs/WTYCZKA_ZAKLADANIE_SEJFU.md`, `WTYCZKA_OTWIERANIE_W_KARCIE.md`, `WTYCZKA_PIN.md`, `WTYCZKA_IMPORT_EKSPORT_CSV.md`, `WIELE_ADRESOW_SERWERA.md`, `ANDROID_ODCISK_PALCA.md` | Opisywały kod sprzed PR #16 (`popup.ts`, `openSetupTab`, `lockOnLeave` …) z dopiskiem „część nazw się zmieniła” | Sekcje o kodzie przepisane na aktualne pliki i nazwy (`views/`, `ui/`, `page-mode.ts`, `PinStore`, `LockController`, `BiometricController`, `FingerprintDialog`); dopiski usunięte |
| `docs/ARCHITEKTURA.md` (nowy) | Nie było jednego miejsca z mapą kodu | Mapa wszystkich pakietów, przepływ synchronizacji, spis dokumentów i tabela starych nazw (przeniesiona z usuniętego `POPRAWKI_PRZEGLADU_2.md`) |

## Usunięte pliki

Decyzja: usuwam tylko raporty, których wszystkie punkty zostały zrobione (Twój wybór na karcie decyzji).
Oba pliki zostają w historii gita.

| Plik | Powód |
|---|---|
| `docs/PRZEGLAD_CZYSTOSCI_KODU_2.md` | Przegląd czystości kodu nr 2: wszystkie 20 punktów zrobione w PR #16. Opisywał kod, którego już nie ma (`popup.ts` 695 linii, `AppViewModel` 400 linii). |
| `docs/POPRAWKI_PRZEGLADU_2.md` | Opis poprawek do tego przeglądu. Jedyna wciąż przydatna część (układ plików wtyczki, tabela starych nazw) jest teraz w `ARCHITEKTURA.md`; opisy funkcji mają już aktualne nazwy, więc nie muszą na niego wskazywać. |

## Pozostawione celowo

| Plik | Dlaczego zostaje |
|---|---|
| `docs/PRZEGLAD_CZYSTOSCI_KODU.md` | Otwarte punkty: 2 (podział `buildApp`), 8 (`ConnectScreen`/`EditScreen`), 15–17; dopisałem na górze, które punkty zrobiono i w którym PR |
| `docs/PRZEGLAD_BEZPIECZENSTWA.md`, `docs/POPRAWKI_BEZPIECZENSTWA.md` | Otwarte N1, N2, N4–N7, I1–I5; `POPRAWKI_…` opisuje aktualny kod S1–S4 |
| `android/app/screenshots/*.png` | Zrzuty z testów Roborazzi, odświeżane przy każdym uruchomieniu testów; linkują do nich README, INSTALACJA i opis odcisku |
| `android/core/src/test/resources/interop.ts` | Używa go `RealServerTest` (test całego systemu) |

## Inne

- `.gitignore`: dopisane `*.db`, `*.db-wal`, `*.db-shm`. `npm start -w server` bez `PASSHOLDER_DB` tworzy
  `passholder.db` w katalogu roboczym i plik mógł przypadkiem trafić do commita.
