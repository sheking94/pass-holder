/**
 * „Załączniki”: the files of an entry. A chosen file is encrypted at once and kept in memory until „Zapisz”
 * stores it with the entry (plan W1); „Usuń” only takes it off the form. In the popup the file chooser would
 * close the window, so „+ Dodaj plik” offers to open the same form in a tab (plan W6).
 */
import { PassHolderError } from "@passholder/core";
import * as files from "@passholder/core/files";
import { FILE_CORRUPTED } from "../../error-messages.ts";
import { formatSize } from "../../files/format-size.ts";
import { busy, confirmBox, h, setStatus } from "../../ui/dom.ts";
import { downloadFile } from "../../ui/download.ts";
import { IN_TAB } from "../../ui/page.ts";
import { store } from "../../ui/state.ts";

const TOO_MANY = `Najwyżej ${files.MAX_ATTACHMENTS_PER_ENTRY} plików we wpisie`;
const WAITING = "czeka na synchronizację";
const NEW = "nowy – zapisz wpis";
const DOWNLOAD_WARNING =
  "Pobierasz plik, który zostanie odszyfrowany i będzie dostępny na tym urządzeniu.";
const TAB_WARNING =
  "Formularz otworzy się w karcie. Niezapisane zmiany z tego okna przepadną – najpierw zapisz wpis, jeśli coś zmieniłeś.";

/** One file on the form: a saved one (with its state here) or one added since the form opened. */
interface Item {
  attachment: files.Attachment;
  added?: files.EncryptedFile;
  ready: boolean;
  note: string;
}

/** A file whose state cannot be read (e.g. IndexedDB fails) is shown as waiting, so the form still opens. */
async function savedItem(a: files.Attachment): Promise<Item> {
  let state: "ready" | "waiting" | "corrupted";
  try {
    state = await store.fileStatus(a);
  } catch {
    return { attachment: a, ready: false, note: WAITING };
  }
  if (state === "corrupted") return { attachment: a, ready: false, note: FILE_CORRUPTED };
  const uploaded = state === "ready" && (await store.fileUploaded(a).catch(() => false));
  return { attachment: a, ready: state === "ready", note: uploaded ? "" : WAITING };
}

export async function attachmentsEditor(
  initial: files.Attachment[],
  status: HTMLElement,
  openInTab: () => void,
): Promise<{
  node: HTMLElement;
  read(): { attachments: files.Attachment[]; added: files.EncryptedFile[] };
}> {
  const items: Item[] = await Promise.all(initial.map(savedItem));
  const list = h("ul", { class: "attachments" });
  // Holds the one open question box (download warning or the W6 warning).
  const dialog = h("div", {});
  // The row whose download question is open, if one is.
  let asking: Item | undefined;

  const download = (item: Item) => {
    const a = item.attachment;
    asking = item;
    dialog.replaceChildren(
      confirmBox(
        DOWNLOAD_WARNING,
        "Pobierz",
        () =>
          void busy(status, "Odszyfrowuję plik…", async () => {
            const bytes = await store.readFile(a);
            downloadFile(a.name, bytes as BlobPart, a.mime || "application/octet-stream");
            // The Blob holds its own copy: the decrypted bytes are not kept anywhere else.
            bytes.fill(0);
            setStatus(status, "");
          }),
      ),
    );
  };

  const render = () =>
    list.replaceChildren(
      ...items.map((item) => {
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
          h(
            "button",
            {
              type: "button",
              title: `Pobierz: ${a.name}`,
              disabled: !item.ready,
              onclick: () => download(item),
            },
            "Pobierz",
          ),
          h(
            "button",
            {
              type: "button",
              title: `Usuń: ${a.name}`,
              onclick: () => {
                items.splice(items.indexOf(item), 1);
                if (asking === item) {
                  asking = undefined;
                  dialog.replaceChildren();
                }
                render();
              },
            },
            "Usuń",
          ),
        );
      }),
    );

  const add = (file: File) =>
    busy(status, "Szyfruję plik…", async () => {
      // Cheap checks first, so a huge file is refused before it is read.
      if (!files.canAddAttachment(items.length)) throw new Error(TOO_MANY);
      // The same codes encryptFile would throw; busy() shows their text.
      if (file.size === 0) throw new PassHolderError("FILE_EMPTY");
      if (file.size > files.MAX_FILE_SIZE) throw new PassHolderError("FILE_TOO_LARGE");
      if (!files.isAttachmentName(file.name)) throw new PassHolderError("FILE_INVALID_NAME");
      const plain = new Uint8Array(await file.arrayBuffer());
      let added: files.EncryptedFile;
      try {
        added = await files.encryptFile(plain, { name: file.name, mime: file.type });
      } finally {
        // Only the encrypted chunks are kept.
        plain.fill(0);
      }
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
    chooser = [
      input,
      h("button", { type: "button", class: "small", onclick: () => input.click() }, "+ Dodaj plik"),
    ];
  } else {
    chooser = [
      h(
        "button",
        {
          type: "button",
          class: "small",
          onclick: () => {
            asking = undefined;
            dialog.replaceChildren(confirmBox(TAB_WARNING, "Otwórz w karcie", openInTab));
          },
        },
        "+ Dodaj plik",
      ),
    ];
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
