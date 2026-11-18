/** Helpers of the content scripts (autofill and the save watch) for the frame they run in. */

/** A form field the content scripts read or fill. */
export type FieldElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export type FrameRole = "top" | "subframe";

/** "top" for the top frame, "subframe" when same-origin with top, undefined when top is cross-origin. */
export function frameRole(doc: Document): FrameRole | undefined {
  const win = doc.defaultView;
  if (!win) return undefined;
  try {
    const top = win.top;
    if (top === win) return "top";
    return top?.location.origin === win.location.origin ? "subframe" : undefined;
  } catch {
    return undefined;
  }
}
