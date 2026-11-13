import type { p2p } from "@passholder/core";
import { TYPE_INFO, emptyContent, tidyContent, validateContent } from "../entry-types.ts";
import { busy, confirmButton, h, show, statusLine } from "../ui/dom.ts";
import { openEditTab, openInTabButton } from "../ui/page.ts";
import { store } from "../ui/state.ts";
import { attachmentsEditor } from "./forms/attachments.ts";
import { customFieldsEditor } from "./forms/custom-fields.ts";
import { cardForm } from "./forms/card.ts";
import { contactForm } from "./forms/contact.ts";
import { documentForm } from "./forms/document.ts";
import { loginForm } from "./forms/login.ts";
import { noteForm } from "./forms/note.ts";
import type { FieldsForm, FieldsOf } from "./forms/types.ts";
import { listView } from "./list.ts";

const SAVED = "Zapisano lokalnie. Zsynchronizuj, gdy telefon będzie w trybie Synchronizacja.";
const DELETED = "Usunięto lokalnie. Zsynchronizuj, żeby usunąć też na innych urządzeniach.";

type Section<T extends p2p.EntryType> = (fields: FieldsOf<T>, status: HTMLElement) => FieldsForm<T> | Promise<FieldsForm<T>>;

/** The form section of each type (between „Nazwa” and „Notatka”). */
const SECTIONS: { [T in p2p.EntryType]: Section<T> } = {
  login: loginForm,
  contact: contactForm,
  card: cardForm,
  note: noteForm,
  document: documentForm,
};

/**
 * Edits the entry of this type with this id, or a new one without it. What the form does not edit
 * (fields of an unknown shape, an id of another type) is kept as it was or refused by the store.
 */
export async function editView(type: p2p.EntryType, id?: string): Promise<void> {
  const existing = id ? store.getEntry(id)?.data : undefined;
  const original = existing && existing.type === type ? existing : undefined;
  const base = original ?? emptyContent(type);
  const status = statusLine();

  const name = h("input", { type: "text", value: base.name });
  const note = h("textarea", { rows: type === "note" ? 8 : 3 });
  note.value = base.note;
  const section = await (SECTIONS[type] as Section<p2p.EntryType>)(base.fields, status);
  const files = await attachmentsEditor(base.attachments ?? [], status, () => void openEditTab(type, original && id));
  const custom = customFieldsEditor(base.custom, status);

  const save = () =>
    busy(status, "Zapisuję…", async () => {
      const { attachments: _, ...rest } = base;
      const { attachments, added } = files.read();
      const content = tidyContent({
        ...rest,
        name: name.value,
        note: note.value,
        custom: custom.read(),
        fields: section.read(),
        ...(attachments.length > 0 ? { attachments } : {}),
      } as p2p.EntryContentV3);
      const error = validateContent(content, original);
      if (error) throw new Error(error);
      await store.putEntry(id ?? crypto.randomUUID(), content, added);
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
    ...section.nodes,
    h("label", {}, type === "note" ? "Treść" : "Notatka"),
    note,
    files.node,
    custom.node,
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
