# Dezinstalacja PassHolder

Jak usunąć wtyczkę, aplikację na telefonie i narzędzia, które zainstalowała [INSTALACJA.md](INSTALACJA.md).
Kroki 1 i 2 usuwają sejf; reszta jest opcjonalna.

## 0. Najpierw kopia haseł

Po krokach 1 i 2 sejfu nie ma już nigdzie. Jeśli hasła mają przetrwać (np. przenosisz je do innego
menedżera), zrób kopię **przed** usunięciem:

1. Na telefonie **Synchronizacja**, we wtyczce **Synchronizuj**, żeby wtyczka miała wszystkie wpisy.
2. We wtyczce **CSV** → zaznacz „Rozumiem, plik będzie zawierał hasła jawnym tekstem” → **Pobierz plik CSV**.
3. Sprawdź, że plik nie jest pusty, zaimportuj go tam, gdzie trzeba, i **usuń go** (także z Kosza). Plik
   zawiera hasła jawnym tekstem.

Jeśli usuwasz tylko jedną część (np. wtyczkę z jednego komputera), druga zachowuje sejf i kopia nie jest
potrzebna.

## 1. Wtyczka w Chrome

1. Opcjonalnie: zablokuj sejf i na ekranie blokady kliknij **Odłącz tę przeglądarkę** (dwa razy, drugie
   kliknięcie potwierdza). To usuwa konto i sejf z pamięci wtyczki.
2. `chrome://extensions` → na karcie PassHolder **Usuń** → potwierdź. Chrome usuwa razem z wtyczką całą jej
   pamięć (zaszyfrowany sejf, PIN, adresy telefonu) i zgody na adresy telefonu.

Powtórz w każdej przeglądarce, w której była wtyczka.

## 2. Aplikacja na telefonie

1. Opcjonalnie: **Zablokuj** → **Usuń sejf z telefonu** → **Usuń**.
2. Odinstaluj aplikację: przytrzymaj ikonę PassHolder → odinstaluj (albo Ustawienia → Aplikacje →
   PassHolder → Odinstaluj). Z komputera przez USB:

   ```powershell
   & "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" uninstall io.github.sheking94.passholder
   ```

Odinstalowanie usuwa wszystkie dane aplikacji: sejf, listę sparowanych wtyczek, ustawienia i klucze w
Android Keystore (klucz odcisku palca i klucz tożsamości telefonu). Kopii w chmurze Google aplikacja nie
robi, więc nic nie zostaje.

Na koniec możesz wyłączyć **Debugowanie USB** w Opcjach programisty i cofnąć zgodę dla komputera
(„Cofnij autoryzacje debugowania USB”, nazwa zależy od producenta).

## 3. Sparowane urządzenia

Jeśli usuwasz tylko jedną wtyczkę, a telefon zostaje: na telefonie **Urządzenia** → przy tej przeglądarce
**Usuń** → **Usuń**. Telefon przestaje się z nią synchronizować. Po odinstalowaniu aplikacji (krok 2) ten
krok nie jest potrzebny.

## 4. Tailscale (opcjonalnie)

Jeśli instalowałeś Tailscale tylko dla PassHoldera:

- Windows: Ustawienia → Aplikacje → Tailscale → Odinstaluj (albo `winget uninstall Tailscale.Tailscale`).
- Telefon: odinstaluj aplikację Tailscale.
- Na stronie konta Tailscale (Machines) usuń oba urządzenia, jeśli zostały na liście.

## 5. Repozytorium i wyniki budowania (opcjonalnie)

W katalogu repozytorium leżą tylko wyniki instalacji i budowania (nie ma w nich haseł):

```powershell
cd C:\Users\krzys\Projekty\PassHolder
Remove-Item -Recurse -Force node_modules, extension\dist, android\build, android\app\build, android\core\build, android\.gradle -ErrorAction SilentlyContinue
```

Albo usuń cały katalog `C:\Users\krzys\Projekty\PassHolder`, jeśli kod nie jest Ci już potrzebny.
`android\local.properties` zawiera tylko ścieżkę do Android SDK.

**Klucz podpisu** `C:\Users\krzys\.android\debug.keystore` usuwaj tylko wtedy, gdy nie budujesz już żadnych
aplikacji na Androida: Android Studio używa go dla wszystkich projektów i utworzy nowy przy następnej budowie.

## 6. Narzędzia na Windows (opcjonalnie)

Jeśli nie są potrzebne do niczego innego:

- **Android Studio**: Ustawienia → Aplikacje → Android Studio → Odinstaluj; potem usuń Android SDK
  (`%LOCALAPPDATA%\Android\Sdk`) i pamięć podręczną Gradle (`%USERPROFILE%\.gradle`).
- **JDK 21**: usuń katalog `%USERPROFILE%\.jdks\jbr-21.0.11`.
- **Node.js przez fnm**: `fnm uninstall 22`, potem `winget uninstall Schniz.fnm`; wiersz `fnm env …` usuń z
  `$PROFILE`, jeśli go tam dopisałeś. Pamięć podręczna npm: `%LOCALAPPDATA%\npm-cache`.
- **Git for Windows**: Ustawienia → Aplikacje → Git → Odinstaluj.
