/** Note section: a note has no fields of its own; its text is the shell's „Treść”. */
import type { p2p } from "@passholder/core";
import type { FieldsForm } from "./types.ts";

export function noteForm(fields: p2p.NoteFields): FieldsForm<"note"> {
  return { nodes: [], read: () => ({ ...fields }) };
}
