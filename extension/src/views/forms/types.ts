import type { p2p } from "@passholder/core";

/** The fields of one entry type. */
export type FieldsOf<T extends p2p.EntryType> = Extract<p2p.EntryContentV3, { type: T }>["fields"];

/** The per-type section of the entry form: its nodes and what they hold now. */
export interface FieldsForm<T extends p2p.EntryType> {
  nodes: HTMLElement[];
  read(): FieldsOf<T>;
}
