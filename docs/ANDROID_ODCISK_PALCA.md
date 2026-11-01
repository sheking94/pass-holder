# Android: odblokowanie odciskiem palca

> Uwaga (2026-11-01): część nazw funkcji i plików opisanych niżej zmieniła się przy poprawkach po przeglądzie kodu, zob. [POPRAWKI_PRZEGLADU_2.md](POPRAWKI_PRZEGLADU_2.md).

Ten dokument opisuje, jak działa odblokowanie sejfu odciskiem palca w aplikacji Android i dlaczego zrobiono to właśnie tak.

## Co widzi użytkownik

1. Po dodaniu sejfu (nowego albo istniejącego) na dole listy wpisów jest przełącznik **„Odblokowanie odciskiem palca”**.
   - Telefon bez czytnika odcisków: przełącznika nie ma.
   - Telefon z czytnikiem, ale bez zapisanego odcisku: przełącznik jest wyszarzony z podpowiedzią „Najpierw dodaj odcisk palca w ustawieniach telefonu”.
2. Włączenie przełącznika otwiera systemowe okno odcisku palca. Po przyłożeniu palca pojawia się „Włączono odblokowanie odciskiem palca. Hasło główne nadal działa.”
3. **Sejf blokuje się po wyjściu z aplikacji** (przycisk Home, lista ostatnich aplikacji, przejście do innej aplikacji, wyłączenie ekranu, zamknięcie przyciskiem Wstecz). Domyślnie **60 sekund** po wyjściu: krótki wypad, np. wklejenie hasła w przeglądarce i powrót po login, nie blokuje sejfu i nie kasuje rozpoczętego formularza wpisu. Przełącznik **„Blokuj dopiero po 60 s poza aplikacją”** na ekranie listy (pod przełącznikiem odcisku) wyłącza opóźnienie: wtedy sejf blokuje się od razu. Obrót ekranu nie blokuje. Szczegóły w „Blokada przy wyjściu z aplikacji” niżej.
4. Przy każdym otwarciu aplikacji i po automatycznej blokadzie po 15 minutach okno odcisku palca otwiera się samo. Na ekranie blokady jest też przycisk **„Odblokuj odciskiem palca”**.
5. Po ręcznym „Zablokuj” okno nie otwiera się samo, bo od razu wyskakiwałoby z powrotem. Wystarczy nacisnąć przycisk. Po wyjściu z aplikacji i powrocie okno znów otworzy się samo.
6. Hasło główne działa zawsze. W oknie odcisku jest przycisk „Użyj hasła głównego”.
7. „Odłącz ten telefon” wyłącza też odcisk palca.

Zrzuty ekranu (z testów): `android/app/screenshots/12-odcisk-wylaczony.png` … `18-opoznienie-wylaczone.png`.

## Blokada przy wyjściu z aplikacji

**Dlaczego wcześniej nie trzeba było przykładać palca.** Klucze odblokowanego sejfu trzyma `VaultStore`, a ten należy do `PassHolderApp`, czyli do **procesu** aplikacji, a nie do ekranu (aktywności) ani do `AppViewModel`. Zamknięcie aplikacji (Wstecz, zamknięcie z listy ostatnich aplikacji) niszczy aktywność i ViewModel, ale Android zwykle zostawia proces w pamięci jeszcze przez dłuższy czas. Przy ponownym otwarciu nowy ViewModel widział `store.isUnlocked == true` i od razu pokazywał listę. Sejf blokowała tylko automatyczna blokada po 15 minutach albo zabicie procesu przez system.

**Co jest teraz.** `MainActivity.onStop()` woła `AppViewModel.lockOnLeave()`. `onStop` przychodzi zawsze, gdy aktywność przestaje być widoczna, więc obejmuje wszystkie sposoby wyjścia z aplikacji. Wyjątek to obrót ekranu: Android też wtedy zatrzymuje i tworzy aktywność od nowa, ale `isChangingConfigurations` jest `true` i nic się nie dzieje. `MainActivity.onStart()` woła `AppViewModel.onReturn()`.

```
MainActivity.onStop()  (nie przy obrocie ekranu)
  → AppViewModel.lockOnLeave()
      fingerprintOnLockedScreen = true       // po powrocie okno odcisku ma się otworzyć samo
      fingerprintRequests += 1               // ekran blokady wie, że to nowy powrót
      sejf zablokowany?           → koniec
      opóźnienie włączone (domyślnie) → LeaveLock.schedule(60 s)   // minutnik w procesie aplikacji
      opóźnienie wyłączone        → lockNow()

lockNow()
      trwa operacja (np. sync) → lockWhenDone = true; zablokuje się zaraz po jej końcu
      inaczej                  → VaultStore.lock() (zeruje klucze), ekran = Zablokowany

Po 60 s poza aplikacją (minutnik LeaveLock)
  → VaultStore.lock() w osobnym wątku

MainActivity.onStart()  (powrót)
  → AppViewModel.onReturn()
      LeaveLock.cancel(): zatrzymuje minutnik; minęło już 60 s? → lockNow()
      sejf zablokowany, a ekran pokazuje wpisy? → ekran = Zablokowany
  → LockedScreen: LaunchedEffect(fingerprintRequests)
      czeka, aż aktywność jest na wierzchu (RESUMED), bo okna odcisku nie da się pokazać z tła
      → okno odcisku palca (jeśli odcisk jest włączony)
```

Szczegóły:

- **Opóźnienie 60 s (`LeaveLock.kt`).** Minutnik należy do `PassHolderApp`, czyli do procesu, a nie do ekranu ani ViewModelu: po „Wstecz” aktywność i ViewModel znikają, a klucze nadal są w pamięci, więc minutnik musi przeżyć ekran. Odlicza `SystemClock.elapsedRealtime`, czyli zegar, który liczy też podczas uśpienia telefonu i którego nie da się przestawić w ustawieniach.
- **Dwa zabezpieczenia.** Android może „zamrozić” aplikację w tle i wtedy minutnik nie wystartuje na czas. Dlatego przy powrocie `LeaveLock.cancel()` porównuje zegar z terminem i, jeśli 60 s minęło, sejf jest blokowany od razu, zanim pokaże się jakikolwiek wpis.
- **Ustawienie** jest zapisane w `SharedPreferences "settings"` jako `lockDelay` (domyślnie `true`, klasa `Settings` w `PassHolderApp.kt`). Przełącznik: `LockDelaySetting` w `ui/ListScreen.kt`.
- **Blokada bez opóźnienia od razu, na głównym wątku.** `VaultStore.lock()` tylko zeruje dwie tablice bajtów, więc jest natychmiastowe. Robimy je synchronicznie w `onStop`, bo przy zamknięciu aplikacji zaraz potem znika ViewModel razem ze swoimi korutynami. Minutnik blokuje w osobnym wątku, bo może trafić na trwającą synchronizację.
- **Gdy trwa operacja.** Metody `VaultStore` są `@Synchronized`; synchronizacja z serwerem może trwać kilka sekund i trzyma blokadę. `lock()` na głównym wątku czekałby na nią i zamroziłby aplikację. Dlatego wtedy ustawiamy `lockWhenDone`, a `launchVaultOperation` blokuje sejf w `finally`, zaraz po końcu operacji. Jeśli ViewModel zniknie wcześniej (aplikacja zamknięta w trakcie), `onCleared()` blokuje sejf w osobnym wątku.
- **Okno odcisku przy każdym powrocie.** `LaunchedEffect` na ekranie blokady jest kluczowany licznikiem `fingerprintRequests`, więc uruchamia się ponownie przy każdym powrocie, także wtedy, gdy sejf był już zablokowany (np. okno odcisku zostało anulowane, bo wcześniej wyszedłeś z aplikacji).
- Systemowe okno odcisku palca nie zatrzymuje aktywności (tylko ją pauzuje, `onPause`), więc samo w sobie nie powoduje blokady.

Koszt (świadomy):

- Z opóźnieniem klucze zostają w pamięci jeszcze do 60 s po wyjściu z aplikacji. Ktoś, kto w tym czasie weźmie odblokowany telefon, otworzy sejf bez palca. Kto woli bezpieczniej, wyłącza przełącznik.
- Po zablokowaniu (od razu albo po 60 s) niezapisane zmiany w otwartym formularzu wpisu przepadają. Inaczej trzeba by je trzymać w pamięci po zablokowaniu, a tego nie chcemy. Przy powrocie przed upływem 60 s formularz zostaje (o ile aplikacja nie została zamknięta przyciskiem Wstecz).

## Jak to działa (kryptografia)

Hasła głównego **nie zapisujemy** nigdzie. Zapisujemy coś innego: dwa klucze, które odblokowany sejf i tak trzyma w pamięci.

| Klucz | Do czego służy |
|---|---|
| klucz sejfu (32 B) | odszyfrowuje lokalną kopię sejfu |
| klucz uwierzytelniania (32 B) | logowanie do serwera przy synchronizacji |

Dzięki temu po odblokowaniu odciskiem działa też synchronizacja, a Argon2id (kilka sekund) nie jest w ogóle liczony.

```
Włączanie (sejf odblokowany):
  Android Keystore: nowy klucz AES-256-GCM "passholder-biometric-unlock"
     (wymaga silnej biometrii przy KAŻDYM użyciu, ginie po dodaniu nowego odcisku)
  okno odcisku palca → Keystore odblokowuje szyfr
  AES-GCM(klucz sejfu ‖ klucz uwierzytelniania) → SharedPreferences "biometric": iv + data

Odblokowanie:
  SharedPreferences "biometric": iv → szyfr do odszyfrowania (jeszcze zablokowany)
  okno odcisku palca → Keystore odblokowuje szyfr
  odszyfruj data → 64 bajty → VaultStore.unlockWithKeys
  VaultStore odszyfrowuje lokalny sejf; zły klucz = błąd AES-GCM = odmowa
```

Dlaczego to jest bezpieczne:

- **Klucz Keystore nie opuszcza Keystore.** Na większości telefonów siedzi w osobnym, sprzętowym module (TEE albo StrongBox). Aplikacja dostaje tylko „uchwyt”, nie bajty klucza. Nawet z kopią plików aplikacji nie da się odszyfrować `data`.
- **Każde użycie wymaga palca.** `setUserAuthenticationRequired(true)` bez okna czasowego (na Androidzie 11+ `setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG)`). Keystore wykona szyfrowanie tylko na szyfrze, który przeszedł przez `BiometricPrompt` z `CryptoObject`.
- **Tylko silna biometria** (`BIOMETRIC_STRONG`), więc nie przejdzie np. słabe rozpoznawanie twarzy z kamery.
- **Nowy odcisk w telefonie unieważnia klucz** (`setInvalidatedByBiometricEnrollment(true)`). Ktoś, kto zna PIN ekranu, nie doda swojego palca i nie otworzy sejfu. Aplikacja wykrywa to (`KeyPermanentlyInvalidatedException`), kasuje zapisane dane i prosi o hasło główne: „Odcisk palca przestał działać…”.
- **Bez kopii zapasowych.** `SharedPreferences` są wyłączone z kopii w chmurze i z przenoszenia na nowy telefon (`data_extraction_rules.xml`, `allowBackup=false`). Zresztą na innym telefonie nie byłoby klucza Keystore.

Słabe punkty (świadomie zaakceptowane):

- Odcisk palca jest tak silny jak zabezpieczenie telefonu. Ktoś, kto zmusi Cię do przyłożenia palca, otworzy sejf. Hasła głównego nie da się w ten sposób wymusić „fizycznie”.
- Na telefonie z odblokowanym bootloaderem albo rootem, przy Keystore bez wsparcia sprzętowego, ochrona jest słabsza.
- Zmiana hasła głównego nie istnieje w aplikacji. Gdyby kiedyś powstała i zmieniała klucz sejfu, trzeba będzie wtedy wyłączyć odcisk palca (zapisane klucze przestałyby pasować; aplikacja i tak by to wykryła i poprosiła o hasło).

## Pliki

| Plik | Co robi |
|---|---|
| `android/core/.../VaultStore.kt` | Nowe `exportUnlockKeys()` (kopia 64 bajtów kluczy z pamięci) i `unlockWithKeys(keys)` (odblokowanie bez Argon2id; poprawność kluczy sprawdza odszyfrowanie lokalnego sejfu). |
| `android/app/.../BiometricUnlock.kt` | Cała obsługa odcisku: `BiometricUnlock` (zapis/odczyt w SharedPreferences, włącz/wyłącz), `KeystoreKeyProtector` (klucz w Android Keystore), `SystemFingerprintPrompt` (systemowe okno `BiometricPrompt` i sprawdzenie, czy telefon ma czytnik). Dwa interfejsy (`UnlockKeyProtector`, `FingerprintPrompt`) pozwalają w testach podmienić Keystore i czytnik. |
| `android/app/.../AppViewModel.kt` | `enableBiometric`, `disableBiometric`, `unlockWithBiometric`, `biometricEnabled` (StateFlow dla ekranów), flaga „otwórz okno odcisku samo” (tak po starcie, po powrocie z tła i po auto-blokadzie, nie po „Zablokuj”). `lockOnLeave()` / `onReturn()` / `lockNow()`: blokada przy wyjściu z aplikacji (od razu albo przez `LeaveLock`, z odroczeniem, gdy trwa operacja), `fingerprintRequests` liczy powroty, `lockDelay` / `setLockDelay` obsługują przełącznik. `disconnect()` wyłącza też odcisk. |
| `android/app/.../ui/ListScreen.kt` | Wiersze z przełącznikami odcisku palca i opóźnienia blokady (cały wiersz jest klikalny). |
| `android/app/.../PassHolderApp.kt` | Trzyma `leaveLock`; `Settings.lockDelay` (domyślnie włączone). |
| `android/app/.../ui/LockedScreen.kt` | Przycisk „Odblokuj odciskiem palca” i automatyczne otwarcie okna przy każdym powrocie do aplikacji (gdy aktywność jest już na wierzchu). |
| `android/app/.../MainActivity.kt` | Teraz `FragmentActivity` (nadal `ComponentActivity`), bo `BiometricPrompt` jej wymaga. `onStop()` blokuje sejf przy wyjściu z aplikacji (od razu albo po 60 s), `onStart()` sprawdza przy powrocie, czy 60 s minęło. |
| `android/app/.../LeaveLock.kt` | Minutnik blokady 60 s po wyjściu z aplikacji, z kontrolą zegara przy powrocie. |
| `android/app/.../PassHolderApp.kt` | Trzyma `biometric` i `fingerprintPrompt`, podmieniane w testach. |
| `android/gradle/libs.versions.toml`, `app/build.gradle.kts` | Zależności `androidx.biometric:biometric:1.1.0` i `androidx.fragment:fragment-ktx`. |

Przepływ wywołań przy odblokowaniu:

```
LockedScreen (LaunchedEffect lub przycisk)
  → AppViewModel.unlockWithBiometric(activity)
      → BiometricUnlock.cipherToUnlock()        // szyfr z kluczem Keystore, jeszcze bez palca
      → FingerprintPrompt.authenticate(...)     // systemowe okno
          onSuccess(cipher) → [wątek IO]
              BiometricUnlock.decrypt(cipher)   // 64 bajty
              VaultStore.unlockWithKeys(keys)   // odszyfrowanie lokalnego sejfu
              keys.fill(0)                      // zerowanie kopii w pamięci
          → ekran listy
```

## Testy

- `core`: `VaultStoreTest` — odblokowanie wyeksportowanymi kluczami po „restarcie” (nowy `VaultStore` na tych samych plikach), odrzucenie złych kluczy i złej długości, synchronizacja działa po takim odblokowaniu, eksport wymaga odblokowanego sejfu.
- `app`: `BiometricScreenTests.kt` (Robolectric, prawdziwe ekrany i ViewModel). Robolectric nie ma Android Keystore ani czytnika, więc tylko te dwie rzeczy są zastąpione: klucz AES programowy (`SoftwareKeyProtector`) i „palec, który zawsze pasuje” (`FakeFingerprintPrompt`). Scenariusze:
  - włączenie, odblokowanie przyciskiem po „Zablokuj” (bez samoczynnego okna), samoczynne okno po ponownym otwarciu aplikacji (test sprawdza, że samo zamknięcie aktywności zablokowało sejf; wcześniej test blokował go ręcznie i dlatego nie wyłapał błędu),
  - przejście w tło i powrót (`FingerprintEveryOpenTest`): sejf zablokowany od razu po `onStop`, okno odcisku otwiera się samo przy każdym powrocie, także po anulowaniu; obrót ekranu nie blokuje; po „Zablokuj” wyjście i powrót też otwiera okno (`FingerprintAfterManualLockTest`),
  - bez odcisku palca (`LockOnLeaveWithoutFingerprintTest`): zamknięcie i ponowne otwarcie wymaga hasła głównego,
  - opóźnienie 60 s (`LockDelayTest`): po 30 s poza aplikacją sejf i rozpoczęty formularz zostają, bez okna odcisku; po 61 s minutnik blokuje sejf w tle i powrót wymaga odcisku. Czas przesuwa zegar Robolectric (`idleFor`), więc test trwa chwilę, nie minutę,
  - „zamrożony” minutnik (`LockDelayLateTimerTest`): minutnik nie zadziałał, ale minęło 61 s → sejf blokuje się przy powrocie,
  - przełącznik (`LockDelaySwitchOffTest`): wyłączenie opóźnienia zapisuje ustawienie i wyjście blokuje sejf od razu,
  - pozostałe testy odcisku działają z wyłączonym opóźnieniem, żeby sprawdzać blokadę natychmiastową,
  - anulowanie okna → hasło główne działa; wyłączenie przełącznika chowa przycisk,
  - nowy odcisk w telefonie (skasowany klucz) → komunikat i powrót do hasła głównego,
  - „Odłącz ten telefon” kasuje zapisane klucze i klucz Keystore.

```
cd android
./gradlew :core:test
./gradlew :app:testDebugUnitTest
```

**Nie przetestowano na prawdziwym telefonie.** Prawdziwy Keystore i `BiometricPrompt` działają tylko na urządzeniu; to warto sprawdzić ręcznie: włączenie, odblokowanie, przycisk „Użyj hasła głównego”, zamknięcie i ponowne otwarcie aplikacji, Home i powrót przed i po 60 s, to samo z wyłączonym opóźnieniem, wyłączenie i włączenie ekranu, obrót ekranu (bez blokady), a na końcu dodanie nowego odcisku w ustawieniach telefonu (aplikacja powinna wtedy poprosić o hasło główne).
