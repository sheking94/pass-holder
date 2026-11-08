/** Login section: login, password with the generator, TOTP, web addresses and Android apps. */
import type { p2p } from "@passholder/core";
import { h, secretField } from "../../ui/dom.ts";
import { listEditor } from "../../ui/list-editor.ts";
import { passwordGenerator } from "./generator.ts";
import type { FieldsForm } from "./types.ts";

/** A list of single text inputs (addresses, package names). */
function stringList(items: readonly string[], addLabel: string, props: Partial<Record<string, unknown>>) {
  return listEditor<string>({
    items,
    empty: () => "",
    addLabel,
    row: (value) => {
      const input = h("input", { ...props, value, autocomplete: "off" });
      return { node: input, read: () => input.value };
    },
  });
}

export async function loginForm(fields: p2p.LoginFields, status: HTMLElement): Promise<FieldsForm<"login">> {
  const username = h("input", { type: "text", value: fields.username, autocomplete: "off" });
  const password = h("input", { type: "password", class: "mono", value: fields.password, autocomplete: "off" });
  const passwordRow = secretField(password, "hasło", status);
  const generator = await passwordGenerator(status, (generated) => {
    password.value = generated;
    passwordRow.setVisible(true);
  });
  const totp = h("input", { type: "password", class: "mono", value: fields.totp, autocomplete: "off" });
  const totpRow = secretField(totp, "kod TOTP", status);
  // Not type="url": Chrome sanitizes its value (trims, punycode), so a stored address would change on save.
  const urls = stringList(fields.urls, "Dodaj adres", { type: "text", inputmode: "url", placeholder: "https://", "aria-label": "Adres strony" });
  const apps = stringList(fields.androidApps, "Dodaj aplikację", { type: "text", placeholder: "np. pl.mbank", "aria-label": "Nazwa pakietu" });

  return {
    nodes: [
      h("label", {}, "Login"),
      username,
      h("label", {}, "Hasło"),
      passwordRow.row,
      generator,
      h("label", {}, "TOTP"),
      totpRow.row,
      h("label", {}, "Adresy stron"),
      urls.node,
      h("label", {}, "Aplikacje Androida"),
      apps.node,
    ],
    // Spread first, so a field this form does not know survives.
    read: () => ({
      ...fields,
      username: username.value,
      password: password.value,
      totp: totp.value,
      urls: urls.read(),
      androidApps: apps.read(),
    }),
  };
}
