import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FieldDescriptor } from "../../src/autofill/fields.ts";
import type { FieldKind } from "../../src/autofill/keywords.ts";
import { fillValue, planFor, type FillPlan } from "../../src/autofill/values.ts";
import type { EntryContent } from "../../src/p2p/entry.ts";

const vectors = JSON.parse(
  readFileSync(new URL("../../test-vectors/autofill/values.json", import.meta.url), "utf8"),
) as {
  cases: {
    plan: FillPlan;
    kind: FieldKind;
    field: FieldDescriptor;
    hasUsernameField: boolean;
    expected: string | null;
  }[];
};

describe("fillValue vectors", () => {
  for (const c of vectors.cases) {
    it(`${c.plan.kind} ${c.kind} ${JSON.stringify(c.field)} hasUsername=${c.hasUsernameField} -> ${c.expected}`, () => {
      expect(
        fillValue(c.plan, c.kind, c.field, { hasUsernameField: c.hasUsernameField }) ?? null,
      ).toBe(c.expected);
    });
  }
});

const base = { name: "n", note: "", custom: [] };

describe("planFor", () => {
  it("maps a login", () => {
    const e: EntryContent = {
      ...base,
      type: "login",
      fields: { username: "u", password: "p", totp: "t", urls: [], androidApps: [] },
    };
    expect(planFor(e)).toEqual({ kind: "login", username: "u", password: "p" });
  });

  it("maps a card without exposing the pin", () => {
    const e: EntryContent = {
      ...base,
      type: "card",
      fields: { holder: "H", number: "1", expiry: "01/30", cvc: "9", pin: "0000" },
    };
    expect(planFor(e)).toEqual({
      kind: "card",
      holder: "H",
      number: "1",
      expiry: "01/30",
      cvc: "9",
    });
  });

  it("maps a contact using the first phone, email and address", () => {
    const e: EntryContent = {
      ...base,
      type: "contact",
      fields: {
        firstName: "A",
        lastName: "B",
        birthDate: "2000-02-29",
        phones: [
          { label: "", value: "111" },
          { label: "", value: "222" },
        ],
        emails: [{ label: "", value: "a@b.c" }],
        addresses: [
          { label: "", street: "S", postalCode: "P", city: "C", country: "K" },
          { label: "", street: "X", postalCode: "X", city: "X", country: "X" },
        ],
      },
    };
    expect(planFor(e)).toEqual({
      kind: "contact",
      firstName: "A",
      lastName: "B",
      email: "a@b.c",
      tel: "111",
      street: "S",
      postalCode: "P",
      city: "C",
      country: "K",
      bday: "2000-02-29",
    });
  });

  it("uses empty strings for a contact without phones, emails, addresses", () => {
    const e: EntryContent = {
      ...base,
      type: "contact",
      fields: {
        firstName: "A",
        lastName: "B",
        birthDate: "",
        phones: [],
        emails: [],
        addresses: [],
      },
    };
    expect(planFor(e)).toMatchObject({
      tel: "",
      email: "",
      street: "",
      postalCode: "",
      city: "",
      country: "",
      bday: "",
    });
  });

  it("drops an invalid birth date", () => {
    for (const birthDate of ["1990-02-30", "01.05.1990", "garbage"]) {
      const e: EntryContent = {
        ...base,
        type: "contact",
        fields: { firstName: "", lastName: "", birthDate, phones: [], emails: [], addresses: [] },
      };
      expect(planFor(e)).toMatchObject({ bday: "" });
    }
  });

  it("returns undefined for notes and documents", () => {
    expect(planFor({ ...base, type: "note", fields: {} })).toBeUndefined();
    expect(
      planFor({
        ...base,
        type: "document",
        fields: {
          kind: "other",
          number: "",
          fullName: "",
          issueDate: "",
          expiryDate: "",
          issuer: "",
        },
      }),
    ).toBeUndefined();
  });
});
