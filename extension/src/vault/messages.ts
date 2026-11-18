import { errorMessage, toUserError } from "../error-messages.ts";

/** Every text the vault modules show, in one place (texts of coded core errors are in error-messages.ts). */
export const LOCKED = "Sejf jest zablokowany";
export const NOT_PAIRED = "Ta przeglądarka nie jest sparowana z telefonem";
export const ALREADY_PAIRED =
  "Ta przeglądarka jest już sparowana. Użyj „Sparuj z innym telefonem”.";
export const WRONG_PASSWORD = "Złe hasło główne";
/** repair(): the password opens this browser's copy but not the phone's (a new master password, or another vault). */
export const PHONE_HAS_OTHER_PASSWORD =
  "To hasło nie otwiera sejfu na telefonie. Jeśli hasło główne zmieniono na telefonie, wpisz nowe hasło i nowy kod.";
export const NO_PENDING_PAIRING =
  "Najpierw sparuj przeglądarkę z telefonem (kod z ekranu Synchronizacja).";
export const NO_ALLOWED_ADDRESS =
  "Brak zgody Chrome na łączenie z żadnym adresem telefonu. Otwórz „Adresy telefonu” i zapisz adresy, a Chrome zapyta o zgodę.";
export const PHONE_WAITS_FOR_RESTORE =
  "Telefon czeka na odtworzenie sejfu z wtyczki, a ta przeglądarka nie ma jeszcze sejfu. Na telefonie wybierz „Dodaj wtyczkę” albo odtwórz sejf z przeglądarki, która go ma.";
export const PAIRING_EXPIRED = "Parowanie wygasło. Poproś telefon o nowy kod.";
export const OTHER_TYPE = "Ten wpis ma inny typ";
export const FILE_NOT_READY = "Plik czeka na synchronizację";

export function deviceNameMessage(maxLength: number): string {
  return `Podaj nazwę tego urządzenia (do ${maxLength} znaków)`;
}

/**
 * After /pair/finish the phone lists this browser in "Urządzenia", so a pairing that is not completed here
 * leaves a device there that nothing uses: this sentence says which one to remove.
 */
export function orphanDeviceNote(deviceName: string, phone = "telefonie"): string {
  return ` Na ${phone} usuń „${deviceName}” z „Urządzenia”.`;
}

export function pairingExpiredMessage(deviceName: string): string {
  return PAIRING_EXPIRED + orphanDeviceNote(deviceName);
}

export function pairingCancelledMessage(deviceName: string): string {
  return "Anulowano parowanie." + orphanDeviceNote(deviceName);
}

/** repair() met a phone with another vault; that phone has already added this browser. */
export function otherVaultMessage(deviceName: string): string {
  return (
    "To inny sejf. Wtyczka zostaje połączona z poprzednim telefonem." +
    orphanDeviceNote(deviceName, "nowym telefonie")
  );
}

/** disconnect() without force while the vault is unlocked and has changes the phone has not seen. */
export class UnsyncedChanges extends Error {
  constructor(readonly count: number) {
    super(
      `Niezsynchronizowane zmiany: ${count}. Odłączenie usunie je z tej przeglądarki. Najpierw zsynchronizuj albo wyeksportuj sejf do pliku.`,
    );
  }
}

/**
 * The pairing is saved (the browser is paired and unlocked), but the first sync after it failed. Thrown by
 * pairFinish and repair so the screen can say "paired" rather than "pairing failed".
 */
export class PairedButSyncFailed extends Error {
  constructor(
    readonly mode: "paired" | "restored",
    readonly syncError: unknown,
  ) {
    super(
      `Sparowano z telefonem, ale pierwsza synchronizacja się nie udała: ${errorMessage(syncError)}`,
    );
  }
}

/**
 * Runs a call into the core and turns its coded errors into errors with the user's text (toUserError), so a
 * screen can show `error.message`.
 */
export async function inUserTerms<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toUserError(error);
  }
}
