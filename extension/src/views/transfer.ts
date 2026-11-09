import { transfer } from "@passholder/core";
import { importSummary } from "../import-summary.ts";
import { busy, h, setStatus, show, statusLine } from "../ui/dom.ts";
import { showInTab } from "../ui/page.ts";
import { store } from "../ui/state.ts";
import { listView } from "./list.ts";

/** Chrome closes the toolbar popup when the file chooser opens, so choosing a file to import only works in a tab. */
export function openTransfer() {
  return showInTab("transfer", transferView);
}

/** Lets the browser save text as a file in the downloads folder (or ask where, per Chrome settings). */
function downloadText(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = h("a", { href: url, download: fileName });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function exportSection(status: HTMLElement) {
  const understood = h("input", { type: "checkbox" });
  const exportButton = h("button", { type: "button", class: "danger" }, "Pobierz plik CSV");
  exportButton.addEventListener("click", () => {
    if (!understood.checked) return setStatus(status, "Najpierw zaznacz, że rozumiesz ryzyko.", true);
    const entries = store.allContents();
    downloadText(`passholder-${new Date().toISOString().slice(0, 10)}.csv`, transfer.exportFile("nordpass", entries));
    setStatus(status, `Wyeksportowano ${entries.length} wpisów. Usuń plik, gdy nie będzie już potrzebny.`);
  });

  return h(
    "fieldset",
    {},
    h("legend", {}, "Eksport"),
    h("p", { class: "warning" }, "Uwaga: plik CSV nie jest zaszyfrowany. Każdy, kto go zobaczy (inny program, kopia zapasowa, synchronizacja folderu Pobrane z chmurą), pozna wszystkie Twoje hasła. Usuń go zaraz po użyciu."),
    h("p", { class: "hint" }, "Eksportowane są wszystkie typy wpisów."),
    h("label", { class: "check" }, understood, "Rozumiem, plik będzie zawierał hasła jawnym tekstem"),
    h("div", { class: "actions" }, exportButton),
  );
}

function importSection(status: HTMLElement) {
  const file = h("input", { type: "file", accept: ".csv,.json,text/csv,application/json" });
  const importButton = h("button", { type: "button", class: "primary" }, "Importuj");
  importButton.addEventListener("click", () => {
    const chosen = file.files?.[0];
    if (!chosen) return setStatus(status, "Wybierz plik CSV lub JSON.", true);
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
    h("p", {}, "Wybierz plik wyeksportowany z NordPass (albo z PassHolder). Wpisy, które już są w sejfie z tą samą nazwą, loginem i hasłem, zostaną pominięte."),
    file,
    h("div", { class: "actions" }, importButton),
  );
}

export function transferView() {
  const status = statusLine();
  show(
    h("h1", {}, "Import i eksport CSV"),
    h("p", {}, "Format pliku jest taki sam jak w NordPass. PassHolder przenosi nazwę, login i hasło; pozostałe kolumny (adres, notatka, folder…) są przy eksporcie puste, a przy imporcie pomijane."),
    exportSection(status),
    importSection(status),
    h("div", { class: "actions" }, h("button", { type: "button", onclick: () => listView() }, "Wróć do listy")),
    status,
  );
}
