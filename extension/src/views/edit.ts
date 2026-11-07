import {
  CHARACTER_GROUPS,
  DEFAULT_GENERATOR_OPTIONS,
  MAX_LENGTH,
  MIN_LENGTH,
  generatePassword,
  type CharacterGroup,
  type GeneratorOptions,
} from "@passholder/core";
import { STORAGE_KEYS } from "../storage.ts";
import { busy, confirmButton, h, passwordField, setStatus, show, statusLine } from "../ui/dom.ts";
import { openInTabButton } from "../ui/page.ts";
import { local, store } from "../ui/state.ts";
import { listView } from "./list.ts";

const GROUP_LABELS: Record<CharacterGroup, string> = {
  lowercase: "małe litery",
  uppercase: "wielkie litery",
  digits: "cyfry",
  symbols: "symbole",
};

async function loadGeneratorOptions(): Promise<GeneratorOptions> {
  return (await local.get<GeneratorOptions>(STORAGE_KEYS.generator)) ?? DEFAULT_GENERATOR_OPTIONS;
}

/** Edits the entry with this id, or a new one without it. */
export async function editView(id?: string) {
  const data = id ? store.entry(id)?.data : undefined;
  const name = h("input", { type: "text", value: data?.name ?? "" });
  const username = h("input", { type: "text", value: data?.username ?? "", autocomplete: "off" });
  const password = h("input", { type: "password", class: "mono", value: data?.password ?? "", autocomplete: "off" });
  const passwordRow = passwordField(password);
  const status = statusLine();

  const options = await loadGeneratorOptions();
  const length = h("input", { type: "range", min: MIN_LENGTH, max: MAX_LENGTH, value: options.length });
  const lengthLabel = h("span", { class: "mono" }, String(options.length));
  length.addEventListener("input", () => (lengthLabel.textContent = length.value));
  const groupBoxes = (Object.keys(CHARACTER_GROUPS) as CharacterGroup[]).map((group) => ({
    group,
    box: h("input", { type: "checkbox", checked: options.groups.includes(group) }),
  }));

  const generate = async () => {
    const chosen: GeneratorOptions = {
      length: Number(length.value),
      groups: groupBoxes.filter((g) => g.box.checked).map((g) => g.group),
    };
    if (chosen.groups.length === 0) return setStatus(status, "Wybierz co najmniej jedną grupę znaków", true);
    password.value = generatePassword(chosen);
    passwordRow.setVisible(true);
    await local.set(STORAGE_KEYS.generator, chosen);
    setStatus(status, "");
  };

  const save = () =>
    busy(status, "Zapisuję…", async () => {
      if (!name.value.trim()) throw new Error("Podaj nazwę serwisu");
      if (!password.value) throw new Error("Podaj albo wygeneruj hasło");
      await store.upsert(id ?? crypto.randomUUID(), {
        name: name.value.trim(),
        username: username.value,
        password: password.value,
      });
      listView("Zapisano lokalnie. Zsynchronizuj, gdy telefon będzie w trybie Synchronizacja.");
    });

  const remove = confirmButton("Usuń", { class: "danger" }, () => {
    void busy(status, "Usuwam…", async () => {
      await store.delete(id!);
      listView("Usunięto lokalnie. Zsynchronizuj, żeby usunąć też na innych urządzeniach.");
    });
  });

  show(
    openInTabButton(),
    h("h1", {}, data ? "Edytuj wpis" : "Nowy wpis"),
    h("label", {}, "Nazwa serwisu"),
    name,
    h("label", {}, "Login"),
    username,
    h("label", {}, "Hasło"),
    passwordRow.row,
    h(
      "fieldset",
      {},
      h("legend", {}, "Generator haseł"),
      h("div", { class: "row" }, h("span", {}, "Długość"), length, lengthLabel),
      h(
        "div",
        { class: "groups" },
        ...groupBoxes.map(({ group, box }) => h("label", {}, box, GROUP_LABELS[group])),
      ),
      h("div", { class: "actions" }, h("button", { onclick: generate }, "Generuj")),
    ),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "primary", onclick: save }, "Zapisz"),
      h("button", { onclick: () => listView() }, "Anuluj"),
      data && remove,
    ),
    status,
  );
  name.focus();
}
