# Kilka adresów serwera (sieć domowa + Tailscale)

Dokument opisuje zmiany z gałęzi `claude/project-thread-9shesd`: wtyczka Chrome i aplikacja na Androida
pamiętają więcej niż jeden adres tego samego serwera i przy każdym połączeniu same wybierają ten, który
odpowiada.

## 1. Problem

W wersji 1.0 klient pamiętał jeden adres (`Account.serverUrl`). Raspberry Pi ma jednak dwa:

- w sieci domowej, np. `https://192.168.1.50:8443`,
- w Tailscale, np. `https://100.x.y.z:8443`.

Klient połączony adresem domowym nie synchronizował się spoza domu, a połączony adresem Tailscale nie
działał w domu bez włączonego VPN. Zmiana adresu wymagała odłączenia i ponownego połączenia.

## 2. Jak to działa teraz

### Co klient pamięta

Konto (`Account`) ma teraz:

| Pole | Znaczenie |
|---|---|
| `serverUrls` | lista adresów tego samego serwera, co najmniej jeden, w kolejności wpisania |
| `lastServerUrl` | adres, który odpowiedział ostatnio; przy następnym połączeniu próbowany jako pierwszy |

Konto zapisane przez wersję 1.0 (pole `serverUrl`) jest czytane dalej: przy odczycie staje się listą
z jednym adresem (`upgradeAccount` we wtyczce, `VaultStore.account()` na Androidzie). Nic nie trzeba
łączyć od nowa.

### Wybór adresu

Kod jest w dwóch odpowiadających sobie plikach:
`extension/src/server-urls.ts` (`pickServer`) i `android/core/.../ServerPicker.kt` (`ServerPicker.pick`).

1. Kolejność prób: najpierw `lastServerUrl`, potem pozostałe adresy w kolejności wpisania (`orderForTrying` / `order`).
2. **Jeden adres:** używany od razu, bez sprawdzania. Zachowanie jak w 1.0, bez dodatkowego zapytania.
3. **Kilka adresów:** do każdego po kolei idzie krótkie `GET /api/v1/status` z limitem czasu
   **4 sekundy** (`PROBE_TIMEOUT_MS`). Pierwszy, który odpowie, wygrywa i przez niego idzie właściwa
   operacja (zakładanie sejfu, logowanie, synchronizacja).
4. Każdy błąd sprawdzenia (brak trasy, odmowa połączenia, przekroczony czas, certyfikat, któremu Chrome nie
   ufa, odpowiedź z błędem) znaczy „tu nie ma serwera, spróbuj następnego”.
5. Jeśli nie odpowie żaden, komunikat wymienia wszystkie sprawdzone adresy i przypomina o Tailscale.
   Na Androidzie, jeśli któryś adres pokazał **inny certyfikat**, zgłaszany jest ten błąd (mówi więcej niż
   „nie odpowiada”).
6. Po udanej synchronizacji adres, który zadziałał, zapisuje się jako `lastServerUrl`.

Limit czasu jest potrzebny, bo adres nieosiągalny z miejsca, w którym jesteś (domowy poza domem, Tailscale
przy wyłączonym VPN), mógłby blokować połączenie przez kilkadziesiąt sekund. We wtyczce to
`AbortSignal.timeout` w `ServerClient.status(timeoutMs)` (`extension/src/api.ts`), na Androidzie
`callTimeout` w `ServerClient.status(timeoutMs)` (`android/core/.../ServerClient.kt`). Najgorszy przypadek
przy dwóch adresach: ok. 4 s czekania, zanim zadziała drugi. Zwykle krócej, bo pierwszy próbowany jest
ten, który działał ostatnio, a odmowa połączenia przychodzi od razu.

Token sesji z serwera działa pod każdym adresem (to ten sam serwer), więc przełączenie adresu między
synchronizacjami nie wymaga ponownego logowania.

## 3. Certyfikat i bezpieczeństwo

**Android.** Telefon przypina odcisk SHA-256 certyfikatu serwera i nie sprawdza nazwy hosta
(`ServerClient.kt`, bez zmian). Jeden odcisk obejmuje więc wszystkie adresy: pod każdym musi być dokładnie
ten certyfikat, który potwierdziłeś przy parowaniu. Dlatego:

- przy łączeniu odcisk pobierany jest z **pierwszego adresu, który odpowie** (drugi, np. Tailscale przy
  wyłączonym VPN, nie musi działać w tej chwili); aplikacja pokazuje, z którego adresu go pobrała;
- dodanie albo zmiana adresu w ekranie **Adresy** nie wymaga ponownego potwierdzania odcisku. Nowy adres
  i tak zadziała tylko wtedy, gdy stoi pod nim ten sam serwer z tym samym certyfikatem;
- adres musi mieć ten sam schemat co parowanie (`https://`; `http://` tylko dla serwera deweloperskiego
  w wersji debug), sprawdza to `ServerPicker.validate`.

**Chrome.** Wtyczka korzysta z zaufania Chrome do Twojego CA (`ca.crt`) i Chrome **sprawdza nazwę**.
Każdy adres musi więc być w certyfikacie serwera (`subjectAltName`). Jeśli certyfikat robiłeś bez adresu
Tailscale, wygeneruj go ponownie z oboma adresami (INSTALACJA.md, 1.5); inaczej adres Tailscale zostanie
pominięty jako niedziałający. Wtyczka prosi o zgodę Chrome na dostęp do każdego wpisanego adresu.

Adres z obcej sieci (np. `192.168.1.50` w kawiarni) może prowadzić do zupełnie innego urządzenia. Nie jest
to groźne: w Chrome nie przejdzie weryfikacji certyfikatu, na Androidzie nie zgodzi się odcisk, więc
klient pominie ten adres. Hasło główne nigdy nie jest wysyłane, a dane na serwerze są zaszyfrowane.

## 4. Interfejs

### Wtyczka (`extension/src/popup.ts`)

- Formularz połączenia ma drugie pole: **Drugi adres serwera (opcjonalnie, np. Tailscale)**
  (`serverUrlFields`). Zgoda Chrome jest wymagana dla obu adresów naraz.
- Na liście wpisów jest przycisk **Adresy serwera**. Otwiera kartę `popup.html?addresses` z widokiem
  `addressesView`, w którym zmienisz adresy już połączonej przeglądarki (`VaultStore.setServerUrls`).
  To karta, nie okienko, z tego samego powodu co przy zakładaniu sejfu: okno zgody Chrome zamyka okienko
  wtyczki (docs/WTYCZKA_ZAKLADANIE_SEJFU.md).

### Android (`android/app/...`)

- `ConnectScreen`: pole **Drugi adres (opcjonalnie)** pod adresem serwera; `AppViewModel.inspectServer`
  pobiera certyfikat z pierwszego adresu, który odpowiada (`firstCertificate`).
- `ListScreen`: przycisk **Adresy** otwiera nowy ekran `AddressesScreen` (`Screen.Addresses`), w którym
  zmienisz adresy już sparowanego telefonu (`AppViewModel.saveServerUrls` → `VaultStore.setServerUrls`).
  Systemowy przycisk Wstecz wraca do listy.

Interfejs pokazuje dwa pola, bo o tyle prosiłeś. Model danych i wybór adresu działają dla dowolnej liczby
adresów.

## 5. Jak przejść z wersji 1.0

Telefon i Chrome połączone jednym adresem działają dalej bez zmian. Żeby dodać drugi adres:

- **Chrome:** ikona PassHolder → odblokuj → **Adresy serwera** → w karcie wpisz drugi adres → **Zapisz** →
  zgoda Chrome.
- **Android:** odblokuj → **Adresy** → drugi adres → **Zapisz**.

Potem zsynchronizuj raz w domu i raz spoza domu (z włączonym Tailscale), żeby sprawdzić oba adresy.

## 6. Testy

| Plik | Co sprawdza |
|---|---|
| `extension/test/server-urls.test.ts` | normalizacja i kolejność adresów; jeden adres bez sprawdzania; pominięcie adresu, który milczy (limit czasu); komunikat, gdy nie działa żaden; założenie sejfu z niedziałającym drugim adresem i synchronizacja przez drugi adres tego samego serwera; `lastServerUrl` próbowany jako pierwszy; odczyt konta z wersji 1.0; odrzucenie pustej listy |
| `android/core/.../ServerPickerTest.kt` | to samo dla Kotlina, plus kontrola schematu adresów (`validate`) |
| `android/app/.../ScreenTests.kt` → `TwoAddressesTest` | parowanie z dwoma adresami, gdy pierwszy nie odpowiada (odcisk z drugiego), synchronizacja, edycja adresów w ekranie **Adresy**; zrzuty `12-dwa-adresy.png`, `13-adresy-serwera.png` |

„Dwa adresy tego samego serwera” w testach to dwa serwery HTTP na różnych portach, które dzielą jedną bazę
(we wtyczce prawdziwy serwer Fastify z tą samą bazą SQLite, na Androidzie `FakeServer` podpięty pod dwa
`MockWebServer`). Prawdziwego Tailscale testy nie używają.

Uruchamianie:

```sh
npm test                                   # wtyczka, serwer, rdzeń
cd android && ./gradlew :core:test :app:testDebugUnitTest
```

## 7. Czego nie zmieniłem

- Serwer i protokół: bez zmian. Wybór adresu dzieje się w całości po stronie klientów.
- Certyfikat: `deploy/make-certs.sh` już przyjmuje kilka adresów; zmiana nie była potrzebna.
- Wtyczka nie cofa zgody Chrome dla adresu usuniętego z listy (zostaje w `chrome://extensions` →
  Szczegóły → Dostęp do witryn; możesz ją tam usunąć ręcznie).
