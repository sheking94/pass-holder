// @vitest-environment happy-dom
import { p2p } from "@passholder/core";
import { afterEach, describe, expect, it } from "vitest";
import { byText, click, settle, setupPopup, teardownPopup } from "./fake-chrome.ts";

afterEach(teardownPopup);

describe("secretField", () => {
  it("starts hidden, shows on „Pokaż” and copies with a clipboard clear request", async () => {
    const { clipboard, messages } = await setupPopup();
    const { h, statusLine, secretField } = await import("../../src/ui/dom.ts");
    const input = h("input", { value: "tajne-123" });
    const status = statusLine();
    const field = secretField(input, "PIN", status);
    document.body.append(field.row, status);

    expect(input.type).toBe("password");
    await click(byText(field.row, "Pokaż"));
    expect(input.type).toBe("text");
    expect(byText(field.row, "Ukryj")).toBeTruthy();
    await click(byText(field.row, "Ukryj"));
    expect(input.type).toBe("password");

    await click(byText(field.row, "Kopiuj"));
    await settle(() => messages.length > 0);
    expect(clipboard).toEqual(["tajne-123"]);
    expect(messages).toEqual([
      expect.objectContaining({ target: "background", type: "password-copied" }),
    ]);
    expect(status.textContent).toBe("Skopiowano PIN. Schowek zostanie wyczyszczony za 1 min.");
  }, 30_000);

  it("setSecret(false) makes the field plain: no „Pokaż”, copy without clearing", async () => {
    const { clipboard, messages } = await setupPopup();
    const { h, statusLine, secretField } = await import("../../src/ui/dom.ts");
    const input = h("input", { value: "jawne" });
    const status = statusLine();
    const field = secretField(input, "wartość", status);
    document.body.append(field.row, status);

    field.setSecret(false);
    expect(input.type).toBe("text");
    expect(() => byText(field.row, "Pokaż")).toThrow();
    await click(byText(field.row, "Kopiuj"));
    expect(clipboard).toEqual(["jawne"]);
    expect(messages).toEqual([]);
    expect(status.textContent).toBe("Skopiowano wartość.");

    field.setSecret(true);
    expect(input.type).toBe("password");
    expect(byText(field.row, "Pokaż")).toBeTruthy();
    field.setVisible(true);
    expect(input.type).toBe("text");
  }, 30_000);

  it("„Kopiuj” on an empty field copies nothing and says „Pole jest puste”", async () => {
    const { clipboard, messages } = await setupPopup();
    const { h, statusLine, secretField } = await import("../../src/ui/dom.ts");
    const input = h("input", { value: "" });
    const status = statusLine();
    const field = secretField(input, "PIN", status);
    document.body.append(field.row, status);
    await click(byText(field.row, "Kopiuj"));
    expect(clipboard).toEqual([]);
    expect(messages).toEqual([]);
    expect(status.textContent).toBe("Pole jest puste");
  }, 30_000);
});

describe("listEditor", () => {
  it("adds rows with „+ Dodaj”, removes them with „Usuń” and reads them in order", async () => {
    await setupPopup();
    const { h } = await import("../../src/ui/dom.ts");
    const { listEditor } = await import("../../src/ui/list-editor.ts");
    const editor = listEditor<string>({
      items: ["a", "b"],
      empty: () => "",
      addLabel: "Dodaj",
      row: (item) => {
        const input = h("input", { value: item });
        return { node: input, read: () => input.value };
      },
    });
    document.body.append(editor.node);
    expect(editor.read()).toEqual(["a", "b"]);

    await click(byText(editor.node, "+ Dodaj"));
    const inputs = editor.node.querySelectorAll("input");
    expect(inputs).toHaveLength(3);
    inputs[2]!.value = "c";
    expect(editor.read()).toEqual(["a", "b", "c"]);

    const remove = editor.node.querySelectorAll("button");
    expect([...remove].every((b) => b.type === "button")).toBe(true);
    await click(byText(editor.node, "Usuń", 1)); // the second row
    expect(editor.read()).toEqual(["a", "c"]);
    await click(byText(editor.node, "Usuń")); // the first row
    expect(editor.read()).toEqual(["c"]);
  }, 30_000);
});

describe("setupPopup", () => {
  it("gives the views a paired, unlocked store with the given entries", async () => {
    const login = p2p.emptyLogin("Bank");
    const { app, store } = await setupPopup([
      {
        id: "1",
        content: { ...login, fields: { ...login.fields, username: "jan", password: "x" } },
      },
    ]);
    expect(app.id).toBe("app");
    expect(store.listEntries("login").map((e) => e.data.name)).toEqual(["Bank"]);
    const state = await import("../../src/ui/state.ts");
    expect(state.store).toBe(store);
  }, 30_000);
});

describe("list view copy buttons", () => {
  it("keep their status texts", async () => {
    const login = p2p.emptyLogin("Bank");
    const { app, clipboard, messages } = await setupPopup([
      {
        id: "1",
        content: { ...login, fields: { ...login.fields, username: "jan", password: "x" } },
      },
    ]);
    const { listView } = await import("../../src/views/list.ts");
    listView();
    const status = app.querySelector(".status")!;
    await click(byText(app, "Login"));
    expect(status.textContent).toBe("Skopiowano login.");
    expect(messages).toEqual([]);
    await click(byText(app, "Hasło"));
    await settle(() => messages.length > 0);
    expect(status.textContent).toBe("Skopiowano hasło. Schowek zostanie wyczyszczony za 1 min.");
    expect(clipboard).toEqual(["jan", "x"]);
    expect(messages).toEqual([expect.objectContaining({ type: "password-copied" })]);
  }, 30_000);
});

describe("teardownPopup", () => {
  it("removes the fake chrome, fetch and clipboard and empties the page", async () => {
    const realFetch = globalThis.fetch;
    const before = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    await setupPopup();
    expect(globalThis.fetch).not.toBe(realFetch);
    teardownPopup();
    expect((globalThis as { chrome?: unknown }).chrome).toBeUndefined();
    expect(globalThis.fetch).toBe(realFetch);
    expect(Object.getOwnPropertyDescriptor(navigator, "clipboard")).toEqual(before);
    expect(document.getElementById("app")).toBeNull();
  }, 30_000);
});
