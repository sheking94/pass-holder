# Instalacja serwera na Raspberry Pi 4B

Po wykonaniu tych kroków serwer startuje sam po włączeniu Pi, działa po HTTPS w sieci domowej,
a dostęp spoza domu włączasz i wyłączasz jedną komendą.

Przykłady zakładają, że Pi ma nazwę `passholder` (adres `passholder.local`) i stały adres
`192.168.1.50`. Podstaw swoje wartości.

## 1. System

1. W Raspberry Pi Imager wybierz **Raspberry Pi OS Lite (64-bit)**. W ustawieniach zaawansowanych ustaw
   nazwę hosta `passholder`, użytkownika, włącz SSH (najlepiej z kluczem) i ewentualnie Wi-Fi.
   Kabel Ethernet jest pewniejszy.
2. W routerze przypisz Pi stały adres IP (rezerwacja DHCP). Certyfikat będzie wystawiony na ten adres.
3. Zaloguj się: `ssh <użytkownik>@passholder.local`, potem `sudo apt update && sudo apt full-upgrade -y && sudo apt install -y rsync`.

## 2. Node.js 22

Raspberry Pi OS ma w repozytorium starszy Node, a serwer wymaga wersji 22.18 lub nowszej
(uruchamia TypeScript bez kompilacji i używa wbudowanego SQLite).

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # musi być v22.18 lub nowszy
```

## 3. Kod i użytkownik usługi

Repozytorium jest prywatne, więc najprościej skopiować kod z komputera z Ubuntu (bez trzymania
danych logowania do GitHuba na Pi). Na Ubuntu, w katalogu repozytorium:

```sh
rsync -a --delete --exclude node_modules --exclude .git ./ <użytkownik>@passholder.local:~/pass-holder/
```

Na Pi:

```sh
sudo useradd --system --home /var/lib/passholder --shell /usr/sbin/nologin passholder
sudo mkdir -p /var/lib/passholder /etc/passholder
sudo chown passholder:passholder /var/lib/passholder
sudo chmod 700 /var/lib/passholder
sudo rsync -a --delete ~/pass-holder/ /opt/pass-holder/
cd /opt/pass-holder && sudo npm ci --omit=dev -w server
```

Aktualizacja w przyszłości to te same dwa `rsync`, `npm ci` i `sudo systemctl restart passholder`.

## 4. Certyfikat HTTPS

Skrypt tworzy własny urząd certyfikacji (CA) i certyfikat serwera podpisany przez niego. Podaj wszystkie
nazwy i adresy, pod którymi będziesz łączyć się z Pi (adres Tailscale dopiszesz po kroku 6).

```sh
sudo /opt/pass-holder/deploy/make-certs.sh /etc/passholder/tls passholder.local 192.168.1.50
sudo chown -R root:passholder /etc/passholder/tls
sudo chmod 640 /etc/passholder/tls/server.key
```

Skrypt wypisze odcisk SHA-256 urzędu i odcisk certyfikatu serwera.

- **Ubuntu (Chrome):** plik `/etc/passholder/tls/ca.crt` zainstaluj w `chrome://settings/certificates` →
  Urzędy → Importuj → `ca.crt`, zaznacz „ufaj przy identyfikacji witryn”.
- **Android:** nic nie instalujesz w systemie. Przy łączeniu aplikacja pokaże odcisk certyfikatu serwera;
  porównaj go z wynikiem
  `sudo openssl x509 -in /etc/passholder/tls/server.crt -noout -fingerprint -sha256` i potwierdź.
  Od tej chwili aplikacja ufa tylko temu jednemu certyfikatowi. Po wygenerowaniu nowego certyfikatu
  (np. po dopisaniu adresu Tailscale albo po 825 dniach) telefon odmówi połączenia: najpierw
  zsynchronizuj telefon, potem wymień certyfikat, a w aplikacji wybierz „Odłącz ten telefon” i połącz ponownie.

Klucz `ca.key` pozwala wystawić certyfikat dla dowolnej nazwy, której ufają Twoje urządzenia. Po
wygenerowaniu certyfikatu przenieś go z Pi w bezpieczne miejsce (np. na zaszyfrowany pendrive) i usuń z Pi.
Będzie potrzebny tylko do odnowienia certyfikatu serwera (ważny 825 dni).

## 5. Usługa systemd

```sh
sudo cp /opt/pass-holder/deploy/passholder.env.example /etc/passholder/passholder.env
sudo cp /opt/pass-holder/deploy/passholder.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now passholder
journalctl -u passholder -n 20
```

Przy pierwszym uruchomieniu w logu pojawi się linia `One-time setup token: …`. Ten token wpiszesz przy
zakładaniu sejfu w pierwszym kliencie (wtyczce). Bez niego nikt inny w sieci nie założy sejfu przed Tobą.
Po założeniu sejfu token przestaje działać.

Sprawdzenie z Ubuntu: `curl --cacert ca.crt https://passholder.local:8443/api/v1/status`.

## 6. Dostęp spoza domu: Tailscale

Tailscale tworzy prywatną sieć VPN między Twoimi urządzeniami bez przekierowywania portów w routerze.
Wymaga darmowego konta Tailscale i aplikacji na telefonie oraz Ubuntu.

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up            # wyświetli link do zalogowania
tailscale ip -4              # adres 100.x.y.z
```

Dopisz ten adres do certyfikatu (ponownie krok 4 z dodatkowym argumentem `100.x.y.z`, CA zostanie
to samo, a potem `sudo systemctl restart passholder`).

Włączanie i wyłączanie:

```sh
/opt/pass-holder/deploy/vpn.sh on      # dostęp spoza domu
/opt/pass-holder/deploy/vpn.sh off     # tylko sieć lokalna
/opt/pass-holder/deploy/vpn.sh status
```

Stan VPN przetrwa restart Pi. Alternatywa to WireGuard, ale wymaga publicznego adresu IP i
przekierowania portu w routerze.

**Ważne:** spoza domu zsynchronizujesz się tylko wtedy, gdy Pi jest włączone. Jeśli wychodzisz z domu i
chcesz mieć tę możliwość, zostaw je włączone.

## 7. Wyłączanie Pi

Wyłączaj Pi komendą `sudo shutdown -h now` i odłączaj zasilanie dopiero, gdy zielona dioda przestanie
migać. Wyciągnięcie wtyczki w trakcie zapisu może uszkodzić kartę SD. Baza ma tryb WAL i pełną
synchronizację zapisu, więc ryzyko utraty danych jest małe, ale karta SD jest najsłabszym elementem.

## 8. Zapora (opcjonalnie)

```sh
sudo apt install -y ufw
sudo ufw allow from 192.168.1.0/24 to any port 22,8443 proto tcp
sudo ufw allow in on tailscale0 to any port 8443 proto tcp
sudo ufw enable
```

## Znane ograniczenia

- Jeśli baza na Pi zginie (np. padnie karta SD), klienci mają pełną kopię sejfu, ale obecny protokół
  nie umie jej jeszcze wgrać z powrotem na pusty serwer. Do tego czasu rób kopię
  `/var/lib/passholder/passholder.db` (np. `sudo apt install sqlite3`, potem `sudo sqlite3 /var/lib/passholder/passholder.db ".backup /home/<użytkownik>/kopia.db"`).
- Sesje logowania są trzymane w pamięci; restart serwera wymaga ponownego logowania.
