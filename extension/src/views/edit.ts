import type { p2p } from "@passholder/core";
import { TYPE_INFO, emptyContent, tidyContent, validateContent } from "../entry-types.ts";
import { busy, confirmButton, h, show, statusLine } from "../ui/dom.ts";
import { MODE, openEditTab, openInTabButton } from "../ui/page.ts";
import { store } from "../ui/state.ts";
import { attachmentsEditor } from "./forms/attachments.ts";
import { customFieldsEditor } from "./forms/custom-fields.ts";
import { cardForm } from "./forms/card.ts";
import { contactForm } from "./forms/contact.ts";
import { documentForm } from "./forms/document.ts";
import { loginForm } from "./forms/login.ts";
import { noteForm } from "./forms/note.ts";
import type { FieldsForm, FieldsOf } from "./forms/types.ts";
import { views } from "./router.ts";

const SAVED = "Zapisano lokalnie. Zsynchronizuj, gdy telefon będzie w trybie Synchronizacja.";
const DELETED = "Usunięto lokalnie. Zsynchronizuj, żeby usunąć też na innych urządzeniach.";

type Section<T extends p2p.EntryType> = (
  fields: FieldsOf<T>,
  status: HTMLElement,
) => FieldsForm<T> | Promise<FieldsForm<T>>;

/** The form section of each type (between „Nazwa” and „Notatka”). */
const SECTIONS: { [T in p2p.EntryType]: Section<T> } = {
  login: loginForm,
  contact: contactForm,
  card: cardForm,
  note: noteForm,
  document: documentForm,
};

/**
 * The edit tab shows its target once: after the form is saved or left, the tab becomes a plain one, so a
 * relock and unlock show the list instead of the form again.
 */
function leaveEditTarget(): void {
  if (MODE === "edit") history.replaceState(null, "", "?tab");
}

/** Back to the list on the tab of this type, once the form is saved or left. */
function leaveForm(type: p2p.EntryType, message = ""): void {
  leaveEditTarget();
  views().list({ message, type });
}

/** The parts of the form below „Nazwa”, read on „Zapisz”. */
interface FormParts {
  name: HTMLInputElement;
  note: HTMLTextAreaElement;
  section: FieldsForm<p2p.EntryType>;
  files: Awaited<ReturnType<typeof attachmentsEditor>>;
  custom: ReturnType<typeof customFieldsEditor>;
}

/** The entry as typed into the form; the attachments come from the files editor. */
function formContent(base: p2p.EntryContent, parts: FormParts) {
  const { attachments: _, ...rest } = base;
  const { attachments, added } = parts.files.read();
  const content = tidyContent({
    ...rest,
    name: parts.name.value,
    note: parts.note.value,
    custom: parts.custom.read(),
    fields: parts.section.read(),
    ...(attachments.length > 0 ? { attachments } : {}),
  } as p2p.EntryContent);
  return { content, added };
}

/**
 * Edits the entry of this type with this id, or a new one without it. Fields of an unknown shape are kept as
 * they were; an id of an entry of another type opens (and saves) a new entry instead.
 */
export async function editView(type: p2p.EntryType, id?: string): Promise<void> {
  const existing = id ? store.getEntry(id)?.data : undefined;
  const original = existing && existing.type === type ? existing : undefined;
  /** The id this form saves under: the edited entry's, or none for a new entry. */
  const editedId = original ? id : undefined;
  const base = original ?? emptyContent(type);
  const status = statusLine();

  const note = h("textarea", { rows: type === "note" ? 8 : 3 });
  note.value = base.note;
  const parts: FormParts = {
    name: h("input", { type: "text", value: base.name }),
    note,
    section: await (SECTIONS[type] as Section<p2p.EntryType>)(base.fields, status),
    files: await attachmentsEditor(
      base.attachments ?? [],
      status,
      () => void openEditTab(type, editedId),
    ),
    custom: customFieldsEditor(base.custom, status),
  };

  const save = () =>
    busy(status, "Zapisuję…", async () => {
      const { content, added } = formContent(base, parts);
      const error = validateContent(content, original);
      if (error) throw new Error(error);
      // An id of another type is not this entry: the form saves a new one and leaves that one alone.
      await store.putEntry(editedId ?? crypto.randomUUID(), content, added);
      leaveForm(type, SAVED);
    });

  const remove = confirmButton("Usuń", { class: "danger" }, () => {
    void busy(status, "Usuwam…", async () => {
      if (editedId === undefined) return;
      await store.delete(editedId);
      leaveForm(type, DELETED);
    });
  });

  show(
    openInTabButton(),
    h("h1", {}, original ? TYPE_INFO[type].editTitle : TYPE_INFO[type].newTitle),
    h("label", {}, "Nazwa"),
    parts.name,
    ...parts.section.nodes,
    h("label", {}, type === "note" ? "Treść" : "Notatka"),
    note,
    parts.files.node,
    parts.custom.node,
    h(
      "div",
      { class: "actions" },
      h("button", { class: "primary", onclick: save }, "Zapisz"),
      h("button", { onclick: () => leaveForm(type) }, "Anuluj"),
      original && remove,
    ),
    status,
  );
  parts.name.focus();
}
