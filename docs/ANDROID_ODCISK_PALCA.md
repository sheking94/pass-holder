# Android: odblokowanie odciskiem palca

Ten dokument opisuje, jak działa odblokowanie sejfu odciskiem palca w aplikacji Android i dlaczego zrobiono to właśnie tak.

## Co widzi użytkownik

1. Po dodaniu sejfu (nowego albo istniejącego) na dole listy wpisów jest przełącznik **„Odblokowanie odciskiem palca”**.
   - Telefon bez czytnika odcisków: przełącznika nie ma.
   - Telefon z czytnikiem, ale bez zapisanego odcisku: przełącznik jest wyszarzony z podpowiedzią „Najpierw dodaj odcisk palca w ustawieniach telefonu”.
2. Włączenie przełącznika otwiera systemowe okno odcisku palca. Po przyłożeniu palca pojawia się „Włączono odblokowanie odciskiem palca. Hasło główne nadal działa.”
3. Przy następnym uruchomieniu aplikacji, i po automatycznej blokadzie po 15 minutach, okno odcisku palca otwiera się samo. Na ekranie blokady jest też przycisk **„Odblokuj odciskiem palca”**.
4. Po ręcznym „Zablokuj” okno nie otwiera się samo, bo od razu wyskakiwałoby z powrotem. Wystarczy nacisnąć przycisk.
5. Hasło główne działa zawsze. W oknie odcisku jest przycisk „Użyj hasła głównego”.
6. „Odłącz ten telefon” wyłącza też odcisk palca.

Zrzuty ekranu (z testów): `android/app/screenshots/12-odcisk-wylaczony.png` … `15-odcisk-niewazny.png`.

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
| `android/app/.../AppViewModel.kt` | `enableBiometric`, `disableBiometric`, `unlockWithBiometric`, `biometricEnabled` (StateFlow dla ekranów), flaga „otwórz okno odcisku samo” (tak po starcie i po auto-blokadzie, nie po „Zablokuj”). `disconnect()` wyłącza też odcisk. |
| `android/app/.../ui/ListScreen.kt` | Wiersz z przełącznikiem (cały wiersz jest klikalny). |
| `android/app/.../ui/LockedScreen.kt` | Przycisk „Odblokuj odciskiem palca” i automatyczne otwarcie okna. |
| `android/app/.../MainActivity.kt` | Teraz `FragmentActivity` (nadal `ComponentActivity`), bo `BiometricPrompt` jej wymaga. |
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
  - włączenie, odblokowanie przyciskiem po „Zablokuj” (bez samoczynnego okna), samoczynne okno po ponownym otwarciu aplikacji,
  - anulowanie okna → hasło główne działa; wyłączenie przełącznika chowa przycisk,
  - nowy odcisk w telefonie (skasowany klucz) → komunikat i powrót do hasła głównego,
  - „Odłącz ten telefon” kasuje zapisane klucze i klucz Keystore.

```
cd android
./gradlew :core:test
./gradlew :app:testDebugUnitTest
```

**Nie przetestowano na prawdziwym telefonie.** Prawdziwy Keystore i `BiometricPrompt` działają tylko na urządzeniu; to warto sprawdzić ręcznie: włączenie, odblokowanie, przycisk „Użyj hasła głównego”, a na końcu dodanie nowego odcisku w ustawieniach telefonu (aplikacja powinna wtedy poprosić o hasło główne).
