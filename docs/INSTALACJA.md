# Instalacja PassHolder

PassHolder ma dwie części: **aplikację na Androida**, która przechowuje sejf, i **wtyczkę do Chrome**, która
trzyma jego zaszyfrowaną kopię i synchronizuje się bezpośrednio z telefonem. Serwer nie jest potrzebny.

Kolejność: [1. narzędzia na Windows](#1-narzędzia-na-windows) → [2. telefon](#2-telefon) →
[3. wtyczka](#3-wtyczka-do-chrome) → [4. Tailscale (opcjonalnie)](#4-tailscale-opcjonalnie). Potem:
[codzienne używanie](#codzienne-używanie), [aktualizacje](#aktualizacje), [kopia zapasowa](#kopia-zapasowa),
[problemy](#problemy), [znane ograniczenia](#znane-ograniczenia) i [dezinstalacja](#dezinstalacja).

## Jak to działa

```
 Windows: Chrome + wtyczka PassHolder                 Android: aplikacja PassHolder
 (zaszyfrowana kopia sejfu, działa offline)           (sejf; tryb „Synchronizacja”)
              │   HTTP na porcie 8787, w środku Noise KK   ▲
              └────────────────────────────────────────────┘
               ta sama sieć Wi-Fi (LAN) albo Tailscale
```

- Sejf zakładasz na telefonie. Hasła są szyfrowane na urządzeniach (Argon2id + AES-256-GCM, [SPEC.md](SPEC.md)).
- Telefon słucha na porcie **8787** tylko w trybie **Synchronizacja**: włączasz go przyciskiem, a wyłącza się
  sam po 5 minutach bez synchronizacji i po wyjściu z aplikacji. Odpowiada tylko w Wi-Fi i Tailscale, nie w sieci
  komórkowej.
- Wtyczkę parujesz z telefonem jednorazowym 8-cyfrowym kodem. Każda synchronizacja jest szyfrowana i
  uwierzytelniona protokołem Noise, więc zwykłe HTTP wystarcza: nie ma certyfikatów do instalowania.
- Wtyczka działa bez telefonu na swojej kopii; zmiany wymienia, gdy telefon jest w trybie Synchronizacja.
  Szczegóły: [SYNCHRONIZACJA.md](SYNCHRONIZACJA.md).

## Czego potrzebujesz

- Komputer z Windows 11 i Google Chrome 127 lub nowszym (wymaga go autouzupełnianie).
- Telefon z Androidem 8.0 lub nowszym (`minSdk = 26`) i kabel USB.
- Wspólną sieć Wi-Fi dla telefonu i komputera; spoza domu opcjonalnie darmowe konto Tailscale.

Przykłady używają PowerShell. `<repo>` oznacza katalog, do którego sklonowano repozytorium (np. `C:\Projekty\pass-holder`); podstaw własną ścieżkę.

---

## 1. Narzędzia na Windows

1. **Git for Windows** i kod:

   ```powershell
   git clone git@github.com:sheking94/pass-holder.git <repo>
   ```

2. **Node.js 22.18 lub nowszy przez fnm** (do budowania wtyczki):

   ```powershell
   winget install Schniz.fnm
   fnm env --shell powershell | Out-String | Invoke-Expression
   fnm install 22
   node -v
   ```

   Wiersz `fnm env …` trzeba wykonać w każdym nowym oknie PowerShell (albo dopisać go do `$PROFILE`),
   inaczej `node` i `npm` nie są widoczne.

3. **Android Studio** (Android SDK i `adb`). Uruchom je raz, przejdź kreator pierwszego startu i otwórz
   katalog `android\` z repozytorium: Android Studio zapisze ścieżkę do SDK w `android\local.properties`
   (plik nie trafia do gita).

4. **JDK 21** w `$HOME\.jdks\jbr-21.0.11`. JBR 25 dołączony do Android Studio nie działa z Gradle 8.14.3,
   dlatego przed każdym `gradlew.bat` ustaw:

   ```powershell
   $env:JAVA_HOME="$HOME\.jdks\jbr-21.0.11"
   ```

   Jeśli nie masz tego JDK, pobierz JDK 21 w Android Studio (ustawienia Gradle → Gradle JDK → Download JDK;
   nazwy menu zależą od wersji) i podaj jego katalog w `JAVA_HOME`.

## 2. Telefon

Aplikacji nie ma w Google Play: budujesz ją i instalujesz przez USB.

### 2.1. Debugowanie USB

1. **Ustawienia → Informacje o telefonie** → stuknij 7 razy w **Numer kompilacji** (pojawią się „Opcje programisty”).
2. **Opcje programisty** → włącz **Debugowanie USB** (nazwy zależą od producenta).
3. Podłącz telefon i zaakceptuj na nim okno zgody na debugowanie (najlepiej z „zawsze zezwalaj z tego komputera”).
   Sprawdzenie: `& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" devices` pokazuje telefon jako `device`.

### 2.2. Instalacja

```powershell
cd <repo>\android
$env:JAVA_HOME="$HOME\.jdks\jbr-21.0.11"
.\gradlew.bat :app:installDebug
```

Pierwsza budowa pobiera Gradle i zależności (kilka minut). Na telefonie pojawi się aplikacja „PassHolder”.

**Klucz podpisu.** Aplikacja jest podpisana kluczem debug z tego komputera:
`$HOME\.android\debug.keystore`. Zachowaj go (i zrób kopię): Android przyjmuje aktualizację tylko z
tym samym podpisem. Inny klucz oznacza odinstalowanie aplikacji, czyli usunięcie sejfu z telefonu (wróci
z wtyczki przez „Odtwórz z wtyczki”, patrz [kopia zapasowa](#kopia-zapasowa)).

**Własny klucz wydania (opcjonalnie, przegląd bezpieczeństwa N5).** Kto ma `debug.keystore` z komputera, na
którym budowano, może wydać „aktualizację”, którą Android zainstaluje na miejscu PassHoldera i która dostanie
jego dane. Ponadto wersja debug pozwala czytać pliki aplikacji przez USB (`adb run-as`, przy włączonym
debugowaniu USB). Wersja wydania z własnym kluczem nie ma tych słabości:

Obu plików poniżej nie ma w repozytorium i nic ich nie generuje: tworzysz je raz, ręcznie. Główny
`.gitignore` pomija `keystore.properties` i `*.jks` w każdym katalogu, więc nie trafią do repo
(sprawdzisz to: `git check-ignore -v android\keystore.properties`).

1. **Klucz.** `keytool` jest w JDK, ale zwykle nie ma go w `PATH`, więc wołaj go z `JAVA_HOME`. Polecenie
   pyta o hasło magazynu i dane właściciela (mogą być dowolne):

   ```powershell
   cd <repo>\android
   $env:JAVA_HOME="$HOME\.jdks\jbr-21.0.11"
   & "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -v -keystore passholder-release.jks -alias passholder -keyalg RSA -keysize 4096 -validity 10000
   ```

   Magazyn ma format PKCS12, w którym hasło klucza jest takie samo jak hasło magazynu.

2. **Plik `android\keystore.properties`.** W tym samym katalogu (`<repo>\android`), z hasłem z kroku 1:

   ```powershell
   $haslo = Read-Host "Hasło magazynu"
   "storeFile=passholder-release.jks", "storePassword=$haslo", "keyAlias=passholder", "keyPassword=$haslo" |
     Set-Content -Encoding ascii keystore.properties
   ```

   `storeFile` jest liczone względem `<repo>\android` (`android/app/build.gradle.kts`). Hasło: tylko znaki
   ASCII (bez polskich liter) i bez `\`, który format `.properties` traktuje jako znak ucieczki.

Instalacja wersji wydania: `.\gradlew.bat :app:installRelease`. Bez `keystore.properties` wersja wydania
dostaje klucz debug (jak dotąd). **Zmiana klucza wymaga odinstalowania aplikacji** (inny podpis): najpierw
eksport albo synchronizacja z wtyczką, potem odinstalowanie, instalacja i „Odtwórz z wtyczki”. Zrób kopię
`passholder-release.jks` i haseł w bezpiecznym miejscu: bez nich nie zainstalujesz aktualizacji.

### 2.3. Założenie sejfu

1. Otwórz aplikację i wybierz **Nowy sejf**.
2. Wpisz **Hasło główne** i **Powtórz hasło główne**, stuknij **Załóż sejf**. Hasło musi mieć co najmniej 12
   znaków i nie może być oczywistym wzorcem: ten sam fragment powtórzony, prosty ciąg (`123456789012`,
   `qwertyuiopas`), mniej niż 5 różnych znaków albo popularne słowo z cyframi (`password2026`, `Haslo1234567`).
   Najlepiej zdanie z kilku słów.

**Hasła głównego nie da się odzyskać.** Bez niego nie otworzysz sejfu ani na telefonie, ani we wtyczce.

Opcjonalnie w ⋮ → **Ustawienia**: przełącznik **Odblokowanie odciskiem palca** i **Blokuj dopiero po 60 s poza
aplikacją** ([FUNKCJE.md](FUNKCJE.md#odcisk-palca-i-blokada-po-wyjściu-android)).

### 2.4. Autouzupełnianie

Opcjonalnie: telefon podpowiada loginy, karty i adresy w innych aplikacjach i przeglądarkach.

1. W PassHolderze: ⋮ → **Ustawienia** → **Autouzupełnianie** → **Włącz**.
2. W oknie systemu wybierz **PassHolder** i potwierdź. Po powrocie wiersz pokazuje „Włączone”. (Ręcznie:
   Ustawienia telefonu → System → Języki i wprowadzanie → Usługa autouzupełniania; nazwy różnią się między
   producentami.) Przy wyłączonym „Blokuj dopiero po 60 s poza aplikacją” sejf blokuje się, gdy otwiera się
   okno systemu – po powrocie odblokuj go ponownie.
3. Chrome na telefonie: Ustawienia → **Autouzupełnianie** (Usługi autouzupełniania) → zaznacz
   **Autouzupełnianie przez inną usługę** i uruchom Chrome ponownie. Bez tego Chrome podpowiada tylko z
   własnego menedżera haseł.

4. Zapisywanie nowych haseł: w ⋮ → **Ustawienia** przełącznik **Pytaj o zapis haseł** (domyślnie włączony). Po
   zalogowaniu w aplikacji lub w Chrome system wyświetla okno z pytaniem o zapis w PassHolder (także po rejestracji); po „Zapisz”
   otwiera się podgląd, w którym można poprawić nazwę, login i hasło ([FUNKCJE.md](FUNKCJE.md#android-2)).

Opis: [FUNKCJE.md](FUNKCJE.md#android-1). Wyłączenie: ten sam systemowy wybór, usługa „Brak”.

## 3. Wtyczka do Chrome

### 3.1. Zbudowanie

```powershell
cd <repo>
fnm env --shell powershell | Out-String | Invoke-Expression
npm ci
npm run build
```

Wynik trafia do `extension\dist\` (`extension/build.mjs`). Opcjonalnie sprawdź kod: `npm test`.

### 3.2. Załadowanie w Chrome

1. Otwórz `chrome://extensions` i włącz **Tryb dewelopera** (prawy górny róg).
2. **Załaduj rozpakowane** → wskaż `<repo>\extension\dist`.
3. Przypnij ikonę PassHolder do paska (ikona puzzla → pinezka).

Nie przenoś katalogu `extension\dist`: Chrome ładuje wtyczkę bezpośrednio z niego, a wtyczka wczytana z
innej ścieżki to dla Chrome nowa wtyczka z pustą pamięcią.

### 3.3. Parowanie z telefonem

1. **Telefon:** odblokuj sejf → **Synchronizacja**. Ekran pokazuje „Adres telefonu do wpisania we wtyczce:”,
   np. `http://192.168.1.23:8787`. Stuknij **Dodaj wtyczkę**: pojawi się 8-cyfrowy kod, ważny 2 minuty,
   działa raz. Ekran nie gaśnie, dopóki działa tryb synchronizacji.
2. **Wtyczka:** kliknij ikonę PassHolder → **Sparuj z telefonem**. Formularz otworzy się w karcie (Chrome
   zamyka okienko wtyczki, gdy pyta o zgodę). Wpisz:
   - **Adresy telefonu** – adres z ekranu telefonu (tylko adres IPv4, nazwy nie działają),
   - **Kod parowania (8 cyfr)**,
   - **Nazwa tej przeglądarki** – zobaczysz ją w telefonie w „Urządzenia”.
3. Kliknij **Sparuj**. Chrome zapyta o zgodę na dostęp do `http://<adres>:8787`: zezwól.
4. Wpisz **Hasło główne** sejfu z telefonu i kliknij **Odblokuj i synchronizuj**. Pomyłka w haśle nie
   spala kodu: spróbuj jeszcze raz.
5. Wtyczka pokaże „Sparowano z telefonem…” i listę wpisów, a telefon „Sparowano: <nazwa>”. Na telefonie
   stuknij **Zakończ**. Kartę możesz zamknąć.

Kolejną przeglądarkę parujesz tak samo, z nowym kodem.

## 4. Tailscale (opcjonalnie)

Bez Tailscale synchronizacja działa, gdy telefon i komputer są w tej samej sieci Wi-Fi. Z Tailscale także
poza domem.

1. Zainstaluj Tailscale na Windows (`winget install Tailscale.Tailscale` albo tailscale.com) i aplikację
   Tailscale z Google Play na telefonie; zaloguj obie na to samo konto.
2. Na telefonie włącz tryb **Synchronizacja**: ekran pokazuje też adres Tailscale (`http://100.x.y.z:8787`).
3. We wtyczce: **Adresy telefonu** → wpisz ten adres w wolnym polu → **Zapisz** (Chrome zapyta o zgodę).

Ponowne parowanie nie jest potrzebne. Przy synchronizacji wtyczka sama wybiera adres, który odpowiada
(najpierw ostatnio działający). Adresy, które telefon poda sam, wtyczka dopisuje do listy, ale używa ich
dopiero po **Zapisz** w „Adresy telefonu” (wtedy Chrome pyta o zgodę).

---

## Codzienne używanie

- **Synchronizacja:** na telefonie **Synchronizacja** (aplikacja na wierzchu), we wtyczce **Synchronizuj** →
  „Zsynchronizowano z telefonem HH:MM”. Na telefonie potem **Zakończ**. Wpisy zmienione we wtyczce, a
  jeszcze niewysłane, mają kropkę •.
- **Wtyczka:** **+ Dodaj** (z generatorem haseł), kopiowanie loginu i hasła (schowek czyszczony po minucie),
  **PIN**, **Plik** (import i eksport), **Adresy telefonu**, **Otwórz w karcie ↗** (opis: [FUNKCJE.md](FUNKCJE.md)).
- **Autouzupełnianie:** na stronie logowania okienko pokazuje „Pasujące do tej strony” → **Wypełnij**; skrót
  `Ctrl+Shift+L` wypełnia od razu, gdy pasuje jeden login. Skrót zmienisz w `chrome://extensions/shortcuts`
  (przy PassHolder, „Wypełnij login na tej stronie”). Opis: [FUNKCJE.md](FUNKCJE.md#autouzupełnianie).
- **Pytanie o zapis:** **Zapis** → **Pytaj o zapis haseł** (domyślnie wyłączone); Chrome pyta o dostęp do
  wszystkich stron: zezwól. Karty otwarte wcześniej przeładuj. Po zalogowaniu na stronie panel pyta, czy zapisać
  login. Opis i ograniczenia: [FUNKCJE.md](FUNKCJE.md#pytanie-o-zapis).
- **Telefon:** zakładki na dole (Loginy, Kontakty, Karty, Notatki, Dokumenty) i **+ Dodaj** dla otwartej zakładki;
  menu ⋮ **Więcej**: **Urządzenia** (sparowane wtyczki, daty ostatniej synchronizacji, **Usuń**: wtyczka przestaje
  się synchronizować), **Ustawienia** (odcisk palca, opóźnienie blokady, autouzupełnianie), **Zablokuj**.
- **Autouzupełnianie na telefonie:** stuknij pole logowania w aplikacji albo w Chrome → wybierz wpis z listy
  pod polem lub z paska klawiatury. Przy zablokowanym sejfie **Odblokuj PassHolder** → hasło główne albo odcisk.
- **Blokada:** obie części blokują się po 15 minutach bez aktywności; telefon także 60 s po wyjściu z
  aplikacji (albo od razu, gdy wyłączysz opóźnienie), wtyczka po zamknięciu przeglądarki.

## Aktualizacje

```powershell
cd <repo>
git pull
fnm env --shell powershell | Out-String | Invoke-Expression
npm ci
npm run build
```

Potem w `chrome://extensions` kliknij przycisk odświeżania (strzałka) na karcie PassHolder. Dane wtyczki zostają.

Telefon (podłączony przez USB):

```powershell
cd android
$env:JAVA_HOME="$HOME\.jdks\jbr-21.0.11"
.\gradlew.bat :app:installDebug
```

Nowa wersja instaluje się na starej, sejf zostaje (pod warunkiem tego samego `debug.keystore`).

## Kopia zapasowa

- **Wtyczka jest kopią sejfu.** Każda sparowana przeglądarka ma pełną zaszyfrowaną kopię z chwili ostatniej
  synchronizacji. Synchronizuj regularnie. Aplikacja na telefonie nie robi kopii w chmurze Google
  (`allowBackup=false`).
- **Nowy, zgubiony albo przeinstalowany telefon:** zainstaluj aplikację (2.2), na ekranie startowym wybierz
  **Odtwórz z wtyczki** → **Rozpocznij odtwarzanie**. Telefon pokaże adres i kod. We wtyczce:
  **Adresy telefonu** → „Sparuj z innym telefonem / odtwórz telefon”: adres, kod, hasło główne → **Sparuj**
  („Telefon odtworzony z tej wtyczki…”). Na telefonie wpisz **Hasło główne** → **Zakończ odtwarzanie**.
  Pozostałe przeglądarki sparuj z nowym telefonem tym samym formularzem, z kodem z **Dodaj wtyczkę**.
- **Eksport do pliku** (awaryjnie, gdy chcesz mieć kopię poza PassHolderem): we wtyczce **Plik** → wybierz format
  (PassHolder JSON zachowuje wszystko) → zaznacz „Rozumiem, plik będzie zawierał hasła jawnym tekstem” → **Pobierz plik**. Plik **nie jest
  zaszyfrowany**: trzymaj go na zaszyfrowanym nośniku (np. BitLocker To Go) albo usuń zaraz po użyciu.
  Import: **Plik** → wybierz plik → **Importuj**, potem **Synchronizuj**.
- **Szyfrowanie dysku:** z opcją „Pamiętaj PIN po zamknięciu przeglądarki” na dysku leżą klucze sejfu
  zaszyfrowane PIN-em. Włącz wtedy BitLocker na dysku systemowym (Windows 11 Pro go ma).

## Problemy

| Objaw | Co zrobić |
|---|---|
| „Telefon nie odpowiada. Czy tryb Synchronizacja jest włączony?” | Włącz **Synchronizacja** na telefonie (wyłącza się po wyjściu z aplikacji i po 5 min bez synchronizacji; „Włącz ponownie”). Telefon nie odpowiada w sieci komórkowej, tylko w Wi-Fi i Tailscale. Sprawdź, czy oba urządzenia są w tej samej sieci Wi-Fi (sieć dla gości często blokuje połączenia między urządzeniami) i czy adres w „Adresy telefonu” zgadza się z ekranem telefonu. |
| Telefon: „Telefon nie ma adresu w sieci…” | Połącz telefon z Wi-Fi (albo włącz Tailscale). |
| Telefon: „Nie mogę uruchomić synchronizacji: port 8787 jest zajęty.” | Zamknij aplikację i otwórz ją ponownie; w ostateczności uruchom telefon ponownie. |
| „Zły kod parowania…” albo „Telefon nie czeka na parowanie albo kod wygasł.” | Kod działa raz i 2 minuty. Na telefonie znów **Dodaj wtyczkę** i wpisz nowy kod. |
| „Nieprawidłowy adres telefonu…” | Wpisz adres IPv4 z ekranu telefonu, np. `http://192.168.1.23:8787`; nazwy (także MagicDNS) i IPv6 nie działają. |
| „Brak zgody Chrome…” albo „Pominięto adresy bez zgody Chrome…” | **Adresy telefonu** → **Zapisz** i zezwól w oknie Chrome. |
| „Złe hasło główne” | Sprawdź wielkość liter i układ klawiatury. |
| „Parowanie wygasło…” | Po 10 min bez hasła parowanie przepada. Usuń wskazaną przeglądarkę na telefonie w **Urządzenia** i sparuj od nowa. |
| „Telefon nie zna tej przeglądarki…” | Telefon usunął ją z „Urządzenia”. **Adresy telefonu** → „Sparuj z innym telefonem / odtwórz telefon” z kodem z **Dodaj wtyczkę**; lokalne zmiany zostają. |
| „To inny sejf…” | Telefon ma inny sejf niż wtyczka. Nic się nie zmieniło; usuń przeglądarkę z „Urządzenia” na tamtym telefonie. |
| Telefon: brak podpowiedzi PassHolder w polach | **Ustawienia** → **Autouzupełnianie** musi być „Włączone”; w Chrome zaznacz „Autouzupełnianie przez inną usługę” (2.4). Login w aplikacji musi mieć jej pakiet w „Aplikacje”, w przeglądarce adres strony. |
| `gradlew.bat` kończy się błędem zaraz po starcie | Nie ustawiono `$env:JAVA_HOME="$HOME\.jdks\jbr-21.0.11"` w tym oknie PowerShell. |
| Gradle: brak Android SDK (`SDK location not found`) | Otwórz `android\` w Android Studio albo utwórz `android\local.properties` z `sdk.dir`. |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | Aplikacja na telefonie ma inny podpis. Przywróć swój `debug.keystore`; inaczej odinstaluj aplikację i odtwórz sejf z wtyczki. |
| `adb devices` pokazuje `unauthorized` | Odblokuj telefon i zaakceptuj okno debugowania USB. |
| `node` / `npm` nie jest rozpoznawane | Wykonaj `fnm env --shell powershell \| Out-String \| Invoke-Expression` w tym oknie. |

## Znane ograniczenia

- **Bez telefonu w pobliżu nie ma synchronizacji** (także między dwoma komputerami). Wtyczka działa wtedy
  offline na swojej kopii.
- **Tylko adresy IPv4.** Telefon odrzuca nazwy (MagicDNS z Tailscale) i IPv6 jako ochronę przed DNS rebinding.
- **Tailscale w prawdziwym Chrome nie był jeszcze sprawdzony** (test T4 w [TESTY.md](TESTY.md#testy-ręczne)).
- **Zmiany na tym samym wpisie bez synchronizacji** w obu miejscach: wygrywa późniejsza, druga przepada.
- **Pytanie o zapis** wymaga dostępu do wszystkich stron; karty otwarte przed włączeniem trzeba przeładować, logowanie w obcej ramce nie jest zgłaszane (więcej w [FUNKCJE.md](FUNKCJE.md#pytanie-o-zapis)). Na telefonie pytanie o zapis obejmuje też formularze rejestracji, a od Androida 9 zapis poprzedza podgląd.
- **Wtyczka w trybie dewelopera:** Chrome może przy starcie przypominać o takich wtyczkach.
- **Klucz debug:** aktualizacje wymagają tego samego `debug.keystore` (2.2). Własny klucz wydania jest opcjonalny (2.2).

---

## Dezinstalacja

Jak usunąć wtyczkę, aplikację i narzędzia z tej instrukcji. Kroki D2 i D3 usuwają sejf; reszta jest opcjonalna.

### D1. Najpierw kopia haseł

Po krokach D2 i D3 sejfu nie ma już nigdzie. Jeśli hasła mają przetrwać (np. przenosisz je do innego
menedżera), zrób kopię **przed** usunięciem:

1. Na telefonie **Synchronizacja**, we wtyczce **Synchronizuj**, żeby wtyczka miała wszystkie wpisy.
2. We wtyczce **Plik** → wybierz format → zaznacz „Rozumiem, plik będzie zawierał hasła jawnym tekstem” → **Pobierz plik**.
3. Sprawdź, że plik nie jest pusty, zaimportuj go tam, gdzie trzeba, i **usuń go** (także z Kosza). Plik
   zawiera hasła jawnym tekstem.

Jeśli usuwasz tylko jedną część (np. wtyczkę z jednego komputera), druga zachowuje sejf i kopia nie jest
potrzebna.

### D2. Wtyczka w Chrome

1. Opcjonalnie: zablokuj sejf i na ekranie blokady kliknij **Odłącz tę przeglądarkę** (dwa razy, drugie
   kliknięcie potwierdza). To usuwa konto i sejf z pamięci wtyczki.
2. `chrome://extensions` → na karcie PassHolder **Usuń** → potwierdź. Chrome usuwa razem z wtyczką całą jej
   pamięć (zaszyfrowany sejf, PIN, adresy telefonu) i zgody na adresy telefonu.

Powtórz w każdej przeglądarce, w której była wtyczka.

### D3. Aplikacja na telefonie

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

### D4. Sparowane urządzenia

Jeśli usuwasz tylko jedną wtyczkę, a telefon zostaje: na telefonie **Urządzenia** → przy tej przeglądarce
**Usuń** → **Usuń**. Telefon przestaje się z nią synchronizować. Po odinstalowaniu aplikacji (D3) ten
krok nie jest potrzebny.

### D5. Tailscale (opcjonalnie)

Jeśli instalowałeś Tailscale tylko dla PassHoldera:

- Windows: Ustawienia → Aplikacje → Tailscale → Odinstaluj (albo `winget uninstall Tailscale.Tailscale`).
- Telefon: odinstaluj aplikację Tailscale.
- Na stronie konta Tailscale (Machines) usuń oba urządzenia, jeśli zostały na liście.

### D6. Repozytorium i wyniki budowania (opcjonalnie)

W katalogu repozytorium leżą tylko wyniki instalacji i budowania (nie ma w nich haseł):

```powershell
cd <repo>
Remove-Item -Recurse -Force node_modules, extension\dist, android\build, android\app\build, android\core\build, android\.gradle -ErrorAction SilentlyContinue
```

Albo usuń cały katalog `<repo>`, jeśli kod nie jest Ci już potrzebny.
`android\local.properties` zawiera tylko ścieżkę do Android SDK.

**Klucz podpisu** `$HOME\.android\debug.keystore` usuwaj tylko wtedy, gdy nie budujesz już żadnych
aplikacji na Androida: Android Studio używa go dla wszystkich projektów i utworzy nowy przy następnej budowie.

### D7. Narzędzia na Windows (opcjonalnie)

Jeśli nie są potrzebne do niczego innego:

- **Android Studio**: Ustawienia → Aplikacje → Android Studio → Odinstaluj; potem usuń Android SDK
  (`%LOCALAPPDATA%\Android\Sdk`) i pamięć podręczną Gradle (`%USERPROFILE%\.gradle`).
- **JDK 21**: usuń katalog `%USERPROFILE%\.jdks\jbr-21.0.11`.
- **Node.js przez fnm**: `fnm uninstall 22`, potem `winget uninstall Schniz.fnm`; wiersz `fnm env …` usuń z
  `$PROFILE`, jeśli go tam dopisałeś. Pamięć podręczna npm: `%LOCALAPPDATA%\npm-cache`.
- **Git for Windows**: Ustawienia → Aplikacje → Git → Odinstaluj.
