/** The status line text; a leaf module so copy.ts and dom.ts can both use it. */
export function setStatus(el: HTMLElement, text: string, isError = false) {
  el.textContent = text;
  el.classList.toggle("error", isError);
}
