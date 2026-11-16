// Subpath import: the @passholder/core root pulls crypto libraries into the page bundle.
import * as autofill from "@passholder/core/autofill";

type FieldElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

declare global {
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

/** Smaller than this (px, either side) is not something a person can see or type into. */
const MIN_VISIBLE_PX = 2;
/** Contact and card (any https page may ask for them): a field this small is treated as hidden. */
const STRICT_MIN_PX = 10;

/**
 * True when the page has layout at all: the root element has a non-empty box. Real browsers always give
 * <html> one; happy-dom (unit tests) returns all-zero rects for every element, so geometry checks are skipped there.
 */
function hasLayout(doc: Document): boolean {
  const rect = doc.documentElement.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

/** clip-path, or clip on a positioned box, on the element or an ancestor: a way to hide a field in plain sight. */
function isClipped(el: Element, view: Window): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    const clipPath = style.getPropertyValue("clip-path");
    if (clipPath !== "" && clipPath !== "none") return true;
    const clip = style.getPropertyValue("clip");
    if (clip !== "" && clip !== "auto" && (style.position === "absolute" || style.position === "fixed")) return true;
  }
  return false;
}

const CLIPS = new Set(["hidden", "clip", "auto", "scroll"]);

/**
 * The field's centre is cut off by an ancestor with overflow other than visible (a field pushed right or down out
 * of a box), or, when that centre is on screen, another element lies on top of it.
 */
function isCoveredOrCut(el: Element, rect: DOMRect, view: Window): boolean {
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  for (let node = el.parentElement; node && node !== el.ownerDocument.documentElement; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (![style.overflowX, style.overflowY, style.overflow].some((v) => CLIPS.has(v))) continue;
    const box = node.getBoundingClientRect();
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) return true;
  }
  if (x < 0 || y < 0 || x > view.innerWidth || y > view.innerHeight) return false; // below the fold: reachable by scrolling
  const hit = el.ownerDocument.elementFromPoint(x, y);
  if (!hit || hit === el || el.contains(hit)) return false;
  // A floating label drawn over its own field.
  return (hit.closest("label") as HTMLLabelElement | null)?.control !== el;
}

/**
 * Whether a person can see the field. `strict` (contact and card, review V3-S4) also rejects clipped, tiny,
 * cut-off and covered fields; login fill does not need it, because it only runs on the entry's own site.
 */
export function isVisible(el: Element, strict = false): boolean {
  const view = el.ownerDocument.defaultView;
  if (!view) return false;
  // Chrome 121+: covers display, visibility, opacity of the element and its ancestors, content-visibility.
  if (el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false) return false;
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.hasAttribute("hidden")) return false;
    const style = view.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (style.opacity !== "" && parseFloat(style.opacity) === 0) return false;
  }
  if (strict && isClipped(el, view)) return false;
  if (!hasLayout(el.ownerDocument)) return true;
  // Zero-size or fully off-screen (above or left of the page origin, unreachable by scrolling) boxes.
  const rect = el.getBoundingClientRect();
  const min = strict ? STRICT_MIN_PX : MIN_VISIBLE_PX;
  if (rect.width < min || rect.height < min) return false;
  if (rect.right + view.scrollX <= 0 || rect.bottom + view.scrollY <= 0) return false;
  return !strict || !isCoveredOrCut(el, rect, view);
}

const isField = (el: Element | null): el is FieldElement =>
  el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;

function isFillable(el: FieldElement, strict = false): boolean {
  if (el.disabled || (!(el instanceof HTMLSelectElement) && el.readOnly)) return false;
  if (el instanceof HTMLInputElement && el.type === "hidden") return false;
  return isVisible(el, strict);
}

interface Candidate { el: FieldElement; descriptor: autofill.FieldDescriptor; kind: autofill.FieldKind | null }

function candidatesIn(root: ParentNode, strict = false): Candidate[] {
  const out: Candidate[] = [];
  for (const el of root.querySelectorAll<FieldElement>("input, select, textarea")) {
    if (!isFillable(el, strict)) continue;
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

/**
 * Contact and card: only the form the user is in (the focused field's form), or else the form of the first
 * visible field the plan fills, never every matching field of the page (review V3-S4).
 */
function fillOther(plan: autofill.FillPlan, doc: Document): number {
  const active = doc.activeElement;
  let scope: ParentNode;
  if (isField(active) && isFillable(active, true)) {
    scope = active.form ?? doc;
  } else {
    const all = candidatesIn(doc, true);
    const first = all.find((c) => c.kind && autofill.fillValue(plan, c.kind, c.descriptor, { hasUsernameField: false }) !== undefined);
    scope = first?.el.form ?? doc;
  }
  const cands = candidatesIn(scope, true);
  return fillCandidates(plan, cands, hasUsername(cands));
}

/** The origin of the top frame when it is the frame's own or same-origin with it; undefined when cross-origin. */
function topOrigin(doc: Document): string | undefined {
  const win = doc.defaultView;
  if (!win) return undefined;
  try {
    const top = win.top;
    if (top === win) return win.location.origin;
    return top?.location.origin === win.location.origin ? win.location.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fills the page, but only when this frame is same-origin with the top frame and that origin is
 * expectedOrigin (the one the service worker checked the plan against; the tab may have navigated since).
 */
export function fillPage(plan: autofill.FillPlan, expectedOrigin: string, doc: Document = document): { filled: number } {
  if (topOrigin(doc) !== expectedOrigin) return { filled: 0 };
  if (plan.kind === "login") return { filled: fillLogin(plan, doc) };
  return { filled: fillOther(plan, doc) };
}
