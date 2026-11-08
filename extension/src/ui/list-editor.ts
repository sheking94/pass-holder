/** An editable list of items (phones, e-mails, custom fields…): a row per item, „Usuń” and „+ <addLabel>”. */
import { h } from "./dom.ts";

export function listEditor<T>(o: {
  items: readonly T[];
  empty: () => T;
  addLabel: string;
  row: (item: T) => { node: HTMLElement; read: () => T };
}): { node: HTMLElement; read: () => T[] } {
  const rows = h("div", { class: "list-rows" });
  const readers = new Map<HTMLElement, () => T>();
  const add = (item: T) => {
    const { node, read } = o.row(item);
    const wrapper = h("div", { class: "row list-row" }, h("div", { class: "grow" }, node));
    wrapper.append(h("button", {
      type: "button",
      class: "small",
      onclick: () => {
        readers.delete(wrapper);
        wrapper.remove();
      },
    }, "Usuń"));
    readers.set(wrapper, read);
    rows.append(wrapper);
  };
  for (const item of o.items) add(item);
  const node = h("div", { class: "list-editor" }, rows, h("button", { type: "button", class: "small", onclick: () => add(o.empty()) }, `+ ${o.addLabel}`));
  // In the order the rows are shown.
  return { node, read: () => [...rows.children].map((row) => readers.get(row as HTMLElement)!()) };
}
