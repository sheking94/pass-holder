/** Contact section: name, birth date, phones, e-mails and postal addresses. */
import type { p2p } from "@passholder/core";
import { h } from "../../ui/dom.ts";
import { listEditor } from "../../ui/list-editor.ts";
import type { FieldsForm } from "./types.ts";

/**
 * A plain text input. Never type="email"/"url": Chrome sanitizes those values (trims, punycode),
 * so a stored value would change on save; inputMode only picks the on-screen keyboard.
 */
function text(value: string, placeholder?: string, ariaLabel?: string, inputMode?: string) {
  return h("input", { type: "text", value, placeholder, "aria-label": ariaLabel, inputmode: inputMode, autocomplete: "off" });
}

/** Label + value pairs (phones, e-mails): a narrow label and the value side by side. */
function labeledList(items: readonly p2p.LabeledValue[], addLabel: string, valueName: string, inputMode: string) {
  return listEditor<p2p.LabeledValue>({
    items,
    empty: () => ({ label: "", value: "" }),
    addLabel,
    row: (item) => {
      const label = text(item.label, "np. dom", "Etykieta");
      const value = text(item.value, valueName, valueName, inputMode);
      return { node: h("div", { class: "pair" }, label, value), read: () => ({ ...item, label: label.value, value: value.value }) };
    },
  });
}

export function contactForm(fields: p2p.ContactFields): FieldsForm<"contact"> {
  const firstName = text(fields.firstName);
  const lastName = text(fields.lastName);
  const birthDate = text(fields.birthDate, "RRRR-MM-DD");
  const phones = labeledList(fields.phones, "Dodaj telefon", "Numer telefonu", "tel");
  const emails = labeledList(fields.emails, "Dodaj e-mail", "Adres e-mail", "email");
  const addresses = listEditor<p2p.PostalAddress>({
    items: fields.addresses,
    empty: () => ({ label: "", street: "", postalCode: "", city: "", country: "" }),
    addLabel: "Dodaj adres",
    row: (item) => {
      const label = text(item.label, "Etykieta (np. dom)", "Etykieta");
      const street = text(item.street, "Ulica", "Ulica");
      const postalCode = text(item.postalCode, "Kod pocztowy", "Kod pocztowy");
      const city = text(item.city, "Miasto", "Miasto");
      const country = text(item.country, "Kraj", "Kraj");
      return {
        node: h("div", { class: "field-stack" }, label, street, h("div", { class: "pair" }, postalCode, city), country),
        read: () => ({ ...item, label: label.value, street: street.value, postalCode: postalCode.value, city: city.value, country: country.value }),
      };
    },
  });

  return {
    nodes: [
      h("label", {}, "Imię"),
      firstName,
      h("label", {}, "Nazwisko"),
      lastName,
      h("label", {}, "Data urodzenia"),
      birthDate,
      h("label", {}, "Telefony"),
      phones.node,
      h("label", {}, "E-maile"),
      emails.node,
      h("label", {}, "Adresy"),
      addresses.node,
    ],
    read: () => ({
      ...fields,
      firstName: firstName.value,
      lastName: lastName.value,
      birthDate: birthDate.value,
      phones: phones.read(),
      emails: emails.read(),
      addresses: addresses.read(),
    }),
  };
}
