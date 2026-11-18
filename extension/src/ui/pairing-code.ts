// The pairing code field, shared by the first pairing (connect.ts) and "Sparuj z innym telefonem" (addresses.ts).
import { p2p } from "@passholder/core";
import { h } from "./dom.ts";

const PAIRING_CODE_LABEL = `Kod parowania (${p2p.PAIRING_CODE_LENGTH} cyfr)`;

function pairingCodeInput(): HTMLInputElement {
  return h("input", {
    type: "text",
    class: "mono",
    inputmode: "numeric",
    autocomplete: "off",
    // One character more than the code, so a typo shows the format error instead of being cut off.
    maxLength: p2p.PAIRING_CODE_LENGTH + 1,
    placeholder: "12345678".slice(0, p2p.PAIRING_CODE_LENGTH),
  });
}

/** The label and the input, for a form; read the code from input. */
export function pairingCodeField(): { input: HTMLInputElement; nodes: HTMLElement[] } {
  const input = pairingCodeInput();
  return { input, nodes: [h("label", {}, PAIRING_CODE_LABEL), input] };
}
