// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { emptyLoginForms, formSignature, loginScope, readLogin } from "../../src/save/read-form.ts";

function html(s: string): void {
  document.body.innerHTML = s;
}
function form(): HTMLFormElement {
  return document.querySelector("form")!;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("readLogin", () => {
  it("reads username and password", () => {
    html(
      `<form><input name="username" value="jan"><input type="password" name="password" value="s3"></form>`,
    );
    expect(readLogin(form())).toEqual({
      username: "jan",
      password: "s3",
      formSignature: "password,username",
    });
  });

  it("uses an email before the password when there is no username field", () => {
    html(
      `<form><input name="email" autocomplete="off" value="jan@example.com"><input type="password" value="s3"></form>`,
    );
    expect(readLogin(form())).toMatchObject({ username: "jan@example.com", password: "s3" });
  });

  it("registration: password from the first new-password field", () => {
    html(`<form><input name="username" value="jan"><input type="password" autocomplete="new-password" value="first1">
      <input type="password" autocomplete="new-password" value="first1"></form>`);
    expect(readLogin(form())).toMatchObject({ username: "jan", password: "first1" });
  });

  it("password change: takes the new password", () => {
    html(`<form><input type="password" autocomplete="current-password" value="old">
      <input type="password" autocomplete="new-password" value="new1">
      <input type="password" autocomplete="new-password" value="new1"></form>`);
    expect(readLogin(form())?.password).toBe("new1");
  });

  it("a contact form with a password is read", () => {
    html(`<form><input name="first_name" value="Jan"><input name="last_name" value="Kowalski"><input type="tel" name="phone" value="123456789">
      <input type="email" name="email" value="jan@example.com"><input type="password" value="s3"></form>`);
    expect(readLogin(form())).toMatchObject({ username: "jan@example.com", password: "s3" });
  });

  it("a form with only a new-password field is read", () => {
    html(`<form><input type="password" autocomplete="new-password" value="s3"></form>`);
    expect(readLogin(form())).toMatchObject({ username: "", password: "s3" });
  });

  it("returns undefined for an empty password", () => {
    html(`<form><input name="username" value="jan"><input type="password"></form>`);
    expect(readLogin(form())).toBeUndefined();
  });

  it("ignores hidden password fields", () => {
    html(
      `<form><input name="username" value="jan"><input type="password" hidden value="x"></form>`,
    );
    expect(readLogin(form())).toBeUndefined();
  });
});

describe("loginScope", () => {
  it("returns the form of the element", () => {
    html(`<form><input type="password"><button>Go</button></form>`);
    expect(loginScope(document.querySelector("button")!)).toBe(form());
  });

  it("without a form returns the nearest ancestor with a visible password field", () => {
    html(
      `<div id="outer"><div id="box"><input type="password" value="x"><button>Go</button></div></div>`,
    );
    expect(loginScope(document.querySelector("button")!)).toBe(document.getElementById("box"));
  });

  it("returns undefined when there is no such ancestor", () => {
    html(`<div><button>Go</button></div>`);
    expect(loginScope(document.querySelector("button")!)).toBeUndefined();
  });
});

describe("formSignature", () => {
  it("does not depend on field order and skips non-data inputs", () => {
    html(`<form id="a"><input name="b"><input id="a1"><input type="hidden" name="csrf"><input type="submit" name="go"></form>
      <form id="b"><input id="a1"><input name="b"></form>`);
    const [a, b] = Array.from(document.forms) as [HTMLFormElement, HTMLFormElement];
    expect(formSignature(a)).toBe("a1,b");
    expect(formSignature(b)).toBe(formSignature(a));
  });
});

describe("emptyLoginForms", () => {
  it("lists forms with an empty visible password field and skips filled ones", () => {
    html(`<form><input name="u"><input type="password" name="p"></form>
      <form><input name="x"><input type="password" name="q" value="filled"></form>`);
    expect(emptyLoginForms(document)).toEqual(["p,u"]);
  });
});
