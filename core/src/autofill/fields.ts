import { AUTOCOMPLETE_TOKENS, KEYWORDS, NEW_PASSWORD_PATTERN, normalizeText, type FieldKind } from "./keywords.ts";

export interface FieldDescriptor {
  /** autocomplete attribute tokens, or Android autofillHints */
  autocomplete: string[];
  /** input type as in the DOM ("select" for <select>) */
  type: string;
  name: string;
  id: string;
  label: string;
  placeholder: string;
  maxLength?: number;
  options?: { value: string; text: string }[];
}

const IGNORED_TYPES = new Set(["hidden", "search", "submit", "button", "checkbox", "radio", "file"]);

export function classifyField(field: FieldDescriptor): FieldKind | null {
  const type = field.type.toLowerCase();
  if (IGNORED_TYPES.has(type)) return null;

  // Rule 1: autocomplete tokens; the last known token wins (section/shipping tokens come first).
  for (const token of [...field.autocomplete].reverse()) {
    const kind = AUTOCOMPLETE_TOKENS[token.toLowerCase()];
    if (kind) return kind;
  }

  const text = normalizeText(`${field.name} ${field.id} ${field.label} ${field.placeholder}`);
  // Rule 2: input type.
  if (type === "password") {
    return NEW_PASSWORD_PATTERN.test(text) ? "newPassword" : "password";
  }
  if (type === "email") return "email";
  if (type === "tel") return "tel";

  // Rule 3: keywords. A non-password field that looks like new-password is skipped.
  const kind = KEYWORDS.find((k) => k.pattern.test(text))?.kind ?? null;
  return kind === "newPassword" ? null : kind;
}
