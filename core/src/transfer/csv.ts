// CSV (RFC 4180) reading and writing shared by the importers and exporters.

/**
 * Splits CSV text into rows of fields. Handles quoted fields with commas, doubled quotes and
 * line breaks inside, CRLF or LF line ends and a UTF-8 BOM. Blank lines are dropped.
 */
export function parseCsv(text: string): { line: number; fields: string[] }[] {
  const rows: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let rowStartLine = 1;
  const input = text.startsWith("﻿") ? text.slice(1) : text;

  const endRow = () => {
    fields.push(field);
    if (fields.length > 1 || fields[0] !== "") rows.push({ line: rowStartLine, fields });
    fields = [];
    field = "";
    rowStartLine = line;
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === ",") {
      fields.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && input[i + 1] === "\n") i++;
      line++;
      endRow();
    } else {
      field += c;
    }
  }
  if (quoted) throw new Error(`Plik CSV jest uszkodzony: niezamknięty cudzysłów (wiersz ${rowStartLine})`);
  if (field !== "" || fields.length > 0) endRow();
  return rows;
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) || value !== value.trim() ? `"${value.replaceAll('"', '""')}"` : value;
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}
