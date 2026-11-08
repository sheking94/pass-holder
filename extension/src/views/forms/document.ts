/** Document section: kind, number, full name, issue and expiry dates, issuer. */
import type { p2p } from "@passholder/core";
import { DOCUMENT_KIND_LABELS } from "../../entry-types.ts";
import { h } from "../../ui/dom.ts";
import type { FieldsForm } from "./types.ts";

function text(value: string, placeholder?: string) {
  return h("input", { type: "text", value, placeholder, autocomplete: "off" });
}

export function documentForm(fields: p2p.DocumentFields): FieldsForm<"document"> {
  const kind = h("select", {}, ...(Object.entries(DOCUMENT_KIND_LABELS) as [p2p.DocumentKind, string][]).map(([value, label]) => {
    const option = h("option", { value }, label);
    option.selected = value === fields.kind;
    return option;
  }));
  const number = text(fields.number);
  const fullName = text(fields.fullName);
  const issueDate = text(fields.issueDate, "RRRR-MM-DD");
  const expiryDate = text(fields.expiryDate, "RRRR-MM-DD");
  const issuer = text(fields.issuer);

  return {
    nodes: [
      h("label", {}, "Rodzaj"),
      kind,
      h("label", {}, "Numer"),
      number,
      h("label", {}, "Imię i nazwisko"),
      fullName,
      h("label", {}, "Data wydania"),
      issueDate,
      h("label", {}, "Data ważności"),
      expiryDate,
      h("label", {}, "Wystawca"),
      issuer,
    ],
    read: () => ({
      ...fields,
      kind: kind.value as p2p.DocumentKind,
      number: number.value,
      fullName: fullName.value,
      issueDate: issueDate.value,
      expiryDate: expiryDate.value,
      issuer: issuer.value,
    }),
  };
}
