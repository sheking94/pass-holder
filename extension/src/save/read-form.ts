// Subpath import: the @passholder/core root pulls crypto libraries into the page bundle.
import * as autofill from "@passholder/core/autofill";
import { describeField, isVisible } from "../autofill/fill-page.ts";

type FieldElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export interface ReadLogin { username: string; password: string; formSignature: string }

const NON_DATA_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);
const VISIBLE_PASSWORD = "input[type=password]";

function hasVisiblePassword(scope: ParentNode): boolean {
  return Array.from(scope.querySelectorAll<HTMLInputElement>(VISIBLE_PASSWORD)).some(isVisible);
}

/** The form of the element, otherwise the nearest ancestor (up to body) holding a visible password field. */
export function loginScope(el: Element): ParentNode | undefined {
  const form = el.closest("form");
  if (form) return form;
  const body = el.ownerDocument.body;
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (hasVisiblePassword(node)) return node;
    if (node === body) break;
  }
  return undefined;
}

/** Sorted, unique name-or-id of the data fields in the scope; stable across field reordering. */
export function formSignature(scope: ParentNode): string {
  const keys = new Set<string>();
  for (const el of scope.querySelectorAll<FieldElement>("input, select, textarea")) {
    if (el instanceof HTMLInputElement && NON_DATA_TYPES.has(el.type)) continue;
    const key = el.name || el.id;
    if (key) keys.add(key);
  }
  return Array.from(keys).sort().join(",");
}

interface Described { el: HTMLInputElement; kind: autofill.FieldKind | null }

function describedInputs(scope: ParentNode): Described[] {
  const out: Described[] = [];
  for (const el of scope.querySelectorAll<HTMLInputElement>("input")) {
    if (el.type === "hidden" || !isVisible(el)) continue;
    out.push({ el, kind: autofill.classifyField(describeField(el)) });
  }
  return out;
}

export function readLogin(scope: ParentNode): ReadLogin | undefined {
  const fields = describedInputs(scope);
  const filled = (f: Described): boolean => f.el.value !== "";
  const passwordField =
    fields.find((f) => f.kind === "newPassword" && filled(f)) ??
    fields.find((f) => f.kind === "password" && f.el.type === "password" && filled(f));
  if (!passwordField) return undefined;
  const before = fields.slice(0, fields.indexOf(passwordField));
  const userField = fields.find((f) => f.kind === "username") ?? before.find((f) => f.kind === "email");
  return { username: userField?.el.value ?? "", password: passwordField.el.value, formSignature: formSignature(scope) };
}

/** Signatures of the scopes that hold a visible, empty password field (a login form awaiting input). */
export function emptyLoginForms(doc: Document): string[] {
  const scopes = new Set<ParentNode>();
  for (const el of doc.querySelectorAll<HTMLInputElement>(VISIBLE_PASSWORD)) {
    if (el.value === "" && isVisible(el)) {
      const scope = loginScope(el);
      if (scope) scopes.add(scope);
    }
  }
  return Array.from(scopes, formSignature);
}
