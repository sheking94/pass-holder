# Dezinstalacja PassHolder z Raspberry Pi

Instrukcja całkowitego usunięcia serwera PassHolder z Raspberry Pi (Raspberry Pi OS Lite 64-bit), czyli
odwrócenie [części 1 instrukcji instalacji](INSTALACJA.md#część-1-serwer-na-raspberry-pi). Na końcu są kroki
poza Pi: router, Ubuntu (Chrome, klucz urzędu) i telefon.

Kroki oznaczone **(opcjonalnie)** pomijasz, jeśli dana rzecz służy na Pi czemuś jeszcze, np. Node.js innej
aplikacji albo Tailscale innym usługom.

## Spis

0. [Zanim zaczniesz: kopia sejfu](#0-zanim-zaczniesz-kopia-sejfu)
1. [Najprostsza droga: nowa karta SD](#1-najprostsza-droga-nowa-karta-sd)
2. [Usługa systemd](#2-usługa-systemd)
3. [Baza, konfiguracja, certyfikaty i kod](#3-baza-konfiguracja-certyfikaty-i-kod)
4. [Użytkownik `passholder`](#4-użytkownik-passholder)
5. [Zapora ufw (opcjonalnie)](#5-zapora-ufw-opcjonalnie)
6. [Tailscale (opcjonalnie)](#6-tailscale-opcjonalnie)
7. [WireGuard (tylko jeśli sam go skonfigurowałeś)](#7-wireguard-tylko-jeśli-sam-go-skonfigurowałeś)
8. [Node.js (opcjonalnie)](#8-nodejs-opcjonalnie)
9. [Pozostałe pakiety i logi (opcjonalnie)](#9-pozostałe-pakiety-i-logi-opcjonalnie)
10. [Sprawdzenie](#10-sprawdzenie)
11. [Poza Pi: router, Ubuntu, telefon](#11-poza-pi-router-ubuntu-telefon)
12. [Skąd te kroki](#12-skąd-te-kroki)

Wartości przykładowe (`passholder.local`, `192.168.1.0/24`, `<użytkownik>`) są te same co w
[INSTALACJA.md](INSTALACJA.md#wartości-przykładowe). Wszystkie komendy w krokach 2–10 wykonujesz **na Pi**
(`ssh <użytkownik>@passholder.local`), chyba że napisano inaczej.

---

## 0. Zanim zaczniesz: kopia sejfu

> **Uwaga.** Krok 3 kasuje bazę `/var/lib/passholder/passholder.db`. To jedyna kopia sejfu, którą da się
> wgrać na nowy serwer. Klienci (wtyczka, telefon) mają swoje kopie, ale obecny protokół **nie umie** wysłać
> ich na pusty serwer (patrz [znane ograniczenia](INSTALACJA.md#znane-ograniczenia)). Bez kopii bazy
> przeniesienie sejfu na nowy serwer jest możliwe tylko przez CSV.

1. **Zsynchronizuj wszystkich klientów** (wtyczka i telefon, przycisk synchronizacji), póki Pi działa.
   Dzięki temu baza na Pi ma najnowsze wpisy.
2. **Zrób kopię bazy** (ta sama procedura co w [Kopii zapasowej](INSTALACJA.md#kopia-zapasowa)):

   ```sh
   # Pi:
   sudo apt install -y sqlite3
   sudo sqlite3 /var/lib/passholder/passholder.db ".backup /home/<użytkownik>/kopia.db"
   # Ubuntu:
   scp <użytkownik>@passholder.local:kopia.db ~/passholder-kopia-$(date +%F).db
   ```

   Sprawdź na Ubuntu, że plik nie jest pusty (`ls -l ~/passholder-kopia-*.db`). Kopia jest zaszyfrowana:
   bez hasła głównego jest bezużyteczna, ale z nim zawiera cały sejf. Przywrócenie na nowym Pi opisuje
   INSTALACJA.md w tym samym miejscu.
3. **Awaryjnie** wyeksportuj wpisy do CSV z wtyczki (przycisk **CSV**). Plik zawiera hasła **jawnym
   tekstem**: przenieś je i usuń plik (`shred -u plik.csv`).

Jeśli porzucasz PassHolder całkiem, a hasła mają trafić do innego menedżera, eksport CSV jest właśnie tym
krokiem (format NordPass, [WTYCZKA_IMPORT_EKSPORT_CSV.md](WTYCZKA_IMPORT_EKSPORT_CSV.md)).

---

## 1. Najprostsza droga: nowa karta SD

Jeśli Pi służyło **tylko** do PassHolder, najpewniej i najszybciej jest po zrobieniu kopii (krok 0)
wyłączyć Pi i nagrać na kartę świeży system w Raspberry Pi Imager. Zostaje wtedy tylko
[krok 11](#11-poza-pi-router-ubuntu-telefon) (router, Ubuntu, telefon) oraz usunięcie urządzenia z konta
Tailscale (patrz [krok 6](#6-tailscale-opcjonalnie), punkt o panelu administracyjnym).

Kroki 2–10 są dla sytuacji, gdy na Pi zostaje system i inne rzeczy.

---

## 2. Usługa systemd

```sh
sudo systemctl disable --now passholder
sudo rm /etc/systemd/system/passholder.service
sudo systemctl daemon-reload
sudo systemctl reset-failed passholder 2>/dev/null || true
```

- `disable --now` zatrzymuje serwer i wyłącza jego start przy uruchomieniu Pi.
- `rm` usuwa plik usługi skopiowany w INSTALACJA.md 1.6 (`deploy/passholder.service`).
- `daemon-reload` każe systemd zapomnieć usługę, `reset-failed` czyści ewentualny stan „failed”.

Od tej chwili port 8443 jest zamknięty, a klienci przy synchronizacji pokażą błąd połączenia.

## 3. Baza, konfiguracja, certyfikaty i kod

> **Ostatnia chwila na kopię.** Pierwsze polecenie kasuje sejf na serwerze. Wróć do kroku 0, jeśli go
> pominąłeś.

```sh
# baza SQLite (passholder.db oraz pliki trybu WAL: passholder.db-wal, passholder.db-shm)
sudo rm -rf /var/lib/passholder

# konfiguracja i certyfikat TLS serwera
sudo shred -u /etc/passholder/tls/server.key
sudo rm -rf /etc/passholder

# kod serwera i kopia robocza przesyłana przez rsync
sudo rm -rf /opt/pass-holder
rm -rf ~/pass-holder

# kopia bazy z kroku 0 i ewentualne starsze kopie (najpierw upewnij się, że są na Ubuntu)
rm -f ~/kopia.db
```

Co jest gdzie:

| Ścieżka | Zawartość | Skąd |
|---|---|---|
| `/var/lib/passholder/` | `passholder.db` (+ `-wal`, `-shm`): zaszyfrowany sejf, skrót uwierzytelnienia, parametry KDF | utworzone w 1.3, plik bazy tworzy serwer (`server/src/db.ts`) |
| `/etc/passholder/passholder.env` | konfiguracja `PASSHOLDER_*` | 1.6 |
| `/etc/passholder/tls/` | `server.crt`, `server.key`, `ca.crt` (publiczny) | 1.5 |
| `/opt/pass-holder/` | kod i `node_modules` z `npm ci` | 1.3 |
| `~/pass-holder/` | kopia kodu w domu użytkownika SSH (cel `rsync` z Ubuntu) | 1.3 |
| `~/kopia.db` | kopia bazy | [Kopia zapasowa](INSTALACJA.md#kopia-zapasowa) |

Uwagi:

- `shred` na karcie SD **nie gwarantuje** fizycznego nadpisania (karta sama rozkłada zapisy po komórkach).
  Klucz serwera i tak traci znaczenie, gdy usuniesz urząd z Chrome i parowanie z telefonu (krok 11). Baza
  zawiera tylko dane zaszyfrowane po stronie klienta, więc jej resztki na karcie bez hasła głównego nic nie
  dają. Jeśli oddajesz kartę komuś, i tak lepiej nagrać ją od nowa (krok 1).
- Jeśli przy przejściu na nowe CA na Pi został stary klucz urzędu (`/etc/passholder/tls/ca.key`,
  `ca.srl`), znika razem z `/etc/passholder`.

**(Opcjonalnie)** pamięć podręczna npm po `sudo npm ci` (pakiety pobrane dla serwera):

```sh
sudo rm -rf /root/.npm
```

Pomiń, jeśli na Pi używasz npm jako root do czegoś innego (to tylko cache, ale przyspiesza instalacje).

## 4. Użytkownik `passholder`

```sh
sudo userdel passholder
getent group passholder && sudo groupdel passholder
```

`userdel` usuwa konto systemowe z 1.3. Grupa o tej samej nazwie zwykle znika razem z nim; druga linia
usuwa ją tylko wtedy, gdy została. Katalog domowy konta (`/var/lib/passholder`) usunąłeś już w kroku 3.

## 5. Zapora ufw (opcjonalnie)

Dotyczy tylko tych, którzy wykonali [1.7](INSTALACJA.md#17-zapora-opcjonalnie-zalecane).

> **Uwaga na SSH.** Reguła z 1.7 otwiera **jednocześnie** SSH (22) i PassHolder (8443). Jeśli ją usuniesz
> przy włączonej zaporze, a SSH nie ma osobnej reguły, odetniesz sobie dostęp do Pi.

**Wariant A: ufw zostaje** (używasz go dla innych usług). Najpierw osobna reguła dla SSH, potem usunięcie
reguł PassHolder:

```sh
sudo ufw allow from 192.168.1.0/24 to any port 22 proto tcp
sudo ufw delete allow from 192.168.1.0/24 to any port 22,8443 proto tcp
sudo ufw delete allow in on tailscale0 to any port 8443 proto tcp   # tylko jeśli ją dodałeś
sudo ufw status numbered
```

Podstaw swoją sieć zamiast `192.168.1.0/24`. Jeśli `ufw delete` napisze „Could not delete non-existent
rule”, sprawdź dokładną treść reguły w `ufw status numbered` i usuń ją numerem: `sudo ufw delete <numer>`.

**Wariant B: ufw był tylko dla PassHolder.** Wyłączenie i usunięcie zapory:

```sh
sudo ufw disable
sudo ufw --force reset
sudo apt purge -y ufw
```

`reset` kasuje wszystkie reguły (kopie zapisuje w `/etc/ufw/*.rules.<data>`), `purge` usuwa pakiet. Pi
wraca do stanu bez zapory, jak po świeżej instalacji Raspberry Pi OS Lite.

## 6. Tailscale (opcjonalnie)

Dotyczy tylko tych, którzy wykonali [1.4](INSTALACJA.md#14-tailscale-opcjonalnie-dostęp-spoza-domu).
Pomiń, jeśli Tailscale na Pi służy czemuś jeszcze (np. dostępowi SSH spoza domu).

```sh
sudo tailscale logout                 # wylogowuje Pi z konta Tailscale
sudo apt purge -y tailscale
sudo rm -rf /var/lib/tailscale        # stan i klucze węzła
ls /etc/apt/sources.list.d/ /usr/share/keyrings/ | grep -i tailscale
```

Skrypt `tailscale.com/install.sh` dodał repozytorium pakietów Tailscale. Ostatnia linia pokazuje jego pliki
(zwykle `tailscale.list` i `tailscale-archive-keyring.gpg`); usuń te, które pokaże, i odśwież listę pakietów:

```sh
sudo rm -f /etc/apt/sources.list.d/tailscale.list /usr/share/keyrings/tailscale-archive-keyring.gpg
sudo apt update
```

Następnie w panelu Tailscale (<https://login.tailscale.com/admin/machines>) usuń urządzenie `passholder`
(menu `…` → **Remove**), jeśli nadal jest na liście. Na Ubuntu i telefonie Tailscale zostaw albo usuń
osobno (krok 11).

`deploy/vpn.sh` znika razem z `/opt/pass-holder` w kroku 3.

## 7. WireGuard (tylko jeśli sam go skonfigurowałeś)

Repozytorium nie instaluje WireGuarda ani nie ma do niego skryptu (INSTALACJA.md 1.4 wspomina go tylko jako
alternatywę). Jeśli postawiłeś go samodzielnie wyłącznie dla PassHolder, typowe sprzątanie wygląda tak
(nazwa interfejsu `wg0` to założenie, sprawdź ją: `ls /etc/wireguard/`):

```sh
sudo systemctl disable --now wg-quick@wg0
sudo apt purge -y wireguard wireguard-tools
sudo rm -rf /etc/wireguard
```

Usuń też w routerze przekierowanie portu UDP (zwykle 51820) na Pi i ewentualną regułę ufw dla tego portu.

## 8. Node.js (opcjonalnie)

Pomiń, jeśli Node.js jest potrzebny na Pi czemuś innemu (`ls /etc/systemd/system/*.service` i własne
skrypty podpowiedzą, czy coś go używa).

```sh
sudo apt purge -y nodejs
sudo apt autoremove -y
ls /etc/apt/sources.list.d/ /etc/apt/keyrings/ /etc/apt/preferences.d/ 2>/dev/null | grep -i -E 'nodesource|nodejs|nsolid'
```

Skrypt `deb.nodesource.com/setup_22.x` z 1.2 dodał repozytorium NodeSource. Ostatnia linia pokazuje jego
pliki (zwykle `nodesource.list`, klucz `nodesource.gpg` i pliki priorytetów `nodejs`, `nsolid`). Usuń te,
które pokaże, i odśwież listę pakietów:

```sh
sudo rm -f /etc/apt/sources.list.d/nodesource.list /etc/apt/sources.list.d/nodesource.sources \
           /etc/apt/keyrings/nodesource.gpg \
           /etc/apt/preferences.d/nodejs /etc/apt/preferences.d/nsolid
sudo apt update
node -v   # powinno zgłosić: command not found
```

`rm -f` nie zgłasza błędu, gdy któregoś pliku nie ma, więc lista może być szersza niż to, co faktycznie
powstało.

## 9. Pozostałe pakiety i logi (opcjonalnie)

**Pakiety.** Instalacja i kopia zapasowa doinstalowały `rsync` (1.1) i `sqlite3` (kopia zapasowa). To
małe, ogólne narzędzia; usuń je tylko, jeśli na pewno nie są Ci potrzebne:

```sh
sudo apt purge -y sqlite3 rsync
sudo apt autoremove -y
```

Nie usuwaj pakietu `curl`: był użyty do instalacji, ale jest częścią systemu.

**Logi.** Dziennik systemd zawiera komunikaty serwera, w tym jednorazowe tokeny zakładania sejfu (po
założeniu sejfu już bezużyteczne) i adresy IP klientów. Haseł ani danych sejfu w logach nie ma. Dziennika
nie da się wyczyścić dla jednej usługi; jeśli chcesz usunąć wpisy PassHolder, usuwasz **wszystkie** stare
logi systemu:

```sh
sudo journalctl --rotate
sudo journalctl --vacuum-time=1s
```

## 10. Sprawdzenie

Każde z tych poleceń powinno nic nie znaleźć albo zgłosić brak:

```sh
systemctl status passholder --no-pager        # Unit passholder.service could not be found.
id passholder                                  # no such user
ls -d /var/lib/passholder /etc/passholder /opt/pass-holder ~/pass-holder 2>&1   # No such file or directory ×4
sudo ss -tlnp | grep 8443                      # pusto
sudo ufw status 2>/dev/null | grep 8443        # pusto (jeśli ufw zostało)
tailscale status 2>&1 | head -1                # command not found (jeśli usunąłeś Tailscale)
node -v 2>&1                                   # command not found (jeśli usunąłeś Node.js)
```

Z Ubuntu: `curl --cacert ~/passholder-ca.crt https://passholder.local:8443/api/v1/status` powinno skończyć
się błędem połączenia (`Connection refused`).

## 11. Poza Pi: router, Ubuntu, telefon

Te kroki nie dotyczą samego Pi, ale bez nich zostają ślady instalacji. Najważniejszy jest urząd
certyfikacji w Chrome.

**Router**

- Rezerwacja DHCP (stały adres IP Pi z 1.1): usuń, jeśli Pi nie będzie już potrzebowało stałego adresu.
- Przekierowania portów: instrukcja ich nie tworzy (Tailscale ich nie potrzebuje); usuń tylko te, które
  dodałeś sam (np. dla WireGuarda).

**Ubuntu: urząd certyfikacji i pliki** (komendy na Ubuntu)

1. W Chrome otwórz `chrome://certificate-manager` (ten sam ekran co w
   [2.2](INSTALACJA.md#22-zaufanie-do-certyfikatu-serwera)) i usuń z zaufanych urząd **„PassHolder local
   CA”**. Póki tam jest, Chrome ufa każdemu certyfikatowi podpisanemu kluczem `ca.key` (w granicach nazw
   `.local` i adresów prywatnych).
2. Usuń klucz urzędu, certyfikaty i kopię `ca.crt` z 2.2:

   ```sh
   shred -u ~/passholder-ca/ca.key
   rm -rf ~/passholder-ca ~/passholder-tls ~/passholder-ca.crt
   ```

   Usuń też ewentualne kopie `ca.key` (pendrive, kopie zapasowe).
3. Kopie bazy `~/passholder-kopia-*.db` zachowaj, jeśli zamierzasz kiedyś postawić serwer od nowa. Usuń je,
   jeśli porzucasz PassHolder całkiem (najpierw przenieś hasła, krok 0).
4. **(Opcjonalnie)** Tailscale na Ubuntu: `sudo tailscale logout && sudo apt purge -y tailscale`, jeśli
   służył tylko do PassHolder.

**Wtyczka Chrome i telefon**

- Jeśli stawiasz serwer od nowa (nowe Pi lub nowa karta): wtyczka i telefon mogą zostać. Po przywróceniu
  bazy z kopii łączysz je jak zwykle; nowy certyfikat serwera oznacza ponowne parowanie telefonu
  ([3.6](INSTALACJA.md#36-nowy-certyfikat-serwera)), a nowe CA ponowny import `ca.crt` w Chrome.
- Jeśli porzucasz PassHolder całkiem: w `chrome://extensions` usuń wtyczkę PassHolder (**Usuń**), a na
  telefonie odinstaluj aplikację. Oba kroki **kasują lokalne kopie sejfu**, więc najpierw upewnij się, że
  hasła są przeniesione (krok 0). Na telefonie usuń też ewentualnie aplikację Tailscale.

## 12. Skąd te kroki

Każdy krok cofa konkretną rzecz z [INSTALACJA.md](INSTALACJA.md) albo z plików w `deploy/`:

| Instalacja | Co powstało | Dezinstalacja |
|---|---|---|
| 1.1 System | stały adres IP w routerze, pakiet `rsync` | 11 (router), 9 |
| 1.2 Node.js 22 | pakiet `nodejs`, repozytorium NodeSource w apt | 8 |
| 1.3 Kod i użytkownik | konto `passholder`, `/var/lib/passholder`, `/etc/passholder`, `/opt/pass-holder`, `~/pass-holder`, cache npm roota | 3, 4 |
| 1.4 Tailscale | pakiet `tailscale`, repozytorium w apt, `/var/lib/tailscale`, urządzenie na koncie Tailscale | 6 |
| 1.5 Certyfikat (`deploy/make-certs.sh`) | na Pi `/etc/passholder/tls/`; na Ubuntu `~/passholder-ca`, `~/passholder-tls` | 3, 11 |
| 1.6 Usługa (`deploy/passholder.service`, `deploy/passholder.env.example`) | `/etc/systemd/system/passholder.service`, `/etc/passholder/passholder.env`, baza tworzona przez serwer | 2, 3 |
| 1.7 Zapora | pakiet `ufw`, reguły dla portów 22 i 8443 | 5 |
| Kopia zapasowa | pakiet `sqlite3`, `~/kopia.db` na Pi, `~/passholder-kopia-*.db` na Ubuntu | 0, 3, 9, 11 |
| 2.2 Zaufanie do certyfikatu | urząd „PassHolder local CA” w Chrome, `~/passholder-ca.crt` | 11 |

Serwer w czasie działania zapisuje wyłącznie bazę (`PASSHOLDER_DB`, w trybie WAL także `-wal` i `-shm`) i
logi w dzienniku systemd. Plik usługi pozwala mu pisać tylko do `/var/lib/passholder`
(`ReadWritePaths`), więc poza wymienionymi miejscami nie zostawia nic.
