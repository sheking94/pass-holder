# Przeniesienie projektu na inny komputer (Ubuntu → Windows 11 Pro)

> Dokument historyczny: dotyczy wersji z serwerem na Raspberry Pi (przed planem 4).

Stan sprawdzony na Ubuntu 4 listopada 2026, w folderze `/home/sheking/Projekty/PassHolder`.
Niczego nie skopiowano ani nie usunięto; to tylko inwentaryzacja i instrukcja.

## 1. Co jest, a czego nie ma w GitHubie

Repozytorium `git@github.com:sheking94/pass-holder.git` jest w pełni wypchnięte:

- brak commitów niewypchniętych na żadnej gałęzi lokalnej (`git log --branches --not --remotes` jest puste),
- brak `git stash`,
- wszystkie gałęzie lokalne mają odpowiednik na `origin`.

Poza gitem w folderze są tylko:

| Ścieżka | Co to | Decyzja |
|---|---|---|
| `PassHolder/passholder-ca.key` | **klucz prywatny lokalnego CA** (`CN=PassHolder local CA`, ważny do 2036) | **skopiować, TAJNE** |
| `PassHolder/passholder-ca.crt` | certyfikat CA (publiczny) | skopiować |
| `pass-holder/android/app/screenshots/12-dwa-adresy.png`, `13-adresy-serwera.png` | zrzuty z testów, nieśledzone | niepotrzebne (testy Roborazzi je odtwarzają) |
| `pass-holder/android/local.properties` | ścieżka do Android SDK na Ubuntu | **nie kopiować**, Android Studio utworzy własny |
| `node_modules/`, `extension/dist/`, `android/*/build/`, `android/.gradle/`, `android/.idea/` | wyniki instalacji i budowania | nie kopiować, odtworzyć |
| `pass-holder/.superpowers/` | pusty katalog roboczy pluginu | nie kopiować |

Nie znaleziono plików `.env`, kopii sejfu w CSV, katalogów `~/passholder-ca` ani `~/passholder-tls`.
Serwer na Pi trzyma swój `server.key` i bazę na samym Pi, więc zmiana komputera ich nie dotyczy.

## 2. Co skopiować (pliki tajne)

1. **Klucz CA**: `/home/sheking/Projekty/PassHolder/passholder-ca.key` + `passholder-ca.crt`.
   Bez niego nowe certyfikaty serwera (`deploy/make-certs.sh`) podpiszesz tylko nowym CA, a wtedy
   trzeba od nowa instalować CA w Chrome i na telefonie. Odcisk SHA-256 do sprawdzenia po przeniesieniu:
   `B4:24:26:EC:71:E8:AC:26:2B:71:0A:DB:B0:9B:48:C6:A2:F7:12:64:4F:33:34:5B:91:AA:7A:E1:95:3E:D0:30`.
2. **Klucz podpisu aplikacji Android**: `/home/sheking/.android/debug.keystore`.
   Wydanie (`release`) jest podpisywane kluczem debug (`android/app/build.gradle.kts`, linia 23–25).
   Nowy komputer wygeneruje inny klucz, a Android **odmówi aktualizacji** aplikacji podpisanej innym
   kluczem. Jedyne wyjście to odinstalowanie, które **kasuje sejf z telefonu**. Na Windowsie plik
   trafia do `C:\Users\<użytkownik>\.android\debug.keystore` (zastąp ten wygenerowany przez Android Studio).
3. **Klucz SSH do GitHuba** (opcjonalnie): `/home/sheking/.ssh/id_ed25519` (+ `.pub`).
   Prościej jednak wygenerować nowy klucz na Windowsie (`ssh-keygen -t ed25519`) i dodać go w GitHubie
   (`gh ssh-key add`). Stary można potem usunąć z konta.

### Jak bezpiecznie przenieść

- Spakuj pliki do archiwum szyfrowanego hasłem, np. `7z a -p -mhe=on passholder-klucze.7z passholder-ca.key passholder-ca.crt debug.keystore`.
  Hasło przekaż inną drogą niż plik (albo zapamiętaj).
- Przenieś na pendrive albo bezpośrednio w sieci lokalnej. Nie wysyłaj mailem, komunikatorem ani na dysk w chmurze bez szyfrowania.
- Na Windowsie trzymaj `passholder-ca.key` poza folderem repozytorium (np. `C:\Users\<użytkownik>\passholder-ca\ca.key`)
  i ogranicz uprawnienia do własnego konta:
  `icacls ca.key /inheritance:r /grant:r "%USERNAME%:R"`.
- Po sprawdzeniu, że wszystko działa, usuń archiwum i kopię z pendrive'a.

## 3. Co wystarczy odtworzyć

| Co | Jak |
|---|---|
| Kod | `git clone git@github.com:sheking94/pass-holder.git` |
| Zależności JS | `npm ci` w katalogu głównym repo (workspaces: `core`, `server`, `extension`) |
| Wtyczka Chrome | `npm run build -w extension`, potem „Wczytaj rozpakowane” z `extension/dist` |
| Android | otwórz `android/` w Android Studio; ono utworzy `local.properties` i pobierze Gradle 8.14.3 |
| Tożsamość gita | `git config --global user.name "SheKing"` i `user.email` (na Ubuntu nie jest ustawiona globalnie) |
| Logowanie `gh` | `gh auth login` (token jest w pęku kluczy Ubuntu, nie da się go przenieść) |
| Claude Code | zaloguj się tym samym kontem; plugin superpowers i ustawienia konta pobiorą się same |

Konfiguracja Claude Code na Ubuntu to tylko `~/.claude/settings.json` z `"outputStyle": "Explanatory"`
(ustaw ponownie). Pamięć projektu Claude leży w `~/.claude/projects/-home-sheking-Projekty-PassHolder/memory/`
(dwa pliki, `MEMORY.md` i `p2p-sync-decision.md`). Na Windowsie katalog nazwie się inaczej, bo zależy od ścieżki
projektu, więc pliki można przekopiować ręcznie do nowego katalogu `memory/` albo pominąć: ta sama decyzja jest
opisana w `docs/SYNCHRONIZACJA_P2P.md`. Historia rozmów (`*.jsonl`) nie jest potrzebna.

## 4. Co zainstalować na Windows 11 Pro

- **Git for Windows** (z Git Bash). Zawiera `bash` i `openssl`, więc `deploy/make-certs.sh` uruchomisz w Git Bash.
- **Node.js 22 LTS** (na Ubuntu: v22.23.4, npm 10.9.9).
- **Android Studio** (zawiera JDK 17+ i SDK Manager). Doinstaluj Android SDK Platform 36 i Build-Tools 36.0.0;
  projekt ma `compileSdk = 36`, `targetSdk = 36`, Javę 17.
- **GitHub CLI** (`winget install GitHub.cli`).
- **Claude Code / aplikacja Claude Desktop**.
- **Tailscale** tylko jeśli chcesz z Windowsa łączyć się z Pi spoza domu (na Ubuntu jest zainstalowany, ale zatrzymany).
- Opcjonalnie **WSL (Ubuntu)**, jeśli wolisz pracować jak dotąd; wtedy klonuj repo wewnątrz WSL (`~/…`), nie na `C:\`.

## 5. Różnice na Windowsie

- **Końce linii.** Git for Windows domyślnie zamienia LF na CRLF, a skrypty bash z `\r` przestają działać.
  Ten PR dodaje `.gitattributes`, które wymusza LF dla `*.sh` i `android/gradlew` i zostawia `*.bat` bez zmian (już ma CRLF).
- **Budowanie Androida z wiersza poleceń**: `android\gradlew.bat assembleDebug` (zamiast `./gradlew`).
- **Skrypty z `deploy/`** (`make-certs.sh`, `vpn.sh`) uruchamiaj w Git Bash albo WSL. `vpn.sh` używa `sudo`
  i dotyczy Pi, więc i tak odpalasz go po SSH na Pi.
- **Ścieżki** w poleceniach z `docs/INSTALACJA.md` typu `~/passholder-ca` w Git Bash oznaczają `C:\Users\<użytkownik>\passholder-ca`.
- **Certyfikat CA w Chrome** na Windowsie: Chrome korzysta z magazynu systemowego, więc zaimportuj `passholder-ca.crt`
  przez `certmgr.msc` → „Zaufane główne urzędy certyfikacji” (albo w Chrome: Ustawienia → Prywatność → Zarządzaj certyfikatami).
- **ADB** do telefonu: sterownik USB Google z SDK Managera (Windows tego wymaga, Linux nie).

## 6. Po przeniesieniu

1. Zatwierdź nowy folder/urządzenie w projekcie Claude (pamięć projektu wskazuje dotąd ścieżkę `/home/sheking/Projekty/PassHolder`).
2. `npm ci && npm test` w repo, żeby sprawdzić środowisko JS.
3. Zbuduj aplikację Android i zainstaluj ją **jako aktualizację** na telefonie: jeśli instalacja się powiedzie bez odinstalowania,
   klucz podpisu przeniósł się poprawnie.
4. Sprawdź odcisk CA: `openssl x509 -in passholder-ca.crt -noout -fingerprint -sha256` (w Git Bash).
5. Dopiero potem usuń kopie przejściowe i, jeśli chcesz, wyczyść stary komputer.
