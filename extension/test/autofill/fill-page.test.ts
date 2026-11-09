// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as autofill from "@passholder/core/autofill";
import { fillPage } from "../../src/autofill/fill-page.ts";

type Plan = autofill.FillPlan;
const ORIGIN = window.location.origin;
const login: Plan = { kind: "login", username: "jan", password: "s3cret" };
const card: Plan = { kind: "card", holder: "Jan Kowalski", number: "4111 1111 1111 1111", expiry: "08/29", cvc: "123" };
const contact: Plan = {
  kind: "contact", firstName: "Jan", lastName: "Kowalski", email: "jan@example.com", tel: "600100200",
  street: "Prosta 1", postalCode: "00-001", city: "Warszawa", country: "Polska", bday: "",
};

function html(s: string): void { document.body.innerHTML = s; }
function val(sel: string): string { return (document.querySelector(sel) as HTMLInputElement).value; }

afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

describe("fillPage", () => {
  it("fills a simple login form", () => {
    html(`<form><input name="username"><input type="password" name="password"></form>`);
    expect(fillPage(login, ORIGIN)).toEqual({ filled: 2 });
    expect(val("[name=username]")).toBe("jan");
    expect(val("[name=password]")).toBe("s3cret");
  });

  it("fills username only in a two-step login", () => {
    html(`<form><input name="login"></form>`);
    expect(fillPage(login, ORIGIN)).toEqual({ filled: 1 });
    expect(val("[name=login]")).toBe("jan");
  });

  it("email field gets the login when there is no username field", () => {
    html(`<form><input name="email" autocomplete="off"><input type="password"></form>`);
    expect(fillPage(login, ORIGIN)).toEqual({ filled: 2 });
    expect(val("[name=email]")).toBe("jan");
  });

  it("two-step login prefers a username field over an earlier email field", () => {
    html(`<form><input type="email" id="news"></form><form><input name="login" id="lg"></form>`);
    expect(fillPage(login, ORIGIN)).toEqual({ filled: 1 });
    expect(val("#lg")).toBe("jan");
    expect(val("#news")).toBe("");
  });

  it("skips passwords in a registration form", () => {
    html(`<form><input name="username"><input type="password" name="p1"><input type="password" name="p2"></form>`);
    fillPage(login, ORIGIN);
    expect(val("[name=p1]")).toBe("");
    expect(val("[name=p2]")).toBe("");
  });

  it("skips new-password fields", () => {
    html(`<form><input name="username"><input type="password" autocomplete="new-password"></form>`);
    const r = fillPage(login, ORIGIN);
    expect(val("[type=password]")).toBe("");
    expect(r.filled).toBe(1);
  });

  it("uses the first form with a visible password field", () => {
    html(`<form id="s"><input name="q" type="text" placeholder="Szukaj"></form>
      <form id="l"><input name="username"><input type="password"></form>`);
    expect(fillPage(login, ORIGIN)).toEqual({ filled: 2 });
    expect(val("#s [name=q]")).toBe("");
    expect(val("#l [name=username]")).toBe("jan");
  });

  it("skips hidden, disabled and readonly fields", () => {
    html(`<form>
      <input name="username" style="display:none">
      <input name="username" hidden>
      <input name="username" disabled>
      <input name="username" readonly>
      <input name="username" type="hidden">
      <input name="username" id="ok"><input type="password">
    </form>`);
    expect(fillPage(login, ORIGIN)).toEqual({ filled: 2 });
    expect(val("#ok")).toBe("jan");
    expect(document.querySelectorAll("input[name=username]:not(#ok)")).toHaveLength(5);
    for (const el of document.querySelectorAll<HTMLInputElement>("input[name=username]:not(#ok)")) expect(el.value).toBe("");
  });

  it("sets value through the prototype setter and fires input and change", () => {
    html(`<form><input name="username"><input type="password"></form>`);
    const el = document.querySelector("[name=username]") as HTMLInputElement;
    let own = "";
    Object.defineProperty(el, "value", { get: () => own, set: (v: string) => { own = "framework:" + v; }, configurable: true });
    const events: string[] = [];
    document.addEventListener("input", () => events.push("input"));
    document.addEventListener("change", () => events.push("change"));
    fillPage(login, ORIGIN);
    expect(own).toBe("");
    expect(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.get!.call(el)).toBe("jan");
    expect(events).toContain("input");
    expect(events).toContain("change");
  });

  it("fills a card with one expiry field", () => {
    html(`<form><input autocomplete="cc-name"><input autocomplete="cc-number"><input autocomplete="cc-exp"><input autocomplete="cc-csc"></form>`);
    expect(fillPage(card, ORIGIN)).toEqual({ filled: 4 });
    expect(val("[autocomplete=cc-number]")).toBe("4111111111111111");
    expect(val("[autocomplete=cc-exp]")).toBe("08/29");
    expect(val("[autocomplete=cc-csc]")).toBe("123");
  });

  it("fills a card with month and year selects", () => {
    html(`<form><input autocomplete="cc-number">
      <select autocomplete="cc-exp-month"><option value="">-</option><option value="8">08</option><option value="9">09</option></select>
      <select autocomplete="cc-exp-year"><option value="">-</option><option value="2029">2029</option></select></form>`);
    expect(fillPage(card, ORIGIN)).toEqual({ filled: 3 });
    expect(val("[autocomplete=cc-exp-month]")).toBe("8");
    expect(val("[autocomplete=cc-exp-year]")).toBe("2029");
  });

  it("fills an address form", () => {
    html(`<form>
      <label for="fn">Imię</label><input id="fn">
      <label>Nazwisko <input id="ln"></label>
      <input type="email" id="em"><input type="tel" id="tl">
      <input autocomplete="street-address" id="st"><input autocomplete="postal-code" id="pc"><input autocomplete="address-level2" id="ct">
      <select autocomplete="country-name" id="co"><option value="DE">Niemcy</option><option value="PL">Polska</option></select>
    </form>`);
    expect(fillPage(contact, ORIGIN)).toEqual({ filled: 8 });
    expect(val("#fn")).toBe("Jan");
    expect(val("#ln")).toBe("Kowalski");
    expect(val("#em")).toBe("jan@example.com");
    expect(val("#tl")).toBe("600100200");
    expect(val("#st")).toBe("Prosta 1");
    expect(val("#pc")).toBe("00-001");
    expect(val("#ct")).toBe("Warszawa");
    expect(val("#co")).toBe("PL");
  });

  it("does not overwrite with empty values", () => {
    html(`<form><input type="tel" id="tl" value="123"><input type="email" id="em"></form>`);
    const r = fillPage({ ...contact, tel: "" } as Plan, ORIGIN);
    expect(val("#tl")).toBe("123");
    expect(r.filled).toBe(1);
  });

  it("returns 0 in a frame from another origin", () => {
    html(`<form><input name="username"><input type="password"></form>`);
    vi.spyOn(window, "top", "get").mockReturnValue({
      get location(): never { throw new Error("cross-origin"); },
    } as unknown as Window);
    expect(fillPage(login, ORIGIN)).toEqual({ filled: 0 });
    expect(val("[name=username]")).toBe("");
  });

  it("returns 0 when top is reachable but has a different origin", () => {
    html(`<form><input name="username"><input type="password"></form>`);
    vi.spyOn(window, "top", "get").mockReturnValue({ location: { origin: "https://other.example" } } as unknown as Window);
    expect(fillPage(login, ORIGIN)).toEqual({ filled: 0 });
    expect(val("[name=username]")).toBe("");
  });

  it("returns 0 without touching fields when the page origin is not the expected one", () => {
    html(`<form><input name="username"><input type="password"></form>`);
    expect(fillPage(login, "https://bank.pl")).toEqual({ filled: 0 });
    expect(val("[name=username]")).toBe("");
    expect(val("[type=password]")).toBe("");
  });
});
