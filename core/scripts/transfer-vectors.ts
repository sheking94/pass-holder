// Generates export and sort vectors in test-vectors/transfer/ (shared with the Kotlin port).
// Run: node --experimental-strip-types core/scripts/transfer-vectors.ts
import { readFileSync, writeFileSync } from "node:fs";
import { exportFile } from "../src/transfer/index.ts";

const dir = new URL("../test-vectors/transfer/", import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, dir), "utf8");
const write = (name: string, text: string): void => writeFileSync(new URL(name, dir), text);

const entries = [...JSON.parse(read("passholder.expected.json")).entries, ...JSON.parse(read("bitwarden.expected.json")).entries];
write("export.passholder.json", exportFile("passholder", entries));
write("export.bitwarden.json", exportFile("bitwarden", entries));
write("export.nordpass.csv", exportFile("nordpass", entries));

const names = ["żaba", "Zebra", "zebra", "Źdźbło", "Łódź", "lody", "Lody", "ćma", "Cma", "cma", "Ąbc", "abc", "Abc", "Ślimak", "sok", "Ósemka", "osa", "Ńa", "na", "10 kotów", "2 koty", "Konto (stare)", "Konto-nowe", "konto_x", " spacja", "Ęka", "ewa"];
const sorted = [...names].sort((a, b) => a.localeCompare(b, "pl"));
write("sort.json", JSON.stringify({ names, sorted }, null, 2) + "\n");
