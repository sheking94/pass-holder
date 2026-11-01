# Instalacja PassHolder

Instrukcja krok po kroku dla trzech części systemu:

1. [Serwer na Raspberry Pi 4B](#część-1-serwer-na-raspberry-pi) – przechowuje zaszyfrowany sejf i synchronizuje klientów.
2. [Wtyczka do Chrome na Ubuntu](#część-2-wtyczka-do-chrome) – pierwszy klient, zakłada sejf.
3. [Aplikacja na Androida](#część-3-aplikacja-na-androida) – drugi klient, łączy się z istniejącym sejfem.

Na końcu: [aktualizacje](#aktualizacje), [kopia zapasowa](#kopia-zapasowa), [rozwiązywanie problemów](#rozwiązywanie-problemów)
i [znane ograniczenia](#znane-ograniczenia).

## Zanim zaczniesz

### Jak to działa w skrócie

```
 Ubuntu: Chrome + wtyczka ──┐                        ┌── Android: aplikacja
                            │  HTTPS :8443           │
                            ▼  (LAN albo Tailscale)  ▼
                     Raspberry Pi: passholder.service (Node.js + SQLite)
```

Hasła są szyfrowane na urządzeniach (Argon2id + AES-256-GCM, opis w [SPEC.md](SPEC.md)). Pi widzi tylko
zaszyfrowane dane. Klienci działają offline, a z Pi synchronizują się, gdy jest włączone.

### Kolejność

Instaluj w tej kolejności: **Pi → wtyczka → telefon**. Sejf zakłada pierwszy klient przy pomocy
jednorazowego tokena z logu serwera; kolejne urządzenia łączą się przyciskiem „Mam już sejf”.
Sejf można też założyć z telefonu, kolejność klientów nie jest wymuszona przez kod.

### Wartości przykładowe

| Co | Przykład w tej instrukcji | Skąd wziąć swoją |
|---|---|---|
| Nazwa hosta Pi | `passholder` → `passholder.local` | ustawiasz w Raspberry Pi Imager |
| Stały adres IP Pi w LAN | `192.168.1.50` | rezerwacja DHCP w routerze |
| Sieć domowa | `192.168.1.0/24` | ustawienia routera |
| Adres Pi w Tailscale (opcjonalnie) | `100.x.y.z` | `tailscale ip -4` na Pi |
| Port serwera | `8443` | `deploy/passholder.env.example` |
| Użytkownik SSH na Pi | `<użytkownik>` | ustawiasz w Raspberry Pi Imager |

### Czego potrzebujesz

- Raspberry Pi 4B, karta microSD (8 GB wystarczy), zasilacz, najlepiej kabel Ethernet.
- Komputer z Ubuntu, na nim: Chrome, `git`, `rsync`, `openssl` (do certyfikatów, jest w Ubuntu domyślnie),
  Node.js 22.18 lub nowszy (do zbudowania wtyczki).
- Telefon z Androidem 8.0 lub nowszym (`minSdk = 26` w `android/app/build.gradle.kts`) i kabel USB.
- Do zbudowania aplikacji: JDK 17+ i Android SDK, najprościej przez Android Studio.
- Opcjonalnie: darmowe konto Tailscale, jeśli chcesz synchronizować spoza domu.

Kod powinien być już sklonowany na Ubuntu (`git clone` / `git pull` w `~/Projekty/PassHolder` lub
gdziekolwiek trzymasz repozytorium). Wszystkie komendy „na Ubuntu” wykonujesz w katalogu repozytorium.

---

# Część 1: Serwer na Raspberry Pi

Po tej części serwer startuje sam po włączeniu Pi, działa po HTTPS w sieci domowej, a dostęp spoza domu
(jeśli go skonfigurujesz) włączasz i wyłączasz jedną komendą.

## 1.1. System

1. W **Raspberry Pi Imager** wybierz: urządzenie Raspberry Pi 4, system **Raspberry Pi OS Lite (64-bit)**.
2. W ustawieniach (koło zębate / „Edytuj ustawienia”) ustaw:
   - nazwę hosta `passholder`,
   - użytkownika i hasło,
   - SSH: włączone, najlepiej z kluczem publicznym z Ubuntu (`~/.ssh/id_ed25519.pub`),
   - ewentualnie Wi-Fi (Ethernet jest pewniejszy).
3. Włóż kartę do Pi i włącz je. W routerze przypisz Pi **stały adres IP** (rezerwacja DHCP po adresie MAC).
   Ten adres trafi do certyfikatu HTTPS, więc nie może się zmieniać.
4. Zaloguj się z Ubuntu i zaktualizuj system:

   ```sh
   ssh <użytkownik>@passholder.local
   sudo apt update && sudo apt full-upgrade -y && sudo apt install -y rsync
   ```

## 1.2. Node.js 22

Serwer wymaga Node.js **22.18 lub nowszego** (`"engines"` w `server/package.json`): uruchamia TypeScript bez
kompilacji i używa wbudowanego modułu SQLite. Raspberry Pi OS ma w repozytorium starszą wersję, więc
instalujesz ją z NodeSource:

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # musi być v22.18 lub nowszy
```

## 1.3. Kod i użytkownik usługi

Repozytorium jest prywatne, więc kod kopiujesz z Ubuntu (dzięki temu na Pi nie ma danych logowania do
GitHuba). **Na Ubuntu**, w katalogu repozytorium (jeśli nie masz `rsync`: `sudo apt install rsync`):

```sh
rsync -a --delete --exclude node_modules --exclude .git ./ <użytkownik>@passholder.local:~/pass-holder/
```

**Na Pi:**

```sh
sudo useradd --system --home /var/lib/passholder --shell /usr/sbin/nologin passholder
sudo mkdir -p /var/lib/passholder /etc/passholder
sudo chown passholder:passholder /var/lib/passholder
sudo chmod 700 /var/lib/passholder
sudo rsync -a --delete ~/pass-holder/ /opt/pass-holder/
cd /opt/pass-holder && sudo npm ci --omit=dev -w server
```

Co tu się dzieje:

- `passholder` to konto systemowe bez powłoki i bez hasła. Usługa działa jako ono, nie jako root.
- `/var/lib/passholder` to jedyny katalog, do którego serwer może pisać (baza `passholder.db`).
- `/opt/pass-holder` to kod, `/etc/passholder` to konfiguracja i certyfikaty.
- `npm ci -w server` instaluje zależności serwera i wspólnego rdzenia `core/` dokładnie w wersjach z `package-lock.json`.
  Nic nie jest kompilowane na Pi.

## 1.4. Tailscale (opcjonalnie: dostęp spoza domu)

Pomiń, jeśli wystarczy Ci synchronizacja w sieci domowej. Jeśli chcesz ją mieć, zrób ten krok **przed
certyfikatem**, żeby adres Tailscale od razu trafił do certyfikatu (patrz uwaga w 1.5).

Tailscale tworzy prywatną sieć VPN między Twoimi urządzeniami bez przekierowania portów w routerze.

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up            # wyświetli link do zalogowania na konto Tailscale
tailscale ip -4              # adres 100.x.y.z – zapisz go
```

Zainstaluj też Tailscale na Ubuntu (ta sama komenda + `sudo tailscale up`) i aplikację Tailscale z Google Play
na telefonie, zalogowane na to samo konto.

Włączanie i wyłączanie dostępu spoza domu (`deploy/vpn.sh`):

```sh
/opt/pass-holder/deploy/vpn.sh on      # sudo tailscale up + wypisuje adres
/opt/pass-holder/deploy/vpn.sh off     # sudo tailscale down: tylko sieć lokalna
/opt/pass-holder/deploy/vpn.sh status
```

Stan VPN przetrwa restart Pi. Alternatywą jest WireGuard, ale wymaga publicznego adresu IP i przekierowania
portu w routerze, dlatego repozytorium nie ma do niego skryptu.

## 1.5. Certyfikat HTTPS

Skrypt `deploy/make-certs.sh` tworzy własny urząd certyfikacji (CA, ważny 10 lat) i podpisany nim certyfikat
serwera (ważny 825 dni). **Uruchamiasz go na Ubuntu, nie na Pi**: klucz urzędu (`ca.key`) nigdy nie trafia
na serwer. Na Pi kopiujesz tylko certyfikat i klucz serwera oraz publiczny `ca.crt`. Skrypt odmówi pracy,
jeśli wykryje, że działa na Raspberry Pi.

Podaj **wszystkie** nazwy i adresy, pod którymi będziesz łączyć się z Pi. Skrypt sam rozpoznaje, co jest
adresem IP, a co nazwą. Na Ubuntu, w katalogu repozytorium:

```sh
# bez Tailscale:
deploy/make-certs.sh ~/passholder-ca ~/passholder-tls passholder.local 192.168.1.50
# z Tailscale:
deploy/make-certs.sh ~/passholder-ca ~/passholder-tls passholder.local 192.168.1.50 100.x.y.z
```

Katalogi:

| Katalog (Ubuntu) | Pliki | Do czego |
|---|---|---|
| `~/passholder-ca/` | `ca.key` (**tajny**), `ca.crt` | urząd; zostaje na Ubuntu, potrzebny przy odnawianiu certyfikatu |
| `~/passholder-tls/` | `server.crt`, `server.key`, `ca.crt` | kopiujesz na Pi |

**Ograniczenie nazw.** Urząd może poświadczać tylko nazwy w domenie `.local`, `localhost` i adresy prywatne
(`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, Tailscale `100.64.0.0/10`, `127.0.0.0/8` i IPv6 `fc00::/7`).
Zapisuje to rozszerzenie X.509 `nameConstraints`, którego pilnuje Chrome. Gdyby ktoś ukradł `ca.key`, nie
podrobi nim strony banku ani poczty: Chrome odrzuci taki certyfikat z błędem `NET::ERR_CERT_INVALID`. Jeśli
potrzebujesz innej nazwy (np. MagicDNS `pi.tailXXXX.ts.net`), ustaw ją **przed pierwszym** uruchomieniem:
`PASSHOLDER_CA_DNS="local localhost tailXXXX.ts.net" deploy/make-certs.sh …`. Skrypt sprawdza każdy certyfikat
(`openssl verify`) i nie wystawi go dla nazwy spoza listy.

Na końcu skrypt wypisuje dwa odciski SHA-256:

- **odcisk CA** – porównasz go, gdy zainstalujesz `ca.crt` w Chrome (część 2),
- **odcisk certyfikatu serwera** – porównasz go w aplikacji na Androida (część 3).

Skopiuj pliki serwera na Pi i ustaw uprawnienia:

```sh
# na Ubuntu:
scp ~/passholder-tls/server.crt ~/passholder-tls/server.key ~/passholder-tls/ca.crt <użytkownik>@passholder.local:
# na Pi:
sudo install -d -m 750 -o root -g passholder /etc/passholder/tls
sudo install -m 644 -o root -g passholder ~/server.crt ~/ca.crt /etc/passholder/tls/
sudo install -m 640 -o root -g passholder ~/server.key /etc/passholder/tls/
shred -u ~/server.key && rm ~/server.crt ~/ca.crt
```

**Klucz `ca.key`** zostaje w `~/passholder-ca/` (uprawnienia `700`/`600`). Dzięki ograniczeniu nazw jego
kradzież nie zagraża innym stronom, ale pozwala podszyć się pod serwer PassHolder. Najlepiej trzymaj ten
katalog na zaszyfrowanym dysku (patrz [szyfrowanie dysku](#szyfrowanie-dysku-ubuntu)) albo na zaszyfrowanym
pendrivie.

**Odnawianie lub dopisanie adresu:** uruchom skrypt ponownie z **tym samym** `~/passholder-ca` i nowym
katalogiem wyjściowym, potem skopiuj pliki na Pi jak wyżej i zrestartuj usługę. Chrome nie wymaga zmian
(to samo CA). Nowy certyfikat serwera oznacza ponowne parowanie telefonu (patrz 3.6).

### Przejście na nowe CA (instalacje sprzed tej wersji)

Starsza wersja skryptu tworzyła CA **bez ograniczenia nazw i na Pi**. Taki `ca.crt` w Chrome pozwala temu,
kto ma `ca.key`, podrobić dowolną stronę. Skrypt odmówi użycia takiego urzędu. Przejście:

1. Zsynchronizuj telefon i wtyczkę (jeszcze ze starym certyfikatem).
2. Na Ubuntu utwórz nowe CA i certyfikat (polecenie wyżej, **nowy** katalog `~/passholder-ca`) i skopiuj
   pliki na Pi jak wyżej (nadpiszą stare w `/etc/passholder/tls/`).
3. Usuń stary klucz urzędu wszędzie, gdzie jest: na Pi `sudo shred -u /etc/passholder/tls/ca.key
   /etc/passholder/tls/ca.srl` (jeśli jeszcze istnieje) i ewentualne kopie (pendrive, kopie zapasowe).
4. Na Pi: `sudo systemctl restart passholder`.
5. W Chrome **usuń stary** urząd „PassHolder local CA” (`chrome://certificate-manager`, ten sam ekran co w
   2.2) i zaimportuj nowy `~/passholder-ca/ca.crt`. Oba mają tę samą nazwę: rozpoznasz stary po odcisku.
6. Telefon: ponowne parowanie (3.6).

## 1.6. Usługa systemd

```sh
sudo cp /opt/pass-holder/deploy/passholder.env.example /etc/passholder/passholder.env
sudo cp /opt/pass-holder/deploy/passholder.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now passholder
systemctl status passholder --no-pager
```

Konfiguracja (`/etc/passholder/passholder.env`, czytana przez `server/src/config.ts`):

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `PASSHOLDER_HOST` | `0.0.0.0` | adres nasłuchu (wszystkie interfejsy) |
| `PASSHOLDER_PORT` | `8443` | port HTTPS |
| `PASSHOLDER_DB` | `/var/lib/passholder/passholder.db` | plik bazy SQLite |
| `PASSHOLDER_TLS_CERT`, `PASSHOLDER_TLS_KEY` | `/etc/passholder/tls/server.{crt,key}` | certyfikat i klucz; bez nich serwer nie wystartuje |
| `PASSHOLDER_INSECURE_HTTP` | nieustawiona | `1` = zwykłe HTTP, **tylko** do testów na komputerze, nigdy na Pi |

Plik usługi (`deploy/passholder.service`) uruchamia serwer jako użytkownik `passholder`, restartuje go po
awarii i ogranicza jego uprawnienia (`ProtectSystem=strict`, zapis tylko do `/var/lib/passholder` i inne).

### Token jednorazowy

Dopóki sejf nie istnieje, serwer przy każdym starcie losuje token i zapisuje go w logu. Odczytaj go:

```sh
journalctl -u passholder -b | grep -o 'setup token: [0-9a-f]*' | tail -1
```

Token wpiszesz w pierwszym kliencie przy zakładaniu sejfu. Bez niego nikt inny w Twojej sieci nie założy
sejfu przed Tobą. Uwagi:

- po restarcie usługi (lub Pi) przed założeniem sejfu token jest **nowy**, stary przestaje działać,
- po założeniu sejfu serwer nie wypisuje już tokena.

### Sprawdzenie

Na Ubuntu (plik `~/passholder-ca.crt` kopiujesz w 2.2):

```sh
curl --cacert ~/passholder-ca.crt https://passholder.local:8443/api/v1/status
# {"initialized":false,"version":"1"}   → serwer działa, sejf jeszcze nie założony
```

## 1.7. Zapora (opcjonalnie, zalecane)

```sh
sudo apt install -y ufw
sudo ufw allow from 192.168.1.0/24 to any port 22,8443 proto tcp
sudo ufw allow in on tailscale0 to any port 8443 proto tcp   # tylko jeśli używasz Tailscale
sudo ufw enable
sudo ufw status
```

Pierwsza reguła wpuszcza SSH i serwer tylko z sieci domowej. Podstaw swoją sieć, inaczej odetniesz sobie SSH.

## 1.8. Codzienne użycie Pi

- **Włączanie:** podłącz zasilanie. Po ok. minucie serwer działa (sprawdzenie: `curl` z 1.6).
- **Wyłączanie:** `ssh <użytkownik>@passholder.local sudo shutdown -h now`, a zasilanie odłącz dopiero, gdy
  zielona dioda przestanie migać. Wyciągnięcie wtyczki w trakcie zapisu może uszkodzić kartę SD.
  Baza ma tryb WAL i pełną synchronizację zapisu, więc ryzyko utraty danych jest małe, ale karta jest
  najsłabszym elementem.
- **Spoza domu** zsynchronizujesz się tylko wtedy, gdy Pi jest włączone i VPN jest włączony (`vpn.sh on`).
- **Logi:** `journalctl -u passholder -n 50`.

---

# Część 2: Wtyczka do Chrome

Wtyczka nie jest w Chrome Web Store. Budujesz ją z kodu i ładujesz jako „rozpakowaną” w trybie dewelopera.

## 2.1. Zbudowanie wtyczki (Ubuntu)

Wymaga Node.js 22.18+ (`node -v`). Jeśli masz starszy, zainstaluj go jak w 1.2. W katalogu repozytorium:

```sh
npm install
npm run build -w extension
```

Wynik trafia do `extension/dist/` (`manifest.json`, `popup.html`, `popup.js`, `background.js`, `offscreen.html`,
`offscreen.js`, `popup.css`). Opcjonalnie sprawdź kod: `npm test`.

## 2.2. Zaufanie do certyfikatu serwera

Chrome musi ufać urzędowi, który podpisał certyfikat Pi. Plik `ca.crt` (publiczny) masz już na Ubuntu z 1.5:

```sh
cp ~/passholder-ca/ca.crt ~/passholder-ca.crt
openssl x509 -in ~/passholder-ca.crt -noout -fingerprint -sha256
```

Odcisk musi być taki sam jak „CA fingerprint” wypisany przez `make-certs.sh` w 1.5.

Zaimportuj go w Chrome:

- **nowsze wersje Chrome:** otwórz `chrome://certificate-manager` → „Certyfikaty lokalne” / „Zainstalowane
  przez Ciebie” → przy „Zaufane certyfikaty” kliknij „Importuj” → wybierz `passholder-ca.crt`;
- **starsze wersje:** `chrome://settings/certificates` → karta „Urzędy” → „Importuj” → wybierz plik →
  zaznacz „Ufaj temu certyfikatowi przy identyfikowaniu witryn”.

Nazwy przycisków różnią się między wersjami Chrome; szukaj importu certyfikatu urzędu (CA) zaufanego dla witryn.

Sprawdzenie: wejdź w Chrome na `https://passholder.local:8443/api/v1/status`. Powinieneś zobaczyć JSON bez
ostrzeżenia o certyfikacie. Jeśli widzisz `NET::ERR_CERT_AUTHORITY_INVALID`, import się nie udał.

## 2.3. Załadowanie wtyczki

1. Otwórz `chrome://extensions`.
2. Włącz **Tryb dewelopera** (przełącznik w prawym górnym rogu).
3. Kliknij **Załaduj rozpakowane** i wskaż katalog `extension/dist`.
4. Przypnij ikonę PassHolder do paska (ikona puzzla → pinezka).

Nie przenoś i nie usuwaj katalogu `extension/dist`: Chrome ładuje wtyczkę bezpośrednio z niego.
Identyfikator rozpakowanej wtyczki zależy od ścieżki, więc wczytanie jej z innego miejsca to dla Chrome
nowa wtyczka z pustą pamięcią (sejf odzyskasz synchronizacją, ale niezsynchronizowane zmiany przepadną).

## 2.4. Założenie sejfu

1. Kliknij ikonę PassHolder, a potem **Otwórz ustawienia połączenia**. Formularz otworzy się w osobnej
   karcie (Chrome zamyka okienko wtyczki, gdy pyta o zgodę, a karta zostaje). Wybierz zakładkę **Nowy sejf**.
2. Wpisz:
   - **Adres serwera:** `https://passholder.local:8443` (albo `https://192.168.1.50:8443`),
   - **Drugi adres serwera** (opcjonalnie): adres Tailscale, np. `https://100.x.y.z:8443`. Wtyczka przy
     każdym połączeniu sama wybierze adres, który odpowiada (docs/WIELE_ADRESOW_SERWERA.md). Oba adresy
     muszą być w certyfikacie (1.5).
   - **Token z logu serwera** z 1.6,
   - **Hasło główne** (co najmniej 12 znaków) i jego powtórzenie.
3. Kliknij **Załóż sejf** (albo naciśnij Enter). Przyciskiem **Pokaż** obok pola sprawdzisz wpisane hasło.
   Chrome zapyta o zgodę na dostęp wtyczki do adresu serwera: zaakceptuj.
   Wtyczka prosi tylko o wpisane adresy (`optional_host_permissions` w `manifest.json`).
4. Liczenie kluczy z hasła głównego (Argon2id, 64 MiB) trwa chwilę. Potem zobaczysz pustą listę.
   Kartę możesz zamknąć: dalej używasz ikony PassHolder na pasku.

**Hasła głównego nie da się odzyskać.** Serwer go nie zna i nie ma resetu. Zapisz je w bezpiecznym miejscu.

Kolejny Chrome (inny komputer) łączysz zakładką **Mam już sejf** w tej samej karcie: adres(y) + hasło główne, bez tokena.

Adresy już połączonej przeglądarki zmienisz przyciskiem **Adresy serwera** na liście wpisów.

## 2.5. Używanie

- **Dodaj wpis:** nazwa serwisu, login, hasło; generator ma suwak długości i grupy znaków.
- **Synchronizuj:** wysyła lokalne zmiany na Pi i pobiera zmiany z innych urządzeń. Działa tylko, gdy Pi jest włączone.
  Bez Pi wtyczka działa offline na lokalnej kopii.
- **Kopiowanie hasła:** schowek jest czyszczony po minucie.
- **Blokada:** sejf blokuje się sam po 15 minutach bez aktywności i po zamknięciu przeglądarki.
- **Odłącz tę przeglądarkę** (na ekranie blokady) usuwa z Chrome konto i lokalny sejf, **także
  niezsynchronizowane zmiany**. Zsynchronizuj przed odłączeniem.

---

# Część 3: Aplikacja na Androida

Aplikacji nie ma w Google Play. Budujesz ją na Ubuntu i instalujesz przez kabel USB.

## 3.1. Narzędzia na Ubuntu

**Wariant A (zalecany): Android Studio.** Zainstaluj je (np. `sudo snap install android-studio --classic`),
uruchom kreator pierwszego startu (pobierze Android SDK i JDK) i otwórz katalog `android/` z repozytorium.
Android Studio samo zapisze ścieżkę do SDK w `android/local.properties`.

**Wariant B: tylko wiersz poleceń.**

```sh
sudo apt install -y openjdk-17-jdk adb
```

Pobierz „Command line tools only” ze strony Android Studio, rozpakuj do `~/Android/Sdk/cmdline-tools/latest`, potem:

```sh
export ANDROID_HOME=~/Android/Sdk
$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses
$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platforms;android-36" "build-tools;36.0.0" "platform-tools"
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
```

Gradle (8.14.3) pobiera się sam przez `./gradlew` przy pierwszym uruchomieniu, razem z zależnościami.
Pierwsza budowa trwa kilka minut.

Sprawdzenie (opcjonalnie): `cd android && ./gradlew :core:test`.

## 3.2. Przygotowanie telefonu

1. **Ustawienia → Informacje o telefonie** → stuknij 7 razy w **Numer kompilacji**. Pojawią się „Opcje programisty”.
2. **Ustawienia → System → Opcje programisty** → włącz **Debugowanie USB**.
   (Dokładne nazwy i położenie zależą od producenta telefonu.)
3. Podłącz telefon kablem do Ubuntu i uruchom `adb devices`. Na telefonie zaakceptuj okno
   „Zezwolić na debugowanie USB?” (najlepiej z „Zawsze zezwalaj z tego komputera”).
   Telefon powinien być na liście ze statusem `device`, nie `unauthorized`.

## 3.3. Instalacja

```sh
cd android
./gradlew :app:installDebug
```

albo w Android Studio przycisk **Run** z wybranym telefonem. Aplikacja „PassHolder” pojawi się na liście aplikacji.

Bez kabla: `./gradlew :app:assembleDebug` tworzy `android/app/build/outputs/apk/debug/app-debug.apk`. Skopiuj
plik na telefon i otwórz go; Android poprosi o zgodę na instalację z nieznanego źródła dla aplikacji, której
użyłeś do otwarcia pliku.

O wariancie debug: tak jest budowana i testowana aplikacja w tym repozytorium. Wersja debug dopuszcza też
zwykłe `http://` (do testów z serwerem na komputerze), ale z Pi łączysz się przez `https://` i aplikacja
sprawdza przypięty certyfikat. Istnieje też `./gradlew :app:assembleRelease` (tylko HTTPS, kod
zminimalizowany przez R8, podpisany kluczem debug), ale tego wariantu nie testowano na telefonie.

## 3.4. Połączenie z sejfem (parowanie)

Telefon nie korzysta z `ca.crt`. Zamiast tego **przypina odcisk SHA-256 certyfikatu serwera**: przy
pierwszym połączeniu pokazuje odcisk, a Ty potwierdzasz, że to Twoje Pi. Potem aplikacja ufa wyłącznie
temu jednemu certyfikatowi (`android/core/.../CertificatePin.kt`).

1. Otwórz aplikację, wybierz **Mam już sejf** (sejf założony we wtyczce) albo **Nowy sejf** (jeśli telefon
   jest pierwszym klientem; wtedy potrzebny token z 1.6).
2. Wpisz adres serwera, np. `https://192.168.1.50:8443`, opcjonalnie drugi adres (Tailscale,
   `https://100.x.y.z:8443`) i stuknij **Dalej: sprawdź certyfikat**. Odcisk zostanie pobrany z pierwszego
   adresu, który odpowie; drugi nie musi teraz działać.
   Zalecam adres IP zamiast `passholder.local`: rozpoznawanie nazw `.local` na Androidzie zależy od wersji
   systemu i producenta (to moje założenie, nie zostało sprawdzone na Twoim telefonie). Certyfikat
   obejmuje oba, a aplikacja i tak weryfikuje przypięty odcisk, nie nazwę.
3. Aplikacja pokaże odcisk w 4 liniach. Na Pi uruchom:

   ```sh
   sudo openssl x509 -in /etc/passholder/tls/server.crt -noout -fingerprint -sha256
   ```

   Porównaj wszystkie 32 bajty. Jeśli się zgadzają, zaznacz **Odcisk się zgadza**. Jeśli nie, przerwij
   (**Wstecz**): łączysz się z innym urządzeniem albo z innym certyfikatem.
4. Wpisz hasło główne i stuknij **Połącz** (albo token + hasło dwa razy i **Załóż sejf**).
5. Stuknij **Synchronizuj**: na liście pojawią się wpisy z wtyczki.

Zrzuty ekranów tego procesu: [`android/app/screenshots/`](../android/app/screenshots/)
(`01-polaczenie.png`, `02-odcisk-certyfikatu.png`, …).

## 3.5. Używanie

Tak jak we wtyczce: dodawanie wpisów z generatorem, **Synchronizuj**, **Zablokuj**, kopiowanie hasła
(schowek czyszczony po minucie), automatyczna blokada po 15 minutach bez aktywności, także gdy aplikacja jest w tle. Aplikacja nie robi kopii
zapasowych w chmurze Google (`allowBackup=false`).

**Adresy** (na liście wpisów) zmienia adresy serwera bez ponownego parowania. Przy synchronizacji telefon
sam wybiera adres, który odpowiada.

**Odłącz ten telefon** (na ekranie blokady) usuwa konto i lokalny sejf z telefonu. Zsynchronizuj przed odłączeniem.

## 3.6. Nowy certyfikat serwera

Po wygenerowaniu nowego certyfikatu (dopisanie adresu, odnowienie po 825 dniach) telefon odmówi połączenia,
bo odcisk się zmienił. To zamierzone. Kolejność:

1. Zsynchronizuj telefon **jeszcze ze starym certyfikatem**.
2. Wymień certyfikat na Pi (1.5) i zrestartuj usługę: `sudo systemctl restart passholder`.
3. W aplikacji: **Zablokuj** → **Odłącz ten telefon** → połącz ponownie (3.4) z nowym odciskiem.

Chrome nie wymaga zmian, jeśli nowy certyfikat podpisało to samo CA.

---

# Aktualizacje

**Serwer** (po `git pull` na Ubuntu):

```sh
# Ubuntu:
rsync -a --delete --exclude node_modules --exclude .git ./ <użytkownik>@passholder.local:~/pass-holder/
# Pi:
sudo rsync -a --delete ~/pass-holder/ /opt/pass-holder/
cd /opt/pass-holder && sudo npm ci --omit=dev -w server
sudo systemctl restart passholder
```

Jeśli zmienił się `deploy/passholder.service`, skopiuj go ponownie i uruchom `sudo systemctl daemon-reload`.
Konfiguracji `/etc/passholder/passholder.env` aktualizacja nie nadpisuje.

**Wtyczka:** `npm install && npm run build -w extension`, potem w `chrome://extensions` przycisk odświeżania
(strzałka) na karcie PassHolder. Dane wtyczki zostają.

**Telefon:** `./gradlew :app:installDebug` instaluje nową wersję na starej, dane zostają. Odinstalowanie aplikacji
usuwa lokalny sejf.

# Kopia zapasowa

Każdy klient ma pełną kopię sejfu, ale obecny protokół nie umie wgrać jej z powrotem na pusty serwer.
Dlatego rób kopię bazy z Pi (np. po większych zmianach):

```sh
# Pi:
sudo apt install -y sqlite3
sudo sqlite3 /var/lib/passholder/passholder.db ".backup /home/<użytkownik>/kopia.db"
# Ubuntu:
scp <użytkownik>@passholder.local:kopia.db ~/passholder-kopia-$(date +%F).db
```

Kopia zawiera tylko zaszyfrowane dane; bez hasła głównego jest bezużyteczna. Przywrócenie: zatrzymaj usługę,
skopiuj plik na `/var/lib/passholder/passholder.db` (właściciel `passholder:passholder`), uruchom usługę.

# Szyfrowanie dysku (Ubuntu)

Na dysku Ubuntu leżą: klucz urzędu `~/passholder-ca/ca.key` (1.5) i profil Chrome z zaszyfrowanym sejfem,
a jeśli włączysz „Pamiętaj PIN po zamknięciu przeglądarki”, także zaszyfrowane PIN-em klucze sejfu. Kto
skopiuje niezaszyfrowany dysk (kradzież laptopa, kopia zapasowa), może próbować zgadywać PIN bez limitu
prób. Dlatego wtyczka wymaga wtedy długiego PIN-u (co najmniej 8 znaków, nie same cyfry), a dodatkowo
**zalecane jest szyfrowanie całego dysku (LUKS)**.

- **Nowa instalacja Ubuntu:** w instalatorze wybierz „Zaawansowane funkcje” → „Użyj LVM i szyfrowania”
  (nazwa zależy od wersji). To najprostsza droga.
- **Istniejąca instalacja:** zaszyfrowania dysku systemowego w miejscu nie da się zrobić bezpiecznie jedną
  komendą. Możesz zaszyfrować tylko katalog domowy innymi narzędziami albo trzymać `~/passholder-ca` na
  zaszyfrowanym pendrivie i nie włączać zapamiętywania PIN-u.
- Sprawdzenie: `lsblk -f` pokazuje `crypto_LUKS` pod dyskiem systemowym, jeśli szyfrowanie działa.

# Rozwiązywanie problemów

| Objaw | Przyczyna i rozwiązanie |
|---|---|
| `systemctl status passholder` pokazuje błąd `Set PASSHOLDER_TLS_CERT and PASSHOLDER_TLS_KEY…` | Brak `/etc/passholder/passholder.env` albo zmiennych w nim. Krok 1.6. |
| W logu `EACCES` przy `server.key` | Grupa lub uprawnienia klucza. Powtórz polecenia `install` z 1.5. |
| `make-certs.sh`: „…made by an older version of this script, without name limits” | Stare CA bez ograniczenia nazw. Patrz „Przejście na nowe CA” w 1.5. |
| `make-certs.sh`: „…outside what the CA may vouch for” | Nazwa spoza `.local` lub adres publiczny. Patrz „Ograniczenie nazw” w 1.5. |
| Chrome: `NET::ERR_CERT_INVALID` przy serwerze PassHolder | Nazwa w certyfikacie spoza ograniczenia CA (np. ręcznie wystawiony certyfikat). Wystaw go skryptem (1.5). |
| Usługa nie startuje, a `node -v` pokazuje wersję starszą niż 22.18 | Za stary Node. Krok 1.2. |
| Nie ma tokena w logu | Sejf już istnieje (zakładasz „Mam już sejf”) albo czytasz stary log: użyj `-b` i najnowszego wpisu. |
| „Invalid setup token” przy zakładaniu sejfu | Usługa wystartowała ponownie i wylosowała nowy token. Odczytaj go jeszcze raz. |
| Chrome: `NET::ERR_CERT_AUTHORITY_INVALID` | `ca.crt` nie zaimportowany jako zaufany urząd. Krok 2.2. |
| Chrome: `NET::ERR_CERT_COMMON_NAME_INVALID` | Łączysz się adresem, którego nie ma w certyfikacie. Wygeneruj certyfikat z tym adresem (1.5). |
| Wtyczka: „Na serwerze nie ma jeszcze sejfu…” | Wybrano „Mam już sejf”, a sejf nie został założony. Załóż go zakładką „Nowy sejf”. |
| Wtyczka: „Bez zgody na dostęp do serwera…” | Odrzucona prośba o uprawnienie. Spróbuj ponownie i zaakceptuj. |
| Połączenie odrzucone / timeout | Pi wyłączone, inna sieć Wi-Fi, zapora (1.7), albo spoza domu bez VPN. Sprawdź `curl` z 1.6. |
| Telefon nie znajduje `passholder.local` | Użyj adresu IP (3.4). |
| „Wrong master password” | Złe hasło główne (wielkość liter, układ klawiatury). |
| Telefon odmawia połączenia po zmianie certyfikatu | Zamierzone. Krok 3.6. |
| `adb devices` pokazuje `unauthorized` | Odblokuj telefon i zaakceptuj okno debugowania USB. |
| `./gradlew` zgłasza brak SDK | Brak `android/local.properties` z `sdk.dir` albo `ANDROID_HOME`. Krok 3.1. |
| Po restarcie Pi pierwsza synchronizacja | Klienci logują się ponownie sami (sesje serwera są w pamięci), nic nie trzeba robić. |

# Znane ograniczenia

- **Dwa pola na adresy.** Wtyczka i telefon pamiętają kilka adresów serwera i same wybierają działający
  (docs/WIELE_ADRESOW_SERWERA.md), ale formularze mają dwa pola. Gdy żaden adres nie odpowiada, czekanie
  trwa do ok. 4 s na adres.
- **Brak odtwarzania serwera z klienta.** Gdy zginie baza na Pi i nie masz kopii, klienci mają dane, ale nie
  wgrają ich na nowy, pusty serwer. Rób kopie (patrz wyżej).
- **Sesje w pamięci serwera.** Restart serwera wylogowuje klientów; ponowne logowanie dzieje się automatycznie.
- **Wtyczka w trybie dewelopera.** Chrome może przy starcie przypominać o wtyczkach w trybie dewelopera.
- **Klucz debug.** Aplikacja jest podpisana kluczem debug z Twojego komputera. Instalacja z innego komputera
  (inny klucz) wymaga odinstalowania starej wersji, co usuwa lokalny sejf: zsynchronizuj wcześniej.
