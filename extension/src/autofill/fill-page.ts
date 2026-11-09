// Subpath import: the @passholder/core root pulls crypto libraries into the page bundle.
import * as autofill from "@passholder/core/autofill";

type FieldElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

declare global {
  // eslint-disable-next-line no-var
  var passholderFill: typeof fillPage | undefined;
}

function labelText(el: FieldElement): string {
  const doc = el.ownerDocument;
  const parts: string[] = [];
  if (el.id) {
    for (const l of doc.querySelectorAll("label")) if (l.htmlFor === el.id) parts.push(l.textContent ?? "");
  }
  const wrapping = el.closest("label");
  if (wrapping) parts.push(wrapping.textContent ?? "");
  const aria = el.getAttribute("aria-label");
  if (aria) parts.push(aria);
  for (const id of (el.getAttribute("aria-labelledby") ?? "").split(/\s+/)) {
    if (id) parts.push(doc.getElementById(id)?.textContent ?? "");
  }
  return parts.map((p) => p.trim()).filter((p) => p !== "").join(" ");
}

export function describeField(el: FieldElement): autofill.FieldDescriptor {
  const isSelect = el instanceof HTMLSelectElement;
  const descriptor: autofill.FieldDescriptor = {
    autocomplete: (el.getAttribute("autocomplete") ?? "").split(/\s+/).filter((t) => t !== ""),
    type: isSelect ? "select" : el instanceof HTMLTextAreaElement ? "textarea" : el.type,
    name: el.name,
    id: el.id,
    label: labelText(el),
    placeholder: isSelect ? "" : el.placeholder,
  };
  if (!isSelect && el.maxLength > 0) descriptor.maxLength = el.maxLength;
  if (isSelect) descriptor.options = Array.from(el.options, (o) => ({ value: o.value, text: o.text }));
  return descriptor;
}

function isVisible(el: Element): boolean {
  const view = el.ownerDocument.defaultView;
  if (!view) return false;
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.hasAttribute("hidden")) return false;
    const style = view.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

function isFillable(el: FieldElement): boolean {
  if (el.disabled || (!(el instanceof HTMLSelectElement) && el.readOnly)) return false;
  if (el instanceof HTMLInputElement && el.type === "hidden") return false;
  return isVisible(el);
}

interface Candidate { el: FieldElement; descriptor: autofill.FieldDescriptor; kind: autofill.FieldKind | null }

function candidatesIn(root: ParentNode): Candidate[] {
  const out: Candidate[] = [];
  for (const el of root.querySelectorAll<FieldElement>("input, select, textarea")) {
    if (!isFillable(el)) continue;
    const descriptor = describeField(el);
    out.push({ el, descriptor, kind: autofill.classifyField(descriptor) });
  }
  return out;
}

/** Sets the value with the prototype setter (frameworks shadow the instance one) and notifies listeners. */
function setValue(el: FieldElement, value: string): void {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function fillCandidates(plan: autofill.FillPlan, cands: Candidate[], hasUsernameField: boolean): number {
  let filled = 0;
  for (const { el, descriptor, kind } of cands) {
    if (!kind) continue;
    const value = autofill.fillValue(plan, kind, descriptor, { hasUsernameField });
    if (value === undefined) continue;
    setValue(el, value);
    filled++;
  }
  return filled;
}

const isPasswordInput = (c: Candidate): boolean => c.descriptor.type.toLowerCase() === "password";
const hasUsername = (cands: Candidate[]): boolean => cands.some((c) => c.kind === "username");

function fillLogin(plan: autofill.FillPlan, doc: Document): number {
  const scopes: ParentNode[] = [...doc.forms, doc];
  for (const scope of scopes) {
    const cands = candidatesIn(scope);
    if (cands.filter(isPasswordInput).length === 1) return fillCandidates(plan, cands, hasUsername(cands));
  }
  // No login form: the first visible username/email field (two-step login) gets the login only.
  const cands = candidatesIn(doc);
  const username = cands.find((c) => c.kind === "username");
  const first = username ?? cands.find((c) => c.kind === "email");
  return first ? fillCandidates(plan, [first], username !== undefined) : 0;
}

function sameOriginAsTop(doc: Document): boolean {
  const win = doc.defaultView;
  if (!win) return false;
  try {
    return win.top === win || win.top?.location.origin === win.location.origin;
  } catch {
    return false;
  }
}

export function fillPage(plan: autofill.FillPlan, doc: Document = document): { filled: number } {
  if (!sameOriginAsTop(doc)) return { filled: 0 };
  if (plan.kind === "login") return { filled: fillLogin(plan, doc) };
  const cands = candidatesIn(doc);
  return { filled: fillCandidates(plan, cands, hasUsername(cands)) };
}
