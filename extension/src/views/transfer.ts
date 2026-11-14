import { transfer } from "@passholder/core";
import { importSummary } from "../import-summary.ts";
import { entriesNoun, filesNoun, skippedFilesPhrase } from "../plural.ts";
import { busy, h, setStatus, show, statusLine } from "../ui/dom.ts";
import { downloadFile } from "../ui/download.ts";
import { showInTab } from "../ui/page.ts";
import { store } from "../ui/state.ts";
import { listView } from "./list.ts";

/** Chrome closes the toolbar popup when the file chooser opens, so choosing a file to import only works in a tab. */
export function openTransfer() {
  return showInTab("transfer", transferView);
}

/** "passholder-zip" is not a transfer.TransferFormat: the archive is written by the store, which reads the files. */
type ExportFormat = transfer.TransferFormat | "passholder-zip";

const FORMATS: { format: ExportFormat; label: string; ext: string; mime: string; hint: boolean }[] = [
  { format: "passholder", label: "PassHolder JSON (wszystko, bez strat)", ext: "json", mime: "application/json", hint: false },
  { format: "passholder-zip", label: "PassHolder ZIP (wpisy i pliki)", ext: "zip", mime: "application/zip", hint: false },
  { format: "bitwarden", label: "Bitwarden JSON", ext: "json", mime: "application/json", hint: true },
  { format: "nordpass", label: "NordPass CSV", ext: "csv", mime: "text/csv;charset=utf-8", hint: true },
];

const PLAIN_WARNING =
  "Uwaga: plik nie jest zaszyfrowany. Każdy, kto go zobaczy (inny program, kopia zapasowa, synchronizacja folderu Pobrane z chmurą), pozna wszystkie Twoje hasła. Usuń go zaraz po użyciu.";
const ZIP_WARNING =
  "Uwaga: archiwum nie jest zaszyfrowane. Zawiera hasła jawnym tekstem i odszyfrowane pliki. Każdy, kto je zobaczy (inny program, kopia zapasowa, folder w chmurze), pozna je wszystkie. Usuń je zaraz po użyciu.";
const ZIP_TOO_LARGE = "Plik jest za duży (limit 256 MiB)";

async function exportZip(status: HTMLElement, day: string) {
  const out = await store.exportArchive();
  downloadFile(`passholder-${day}.zip`, new Blob(out.parts as BlobPart[]), "application/zip");
  const parts = [
    out.files > 0 ? `Wyeksportowano ${entriesNoun(out.entries)} i ${filesNoun(out.files)}.` : `Wyeksportowano ${entriesNoun(out.entries)}.`,
    out.missing > 0 && `Pominięto ${filesNoun(out.missing)}, które czekają na synchronizację albo są uszkodzone.`,
    "Usuń archiwum, gdy nie będzie już potrzebne.",
  ];
  setStatus(status, parts.filter(Boolean).join(" "));
}

function exportSection(status: HTMLElement) {
  const understood = h("input", { type: "checkbox" });
  const radios = FORMATS.map((f, i) => h("input", { type: "radio", name: "format", value: f.format, checked: i === 0 }));
  const choices = FORMATS.flatMap((f, i) => [
    h("label", { class: "check" }, radios[i]!, f.label),
    f.hint && h("p", { class: "hint" }, "Część pól trafi do notatki lub własnych pól."),
  ]);
  const chosen = () => FORMATS.find((_, i) => radios[i]!.checked)!;
  const warning = h("p", { class: "warning" }, PLAIN_WARNING);
  for (const radio of radios) {
    radio.addEventListener("change", () => {
      warning.textContent = chosen().format === "passholder-zip" ? ZIP_WARNING : PLAIN_WARNING;
    });
  }
  const exportButton = h("button", { type: "button", class: "danger" }, "Pobierz plik");
  exportButton.addEventListener("click", () => {
    if (!understood.checked) return setStatus(status, "Najpierw zaznacz, że rozumiesz ryzyko.", true);
    const format = chosen();
    const day = new Date().toISOString().slice(0, 10);
    if (format.format === "passholder-zip") return void busy(status, "Przygotowuję archiwum…", () => exportZip(status, day));
    try {
      const entries = store.allContents();
      downloadFile(`${format.format}-${day}.${format.ext}`, transfer.exportFile(format.format, entries), format.mime);
      setStatus(status, `Wyeksportowano ${entriesNoun(entries.length)}. Usuń plik, gdy nie będzie już potrzebny.`);
    } catch (error) {
      setStatus(status, error instanceof Error ? error.message : String(error), true);
    }
  });

  const skipped = transfer.countAttachments(store.allContents());
  return h(
    "fieldset",
    {},
    h("legend", {}, "Eksport"),
    ...choices,
    skipped > 0 && h("p", { class: "hint" }, `${skippedFilesPhrase(skipped)} w formatach JSON i CSV. Wybierz PassHolder ZIP, żeby je zabrać.`),
    warning,
    h("label", { class: "check" }, understood, "Rozumiem, plik będzie zawierał hasła jawnym tekstem"),
    h("div", { class: "actions" }, exportButton),
  );
}

function importSection(status: HTMLElement) {
  const file = h("input", { type: "file", accept: ".json,.csv,.zip,application/json,text/csv,application/zip" });
  const importButton = h("button", { type: "button", class: "primary" }, "Importuj");
  importButton.addEventListener("click", () => {
    const chosen = file.files?.[0];
    if (!chosen) return setStatus(status, "Wybierz plik JSON, CSV lub ZIP.", true);
    void busy(status, "Importuję…", async () => {
      // Refused before reading: the largest file anything here accepts is a 256 MiB archive.
      if (chosen.size > transfer.MAX_ZIP_BYTES) throw new Error(ZIP_TOO_LARGE);
      const bytes = new Uint8Array(await chosen.arrayBuffer());
      if (transfer.isZip(bytes)) {
        const { parsed, result, filesAdded, fileSkips } = await store.importArchive(bytes);
        setStatus(status, importSummary(parsed, result, "passholder", { added: filesAdded, skipped: fileSkips }));
      } else {
        const { format, parsed } = transfer.parseImportFile(new TextDecoder().decode(bytes));
        const result = await store.importContents(parsed.entries);
        setStatus(status, importSummary(parsed, result, format, parsed.files && { added: 0, skipped: parsed.files }));
      }
      file.value = "";
    });
  });

  return h(
    "fieldset",
    {},
    h("legend", {}, "Import"),
    h("p", {}, "Wpisy, które już są w sejfie z identyczną treścią, zostaną pominięte."),
    file,
    h("div", { class: "actions" }, importButton),
  );
}

export function transferView() {
  const status = statusLine();
  show(
    h("h1", {}, "Import i eksport"),
    h("p", {}, "Import rozpoznaje format sam: PassHolder ZIP, PassHolder JSON, Bitwarden JSON (bez szyfrowania) albo NordPass CSV."),
    exportSection(status),
    importSection(status),
    h("div", { class: "actions" }, h("button", { type: "button", onclick: () => listView() }, "Wróć do listy")),
    status,
  );
}
