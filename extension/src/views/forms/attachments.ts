/**
 * „Załączniki”: the files of an entry. A chosen file is encrypted at once and kept in memory until „Zapisz”
 * stores it with the entry (plan W1); „Usuń” only takes it off the form. In the popup the file chooser would
 * close the window, so „+ Dodaj plik” offers to open the same form in a tab (plan W6).
 */
import * as files from "@passholder/core/files";
import { formatSize } from "../../files/format-size.ts";
import { busy, confirmBox, h, setStatus } from "../../ui/dom.ts";
import { downloadFile } from "../../ui/download.ts";
import { IN_TAB } from "../../ui/page.ts";
import { store } from "../../ui/state.ts";

const TOO_MANY = "Najwyżej 20 plików we wpisie";
const EMPTY = "Plik jest pusty";
const TOO_LARGE = "Plik jest za duży (limit 10 MB)";
const BAD_NAME = "Nieprawidłowa nazwa pliku";
const WAITING = "czeka na synchronizację";
const CORRUPTED = "Plik jest uszkodzony";
const NEW = "nowy – zapisz wpis";
const DOWNLOAD_WARNING = "Pobierasz plik, który zostanie odszyfrowany i będzie dostępny na tym urządzeniu.";
const TAB_WARNING =
  "Formularz otworzy się w karcie. Niezapisane zmiany z tego okna przepadną – najpierw zapisz wpis, jeśli coś zmieniłeś.";

/** One file on the form: a saved one (with its state here) or one added since the form opened. */
interface Item {
  attachment: files.Attachment;
  added?: files.EncryptedFile;
  ready: boolean;
  note: string;
}

async function savedItem(a: files.Attachment): Promise<Item> {
  const state = await store.fileStatus(a);
  const note = state === "corrupted" ? CORRUPTED : state === "waiting" || !(await store.fileUploaded(a)) ? WAITING : "";
  return { attachment: a, ready: state === "ready", note };
}

export async function attachmentsEditor(
  initial: files.Attachment[],
  status: HTMLElement,
  openInTab: () => void,
): Promise<{ node: HTMLElement; read(): { attachments: files.Attachment[]; added: files.EncryptedFile[] } }> {
  const items: Item[] = await Promise.all(initial.map(savedItem));
  const list = h("ul", { class: "attachments" });
  // Holds the one open question box (download warning or the W6 warning).
  const dialog = h("div", {});

  const download = (a: files.Attachment) =>
    dialog.replaceChildren(confirmBox(DOWNLOAD_WARNING, "Pobierz", () =>
      void busy(status, "Odszyfrowuję plik…", async () => {
        const bytes = await store.readFile(a);
        downloadFile(a.name, bytes as BlobPart, a.mime || "application/octet-stream");
        // The Blob holds its own copy: the decrypted bytes are not kept anywhere else.
        bytes.fill(0);
        setStatus(status, "");
      })));

  const render = () =>
    list.replaceChildren(...items.map((item) => {
      const a = item.attachment;
      return h(
        "li",
        { class: "attachment" },
        h(
          "span",
          { class: "grow" },
          h("span", { class: "name", title: a.name }, a.name),
          h("span", { class: "user" }, formatSize(a.size), item.note && ` · ${item.note}`),
        ),
        h("button", { type: "button", title: `Pobierz: ${a.name}`, disabled: !item.ready, onclick: () => download(a) }, "Pobierz"),
        h("button", {
          type: "button",
          title: `Usuń: ${a.name}`,
          onclick: () => {
            items.splice(items.indexOf(item), 1);
            render();
          },
        }, "Usuń"),
      );
    }));

  const add = (file: File) =>
    busy(status, "Szyfruję plik…", async () => {
      // Cheap checks first, so a huge file is refused before it is read.
      if (!files.canAddAttachment(items.length)) throw new Error(TOO_MANY);
      if (file.size === 0) throw new Error(EMPTY);
      if (file.size > files.MAX_FILE_SIZE) throw new Error(TOO_LARGE);
      if (!files.isAttachmentName(file.name)) throw new Error(BAD_NAME);
      const added = await files.encryptFile(new Uint8Array(await file.arrayBuffer()), { name: file.name, mime: file.type });
      items.push({ attachment: added.attachment, added, ready: false, note: NEW });
      render();
      setStatus(status, "");
    });

  let chooser: HTMLElement[];
  if (IN_TAB) {
    const input = h("input", { type: "file", hidden: true });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      // Cleared, so choosing the same file again fires "change" again (a second, independent attachment).
      input.value = "";
      if (file) void add(file);
    });
    chooser = [input, h("button", { type: "button", class: "small", onclick: () => input.click() }, "+ Dodaj plik")];
  } else {
    chooser = [h("button", {
      type: "button",
      class: "small",
      onclick: () => dialog.replaceChildren(confirmBox(TAB_WARNING, "Otwórz w karcie", openInTab)),
    }, "+ Dodaj plik")];
  }

  render();
  return {
    node: h("fieldset", {}, h("legend", {}, "Załączniki"), list, ...chooser, dialog),
    read: () => ({
      attachments: items.map((i) => i.attachment),
      added: items.flatMap((i) => (i.added ? [i.added] : [])),
    }),
  };
}
