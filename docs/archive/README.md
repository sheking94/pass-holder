# Archiwum dokumentacji

Dokumenty historyczne. Opisują kod, którego już nie ma albo zmiany zrobione raz; aktualny stan jest w
[../ARCHITEKTURA.md](../ARCHITEKTURA.md).

| Dokument | Treść |
|---|---|
| [PRZEGLAD_BEZPIECZENSTWA.md](PRZEGLAD_BEZPIECZENSTWA.md), [POPRAWKI_BEZPIECZENSTWA.md](POPRAWKI_BEZPIECZENSTWA.md) | przegląd bezpieczeństwa wersji z Pi i poprawki S1–S4, N3 |
| [PRZEGLAD_CZYSTOSCI_KODU.md](PRZEGLAD_CZYSTOSCI_KODU.md) | przegląd Clean Code (PR #16) |
| [PRZEGLAD_BEZPIECZENSTWA_V3.md](PRZEGLAD_BEZPIECZENSTWA_V3.md) | przegląd bezpieczeństwa po V3 (2026-11-15); wszystkie 5 grup poprawek zrobione (PR #51–#55) |
| [PRZEGLAD_CZYSTOSCI_KODU_V3.md](PRZEGLAD_CZYSTOSCI_KODU_V3.md) | przegląd czystości kodu po V3 (2026-11-16); grupy G1–G14 zrobione (PR #58–#71) |
| [WIELE_ADRESOW_SERWERA.md](WIELE_ADRESOW_SERWERA.md), [WTYCZKA_ZAKLADANIE_SEJFU.md](WTYCZKA_ZAKLADANIE_SEJFU.md) | funkcje wersji z serwerem Pi |
| [PRZENIESIENIE_NA_INNY_KOMPUTER.md](PRZENIESIENIE_NA_INNY_KOMPUTER.md) | przeniesienie z Ubuntu na Windows 11 |
| [P2P_USUNIECIE_SERWERA.md](P2P_USUNIECIE_SERWERA.md) | usunięcie serwera Pi i kodu v1 (plan 4) |
| [ZMIANY_DOKUMENTACJI_2026-11-02.md](ZMIANY_DOKUMENTACJI_2026-11-02.md), [ZMIANY_DOKUMENTACJI_2026-11-07.md](ZMIANY_DOKUMENTACJI_2026-11-07.md), [ZMIANY_DOKUMENTACJI_2026-11-19.md](ZMIANY_DOKUMENTACJI_2026-11-19.md) | porządki w dokumentacji |
| [plany/](plany/) | wykonane plany implementacji: P2P (plany 1–4), V3 (typy wpisów, autouzupełnianie, pytanie o zapis, pliki, ZIP) i plan przeglądu bezpieczeństwa V3 |
| [specs/](specs/) | specyfikacje projektowe V3 (typy wpisów, autouzupełnianie, pytanie o zapis, pliki w sejfie); aktualny stan opisują SPEC, FUNKCJE i ARCHITEKTURA |

## Stare nazwy w kodzie

Nazwy, które występują w dokumentach archiwum i starszych PR-ach, a których już nie ma w kodzie. Plany i specyfikacje
V3 podają ścieżki sprzed przeniesienia (`docs/superpowers/plans/`, `docs/superpowers/specs/`, `docs/PRZEGLAD_*_V3.md`)
i nazwy sprzed grup G1–G14 (np. przyrostki `V2`/`V3`, jeden plik `vault-store.ts`); aktualne nazwy są w
[../ARCHITEKTURA.md](../ARCHITEKTURA.md).

| Było | Jest |
|---|---|
| `extension/src/server-urls.ts`, `pickServer` | `extension/src/phone-urls.ts`, `pickPhone` (plan 4) |
| `extension/src/ui/server-url-fields.ts`, `serverUrlFields` | `extension/src/ui/phone-url-fields.ts`, `phoneUrlFields` (plan 4) |
| `extension/src/api.ts` (`ServerClient`) | `extension/src/phone-client.ts` (`PhoneClient`, plan 3) |
| `android/core/.../VaultStore.kt`, `Sync.kt`, `ServerClient.kt`, `ServerPicker.kt`, `CertificatePin.kt` | `p2p/PhoneVaultStore.kt` i serwer na telefonie; reszta usunięta (plan 4) |
| `core/src/sync.ts` (klient v1), `server/`, `deploy/` | usunięte (plan 4); host: `core/src/p2p/host-sync.ts` i `HostSync.kt` |
| ekrany `ConnectScreen`, `AddressesScreen` (Android) | `StartScreen`, `SyncScreen`, `DevicesScreen`, `RestoreScreen` (plan 3) |
| widoki w `extension/src/popup.ts` (695 linii) | `extension/src/views/*.ts` i `extension/src/ui/*.ts` (PR #16) |
| `IN_TAB`, `TRANSFER_TAB`, `isTabPage`, `TAB_PARAM`, `SETUP_PARAM` | `pageMode`, `isInTab`, `isMainTab`, `modeQuery` (`page-mode.ts`); `IN_TAB` w `ui/page.ts` (PR #16) |
| `openSetupTab`, `openAddressesTab`, `openTransferTab` | `showInTab("setup" \| "addresses" \| "transfer", widok)` (PR #16) |
| `VaultStore.findPinLock`, `resetPinAttempts` | `PinStore.find` (prywatna), `PinStore.resetAttempts` (PR #16) |
| `AppViewModel.lockOnLeave`, `fingerprintRequests` | `onLeftApp` → `LockController.onLeftApp`, `timesLeftApp` (PR #16) |
| `fingerprintOnLockedScreen`, `lockWhenDone` | `LockController.offerFingerprint`, `lockWaitsForOperation` (PR #16) |
| `AppViewModel.enableBiometric(activity)`, `unlockWithBiometric(activity)` | `cipherToEnableBiometric` + `onBiometricEnableAuthorized`, `cipherToUnlockBiometric` + `onBiometricUnlockAuthorized` (PR #16) |
