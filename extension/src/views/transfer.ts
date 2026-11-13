import { transfer } from "@passholder/core";
import { importSummary } from "../import-summary.ts";
import { entriesNoun, filesNoun } from "../plural.ts";
import { busy, h, setStatus, show, statusLine } from "../ui/dom.ts";
import { downloadFile } from "../ui/download.ts";
import { showInTab } from "../ui/page.ts";
import { store } from "../ui/state.ts";
import { listView } from "./list.ts";

/** Chrome closes the toolbar popup when the file chooser opens, so choosing a file to import only works in a tab. */
export function openTransfer() {
  return showInTab("transfer", transferView);
}

const FORMATS: { format: transfer.TransferFormat; label: string; ext: string; mime: string; hint: boolean }[] = [
  { format: "passholder", label: "PassHolder JSON (wszystko, bez strat)", ext: "json", mime: "application/json", hint: false },
  { format: "bitwarden", label: "Bitwarden JSON", ext: "json", mime: "application/json", hint: true },
  { format: "nordpass", label: "NordPass CSV", ext: "csv", mime: "text/csv;charset=utf-8", hint: true },
];

function exportSection(status: HTMLElement) {
  const understood = h("input", { type: "checkbox" });
  const radios = FORMATS.map((f, i) => h("input", { type: "radio", name: "format", value: f.format, checked: i === 0 }));
  const choices = FORMATS.flatMap((f, i) => [
    h("label", { class: "check" }, radios[i]!, f.label),
    f.hint && h("p", { class: "hint" }, "Część pól trafi do notatki lub własnych pól."),
  ]);
  const exportButton = h("button", { type: "button", class: "danger" }, "Pobierz plik");
  exportButton.addEventListener("click", () => {
    if (!understood.checked) return setStatus(status, "Najpierw zaznacz, że rozumiesz ryzyko.", true);
    try {
      const chosen = FORMATS.find((_, i) => radios[i]!.checked)!;
      const entries = store.allContents();
      const day = new Date().toISOString().slice(0, 10);
      downloadFile(`${chosen.format}-${day}.${chosen.ext}`, transfer.exportFile(chosen.format, entries), chosen.mime);
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
    skipped > 0 && h("p", { class: "hint" }, `${filesNoun(skipped)} nie zostaną wyeksportowane (eksport z plikami będzie w kolejnej wersji).`),
    h("p", { class: "warning" }, "Uwaga: plik nie jest zaszyfrowany. Każdy, kto go zobaczy (inny program, kopia zapasowa, synchronizacja folderu Pobrane z chmurą), pozna wszystkie Twoje hasła. Usuń go zaraz po użyciu."),
    h("label", { class: "check" }, understood, "Rozumiem, plik będzie zawierał hasła jawnym tekstem"),
    h("div", { class: "actions" }, exportButton),
  );
}

function importSection(status: HTMLElement) {
  const file = h("input", { type: "file", accept: ".json,.csv,application/json,text/csv" });
  const importButton = h("button", { type: "button", class: "primary" }, "Importuj");
  importButton.addEventListener("click", () => {
    const chosen = file.files?.[0];
    if (!chosen) return setStatus(status, "Wybierz plik JSON lub CSV.", true);
    void busy(status, "Importuję…", async () => {
      const { format, parsed } = transfer.parseImportFile(await chosen.text());
      const result = await store.importContents(parsed.entries);
      setStatus(status, importSummary(parsed, result, format));
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
    h("p", {}, "Import rozpoznaje format sam: PassHolder JSON, Bitwarden JSON (bez szyfrowania) albo NordPass CSV."),
    exportSection(status),
    importSection(status),
    h("div", { class: "actions" }, h("button", { type: "button", onclick: () => listView() }, "Wróć do listy")),
    status,
  );
}
