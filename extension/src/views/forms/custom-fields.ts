/** „Własne pola”: label, value and „ukryte”; a hidden value is masked and copied as a secret. */
import type { p2p } from "@passholder/core";
import { h, secretField } from "../../ui/dom.ts";
import { listEditor } from "../../ui/list-editor.ts";

export function customFieldsEditor(
  items: readonly p2p.CustomField[],
  status: HTMLElement,
): { node: HTMLElement; read(): p2p.CustomField[] } {
  const editor = listEditor<p2p.CustomField>({
    items,
    empty: () => ({ label: "", value: "", hidden: false }),
    addLabel: "Dodaj pole",
    row: (item) => {
      const label = h("input", { type: "text", placeholder: "Etykieta", value: item.label, autocomplete: "off" });
      const value = h("input", { type: "text", placeholder: "Wartość", value: item.value, autocomplete: "off" });
      const field = secretField(value, "wartość pola", status);
      const hidden = h("input", { type: "checkbox", checked: item.hidden });
      field.setSecret(item.hidden);
      hidden.addEventListener("change", () => field.setSecret(hidden.checked));
      return {
        node: h("div", { class: "custom-field" }, label, field.row, h("label", { class: "check" }, hidden, "ukryte")),
        read: () => ({ ...item, label: label.value, value: value.value, hidden: hidden.checked }),
      };
    },
  });
  return { node: h("fieldset", {}, h("legend", {}, "Własne pola"), editor.node), read: editor.read };
}
