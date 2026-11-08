/** Card section: holder, number, expiry, CVC and PIN (number, CVC and PIN are masked). */
import type { p2p } from "@passholder/core";
import { h, secretField } from "../../ui/dom.ts";
import type { FieldsForm } from "./types.ts";

function secret(value: string, what: string, status: HTMLElement, props: Partial<Record<string, unknown>> = {}) {
  const input = h("input", { type: "password", class: "mono", value, autocomplete: "off", ...props });
  return { input, row: secretField(input, what, status).row };
}

export function cardForm(fields: p2p.CardFields, status: HTMLElement): FieldsForm<"card"> {
  const holder = h("input", { type: "text", value: fields.holder, autocomplete: "off" });
  const number = secret(fields.number, "numer karty", status, { inputMode: "numeric" });
  const expiry = h("input", { type: "text", value: fields.expiry, placeholder: "MM/RR", autocomplete: "off" });
  const cvc = secret(fields.cvc, "CVC", status);
  const pin = secret(fields.pin, "PIN", status);

  return {
    nodes: [
      h("label", {}, "Posiadacz"),
      holder,
      h("label", {}, "Numer"),
      number.row,
      h("label", {}, "Ważność"),
      expiry,
      h("label", {}, "CVC"),
      cvc.row,
      h("label", {}, "PIN"),
      pin.row,
    ],
    read: () => ({
      ...fields,
      holder: holder.value,
      number: number.input.value,
      expiry: expiry.value,
      cvc: cvc.input.value,
      pin: pin.input.value,
    }),
  };
}
