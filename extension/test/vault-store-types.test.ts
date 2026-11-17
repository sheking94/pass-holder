import { describe, expect, it } from "vitest";
import { p2p } from "@passholder/core";
import { pairedBrowser } from "./fake-phone.ts";

function card(name: string): p2p.EntryContent {
  return {
    type: "card",
    name,
    note: "n",
    custom: [{ label: "x", value: "y", hidden: true }],
    fields: {
      holder: "Jan",
      number: "4111 1111 1111 1111",
      expiry: "12/30",
      cvc: "123",
      pin: "1234",
    },
  };
}
function contact(name: string): p2p.EntryContent {
  return {
    type: "contact",
    name,
    note: "",
    custom: [],
    fields: {
      firstName: "Anna",
      lastName: "Nowak",
      birthDate: "1990-01-02",
      phones: [{ label: "dom", value: "123" }],
      emails: [],
      addresses: [],
    },
  };
}

describe("typed entry API", () => {
  it("stores a card and a contact, lists by type and syncs them", async () => {
    const { store, phone } = await pairedBrowser();
    await store.putEntry("c1", card("Visa"));
    await store.putEntry("p1", contact("Anna"));

    expect(store.listEntries("card")).toEqual([{ id: "c1", dirty: true, data: card("Visa") }]);
    expect(store.listEntries("contact").map((e) => e.id)).toEqual(["p1"]);
    expect(store.getEntry("c1")).toEqual({ id: "c1", dirty: true, data: card("Visa") });
    expect(Object.keys(store.getEntry("c1")!.data)).not.toContain("hlc");
    expect(Object.keys(store.getEntry("c1")!.data)).not.toContain("v");

    await store.sync();
    expect(store.getEntry("c1")!.dirty).toBe(false);
    const onPhone = await phone.entryData("c1");
    expect(onPhone).toMatchObject(card("Visa"));
  }, 30_000);

  it("sorts by name with the Polish collation", async () => {
    const { store } = await pairedBrowser();
    await store.putEntry("1", card("Żółta"));
    await store.putEntry("2", card("Zielona"));
    await store.putEntry("3", card("Ala"));
    expect(store.listEntries("card").map((e) => e.data.name)).toEqual(["Ala", "Zielona", "Żółta"]);
  }, 30_000);
  it("refuses another type over a live entry, but allows it after delete", async () => {
    const { store } = await pairedBrowser();
    await store.putEntry("x", card("Visa"));
    await expect(store.putEntry("x", p2p.emptyLogin("l"))).rejects.toThrow("Ten wpis ma inny typ");
    expect(store.getEntry("x")!.data.type).toBe("card");
    await store.putEntry("x", card("Visa 2"));
    await store.delete("x");
    expect(store.getEntry("x")).toBeUndefined();
    await store.putEntry("x", p2p.emptyLogin("l"));
    expect(store.getEntry("x")!.data.type).toBe("login");
  }, 30_000);

  it("rejects a too large entry and stores nothing", async () => {
    const { store } = await pairedBrowser();
    const note: p2p.EntryContent = {
      type: "note",
      name: "n",
      note: "a".repeat(70_000),
      custom: [],
      fields: {},
    };
    await expect(store.putEntry("big", note)).rejects.toThrow("Wpis jest za duży");
    expect(store.getEntry("big")).toBeUndefined();
    expect(store.pendingCount()).toBe(0);
  }, 30_000);
});
