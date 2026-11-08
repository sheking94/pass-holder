import {
  CHARACTER_GROUPS,
  DEFAULT_GENERATOR_OPTIONS,
  MAX_LENGTH,
  MIN_LENGTH,
  generatePassword,
  type CharacterGroup,
  type GeneratorOptions,
  type p2p,
} from "@passholder/core";
import { TYPE_INFO, emptyContent, tidyContent, validateContent } from "../entry-types.ts";
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

const SAVED = "Zapisano lokalnie. Zsynchronizuj, gdy telefon będzie w trybie Synchronizacja.";
const DELETED = "Usunięto lokalnie. Zsynchronizuj, żeby usunąć też na innych urządzeniach.";

/** Edits the entry of this type with this id, or a new one without it. */
export async function editView(type: p2p.EntryType, id?: string) {
  if (type !== "login") return otherTypeForm(type, id);
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
      listView(SAVED, false, "login");
    });

  const remove = confirmButton("Usuń", { class: "danger" }, () => {
    void busy(status, "Usuwam…", async () => {
      await store.delete(id!);
      listView(DELETED, false, "login");
    });
  });

  show(
    openInTabButton(),
    h("h1", {}, data ? TYPE_INFO.login.editTitle : TYPE_INFO.login.newTitle),
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
      h("button", { onclick: () => listView("", false, "login") }, "Anuluj"),
      data && remove,
    ),
    status,
  );
  name.focus();
}

/**
 * Stopgap form for the non-login types until their own forms exist: only name and note,
 * the other fields of an existing entry are kept as they are.
 */
function otherTypeForm(type: p2p.EntryType, id?: string) {
  const existing = id ? store.getEntry(id)?.data : undefined;
  const original = existing && existing.type === type ? existing : undefined;
  const name = h("input", { type: "text", value: original?.name ?? "" });
  const note = h("textarea", { rows: 6 });
  note.value = original?.note ?? "";
  const status = statusLine();

  const save = () =>
    busy(status, "Zapisuję…", async () => {
      const content = tidyContent({ ...(original ?? emptyContent(type)), name: name.value, note: note.value });
      const error = validateContent(content, original);
      if (error) throw new Error(error);
      await store.putEntry(id ?? crypto.randomUUID(), content);
      listView(SAVED, false, type);
    });

  const remove = confirmButton("Usuń", { class: "danger" }, () => {
    void busy(status, "Usuwam…", async () => {
      await store.delete(id!);
      listView(DELETED, false, type);
    });
  });

  show(
    openInTabButton(),
    h("h1", {}, original ? TYPE_INFO[type].editTitle : TYPE_INFO[type].newTitle),
    h("label", {}, "Nazwa"),
    name,
    h("label", {}, "Notatka"),
    note,
    h(
      "div",
      { class: "actions" },
      h("button", { class: "primary", onclick: save }, "Zapisz"),
      h("button", { onclick: () => listView("", false, type) }, "Anuluj"),
      original && remove,
    ),
    status,
  );
  name.focus();
}
